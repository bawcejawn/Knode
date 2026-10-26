// Audit v5 (2026-10-26, commit 2ea29e8) fixes: bot side.
//   M-1  low-score free wallets settled early by someone else don't use up the bot's free-settle budget
//   L-4  a player who held the minimum stake this week is never treated as a free player by the bot
//   M-5  owner / seed / desk commands sign only for the pinned contracts and tokens on mainnet
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { tick, paths, pinDeployment, PINNED_MAINNET, DAY_MS } from "../../bot/bot.ts";

const op = Signer.fromSeed("audit-v5-test-only");
const VHP = 100_000_000n;
const addr = (s: string) => Signer.fromSeed(`v5 ${s}`).getAddress();

/** Week 0 is closed and in its settle window; question 0 and 1 resolved to option A (outcome 1). */
function world(rows: any[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v5a-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  const genesis = 1_700_000_000_000, time = genesis + 7 * DAY_MS + 30 * 3_600_000, height = 10_000_000;
  const sent: any[] = [];
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height, lib: height - 60 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: String(height), time: String(time),
        config: { owner: "1Owner", operator: "1Op", genesis_time: String(genesis), week_length: String(7 * DAY_MS), close_delay: "43200000", min_stake: String(VHP) },
        totals: { weeks_closed: "1", weeks_finalized: "0", next_question_id: 3 }, koin_balance: "0" };
      if (method === "get_week") return { week: args.week === "0"
        ? { questions: 3, resolved: 3, reward_rule: true, settle_start: String(time - 3_600_000), settle_end: String(time + DAY_MS), free_best: 1, free_best_n: rows.filter((r) => r.entry.settled).length }
        : { questions: 0, resolved: 0 } };
      if (method === "get_question") return { question: { week: "0", outcome: 1, k: 2 } };
      if (method === "list_players") return { rows: args.start ? [] : rows };
      return {};
    },
    async send(calls: any[]) { sent.push(...calls); return { ok: true }; },
  };
  const ctx = () => ({ chain, operator: op, P, dryRun: false, problems: [] as string[], generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true } as any);
  return { sent, ctx };
}
const answers = (right: number, n = 3) => Array.from({ length: n }, (_, i) => ({ question_id: i, option: i < right ? 0 : 1 }));

test("M-1: 20 one-point free wallets settled early don't stop the bot settling the best free players", async () => {
  const sybils = Array.from({ length: 20 }, (_, i) => ({ address: addr(`sybil ${i}`), entry: { stake: "0", settled: true, free_player: true, points: 1, counted: 3, answers: answers(1) } }));
  const best = { address: addr("best"), entry: { stake: "0", settled: false, answers: answers(3) } };
  const second = { address: addr("second"), entry: { stake: "0", settled: false, answers: answers(2) } };
  const w = world([...sybils, best, second]);
  await tick(w.ctx());
  const settled = w.sent.filter((c) => c.method === "settle").map((c) => c.args.player);
  assert.ok(settled.includes(best.address), "the best free player (3 points) must be settled");
  assert.ok(settled.includes(second.address), "the second free player (2 points) must be settled");
});

test("L-4: a player who held the minimum stake this week and withdrew below it is not settled as a free player", async () => {
  const dropped = { address: addr("dropped"), entry: { stake: String(VHP / 2n), peak_stake: String(10n * VHP), settled: false, answers: answers(3) } };
  const free = { address: addr("free"), entry: { stake: "0", settled: false, answers: answers(2) } };
  const w = world([dropped, free]);
  await tick(w.ctx());
  const settled = w.sent.filter((c) => c.method === "settle").map((c) => c.args.player);
  assert.ok(!settled.includes(dropped.address), "a staked-then-dropped player is not a free-prize candidate");
  assert.ok(settled.includes(free.address));
});

test("M-5: on mainnet a deployment file naming another contract or token is refused before anything is signed", () => {
  const good = { contract: PINNED_MAINNET.game, koin: PINNED_MAINNET.koin, vhp: PINNED_MAINNET.vhp, pob: PINNED_MAINNET.pob };
  assert.doesNotThrow(() => pinDeployment("game", { ...good }, "https://api.koinos.io", "x"));
  assert.throws(() => pinDeployment("game", { ...good, contract: "1AttackerContractXXXXXXXXXXXXXXXXX" }, "https://api.koinos.io", "x"), /not 1Mpmf2/);
  assert.throws(() => pinDeployment("game", { ...good, vhp: "1AttackerTokenXXXXXXXXXXXXXXXXXXXX" }, "https://api.koinos.io", "x"), /Refusing to sign/);
  assert.throws(() => pinDeployment("desk", { contract: PINNED_MAINNET.game }, "https://api.koinos.io", "x"), /desk contract/);
  const filled = pinDeployment("desk", { contract: PINNED_MAINNET.desk }, "https://api.koinos.io", "x");
  assert.equal(filled.koin, PINNED_MAINNET.koin);
});
