// Red-team THIEF (fix check 2, Knode audit-fixes-1 @ 1dbc129): the contract now refuses to sponsor the settle of a
// voided entry (player withdrew everything that week), but the bot's settlePass still lists voided entries as
// "staked, unsettled" (it filters on entry.stake only), sorts them by their (stale) stake, largest first, and pays for
// them itself, with no cap in the last 3 hours before settle_end. Settling a voided entry is useless (never eligible).
// Asserts the SAFE behaviour: a failing case is a proven problem.
// Harness: tests/audit/bot.settle-cap.test.ts (SAB-SETTLE-1), same mocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { tick, paths } from "../../bot/bot.ts";

const WEEK = 7 * 86_400_000, GENESIS = 1_792_368_000_000, HOUR = 3_600_000;
const BIG = "100000000000";   // 1,000 VHP: the stake the sybils had at their first answer (withdrawn since)
const MIN = "100000000";      // 1 VHP = min_stake

function world(opts: { sponsorOn: boolean; botBudget: number }) {
  const settleStart = GENESIS + WEEK + 12 * HOUR, settleEnd = settleStart + 24 * HOUR;
  const now = settleEnd - 2 * HOUR;                           // inside the last 3 hours: no cap on bot-paid settles
  const sybils = Array.from({ length: 12 }, (_, i) => `1Sybil${String(i).padStart(2, "0")}`);
  const honest = ["1Honest0", "1Honest1", "1Honest2"];
  const settled = new Set<string>();
  const botPaid: string[] = [];
  let budget = opts.botBudget;
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height: 50_000_000, lib: 49_999_900 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: "50000000", time: String(now),
        config: { owner: "1Owner", operator: "1Op", genesis_time: String(GENESIS), week_length: String(WEEK), close_delay: "43200000", min_stake: MIN },
        totals: { weeks_closed: "1", weeks_finalized: "0", next_question_id: 0 }, koin_balance: "0" };
      if (method === "get_week") {
        if (Number(args.week) === 0) return { week: { closed: true, finalized: false, settle_start: String(settleStart), settle_end: String(settleEnd), questions: 6, resolved: 6 } };
        return { week: { questions: 0, resolved: 0 } };
      }
      if (method === "get_question") return { question: undefined };
      if (method === "list_players") {
        if (args.start) return { rows: [] };
        return { rows: [
          ...sybils.map((a) => ({ address: a, entry: { stake: BIG, voided: true, settled: settled.has(a) } })),
          ...honest.map((a) => ({ address: a, entry: { stake: MIN, settled: settled.has(a) } })),
        ] };
      }
      return {};
    },
    async send(calls: any[], _signers: any[], o: any = {}) {
      const who = calls.find((c) => c.method === "settle")?.args.player;
      if (who === undefined) return { ok: true };            // not a settle: not part of this attack
      if (o.sponsored) {
        // The contract (Kpred.ts sponsorOk, EP_SETTLE) declines voided entries; with sponsorship off it declines all.
        if (!opts.sponsorOn || sybils.includes(who)) return { ok: false, error: "transaction payer (contract) refused: authorize returned false" };
        settled.add(who);
        return { ok: true };
      }
      if (budget-- <= 0) return { ok: false, error: "operator: not enough Mana" };
      botPaid.push(who);
      settled.add(who);
      return { ok: true };
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thief-settle-voided-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  const ctx: any = { chain, operator: Signer.fromSeed("thief-settle-voided-test-only"), P, dryRun: false, problems: [] as string[],
    generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true };
  return { ctx, sybils, honest, settled, botPaid };
}

test("THIEF2-BOT-1: the bot never pays Mana to settle a voided entry (sybils who withdrew everything)", async () => {
  // Attack: N sybils stake, take one free sponsored answer, withdraw everything (entry voided, stake field kept); the
  // contract declines their settle, so the bot pays for each one itself, uncapped in the last 3 h. Safe: 0 bot-paid
  // settles for voided entries.
  const w = world({ sponsorOn: true, botBudget: 1000 });
  await tick(w.ctx);
  const wasted = w.botPaid.filter((a) => w.sybils.includes(a));
  assert.equal(wasted.length, 0,
    `THIEF2-BOT-1: the bot paid its own Mana for ${wasted.length} settles of voided entries (useless: never eligible); a sybil farm drains the operator's Mana at no lasting cost`);
});

test("THIEF2-BOT-2: voided entries with large stale stakes do not push honest players out of the bot's Mana budget", async () => {
  // Attack: sponsorship off (or pool Mana low) so every settle is bot-paid; sybils' voided entries keep a 1,000 VHP
  // stake field, so "largest stake first" settles them first and the bot's Mana runs out before the honest 1-VHP
  // players, who are left unsettled and lose the week (their share goes to the thief). Safe: every honest player settled.
  const w = world({ sponsorOn: false, botBudget: 5 });
  await tick(w.ctx);
  const left = w.honest.filter((a) => !w.settled.has(a));
  assert.equal(left.length, 0,
    `THIEF2-BOT-2: ${left.length} honest staked player(s) left unsettled; the bot spent its Mana on ${w.botPaid.filter((a) => w.sybils.includes(a)).length} voided sybil entries first`);
});
