/**
 * Move the old bot wallet's KOIN to the owner wallet (one-off, after the 2026-10-26 operator rotation).
 *
 *   npx tsx tools/sweep-old-bot.ts            dry run: finds the key, shows balances and the amount, sends nothing
 *   npx tsx tools/sweep-old-bot.ts --send     sends it (mainnet: needs CONFIRM_MAINNET=yes in .env)
 *   options: --keep <KOIN>   KOIN to leave behind (default 2, so the old wallet can still pay for a later transaction)
 *
 * Safety:
 * - It sends ONLY from the old bot wallet to the owner wallet. Both addresses are fixed below; there is no option to
 *   change them.
 * - It looks through every *_WIF entry in .env for the one whose address is the old bot wallet. It prints the entry's
 *   NAME only, never a key.
 * - It checks it is talking to Koinos mainnet (pinned chain id) before reading or sending anything.
 * - KOIN transfers need Mana at least equal to the amount, so the amount is capped by the wallet's Mana.
 */
import fs from "node:fs";
import { Signer, Provider, Contract, utils } from "koilib";
import { tokenAbi } from "../bot/token-abi.ts";

const FROM = "1JSTwoKYNAUq2gmmTg4r1kdYCERR2kUrZ";       // old bot (operator until 2026-10-26)
const TO = "1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717";         // owner and treasury
const KOIN = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK";
const VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq";
const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const RC_LIMIT = 100_000_000n;                             // 1 KOIN of Mana at most for the transfer (it costs ~0.2)
const UNIT = 100_000_000n;

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const send = process.argv.includes("--send");
const keep = BigInt(Math.round(Number(arg("--keep") ?? "2") * 1e8));
const envFile = arg("--env") ?? ".env";
const fmt = (n: bigint) => utils.formatUnits(n.toString(), 8);

function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

async function main() {
  const env = readEnv(envFile);
  if (!Object.keys(env).length) throw new Error(`${envFile} not found or empty. Run this in C:\\kprediction.`);
  // 1. Find the old bot wallet's key by its address. Only names are printed.
  let signer: Signer | null = null, keyName = "";
  for (const [name, value] of Object.entries(env)) {
    if (!/WIF$/.test(name) || !value) continue;
    let s: Signer;
    try { s = Signer.fromWif(value); } catch { continue; }
    if (s.getAddress() === FROM) { signer = s; keyName = name; break; }
  }
  if (!signer) {
    const names = Object.keys(env).filter((n) => /WIF$/.test(n) && env[n]);
    throw new Error(`None of the keys in ${envFile} (${names.join(", ") || "no *_WIF entries"}) belongs to the old bot wallet ${FROM}.`);
  }
  console.log(`Found the old bot wallet's key in ${envFile} under: ${keyName}`);

  // 2. Mainnet only, checked.
  const rpc = env.RPC || "https://api.koinos.io";
  const provider = new Provider([rpc]);
  const chainId = await provider.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) throw new Error(`${rpc} is not Koinos mainnet (chain id ${chainId}). Stopping.`);
  signer.provider = provider;

  // 3. Balances and the amount.
  const koin = new Contract({ id: KOIN, abi: tokenAbi as any, provider, signer });
  const vhp = new Contract({ id: VHP, abi: tokenAbi as any, provider });
  const bal = async (c: Contract, who: string) => BigInt((await c.functions.balance_of({ owner: who })).result?.value ?? 0);
  const koinFrom = await bal(koin, FROM), vhpFrom = await bal(vhp, FROM), koinTo = await bal(koin, TO);
  const mana = BigInt(await provider.getAccountRc(FROM));
  console.log(`Old bot wallet ${FROM}: ${fmt(koinFrom)} KOIN, ${fmt(mana)} Mana, ${fmt(vhpFrom)} VHP`);
  console.log(`Owner wallet   ${TO}: ${fmt(koinTo)} KOIN`);
  let amount = koinFrom > keep ? koinFrom - keep : 0n;
  const manaCap = mana > RC_LIMIT + keep ? mana - RC_LIMIT - keep : 0n;   // KOIN moves need Mana >= the amount
  if (amount > manaCap) amount = manaCap;
  amount = (amount / 1_000_000n) * 1_000_000n;                            // round down to 0.01 KOIN
  if (amount === 0n) { console.log("Nothing to send (balance or Mana too low)."); return; }
  if (vhpFrom > 0n) console.log(`Note: the old wallet also holds ${fmt(vhpFrom)} VHP. This tool moves KOIN only.`);
  console.log(`\nPlan: send ${fmt(amount)} KOIN from ${FROM} to ${TO}, leaving about ${fmt(koinFrom - amount)} KOIN behind.`);

  if (!send) { console.log("\nDry run: nothing was sent. If this looks right, run it again with --send."); return; }
  if (env.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");

  // 4. Send and wait for it to be included.
  const { transaction, receipt } = await koin.functions.transfer(
    { from: FROM, to: TO, value: amount.toString() },
    { payer: FROM, rcLimit: RC_LIMIT.toString() },
  );
  console.log(`Sent: transaction ${transaction?.id}`);
  if (receipt && (receipt as any).reverted) throw new Error("The transaction was reverted: nothing moved.");
  await transaction?.wait("byBlock", 60_000);
  const after = await bal(koin, TO);
  console.log(`Included. Owner wallet now holds ${fmt(after)} KOIN (was ${fmt(koinTo)}).`);
  console.log(`Check it on https://koinosscan.com/tx/${transaction?.id}`);
}

main().catch((e) => { console.error(`\nStopped: ${e.message ?? e}`); process.exitCode = 1; });
