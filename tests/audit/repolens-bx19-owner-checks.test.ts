// Repo Lens audit 2026-10-28 (commit 611f63d): the auditor's tests, kept as written except where noted. Each failed
// before the fixes. Two wait for owner decisions (todo): BXW-1 guest play on the shared github.io origin, BXS-1 sybils.
// BXO-2 — NOT RUN HERE (static review). node:test via `node --import tsx --test`.
// Fails today: announce/apply/pause sign with OWNER_WIF for whatever address picks-data/deployment.json (mainnet) or
// testnet/blockx.json names, without first checking that address's on-chain code hash and flags. Expects a helper
// (suggested name: assertAuditedContract) that the send paths call before signing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("every owner-signed command checks the target's code hash before signing", () => {
  const src = fs.readFileSync("bot/picks.ts", "utf8");
  for (const fn of ["announce", "apply", "pause"]) {
    const body = src.slice(src.indexOf(`async function ${fn}(`), src.indexOf("\n}\n", src.indexOf(`async function ${fn}(`)));
    assert.match(body, /contractMetadata\(|assertAuditedContract\(/, `${fn} signs for net.picks without checking its code on chain`);
  }
});

// Added with the fix: assertAuditedContract refuses a missing contract, another build, or overrides off.
import { assertAuditedContract, PICKS_SHA256 } from "../../bot/picks.ts";
test("assertAuditedContract: the expected build with all three overrides, or nothing is signed", async () => {
  const net = { testnet: false, picks: "1P" };
  const meta = (m: any) => async () => m;
  await assertAuditedContract(net, {} as any, meta({ exists: true, hash: "0x1220" + PICKS_SHA256, call: true, tx: true, upload: true }) as any);
  await assert.rejects(assertAuditedContract(net, {} as any, meta({ exists: false }) as any), /no contract on chain/);
  await assert.rejects(assertAuditedContract(net, {} as any, meta({ exists: true, hash: "0x1220" + "00".repeat(32), call: true, tx: true, upload: true }) as any), /not the expected Picks build/);
  await assert.rejects(assertAuditedContract(net, {} as any, meta({ exists: true, hash: "0x1220" + PICKS_SHA256, call: true, tx: false, upload: true }) as any), /overrides/);
});
