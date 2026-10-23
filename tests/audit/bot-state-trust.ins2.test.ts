// Red-team INSIDER (fix check 2, commit 1dbc129): game-data/bot-state.json is pushed to main by the publish job and is
// not covered by the recommended push ruleset (bot/README.md), so anyone with push access (directly, or through a
// workflow on their own branch) can edit it. The bot trusts it for alert dedup (notified), the expected producer key,
// the orphan list it voids with OPERATOR_WIF, and the production alarm. Each case asserts the SAFE behaviour: failing
// = proven problem. Runs the real bot tick against an in-memory fake chain (harness copied from
// tests/audit/bot.insider-alerts.test.ts; no network; throwaway key).
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

test("INS2-S1 a planted 'notified' key must not silence a code-upgrade announcement (stolen owner key + repo write)", async () => {
  const time = GENESIS + 3 * DAY;
  const up = { hash: "0x" + "ab".repeat(32), eta: String(time - 10 * 60_000 + 48 * HOUR) };   // scheduled 10 min ago
  const ctl = world({ s: { time, upgrade: up } });
  assert.equal(count(await ctl.run(), /code upgrade is scheduled/), 1, "control: the announcement is emailed");
  // The thief read eta from the chain and pushed bot-state.json with the matching dedup key before minute 7.
  const w = world({ s: { time, upgrade: up }, botState: { notified: [`upgrade:${up.hash}:${up.eta}`] } });
  assert.equal(count(await w.run(), /code upgrade is scheduled/), 1,
    "INS2-S1: a dedup key planted in bot-state.json silenced the only email about a malicious 48 h upgrade announcement");
});

test("INS2-S2 a planted 'notified' key must not silence a pending ownership transfer", async () => {
  const cfg = { pending_owner: "1Thief", pending_owner_height: "40000123" };
  const w = world({ s: { config: cfg }, botState: { notified: ["owner:1Thief:40000123", "owner-changed:1Thief"] } });
  assert.ok(count(await w.run(), /ownership transfer to 1Thief/) >= 1,
    "INS2-S2: propose_owner by a stolen owner key was never emailed because bot-state.json already listed its key; accept_owner follows silently 28,800 blocks later");
});

test("INS2-S3 a producer key planted in bot-state.json must not be accepted silently (deployment.json without producerKey)", async () => {
  const key = "02" + "ab".repeat(32);
  const ctl = world();
  assert.ok(count(await ctl.run({ producerKey: async () => key }), /producer ?key|registered for the game/i) >= 1, "control: a key not in deployment.json is emailed once");
  const w = world({ botState: { producerKey: key } });
  assert.ok(count(await w.run({ producerKey: async () => key }), /producer ?key|registered for the game/i) >= 1,
    "INS2-S3: register_key to the thief's key + bot-state.json producerKey set to it = no email ever (the 'key-noted' mail never fires)");
});

test("INS2-S4 the bot must not void a posted question because bot-state.json lists its id as an orphan", async () => {
  const q = M9(); q.chainId = 0;
  const ctl = world({ questions: [structuredClone(q)], onchain: [onchainFor(q, 0)], botState: { checkedUpTo: 1, orphans: [] } });
  await ctl.run();
  const good = ctl.sent.filter((c) => c.method === "resolve_question");
  assert.equal(good.length, 1, "control: the question is resolved from its blocks");
  assert.notEqual(good[0].args.outcome, 1000, "control: not void");
  const w = world({ questions: [structuredClone(q)], onchain: [onchainFor(q, 0)], botState: { checkedUpTo: 1, orphans: [0] } });
  await w.run();
  const voids = w.sent.filter((c) => c.method === "resolve_question" && c.args.outcome === 1000);
  assert.equal(voids.length, 0,
    "INS2-S4: a planted orphans:[0] made the bot (OPERATOR_WIF) resolve a real, linked question as VOID; only the owner can undo it, one correction per question");
});

test("INS2-S5 a planted lastProduced must not silence the 'pool produced no block' alarm", async () => {
  const lib = 40_000_400, today = Math.floor(lib / 28_800);
  const byDay: Record<string, number> = {};
  for (let d = today - 7; d < today; d++) byDay[String(d)] = 100;
  const base = { producedByDay: byDay, producerScannedTo: lib };
  const ctl = world({ botState: { ...base, lastProduced: lib - 5_000 } });
  assert.ok(count(await ctl.run({ recentBlocks: async () => [] }), /produced no block/) >= 1, "control: 5,000 silent blocks raise the alarm");
  const w = world({ botState: { ...base, lastProduced: 9_000_000_000_000 } });
  assert.ok(count(await w.run({ recentBlocks: async () => [] }), /produced no block/) >= 1,
    "INS2-S5: lastProduced set far in the future in bot-state.json silences the production alarm for good (gap is negative)");
});
