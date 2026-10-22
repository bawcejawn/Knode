// Proof test (audit fix check, AB-023): when the contract declines to sponsor settles, the bot's own cap must not leave
// staked players unsettled at the deadline; if some still are, the run reports it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { tick, paths } from "../../bot/bot.ts";

const WEEK = 7 * 86_400_000, GENESIS = 1_792_368_000_000, HOUR = 3_600_000;

test("SAB-SETTLE-1: when the contract declines to sponsor, the last run before settle_end still settles every staked player", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sab-settle-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  const settleStart = GENESIS + WEEK + 12 * HOUR, settleEnd = settleStart + 24 * HOUR;
  const now = settleEnd - 30 * 60_000;                      // 30 minutes left: the next hourly run is too late
  // 15 sybils whose addresses sort first, then 10 honest players. All staked at exactly min_stake, all unsettled.
  const players = [
    ...Array.from({ length: 15 }, (_, i) => `11111Sybil${String(i).padStart(2, "0")}`),
    ...Array.from({ length: 10 }, (_, i) => `1zHonest${String(i).padStart(2, "0")}`),
  ];
  const settled = new Set<string>();
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height: 50_000_000, lib: 49_999_900 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: "50000000", time: String(now),
        config: { owner: "1Owner", operator: "1Op", genesis_time: String(GENESIS), week_length: String(WEEK), close_delay: "43200000", min_stake: "100000000" },
        totals: { weeks_closed: "1", weeks_finalized: "0", next_question_id: 0 }, koin_balance: "0" };
      if (method === "get_week") {
        if (Number(args.week) === 0) return { week: { closed: true, finalized: false, settle_start: String(settleStart), settle_end: String(settleEnd), questions: 6, resolved: 6 } };
        return { week: { questions: 0, resolved: 0 } };
      }
      if (method === "get_question") return { question: undefined };
      if (method === "list_players") {
        if (args.start) return { rows: [] };
        return { rows: players.map((a) => ({ address: a, entry: { stake: "100000000", settled: settled.has(a) } })) };
      }
      return {};
    },
    async send(calls: any[], _signers: any[], opts: any = {}) {
      // Contract Mana is low: every sponsored transaction is refused (rc_limit below the sponsorship floor).
      if (opts.sponsored) return { ok: false, error: "transaction payer (contract) refused: authorize returned false" };
      for (const c of calls) if (c.method === "settle") settled.add(c.args.player);
      return { ok: true };
    },
  };
  const ctx: any = { chain, operator: Signer.fromSeed("sab-settle-test-only"), P, dryRun: false, problems: [] as string[],
    generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true };
  await tick(ctx);
  const honestLeft = players.filter((a) => a.startsWith("1zHonest") && !settled.has(a));
  assert.equal(honestLeft.length, 0,
    `SAB-SETTLE-1: ${honestLeft.length} honest staked player(s) left unsettled on the last run before settle_end (${settled.size}/${players.length} settled); they will be ineligible and lose their payout`);
  assert.equal(settled.size, players.length, "SAB-SETTLE-1: every staked player is settled before the window closes");
});

test("in the last hours, staked players the bot could not settle are reported (largest stakes are settled first)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settle-alert-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  const settleStart = GENESIS + WEEK + 12 * HOUR, settleEnd = settleStart + 24 * HOUR;
  const players = [{ a: "1Small", s: "100000000" }, { a: "1Big", s: "900000000" }, { a: "1Mid", s: "500000000" }];
  const order: string[] = [];
  let now = settleEnd - 10 * HOUR, budget = 1;              // the bot can pay for one settle, then its sends fail
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height: 50_000_000, lib: 49_999_900 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: "50000000", time: String(now),
        config: { owner: "1Owner", operator: "1Op", genesis_time: String(GENESIS), week_length: String(WEEK), close_delay: "43200000", min_stake: "100000000" },
        totals: { weeks_closed: "1", weeks_finalized: "0", next_question_id: 0 }, koin_balance: "0" };
      if (method === "get_week") return Number(args.week) === 0 ? { week: { closed: true, finalized: false, settle_start: String(settleStart), settle_end: String(settleEnd) } } : { week: {} };
      if (method === "list_players") return args.start ? { rows: [] } : { rows: players.map((p) => ({ address: p.a, entry: { stake: p.s, settled: order.includes(p.a) } })) };
      return {};
    },
    async send(calls: any[], _s: any[], opts: any = {}) {
      if (opts.sponsored) return { ok: false, error: "declined" };
      if (budget-- <= 0) return { ok: false, error: "not enough Mana" };
      for (const c of calls) if (c.method === "settle") order.push(c.args.player);
      return { ok: true };
    },
  };
  const ctx = (): any => ({ chain, operator: Signer.fromSeed("settle-alert-test-only"), P, dryRun: false, problems: [] as string[],
    generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true });
  const early = ctx();
  await tick(early);
  assert.deepEqual(order, ["1Big"], "largest stake first");
  assert.ok(!early.problems.some((p: string) => /still not settled/.test(p)), "no deadline alert 10 hours before the end");
  now = settleEnd - 2 * HOUR;
  const late = ctx();
  await tick(late);
  assert.ok(late.problems.some((p: string) => /Week 0: 2 staked player\(s\) are still not settled/.test(p)), late.problems.join(" | "));
});
