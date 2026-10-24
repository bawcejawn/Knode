/**
 * Desk upgrade v1 → v2: the new code must read everything the live desk stored, exactly as it was written, and keep
 * working; the swap happens through the live code's own authorize(contract_upload), as on chain.
 *
 * test-fixtures/desk-v1-test-build.wasm is the TEST build of the live desk (its release build is the live sha256
 * 05039d74…, desk-data/deployment.json). Run after `npm run build:sim` in desk/, from the repo root:
 *   node --import tsx --test desk/scripts/storage-compat.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { Signer } from "koilib";
import { SimChain } from "../../bot/chain.ts";

const OLD = "desk/test-fixtures/desk-v1-test-build.wasm";
const NEW = "desk/build/sim/contract.wasm";
const ABI = JSON.parse(fs.readFileSync("desk/abi/desk.koilib.json", "utf8"));
const VHP = 100_000_000n;
const HOUR = 3_600_000, DAY = 24 * HOUR, T0 = 1_800_000_000_000;
const TIMELOCK = 2 * DAY;
const key = (s: string) => Signer.fromSeed(`desk-compat ${s}`).getAddress();
const [DESK, OWNER, TREASURY, A, B, NEXT] = ["desk", "owner", "treasury", "A", "B", "next"].map(key);
const NEW_FIELDS = new Set(["daily_cap", "day_start", "day_out", "owner_change", "pending", "swap_left_today",
  "has_fee", "fee_bps", "has_cap", "public_key", "eta"]);
const isDefault = (v: any) => v === undefined || v === null || v === false || v === 0 || v === "0" || v === "" || v === "0x" ||
  (typeof v === "object" && Object.values(v).every(isDefault));
const sha = (f: string) => "0x" + crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function sameAsBefore(before: any, after: any, where: string) {
  if (before === null || typeof before !== "object") { assert.deepEqual(after, before, where); return; }
  for (const k of Object.keys(before)) {
    if (k === "time") continue;
    sameAsBefore(before[k], after?.[k], `${where}.${k}`);
  }
  for (const k of Object.keys(after ?? {})) {
    if (k in before) continue;
    assert.ok(NEW_FIELDS.has(k), `${where}.${k}: a field the live code never returned`);
    assert.ok(isDefault(after[k]), `${where}.${k} should read as its default, got ${JSON.stringify(after[k])}`);
  }
}

async function liveDesk() {
  const sim = new SimChain(DESK, OLD, ABI);
  await sim.init();
  sim.setHeight(1000, T0);
  const ok = async (method: string, args: any, who: string[]) => {
    const r = await sim.sendAs([{ method, args }], who);
    assert.ok(r.ok, `${method}: ${r.error}`);
  };
  await ok("init", { owner: OWNER, treasury: TREASURY, fee_bps: 300, min_swap: String(VHP), max_swap: "0", timelock_length: String(TIMELOCK) }, [DESK]);
  await sim.ledgerSet(1, DESK, 1000n * VHP); await sim.ledgerSet(3, DESK, 1000n * VHP); await sim.ledgerSet(2, DESK, 5000n * VHP);
  for (const p of [A, B]) await sim.ledgerSet(2, p, 1000n * VHP);
  const swap = async (who: string, n: bigint) => { await sim.ledgerSet(4, who, n * VHP); await ok("swap", { from: who, vhp_amount: String(n * VHP), min_koin_out: "0" }, [who]); };
  return { sim, ok, swap };
}

test("desk v1 → v2: stored data reads back unchanged, the upload goes through authorize, and v2 keeps working", { skip: !fs.existsSync(NEW) && `${NEW} missing: run npm run build:sim in desk/` }, async () => {
  const { sim, ok, swap } = await liveDesk();
  await swap(A, 100n); await swap(B, 50n);
  await ok("set_limits", { min_swap: String(VHP), max_swap: String(500n * VHP) }, [OWNER]);
  await ok("schedule_treasury", { treasury: NEXT }, [OWNER]);
  await ok("schedule_upgrade", { hash: sha(NEW) }, [OWNER]);
  const views = async () => ({ state: await sim.read("get_state", {}), recent: await sim.read("get_recent", {}) });
  const before = await views();

  sim.setHeight(1000 + 60_000, T0 + TIMELOCK + HOUR);
  assert.equal(await sim.uploadAuthorized(NEW, [A]), false, "only the owner can upload");
  assert.equal(await sim.uploadAuthorized(NEW, [OWNER], { call: true, tx: false, upload: true }), false, "a switch off is refused");
  assert.equal(await sim.uploadAuthorized(NEW, [OWNER]), true, "owner-authorized upload of the announced code");
  const after = await views();
  sameAsBefore(before, after, "view");

  // v2 keeps working: the announced treasury change still applies, swaps work, the cap and owner change are new.
  await ok("apply_treasury", {}, [OWNER]);
  assert.equal((await sim.read("get_state", {})).config.treasury, NEXT);
  await swap(A, 10n);
  await ok("set_daily_cap", { daily_cap: String(20n * VHP) }, [OWNER]);
  await sim.ledgerSet(4, B, 30n * VHP);
  assert.equal((await sim.sendAs([{ method: "swap", args: { from: B, vhp_amount: String(30n * VHP), min_koin_out: "0" } }], [B])).ok, false, "the daily cap stops a large swap");
  await ok("propose_owner", { new_owner: NEXT }, [OWNER]);
  sim.setHeight(1000 + 120_000, sim.time + TIMELOCK);
  await ok("accept_owner", {}, [NEXT]);
  assert.equal((await sim.read("get_state", {})).config.owner, NEXT);
  // Books: every VHP and KOIN is accounted for (swaps moved exactly vhp_in in and koin_out out).
  const s = await sim.read("get_state", {});
  assert.equal(BigInt(s.vhp_balance), 5000n * VHP + BigInt(s.totals.vhp_in));
  assert.equal(BigInt(s.koin_balance), 1000n * VHP - BigInt(s.totals.koin_out));
});

test("rollback desk v2 → v1 is authorized by v2 and keeps the books; v2-only settings are dropped", { skip: !fs.existsSync(NEW) && `${NEW} missing` }, async () => {
  const sim = new SimChain(DESK, NEW, ABI);
  await sim.init();
  sim.setHeight(1000, T0);
  const ok = async (method: string, args: any, who: string[]) => { const r = await sim.sendAs([{ method, args }], who); assert.ok(r.ok, `${method}: ${r.error}`); };
  await ok("init", { owner: OWNER, treasury: TREASURY, fee_bps: 300, min_swap: String(VHP), max_swap: "0", timelock_length: String(TIMELOCK) }, [DESK]);
  await sim.ledgerSet(1, DESK, 1000n * VHP); await sim.ledgerSet(3, DESK, 1000n * VHP); await sim.ledgerSet(2, A, 100n * VHP);
  await ok("set_daily_cap", { daily_cap: String(50n * VHP) }, [OWNER]);
  await ok("schedule_upgrade", { hash: sha(OLD) }, [OWNER]);
  sim.setHeight(2000, T0 + TIMELOCK);
  assert.equal(await sim.uploadAuthorized(OLD, [OWNER]), true);
  const s = await sim.read("get_state", {});
  assert.equal(s.config.fee_bps, 300);
  assert.equal(BigInt(s.koin_balance), 1000n * VHP);
  // the v1 code ignores the cap: a swap above it goes through (documented loss of a rollback)
  await sim.ledgerSet(4, A, 60n * VHP);
  await ok("swap", { from: A, vhp_amount: String(60n * VHP), min_koin_out: "0" }, [A]);
});
