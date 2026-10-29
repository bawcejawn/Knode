/**
 * testnet-v6: the Vault's testnet check, in one command (audit V6-12 and V2-14).
 *
 * On the Koinos Foundation testnet (test KOIN only) it deploys a FRESH copy of the Vault (game/build/release, the
 * audited normal build), adds 12 more games (13 in all), has 20 test players stake in them, runs short weeks
 * (10 minutes each) and measures the Mana (rc_used) of the heaviest calls:
 *   - a player's deposit that first has to close a 13-game week (advance → closeV6), and a plain deposit;
 *   - posting one game's results (16 rows), the seal, finalizing (16 places), a claim, a withdrawal.
 * It also checks that the chain lists storage keys in byte order (list_players over every test player), which the
 * simulator and the tests assume.
 *
 *   npm run bot -- testnet-v6           first run: makes a throwaway testnet wallet and prints its address for the faucet;
 *                                       later runs: carry on from where the last one stopped, then write the report
 *   npm run bot -- testnet-v6 status    what the run has done so far, and the funder's balance
 *
 * Everything lives in testnet-v6/ (keys, progress, report). It never reads .env, never touches mainnet, and refuses to
 * run unless the node answers with the testnet's chain id. Test KOIN is worthless; nothing needs returning.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Provider, Signer, Contract, Transaction, utils } from "koilib";
import { KoinosChain, loadAbi, showKoin, toSat } from "./chain.ts";
import { tokenAbi } from "./token-abi.ts";

const RPC = "https://testnet.koinosfoundation.org";
const CHAIN_ID = "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==";
const KOIN = "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju";
const FAUCET = "https://t.me/KoinosTestnetFaucetBot";
const WASM = "game/build/release/contract.wasm";
const NORMAL_SHA = "eed38f7ce130d9d2e0dfafa8ddd5c4a6f383e2c7ce12ab87b02c584f43920b3d";
const DIR = "testnet-v6";
const VHP = 100_000_000n;
const MIN = 60_000;
const WEEK = 10 * MIN, CLOSE = 2 * MIN, SETTLE = 3 * MIN, LOCK = 2 * MIN;
const PLAYERS = 20, IN_13 = 16;          // 16 players stake in game 13 (the measured results); the rest in games 2–12
const PER_PLAYER = 4n * VHP;             // test KOIN for each player: 1 staked (burned into VHP), the rest is Mana
const LAST_PLAYER = 15n * VHP;           // the player whose deposit closes the 13-game week needs more Mana
const TO_CONTRACT = 15n * VHP;           // the vault's own Mana, so it can burn players' KOIN stakes into VHP
const REWARDS = 5n * VHP;                // stands in for a week's block rewards, so the measured week has buckets to pay
const NEED = 150n * VHP;                 // what the funder should hold before starting

const log = (...a: any[]) => console.log(...a);
const file = (n: string) => path.join(DIR, n);
const readJ = (n: string, d: any) => (fs.existsSync(file(n)) ? JSON.parse(fs.readFileSync(file(n), "utf8")) : d);
const writeJ = (n: string, v: any) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(file(n), JSON.stringify(v, null, 2) + "\n"); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type State = { contract?: string; uploaded?: boolean; initDone?: boolean; genesis?: number; funded?: boolean; gamesProposed?: boolean;
  gamesApplied?: boolean; staked?: boolean; earlyClosed?: boolean; m: Record<string, { rc: string; note: string }>; done?: boolean };

export async function testnetV6(args: string[]) {
  fs.mkdirSync(DIR, { recursive: true });
  const provider = new Provider([RPC]);
  const cid: any = await provider.call("chain.get_chain_id", {});
  if (cid?.chain_id !== CHAIN_ID) throw new Error(`${RPC} is not the Koinos Foundation testnet (chain id ${cid?.chain_id}). Stopping.`);

  // ── keys: throwaway, testnet only ──
  let keys = readJ("keys.json", null);
  if (!keys) {
    const rnd = () => utils.toHexString(crypto.randomBytes(32));
    keys = { note: "TESTNET ONLY: throwaway keys for npm run bot -- testnet-v6. Worthless; never use them on mainnet.",
      funder: Signer.fromSeed(rnd()).getPrivateKey("wif", true), contract: Signer.fromSeed(rnd()).getPrivateKey("wif", true), playerSeed: rnd() };
    writeJ("keys.json", keys);
  }
  const funder = Signer.fromWif(keys.funder), contractKey = Signer.fromWif(keys.contract);
  funder.provider = provider; contractKey.provider = provider;
  const players = Array.from({ length: PLAYERS }, (_, i) => { const s = Signer.fromSeed(`${keys.playerSeed} player ${i}`); s.provider = provider; return s; });
  const koin = new Contract({ id: KOIN, abi: tokenAbi as any, provider });
  const bal = async (a: string) => BigInt(((await (koin.functions as any).balance_of({ owner: a })).result?.value) ?? 0);
  const fBal = await bal(funder.getAddress()), fMana = BigInt(await provider.getAccountRc(funder.getAddress()));
  const st: State = readJ("state.json", { m: {} });
  const save = () => writeJ("state.json", st);

  log(`Testnet         ${RPC}`);
  log(`Funder wallet   ${funder.getAddress()}   holds ${showKoin(fBal)} test KOIN (Mana ${showKoin(fMana)})`);
  log(`Vault (test)    ${contractKey.getAddress()}${st.uploaded ? "" : "  (not deployed yet)"}`);
  if (args[0] === "status") { log(JSON.stringify(st, null, 2)); return; }
  if (st.done) { log("This run is finished; its report is testnet-v6/report.md. Delete the testnet-v6 folder to run it again from scratch."); return; }
  if (!st.uploaded && fBal < NEED) {
    log(`\nThe funder needs about ${showKoin(NEED)} test KOIN (has ${showKoin(fBal)}). In Telegram, send this to ${FAUCET}:`);
    log(`  /faucet ${funder.getAddress()}`);
    log(`Repeat if needed (the faucet may limit how often), then run this command again.`);
    return;
  }

  // ── the build: exactly the audited normal build ──
  if (!fs.existsSync(WASM)) throw new Error(`${WASM} not found: in the game folder run npm test (it builds), then try again.`);
  const wasm = fs.readFileSync(WASM);
  const sha = crypto.createHash("sha256").update(wasm).digest("hex");
  if (sha !== NORMAL_SHA) throw new Error(`${WASM} is ${sha}, not the audited normal build ${NORMAL_SHA}. Run: git checkout vault-v6, then cd game; npm test; cd ..`);
  const C = contractKey.getAddress();
  const chain = new KoinosChain(RPC, C);
  const chainTime = async () => Number(((await provider.getHeadInfo()) as any).head_block_time);
  const waitUntil = async (t: number, what: string) => {
    for (;;) {
      const now = await chainTime();
      if (now >= t) return;
      log(`  … waiting ${Math.ceil((t - now) / 1000)} s for ${what}`);
      await sleep(Math.min(60_000, t - now + 3000));
    }
  };
  const send = async (who: Signer, calls: any[], what: string, rcLimitKoin = 5) => {
    const r = await chain.send(calls, [who], { rcLimitKoin });
    if (!r.ok) throw new Error(`${what} failed: ${r.error}`);
    return r;
  };
  const measure = async (key: string, who: Signer, calls: any[], note: string, rcLimitKoin = 10) => {
    if (st.m[key]) return;
    const r = await send(who, calls, key, rcLimitKoin);
    st.m[key] = { rc: String(r.rcUsed ?? "0"), note }; save();
    log(`  measured ${key}: ${showKoin(r.rcUsed)} Mana`);
  };
  const transfer = (to: string, value: bigint) => ({ contract: KOIN, abi: tokenAbi, method: "transfer", args: { from: funder.getAddress(), to, value: String(value) } });
  const approve = (owner: string, value: bigint) => ({ contract: KOIN, abi: tokenAbi, method: "approve", args: { owner, spender: C, value: String(value) } });
  const stake = (p: Signer, game: number) => [approve(p.getAddress(), VHP), { method: "deposit_to", args: { from: p.getAddress(), game, amount: String(VHP), koin: true } }];

  // ── 1. upload and init ──
  if (!st.uploaded) {
    log("\n1. Uploading a fresh Vault to the testnet (the funder pays, the vault's own key authorizes) …");
    const abi = loadAbi();
    const c = new Contract({ id: C, abi, provider, signer: contractKey, bytecode: new Uint8Array(wasm) });
    const { operation } = await c.deploy({ abi: JSON.stringify(abi), authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true, onlyOperation: true } as any);
    const mana = BigInt(await provider.getAccountRc(funder.getAddress()));
    const limit = (mana * 9n) / 10n < toSat(60) ? (mana * 9n) / 10n : toSat(60);
    const tx = new Transaction({ signer: funder, provider, options: { payer: funder.getAddress(), payee: funder.getAddress(), rcLimit: limit.toString() } });
    await tx.pushOperation(operation);
    await tx.prepare();
    let t: any = tx.transaction;
    t = await funder.signTransaction(t);
    t = await contractKey.signTransaction(t);
    const { receipt, transaction } = await provider.sendTransaction(t);
    if ((receipt as any)?.reverted) throw new Error(`upload reverted: ${JSON.stringify((receipt as any).logs)}`);
    await transaction.wait("byBlock", 300_000);
    st.uploaded = true; st.contract = C;
    st.m.upload = { rc: String((receipt as any).rc_used ?? 0), note: `uploading the ${(wasm.length / 1024).toFixed(1)} KB contract` }; save();
    log(`  uploaded (Mana ${showKoin((receipt as any).rc_used)})`);
  }
  if (!st.initDone) {
    const genesis = Math.ceil(((await chainTime()) + 8 * MIN) / MIN) * MIN;   // week 0 starts in about 8 minutes
    const init = { owner: funder.getAddress(), operator: funder.getAddress(), seed_owner: funder.getAddress(), genesis_time: String(genesis),
      week_length: String(WEEK), close_delay: String(CLOSE), settle_length: String(SETTLE), timelock_length: String(LOCK), min_stake: String(VHP), max_sponsor_rc: "0" };
    const r = await chain.send([{ method: "init", args: init }], [funder, contractKey], { rcLimitKoin: 5 });
    if (!r.ok) throw new Error(`init failed: ${r.error}`);
    st.initDone = true; st.genesis = genesis; save();
    log(`  initialised: 10-minute weeks from ${new Date(genesis).toISOString()}`);
  }
  const weekEnd = (w: number) => st.genesis! + (w + 1) * WEEK;

  // ── 2. money: the vault's own Mana and the players' test KOIN ──
  if (!st.funded) {
    log("\n2. Sending test KOIN to the vault (its Mana) and to 20 test players …");
    await send(funder, [transfer(C, TO_CONTRACT)], "fund the vault");
    for (let i = 0; i < PLAYERS; i += 4)
      await send(funder, players.slice(i, i + 4).map((p, j) => transfer(p.getAddress(), i + j === PLAYERS - 1 ? LAST_PLAYER : PER_PLAYER)), `fund players ${i}-${i + 3}`);
    st.funded = true; save();
  }

  // ── 3. thirteen games ──
  if (!st.gamesProposed) {
    log("\n3. Announcing games 2 to 13 (staked + free prize; game 3 with 2-week seasons) …");
    const calls = [];
    for (let id = 2; id <= 13; id++) calls.push({ method: "propose_game", args: { game: id, name: `Test game ${id}`, staked: true, free_prize: true, season_weeks: id === 3 ? 2 : 1 } });
    for (let i = 0; i < calls.length; i += 6) await send(funder, calls.slice(i, i + 6), "propose games");
    st.gamesProposed = true; save();
  }
  if (!st.gamesApplied) {
    const eta = Math.max(...((await chain.read("list_games", {})).proposals ?? []).map((p: any) => Number(p.eta ?? 0)));
    await waitUntil(eta + 5000, "the games' 2-minute notice");
    const calls = [];
    for (let id = 2; id <= 13; id++) calls.push({ method: "apply_game", args: { game: id } });
    for (let i = 0; i < calls.length; i += 6) await send(funder, calls.slice(i, i + 6), "apply games");
    st.gamesApplied = true; save();
  }
  const games = (await chain.read("list_games", {})).games ?? [];
  const T = Math.max(...games.map((g: any) => Number(g.from_week ?? 0)));   // the first week every game earns
  const W = String(T);

  // ── 4. stakes (KOIN, burned into VHP by the vault) ──
  if (!st.staked) {
    log("\n4. 19 players stake 1 test KOIN each (16 in game 13, the rest spread over games 2–12) …");
    for (let i = 0; i < PLAYERS - 1; i++) {   // the last player stakes later: its deposit is the one that closes the week
      const game = i < IN_13 ? 13 : 2 + ((i - IN_13) * 4) % 11;
      if (i === 0) await measure("deposit", players[i], stake(players[i], game), "a stake in another game (deposit_to, KOIN)", 1.5);
      else await send(players[i], stake(players[i], game), `player ${i} stake`, 1.5);
    }
    st.staked = true; save();
  }

  // ── 5. the earlier weeks close (not every game earns yet); week T is measured, with all 13 earning ──
  if (!st.earlyClosed) {
    for (let w = Number((await chain.read("get_state", {})).totals?.weeks_closed ?? 0); w < T; w++) {
      await waitUntil(weekEnd(w) + CLOSE + 5000, `week ${w} to end and its close time`);
      await send(funder, [{ method: "close_week", args: { week: String(w) } }], `close week ${w}`, 10);
    }
    await send(funder, [transfer(C, REWARDS)], "stand-in block rewards for the measured week");
    st.earlyClosed = true; save();
  }
  log(`\n5. Week ${T} is the measured week: all 13 games earn.`);
  await waitUntil(weekEnd(T) + CLOSE + 5000, `week ${T} to end`);
  // The heaviest player call: a deposit that has to close week T first (advance) — measured before anything else closes it.
  const closed = Number((await chain.read("get_state", {})).totals?.weeks_closed ?? 0);
  if (!st.m.close13 && closed <= T) {
    const p = players[PLAYERS - 1];
    await measure("close13", p, stake(p, 13), "a player's deposit that first closes a week with 13 games (advance → closeV6)", 10);
  } else if (!st.m.close13) log("  (the measured week was already closed; the 13-game close was not measured)");

  // ── 6. game 13's results, the seal, finalizing, a claim, a withdrawal ──
  const rows = players.slice(0, IN_13).map((p, i) => ({ player: p.getAddress(), points: 1 + (i % 7) * 30 }));
  await measure("post16", funder, [{ method: "post_results", args: { game: 13, week: W, rows } }], "posting 16 result rows for one game");
  await measure("seal", funder, [{ method: "seal_results", args: { game: 13, week: W } }], "sealing game 13's week");
  const gw = (await chain.read("get_game", { game: 13, week: W })).week ?? {};
  await waitUntil(Number(gw.seal_time ?? 0) + 2 * CLOSE + 5000, "the 4-minute correction window after the seal");
  await measure("finalize16", funder, [{ method: "finalize_game_week", args: { game: 13, week: W } }], "finalizing game 13's week (16 players)", 10);
  const winner = players[6];   // points 1 + 6 × 30 = 181, among the top 30%
  await measure("claim", winner, [{ method: "claim_game", args: { player: winner.getAddress(), game: 13, week: W } }], "a winner's claim in another game", 1.5)
    .catch((e) => log(`  (claim not measured: ${(e as Error).message.slice(0, 160)})`));
  const w = players[1];
  await measure("withdraw", w, [{ method: "withdraw_from", args: { to: w.getAddress(), game: 13, amount: String(VHP) } }], "a full withdrawal from another game (withdraw_from)", 1.5);

  // ── 7. the chain's key order (V2-14) ──
  const listed: string[] = [];
  let start = "";
  for (;;) {
    const page = (await chain.read("list_players", { limit: 50, week: W, ...(start ? { start } : {}) })).rows ?? [];
    listed.push(...page.map((r: any) => r.address));
    if (page.length < 50) break;
    start = page[page.length - 1].address;
  }
  const hex = listed.map((a) => Buffer.from(utils.decodeBase58(a)).toString("hex"));
  const inOrder = hex.every((h, i) => i === 0 || hex[i - 1] < h);
  const highBytes = listed.filter((a) => [...utils.decodeBase58(a)].slice(1, 6).some((b) => b >= 0x80)).length;

  // ── report ──
  const rowsOut = Object.entries(st.m).map(([k, v]) => `| ${k} | ${showKoin(v.rc)} | ${v.note} |`).join("\n");
  const close13 = BigInt(st.m.close13?.rc ?? "0"), post16 = BigInt(st.m.post16?.rc ?? "0"), fin16 = BigInt(st.m.finalize16?.rc ?? "0");
  const report = `# Vault v6 testnet check (${new Date().toISOString()})

Koinos Foundation testnet, a fresh Vault at \`${C}\` (build \`${NORMAL_SHA.slice(0, 16)}…\`), 13 games, ${PLAYERS} test players, measured week ${T}.

## Mana used (KOIN), measured on chain
| Call | Mana | What |
|---|---|---|
${rowsOut}

- 50 result rows (the most per call): at most about ${showKoin((post16 * 50n) / 16n)} (16 rows scaled up; the fixed part of a call isn't per row, so this is an upper bound).
- A 500-place finalize page: at most about ${showKoin((fin16 * 500n) / 16n)} (16 places scaled up, the same kind of upper bound).
- The heaviest player call measured: ${showKoin(close13)} (a deposit that first closes a 13-game week). The bot closes weeks itself every hour, so players rarely pay it.

## Key order (audit V2-14)
list_players returned ${listed.length} players (${highBytes} with a high byte near the front of the address): **${inOrder ? "in byte order, as the simulator and the tests assume" : "NOT in byte order: send this report to the Vault chat"}**.
`;
  fs.writeFileSync(file("report.md"), report);
  st.done = true; save();
  log("\n" + report);
  log(`Saved ${file("report.md")}. Send it to the Vault chat.`);
}
