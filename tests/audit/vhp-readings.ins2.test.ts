// Red-team INSIDER (fix check 2, commit 1dbc129): question-file edits vs the params_hash check. vhpReadings (and the
// legacy vhpEnd) decide the VHP-swing void but are outside params_hash, and nothing ties them to the chain, so a push
// that edits only them changes the outcome the bot posts with OPERATOR_WIF. Wording/hashRule edits are checked as
// blocked. Asserts the SAFE behaviour (failing = proven problem). Harness copied from
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


/** The M9 question released WITH a VHP snapshot (VHP-swing rule on), linked to on-chain id 0. */
function M9vhp() {
  const q = M9();
  const [who] = q.subjects;
  q.model.vhp = { [who]: "100000000000000" };            // 1,000,000 VHP at release
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.10;
  q.paramsHash = paramsHashOf(q);
  q.chainId = 0;
  return q;
}

test("INS2-V1 editing vhpReadings in a published question file must not change the posted outcome unseen", async () => {
  const pub = M9vhp();
  const [who] = pub.subjects;
  const inWin = pub.windowStart + 100;
  const cases = [
    // A real reading 3 % up: the honest result is the block count. The edit adds a reading 100 % up: forced VOID.
    { name: "planted swing", honest: [{ height: inWin, readAt: "x", values: { [who]: "103000000000000" } }],
      edited: [{ height: inWin, readAt: "x", values: { [who]: "103000000000000" } }, { height: inWin + 50, readAt: "y", values: { [who]: "200000000000000" } }] },
    // A real reading 50 % down: the honest result is VOID. The edit deletes it: the rule is skipped, an option is paid.
    { name: "deleted swing", honest: [{ height: inWin, readAt: "x", values: { [who]: "50000000000000" } }], edited: [] },
  ];
  const bad: string[] = [];
  for (const c of cases) {
    const h = structuredClone(pub); h.vhpReadings = c.honest;
    const e = structuredClone(pub); e.vhpReadings = c.edited;
    assert.equal(paramsHashOf(e), paramsHashOf(h), "precondition: vhpReadings are outside params_hash");
    const ctl = world({ questions: [h], onchain: [onchainFor(h, 0)] });
    await ctl.run();
    const honest = ctl.sent.find((x) => x.method === "resolve_question")!.args.outcome;
    const w = world({ questions: [e], onchain: [onchainFor(e, 0)] });
    const p = await w.run();
    const posted = w.sent.find((x) => x.method === "resolve_question")?.args.outcome;
    if (!(posted === honest || p.length > 0)) bad.push(`${c.name}: ${honest} -> ${posted}`);
  }
  assert.deepEqual(bad, [],
    "INS2-V1: a push to main editing only vhpReadings changed the outcome the bot posted with OPERATOR_WIF, with no params_hash mismatch and no email");
});

test("INS2-V2 wording and hashRule edits to a hashRule-2 question trip the params_hash check (blocked attack, should pass)", () => {
  const q = M9(); q.hashRule = 2; q.paramsHash = paramsHashOf(q);
  const base = paramsHashOf(q);
  const edits: Array<[string, (x: any) => void]> = [
    ["title", (x) => { x.title += " "; }],
    ["text", (x) => { x.text = x.text.replace("sign", "produce"); }],
    ["option label", (x) => { x.options[3].label = "219 or more"; }],
    ["option dropped", (x) => { x.options.pop(); }],
    ["hashRule 2 -> 1", (x) => { x.hashRule = 1; }],
    ["hashRule removed", (x) => { delete x.hashRule; }],
    ["hashRule as text", (x) => { x.hashRule = "2"; }],
    ["thresholds", (x) => { x.thresholds[2] = 220; }],
    ["model.vhp added", (x) => { x.model.vhp = { [x.subjects[0]]: "1" }; x.model.voidVhpSwing = 0.1; }],
  ];
  for (const [name, f] of edits) {
    const e = structuredClone(q); f(e);
    assert.notEqual(paramsHashOf(e), base, `INS2-V2: editing ${name} did not change params_hash`);
  }
  // A legacy question (no hashRule) cannot be moved under rule 2 either.
  const old = M9(); const oldHash = paramsHashOf(old);
  const up = structuredClone(old); up.hashRule = 2;
  assert.notEqual(paramsHashOf(up), oldHash, "INS2-V2: adding hashRule 2 to a legacy question kept its hash");
});
