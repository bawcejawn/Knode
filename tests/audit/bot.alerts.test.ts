// The bot's v4 behaviour on an in-memory fake chain (no network; the key is a throwaway test seed):
// VHP readings during the window, alerts (roles, producer keys, the Desk, corrections, outcome mismatches),
// closing only after the correction time, and paged finalization.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { tick, paths } from "../../bot/bot.ts";
import { paramsHashOf, vhpSubjects } from "../../resolver.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const M9 = () => { const q = structuredClone(day.questions.find((x: any) => x.template === "M9")); delete q.chainId; return q; };
const WEEK = 7 * 86_400_000, GENESIS = 1_792_368_000_000;

/** Blocks where the M9 subject signs at its published rate. */
function csvFor(q: any) {
  const width = q.windowEnd - q.windowStart + 1, [who] = q.subjects, n = Math.round(width * q.model.rates[who]);
  const sig = new Array(width).fill("1Filler");
  for (let j = 0; j < n; j++) sig[Math.floor(((j + 0.5) * width) / n)] = who;
  return sig.map((s, i) => `${q.windowStart + i},${1_792_627_200_000 + i * 3000},${s},0,0`).join("\n") + "\n";
}

type World = { questions?: any[]; onchain?: any[]; config?: any; week?: any; deployment?: any; time?: number; height?: number;
  weeksClosed?: number; weeksFinalized?: number; finalizePages?: number };
function world(w: World) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-v4-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  if (w.questions) fs.writeFileSync(path.join(P.questions, "W000-D3.json"), JSON.stringify({ ...day, questions: w.questions }));
  if (w.questions?.length) fs.writeFileSync(path.join(dir, "blocks.csv"), csvFor(w.questions[0]));
  if (w.deployment) fs.writeFileSync(P.deployment, JSON.stringify(w.deployment));
  const onchain = w.onchain ?? [];
  const sent: any[] = [];
  let pages = w.finalizePages ?? 1, closed = w.weeksClosed ?? 0, finalized = w.weeksFinalized ?? 0;
  let height = w.height ?? (w.questions?.[0]?.windowEnd ?? 40_000_000) + 500;
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height, lib: height - 100 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: String(height), time: String(w.time ?? GENESIS + 3 * 86_400_000),
        config: { owner: "1Owner", operator: "1Op", genesis_time: String(GENESIS), week_length: String(WEEK), close_delay: "43200000", min_stake: "100000000", ...w.config },
        totals: { weeks_closed: String(closed), weeks_finalized: String(finalized), next_question_id: onchain.length }, koin_balance: "0" };
      if (method === "get_week") {
        if (Number(args.week) < closed) return { week: { closed: true, finalized: Number(args.week) < finalized, settle_start: "0", settle_end: "1" } };
        return { week: { questions: onchain.length, resolved: onchain.filter((x) => x.outcome).length, ...w.week } };
      }
      if (method === "get_question") return { question: onchain[Number(args.id)] };
      if (method === "list_players") return { rows: [] };
      return {};
    },
    async send(calls: any[]) {
      for (const c of calls) {
        sent.push(c);
        if (c.method === "resolve_question") { const x = onchain[Number(c.args.id)]; x.outcome = c.args.outcome === 1000 ? 1000 : c.args.outcome + 1; }
        if (c.method === "close_week") closed++;
        if (c.method === "finalize_week" && --pages === 0) finalized++;
      }
      return { ok: true };
    },
  };
  const ctx = (extra: any = {}) => ({ chain, operator: Signer.fromSeed("bot-v4-test-only"), P, dryRun: false, problems: [] as string[],
    generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true, ...extra } as any);
  const file = () => JSON.parse(fs.readFileSync(path.join(P.questions, "W000-D3.json"), "utf8")).questions;
  /** Moves the fake chain's head (and the height get_state reports) to h. */
  const at = (h: number) => { height = h; };
  return { chain, sent, onchain, ctx, file, P, at };
}

/** M9 as the generator now releases it: VHP snapshot + 10% limit, hashed. */
function snapshotQuestion() {
  const q = M9();
  q.model.vhp = { [q.subjects[0]]: "100000000000000" };
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  q.paramsHash = paramsHashOf(q);
  return q;
}
const onchainFor = (q: any, outcome = 0) => ({ week: "0", k: 4, window_end: String(q.windowEnd), outcome, params_hash: "0x" + q.paramsHash });

const reader = (h: () => number, value: string, asked: string[][] = []) => async (who: string[]) => {
  asked.push(who); return { height: h(), values: Object.fromEntries(who.map((x) => [x, value])) };
};

test("the bot reads VHP on every run during the window, saves each reading, and a swing of more than 10% voids", async () => {
  const q = snapshotQuestion();
  const w = world({ questions: [q], onchain: [onchainFor(q)], height: q.windowStart + 100 });
  let h = q.windowStart + 100;
  const asked: string[][] = [];
  await tick(w.ctx({ vhp: reader(() => h, "120000000000000", asked) }));     // in the window: +20%
  assert.deepEqual(asked, [vhpSubjects(q)]);
  assert.equal(w.sent.filter((c) => c.method === "resolve_question").length, 0, "not due yet");
  h = q.windowEnd - 5; w.at(h);
  await tick(w.ctx({ vhp: reader(() => h, "100000000000000", asked) }));     // back to normal before the end
  assert.deepEqual(w.file()[0].vhpReadings.map((r: any) => [r.height, r.values[q.subjects[0]]]),
    [[q.windowStart + 100, "120000000000000"], [q.windowEnd - 5, "100000000000000"]]);
  h = q.windowEnd + 500; w.at(h);
  await tick(w.ctx({ vhp: reader(() => h, "100000000000000", asked) }));
  assert.equal(asked.length, 2, "no reading after the window");
  const saved = w.file()[0];
  const res = w.sent.filter((c) => c.method === "resolve_question");
  assert.equal(res.length, 1);
  assert.equal(res[0].args.outcome, 1000, "+20% during the window: void");
  assert.match(saved.result.reason, /changed by more than 10%/);
  assert.equal(saved.result.vhpCheck.values[q.subjects[0]].change, "+20.00%");
  assert.equal(saved.result.vhpCheck.values[q.subjects[0]].height, q.windowStart + 100);
  assert.equal(paramsHashOf(saved), q.paramsHash, "readings do not change the published hash");
});

test("a swing seen only after the window does not void; a reading that lands after the window is not kept", async () => {
  const q = snapshotQuestion();
  const w = world({ questions: [q], onchain: [onchainFor(q)], height: q.windowEnd - 1 });
  // The head was in the window when the run started, but the values came back from a later block.
  await tick(w.ctx({ vhp: reader(() => q.windowEnd + 1, "150000000000000") }));
  assert.equal(w.file()[0].vhpReadings, undefined, "a reading from after the window is dropped");
  w.at(q.windowEnd + 500);
  await tick(w.ctx({ vhp: reader(() => q.windowEnd + 500, "150000000000000") }));
  const res = w.sent.filter((c) => c.method === "resolve_question");
  assert.equal(res.length, 1);
  assert.notEqual(res[0].args.outcome, 1000);
});

test("within 10% the question resolves normally; with no reading during the window the rule is skipped and logged", async () => {
  const q = snapshotQuestion();
  const w = world({ questions: [q], onchain: [onchainFor(q)], height: q.windowEnd });
  await tick(w.ctx({ vhp: reader(() => q.windowEnd, "105000000000000") }));
  w.at(q.windowEnd + 500);
  await tick(w.ctx());
  const res = w.sent.filter((c) => c.method === "resolve_question");
  assert.equal(res.length, 1);
  assert.notEqual(res[0].args.outcome, 1000);
  // The bot was down for the whole window: no reading, so no swing void; the result records why.
  const w2 = world({ questions: [snapshotQuestion()], onchain: [onchainFor(q)] });
  const logged: string[] = [], orig = console.log;
  console.log = (...a: any[]) => { logged.push(a.join(" ")); };
  try { await tick(w2.ctx({ vhp: reader(() => q.windowEnd + 500, "300000000000000") })); } finally { console.log = orig; }
  const r2 = w2.sent.filter((c) => c.method === "resolve_question");
  assert.equal(r2.length, 1);
  assert.notEqual(r2[0].args.outcome, 1000);
  assert.match(w2.file()[0].result.vhpCheck.skipped, /no VHP reading was taken during the window/);
  assert.ok(logged.some((l) => /VHP-swing check skipped/.test(l)), "the skip is logged");
  // During the window, a run that cannot read VHP says so.
  const w3 = world({ questions: [snapshotQuestion()], onchain: [onchainFor(q)], height: q.windowStart + 10 });
  const c3 = w3.ctx();
  await tick(c3);
  assert.ok(c3.problems.some((p: string) => /need a VHP reading/.test(p)), c3.problems.join(" | "));
});

test("an on-chain outcome that differs from the blocks is emailed (a failed run), not only logged", async () => {
  const q = snapshotQuestion();
  delete q.model.vhp; delete q.model.vhpHeight; delete q.model.voidVhpSwing;
  q.paramsHash = paramsHashOf(q);
  const w = world({ questions: [q], onchain: [onchainFor(q, 1000)] });   // void on chain, but nobody went offline
  const c = w.ctx();
  await tick(c);
  assert.ok(c.problems.some((p: string) => /differs from what the blocks say/.test(p)), c.problems.join(" | "));
});

test("a result changed on chain after the bot recorded it is emailed and recorded in the file", async () => {
  const q = M9();
  q.chainId = 0; q.chainOutcome = 2;
  const w = world({ questions: [q], onchain: [onchainFor(q, 3)] });
  const c = w.ctx();
  await tick(c);
  assert.ok(c.problems.some((p: string) => /A result was changed on chain: W000-D3-3 \(#0\) went from outcome 2 to 3/.test(p)), c.problems.join(" | "));
  const saved = w.file()[0];
  assert.equal(saved.chainOutcome, 3);
  assert.equal(saved.corrections[0].from, 2);
  assert.equal(saved.corrections[0].to, 3);
  assert.equal(paramsHashOf(saved), saved.paramsHash, "the record does not change the published hash");
  const c2 = w.ctx();
  await tick(c2);
  assert.ok(!c2.problems.some((p: string) => /changed on chain/.test(p)), "emailed once");
});

test("owner, operator and producer keys that differ from deployment.json are emailed (once), and the Desk is checked", async () => {
  const w = world({ config: { owner: "1Thief", operator: "1OtherBot" }, deployment: { owner: "1Owner", operator: "1Op", producerKey: "AkEY" } });
  const deskState = { config: { owner: "1Thief", treasury: "1ThiefWallet" }, upgrade: { hash: "0xab", eta: String(GENESIS) }, treasury_change: {} };
  const extra = {
    producerKey: async () => "OtherKey",
    desk: { deployment: { contract: "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR", owner: "1Owner", treasury: "1Owner" }, read: async () => deskState },
  };
  const c = w.ctx(extra);
  await tick(c);
  const all = c.problems.join(" | ");
  for (const re of [/game's owner is 1Thief, not 1Owner/, /game's operator is 1OtherBot, not 1Op/, /producer key registered for the game is OtherKey, not AkEY/,
    /Desk's owner is 1Thief/, /Desk's treasury is 1ThiefWallet/, /Desk code upgrade is scheduled/]) assert.match(all, re);
  const c2 = w.ctx(extra);
  await tick(c2);
  assert.ok(!/1Thief/.test(c2.problems.join(" | ")), "each change is emailed once, not every hour");
});

test("with no producerKey in deployment.json, the key the bot first sees is emailed (once) so it can be pinned", async () => {
  const w = world({ deployment: { owner: "1Owner", operator: "1Op" } });
  const c = w.ctx({ producerKey: async () => "SeenKey" });
  await tick(c);
  assert.ok(c.problems.some((p: string) => /has no "producerKey"\. The key registered for the game is SeenKey/.test(p)), c.problems.join(" | "));
  const c2 = w.ctx({ producerKey: async () => "SeenKey" });
  await tick(c2);
  assert.ok(!c2.problems.some((p: string) => /producerKey/.test(p)), "emailed once");
  const c3 = w.ctx({ producerKey: async () => "OtherKey" });
  await tick(c3);
  assert.ok(c3.problems.some((p: string) => /is OtherKey, not SeenKey/.test(p)), "a later change is still caught");
});

test("the bot does not try to close a week before close_delay has passed after its last resolution", async () => {
  const end = GENESIS + WEEK + 43_200_000;                       // week 0's normal close time
  const late = { time: end + 3_600_000, week: { last_resolved_time: String(end - 1_000) } };   // resolved late: close at end + 12 h
  const w = world(late);
  await tick(w.ctx());
  assert.equal(w.sent.filter((c) => c.method === "close_week").length, 0);
  const w2 = world({ ...late, time: end + 43_200_000 });
  await tick(w2.ctx());
  assert.equal(w2.sent.filter((c) => c.method === "close_week").length, 1);
});

test("a big week is finalized page by page in one run", async () => {
  const w = world({ weeksClosed: 1, weeksFinalized: 0, finalizePages: 4, time: GENESIS + WEEK + 3 * 86_400_000 });
  await tick(w.ctx());
  assert.equal(w.sent.filter((c) => c.method === "finalize_week").length, 4);
});
