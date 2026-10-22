// Proof test (audit fix check, AB-024 bot side and AB-025): owner and operator actions the bot must report.
//   B1 announcements email once (guard); B2 a re-proposal of the same address; B3 a same-outcome correction (new
//   data_hash); B4 a week held open past its normal close; B5 an owner void before the window's blocks are final;
//   B6 an on-chain question the bot never posted; B7 owner-only settings changes.
// Runs the real bot tick against an in-memory fake chain (no network; the key is a throwaway test seed).
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

/** The fixture's M9 question, as released without a VHP snapshot, not yet linked to a chain id. */
function M9() {
  const q = structuredClone(day.questions.find((x: any) => x.template === "M9"));
  for (const k of ["chainId", "chainOutcome", "result", "vhpEnd", "corrections", "postSkipped"]) delete q[k];
  if (q.model) { delete q.model.vhp; delete q.model.vhpHeight; delete q.model.voidVhpSwing; }
  q.paramsHash = paramsHashOf(q);
  return q;
}
/** Blocks where the M9 subject signs at its published rate (same as bot.alerts.test.ts). */
function csvFor(q: any) {
  const width = q.windowEnd - q.windowStart + 1, [who] = q.subjects, n = Math.round(width * q.model.rates[who]);
  const sig = new Array(width).fill("1Filler");
  for (let j = 0; j < n; j++) sig[Math.floor(((j + 0.5) * width) / n)] = who;
  return sig.map((s, i) => `${q.windowStart + i},${1_792_627_200_000 + i * 3000},${s},0,0`).join("\n") + "\n";
}
const onchainFor = (q: any, outcome = 0, dataHash = "ab".repeat(32)) =>
  ({ week: "0", k: 4, window_end: String(q.windowEnd), outcome, params_hash: "0x" + q.paramsHash, data_hash: "0x" + dataHash });

type S = { time: number; height: number; config: any; week: any; upgrade: any; seed_withdrawal: any; closed: number; finalized: number };

function world(o: { questions?: any[]; onchain?: any[]; deployment?: any; s?: Partial<S> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-ins-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  if (o.questions) fs.writeFileSync(path.join(P.questions, "W000-D3.json"), JSON.stringify({ ...day, questions: o.questions }));
  if (o.questions?.length) fs.writeFileSync(path.join(dir, "blocks.csv"), csvFor(o.questions[0]));
  fs.writeFileSync(P.deployment, JSON.stringify(o.deployment ?? { owner: "1Owner", operator: "1Op" }));
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
    const ctx: any = { chain, operator: Signer.fromSeed("bot-ins-test-only"), P, dryRun: false, problems: [] as string[],
      generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true, ...extra };
    await tick(ctx);
    return ctx.problems as string[];
  };
  return { s, onchain, sent, run, P };
}
const count = (problems: string[], re: RegExp) => problems.filter((p) => re.test(p)).length;

test("INS-B1 announcements email exactly once, again for a new one, and normal operation is quiet", async () => {
  const w = world();
  assert.deepEqual(await w.run(), [], "a normal run must not raise anything");
  w.s.upgrade = { hash: "0x" + "ab".repeat(32), eta: String(w.s.time + 48 * HOUR) };          // runbook step 1
  assert.equal(count(await w.run(), /code upgrade is scheduled/), 1, "first run after schedule_upgrade");
  assert.equal(count(await w.run(), /code upgrade is scheduled/), 0, "second hour: no repeat");
  w.s.upgrade = { ...w.s.upgrade, eta: String(w.s.time + 50 * HOUR) };                         // re-announced
  assert.equal(count(await w.run(), /code upgrade is scheduled/), 1, "a new announcement (new eta) must email again");
  w.s.upgrade = { eta: "0" };                                                                    // runbook step 3: cancel_upgrade
  assert.deepEqual(await w.run(), [], "after the runbook's cancel the bot must be quiet");
  w.s.seed_withdrawal = { vhp: "100000000", koin: "0", eta: String(w.s.time + 48 * HOUR) };
  assert.equal(count(await w.run(), /seed withdrawal is scheduled/), 1);
  assert.equal(count(await w.run(), /seed withdrawal is scheduled/), 0);
  w.s.seed_withdrawal = { vhp: "100000000", koin: "0", eta: String(w.s.time + 49 * HOUR) };   // requested again
  assert.equal(count(await w.run(), /seed withdrawal is scheduled/), 1, "a new request (new eta) must email again");
  w.s.seed_withdrawal = { eta: "0" };
  w.s.config = { pending_owner: "1Thief", pending_owner_height: "40000000" };
  assert.equal(count(await w.run(), /ownership transfer to 1Thief is pending/), 1);
  assert.equal(count(await w.run(), /ownership transfer/), 0);
});

test("INS-B2 a re-proposal of the same address (clock restarted, owner's counter overwritten) must email again", async () => {
  const w = world({ s: { config: { pending_owner: "1Thief", pending_owner_height: "40000000" } } });
  assert.equal(count(await w.run(), /ownership transfer to 1Thief is pending/), 1, "precondition: the first proposal is emailed");
  // Within the next hour: the owner proposed their own address (as the email says), then the thief proposed again.
  w.s.config = { pending_owner: "1Thief", pending_owner_height: "40000900" };
  const p = await w.run();
  assert.ok(count(p, /ownership transfer|owner/i) >= 1,
    "INS-B2: the thief's new proposal (new pending_owner_height) was not emailed; dedup key `owner:<address>` has no height, so the owner never learns the counter-proposal was overwritten");
});

test("INS-B3 a correction to the SAME outcome (restarts the correction time) must be emailed", async () => {
  const q = M9();
  q.chainId = 0; q.chainOutcome = 2; q.result = { ok: true, option: 1, void: false, dataHash: "ab".repeat(32) };
  const base = { time: GENESIS + WEEK + 2 * HOUR, week: { last_resolved_time: String(GENESIS + 4 * DAY) } };
  const ctl = world({ questions: [structuredClone(q)], onchain: [onchainFor(q, 2)], s: structuredClone(base) });
  assert.deepEqual(await ctl.run(), [], "control: a resolved question, untouched, raises nothing");
  // The owner key "corrected" it to the same outcome 10 minutes ago: new data_hash, close moved by 12 h.
  const w = world({ questions: [structuredClone(q)], onchain: [onchainFor(q, 2, "cd".repeat(32))],
    s: { ...structuredClone(base), week: { last_resolved_time: String(base.time - 10 * 60_000) } } });
  const p = await w.run();
  assert.ok(p.length >= 1,
    "INS-B3: correct_question to the same outcome (new data_hash, last_resolved_time moved past the bot's own resolution) raised no alarm; repeatable to hold the week open");
});

test("INS-B4 a week held open 3 days past its normal close by repeated corrections must be reported", async () => {
  const q = M9();
  q.chainId = 0; q.chainOutcome = 2; q.result = { ok: true, option: 1, void: false, dataHash: "ab".repeat(32) };
  const time = GENESIS + WEEK + CD + 3 * DAY - 2 * HOUR;   // 10:00 UTC, before the day's release
  const ctl = world({ questions: [structuredClone(q)], onchain: [onchainFor(q, 2)], s: { time, week: { last_resolved_time: String(GENESIS + 4 * DAY) } } });
  assert.deepEqual(await ctl.run(), [], "control: the bot closes the overdue week itself and raises nothing");
  assert.equal(ctl.sent.filter((c) => c.method === "close_week").length, 1, "control: close_week sent");
  const w = world({ questions: [structuredClone(q)], onchain: [onchainFor(q, 2)], s: { time, week: { last_resolved_time: String(time - HOUR) } } });
  const p = await w.run();
  assert.equal(w.sent.filter((c) => c.method === "close_week").length, 0);
  assert.ok(p.length >= 1,
    "INS-B4: week 0 is 3 days past weekEnd + close_delay, kept open by corrections (last_resolved_time keeps moving), and the overdue alarm never fires");
});

test("INS-B5 an OPEN question voided by the owner before its window ends must be emailed (at the latest once the blocks say otherwise)", async () => {
  const q = M9();
  q.chainId = 0;
  // control: the same question, not touched by the owner, resolves normally and quietly
  const ctl = world({ questions: [structuredClone(q)], onchain: [onchainFor(q, 0)], s: { height: q.windowStart - 100 } });
  assert.deepEqual(await ctl.run({ windowBlocks: async () => [] }), []);
  ctl.s.height = q.windowEnd + 500;
  assert.deepEqual(await ctl.run(), [], "control: normal resolution is quiet");
  assert.equal(ctl.sent.filter((c) => c.method === "resolve_question").length, 1, "control: resolved by the bot");
  // abuse: the owner key voided it while its window had not even started
  const w = world({ questions: [structuredClone(q)], onchain: [onchainFor(q, 1000)], s: { height: q.windowStart - 100 } });
  const p1 = await w.run({ windowBlocks: async () => [] });   // live bot: no irreversible window blocks yet
  w.s.height = q.windowEnd + 500;                              // the window is over; the blocks now give a real answer
  const p2 = await w.run();
  assert.ok(p1.length + p2.length >= 1,
    "INS-B5: an early owner void was recorded as chainOutcome 1000 with no check and never compared with the window's blocks; no email in either run");
});

test("INS-B6 a question the bot never posted (stolen operator key) must be reported, not only logged", async () => {
  const w = world({ onchain: [{ week: "0", k: 4, window_end: "40000000", outcome: 0, params_hash: "0x" + "ee".repeat(32), data_hash: "0x" }],
    s: { height: 40_000_500 } });
  const p = await w.run();
  assert.equal(w.sent.filter((c) => c.method === "resolve_question").length, 1, "precondition: the orphan is voided");
  assert.ok(p.length >= 1, "INS-B6: an unknown on-chain question was voided silently; a stolen operator key posting questions is never emailed");
});

test("INS-B7 owner-only settings changes (min_stake, sponsorship, pause) must be reported", async () => {
  const dep = { owner: "1Owner", operator: "1Op", minStake: "100000000", maxSponsorRc: "200000000" };
  const ctl = world({ deployment: dep });
  assert.deepEqual(await ctl.run(), [], "control: settings as deployed");
  const w = world({ deployment: dep, s: { config: { min_stake_next: "100000000000", min_stake_next_week: "1", max_sponsor_rc: "0", paused: true } } });
  const p = await w.run();
  assert.ok(p.length >= 1,
    "INS-B7: min_stake raised 1000x from next week, sponsorship switched off and deposits paused: no alarm (a stolen owner key can make next week's pot roll over unseen)");
});
