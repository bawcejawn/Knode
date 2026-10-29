// RepoLens fix-check 3 (V3-3, V3-4): with the withdrawals-only build live (get_state.safe_mode), the hourly bot sends
// none of the calls that build refuses (closes, finalizing, new questions) and raises no "overdue to close" alarm.
// The same world in normal mode does both, so the test can tell the two apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { tick, paths, DAY_MS } from "../../bot/bot.ts";

const op = Signer.fromSeed("safe-mode-test-only");
const VHP = 100_000_000n;
const REFUSED = ["deposit_vhp", "deposit_koin", "deposit_to", "move_stake", "answer", "post_question", "close_week", "finalize_week",
  "finalize_game_week", "set_min_stake", "seed_deposit_vhp", "seed_deposit_koin", "propose_game", "apply_game"];

/** Week 0 closed and past its settle window (finalizing due); week 1 over for 30 h and not closed (closing due). */
function world(safe: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  const genesis = 1_700_000_000_000, time = genesis + 14 * DAY_MS + 30 * 3_600_000, height = 10_000_000;
  const sent: any[] = [];
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height, lib: height - 60 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: String(height), time: String(time), safe_mode: safe,
        config: { owner: "1Owner", operator: "1Op", genesis_time: String(genesis), week_length: String(7 * DAY_MS), close_delay: "43200000", min_stake: String(VHP) },
        totals: { weeks_closed: "1", weeks_finalized: "0", next_question_id: 0 }, koin_balance: "0" };
      if (method === "get_week") return { week: args.week === "0"
        ? { closed: true, questions: 0, resolved: 0, settle_start: String(genesis + 7 * DAY_MS), settle_end: String(genesis + 8 * DAY_MS) }
        : { questions: 0, resolved: 0 } };
      if (method === "list_players") return { rows: [] };
      return {};
    },
    async send(calls: any[]) { sent.push(...calls); return { ok: true }; },
  };
  const ctx = { chain, operator: op, P, dryRun: false, problems: [] as string[], generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true } as any;
  return { sent, ctx };
}

test("normal build: the same world closes and finalizes (so the safe-mode test below means something)", async () => {
  const w = world(false);
  await tick(w.ctx);
  const methods = w.sent.map((c) => c.method);
  assert.ok(methods.includes("close_week") || methods.includes("finalize_week"), `expected a close or finalize: ${methods.join(", ")}`);
});

test("withdrawals-only build: the hourly bot sends no refused call and raises no overdue-close alarm", async () => {
  const w = world(true);
  await tick(w.ctx);
  const bad = w.sent.map((c) => c.method).filter((m) => REFUSED.includes(m));
  assert.deepEqual(bad, [], "calls the safe build always refuses");
  assert.ok(!w.ctx.problems.some((p: string) => /overdue to close|admin key may be compromised/.test(p)), w.ctx.problems.join(" | "));
});
