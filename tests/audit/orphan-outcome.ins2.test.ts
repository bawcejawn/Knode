// Red-team INSIDER (fix check 2, commit 1dbc129): on-chain results of ORPHAN questions (ids that match no question file)
// are never compared again once the bot has seen them: resolvePass skips any orphan whose outcome is not 0, and
// correctionCheck only walks questions that have a file. The orphan email says "It will be voided", so the owner does
// not act. Asserts the SAFE behaviour (failing = proven problem). Harness copied from
// tests/audit/bot.insider-alerts.test.ts (in-memory fake chain, no network, throwaway key).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { tick, paths } from "../../bot/bot.ts";
import { paramsHashOf } from "../../resolver.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const HOUR = 3_600_000, DAY = 24 * HOUR, WEEK = 7 * DAY, GENESIS = 1_792_368_000_000, CD = 12 * HOUR;

function M9() {
  const q = structuredClone(day.questions.find((x: any) => x.template === "M9"));
  for (const k of ["chainId", "chainOutcome", "result", "vhpEnd", "corrections", "postSkipped"]) delete q[k];
  if (q.model) { delete q.model.vhp; delete q.model.vhpHeight; delete q.model.voidVhpSwing; }
  q.paramsHash = paramsHashOf(q);
  return q;
}
function csvFor(q: any) {
  const width = q.windowEnd - q.windowStart + 1, [who] = q.subjects, n = Math.round(width * q.model.rates[who]);
  const sig = new Array(width).fill("1Filler");
  for (let j = 0; j < n; j++) sig[Math.floor(((j + 0.5) * width) / n)] = who;
  return sig.map((s, i) => `${q.windowStart + i},${1_792_627_200_000 + i * 3000},${s},0,0`).join("\n") + "\n";
}
const onchainFor = (q: any, outcome = 0, dataHash = "ab".repeat(32)) =>
  ({ week: "0", k: 4, window_end: String(q.windowEnd), outcome, params_hash: "0x" + q.paramsHash, data_hash: "0x" + dataHash });

type S = { time: number; height: number; config: any; week: any; upgrade: any; seed_withdrawal: any; closed: number; finalized: number };

function world(o: { questions?: any[]; onchain?: any[]; deployment?: any; s?: Partial<S>; botState?: any } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-ins2-" + Math.random().toString(36).slice(2, 6) + "-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  if (o.questions) fs.writeFileSync(path.join(P.questions, "W000-D3.json"), JSON.stringify({ ...day, questions: o.questions }));
  if (o.questions?.length) fs.writeFileSync(path.join(dir, "blocks.csv"), csvFor(o.questions[0]));
  fs.writeFileSync(P.deployment, JSON.stringify(o.deployment ?? { owner: "1Owner", operator: "1Op" }));
  if (o.botState) fs.writeFileSync(P.botState, JSON.stringify(o.botState));      // what main's bot-state.json says
  const onchain = o.onchain ?? [];
  const sent: any[] = [];
  const s: S = {
    time: GENESIS + 3 * DAY, height: (o.questions?.[0]?.windowEnd ?? 40_000_000) + 500,
    config: {}, week: {}, upgrade: {}, seed_withdrawal: {}, closed: 0, finalized: 0, ...o.s,
  };
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height: s.height, lib: s.height - 100 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return {
        height: String(s.height), time: String(s.time),
        config: { owner: "1Owner", operator: "1Op", genesis_time: String(GENESIS), week_length: String(WEEK), close_delay: String(CD),
          min_stake: "100000000", max_sponsor_rc: "200000000", ...s.config },
        totals: { weeks_closed: String(s.closed), weeks_finalized: String(s.finalized), next_question_id: onchain.length },
        upgrade: s.upgrade, seed_withdrawal: s.seed_withdrawal, koin_balance: "0", mana: "0",
      };
      if (method === "get_week") {
        if (Number(args.week) < s.closed) return { week: { closed: true, finalized: Number(args.week) < s.finalized, settle_start: "0", settle_end: "1" } };
        return { week: { questions: onchain.length, resolved: onchain.filter((x) => x.outcome).length, ...s.week } };
      }
      if (method === "get_question") return { question: onchain[Number(args.id)] };
      if (method === "list_players") return { rows: [] };
      return {};
    },
    async send(calls: any[]) {
      for (const c of calls) {
        sent.push(c);
        if (c.method === "resolve_question") { const x = onchain[Number(c.args.id)]; x.outcome = c.args.outcome === 1000 ? 1000 : c.args.outcome + 1; }
        if (c.method === "close_week") s.closed++;
        if (c.method === "finalize_week") s.finalized++;
      }
      return { ok: true };
    },
  };
  const run = async (extra: any = {}) => {
    const ctx: any = { chain, operator: Signer.fromSeed("bot-ins2-test-only"), P, dryRun: false, problems: [] as string[],
      generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true, ...extra };
    await tick(ctx);
    return ctx.problems as string[];
  };
  return { s, onchain, sent, run, P };
}
const count = (problems: string[], re: RegExp) => problems.filter((p) => re.test(p)).length;


const ORPHAN = (outcome = 0, window_end = "40000000") =>
  ({ week: "0", k: 4, window_end, outcome, params_hash: "0x" + "ee".repeat(32), data_hash: "0x" + "00".repeat(32) });

test("INS2-O1 stolen operator key: an orphan it resolves to a real option before the bot voids it must be reported", async () => {
  // Hour 1: the thief posted a question (no file). The bot emails "It will be voided".
  const w = world({ onchain: [ORPHAN()], s: { height: 39_999_000 } });
  assert.ok(count(await w.run(), /matches no question file/) >= 1, "precondition: the orphan is emailed once");
  // Its sybils answered option 1; the thief resolves it with option 1 in the first block it is allowed to.
  w.onchain[0].outcome = 2; w.onchain[0].data_hash = "0x" + "12".repeat(32);
  w.s.height = 40_000_500;
  const p = await w.run();
  assert.equal(w.sent.filter((c) => c.method === "resolve_question").length, 0, "precondition: the bot cannot void it any more");
  assert.ok(count(p, /#0(?![0-9])/) >= 1,
    "INS2-O1: orphan #0 was resolved with option 1 (not void, as the email promised) and the bot said nothing; the sybils' points stand unless the owner corrects it");
});

test("INS2-O2 owner key: a voided orphan flipped to a real option must be reported like any other correction", async () => {
  const w = world({ onchain: [ORPHAN()], s: { height: 40_000_500 } });
  await w.run();
  assert.equal(w.onchain[0].outcome, 1000, "precondition: the bot voided the orphan");
  w.onchain[0].outcome = 3; w.onchain[0].data_hash = "0x" + "34".repeat(32);   // correct_question(id 0, option 2)
  const p = await w.run();
  assert.ok(count(p, /#0(?![0-9])/) >= 1,
    "INS2-O2: correct_question turned voided orphan #0 into option 2 and no email was sent (correctionCheck only covers questions with a file)");
});
