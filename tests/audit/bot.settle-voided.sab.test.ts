// Red-team SABOTEUR (fix check 1dbc129): settle ordering (largest stake first) + uncapped bot-paid settles in the last
// 3 hours before settle_end.
// Attack: sybils deposit a large stake in week w−1, answer one question in week w (sponsored), then withdraw EVERYTHING
// in week w. Their entries are voided (Kpred.withdraw sets e.voided, keeps e.stake = stake at the start of the week), so
// they can never earn anything and the contract refuses to sponsor their settle (sponsorOk: se.voided). The bot's
// "unsettled" filter (bot.ts settlePass) does not look at entry.voided: it sorts them FIRST (largest stake) and pays
// their settles itself. The capital comes back at once (withdrawn), so it can be reused every week.
// Each test asserts the SAFE behaviour and FAILS on the current code.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { tick, paths } from "../../bot/bot.ts";

const WEEK = 7 * 86_400_000, GENESIS = 1_792_368_000_000, HOUR = 3_600_000;
const settleStart = GENESIS + WEEK + 12 * HOUR, settleEnd = settleStart + 24 * HOUR;

type Row = { a: string; stake: string; voided: boolean };
const SYBILS: Row[] = Array.from({ length: 12 }, (_, i) => ({ a: `1SybilVoided${String(i).padStart(2, "0")}`, stake: "500000000", voided: true }));   // 5 VHP each
const HONEST: Row[] = Array.from({ length: 5 }, (_, i) => ({ a: `1Honest${String(i).padStart(2, "0")}`, stake: "100000000", voided: false }));        // 1 VHP each

/** Fake chain, built like tests/audit/bot.settle-cap.test.ts. `sponsorRule` decides what the contract agrees to pay for;
 *  `budget` is how many settles the bot's own Mana can pay for. */
function world(now: number, sponsorRule: (r: Row) => boolean, budget = Infinity) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sab2-settle-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  const players = [...HONEST, ...SYBILS];
  const settled = new Set<string>(), botPaid: string[] = [];
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
        return { rows: players.map((p) => ({ address: p.a, entry: { stake: p.stake, settled: settled.has(p.a), voided: p.voided } })) };
      }
      return {};
    },
    async send(calls: any[], _s: any[], opts: any = {}) {
      const c = calls[0];
      const row = players.find((p) => p.a === c?.args?.player);
      if (opts.sponsored) {
        if (!row || !sponsorRule(row)) return { ok: false, error: "transaction payer (contract) refused: authorize returned false" };
        settled.add(row.a);
        return { ok: true };
      }
      if (budget <= 0) return { ok: false, error: "insufficient rc (bot Mana exhausted)" };
      budget--;
      if (row) { settled.add(row.a); botPaid.push(row.a); }   // Kpred.settle accepts a voided entry (settleCheck ignores voided)
      return { ok: true };
    },
  };
  const ctx: any = { chain, operator: Signer.fromSeed("sab2-settle-test-only"), P, dryRun: false, problems: [] as string[],
    generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true };
  return { ctx, settled, botPaid };
}

// Attack: 12 voided sybils, contract sponsors everything except voided entries (its real rule). Last 3 h: no cap.
// Safe: the bot spends none of its own Mana on entries that can never be paid (voided).
test("SAB2-SETTLE-1: the bot must not pay its own Mana to settle entries the player voided by withdrawing", async () => {
  const w = world(settleEnd - 2 * HOUR, (r) => !r.voided);
  await tick(w.ctx);
  const wasted = w.botPaid.filter((a) => a.startsWith("1SybilVoided"));
  assert.equal(wasted.length, 0,
    `SAB2-SETTLE-1: the bot paid for ${wasted.length} settle(s) of voided entries (worth 0 to anyone); the contract had refused to sponsor them`);
});

// Attack: pool Mana is low (contract declines every sponsored settle) and the bot can pay for 10 settles. The voided
// sybils hold the largest stakes, so the bot's largest-first order spends its whole budget on them.
// Safe: every honest staked player is settled before settle_end (otherwise they lose the week's reward).
test("SAB2-SETTLE-2: voided sybils with larger stakes must not use up the bot's settle budget before honest players", async () => {
  const w = world(settleEnd - 2 * HOUR, () => false, 10);
  await tick(w.ctx);
  const left = HONEST.filter((h) => !w.settled.has(h.a)).map((h) => h.a);
  assert.equal(left.length, 0,
    `SAB2-SETTLE-2: ${left.length}/${HONEST.length} honest staked players left unsettled 2 h before settle_end; bot budget went to: ${w.botPaid.join(", ")}`);
});

// Same attack in normal hours (cap of 10 bot-paid settles per run): safe = honest players are not pushed behind
// sybils that can never be paid.
test("SAB2-SETTLE-3: in normal hours the 10-per-run cap is not spent on voided sybils ahead of honest players", async () => {
  const w = world(settleEnd - 12 * HOUR, () => false);
  await tick(w.ctx);
  const left = HONEST.filter((h) => !w.settled.has(h.a)).map((h) => h.a);
  assert.equal(left.length, 0,
    `SAB2-SETTLE-3: ${left.length}/${HONEST.length} honest players not settled this run; the capped run paid for ${w.botPaid.filter((a) => a.startsWith("1SybilVoided")).length} voided sybil(s)`);
});
