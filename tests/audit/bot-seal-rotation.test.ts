// After an operator-key rotation with PREVIOUS_OPERATOR_WIF set, the readings the bot sealed with the old key still
// count (and are re-sealed with the new one); without it the question is held and reported, never resolved silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { paramsHashOf } from "../../resolver.ts";
import { tick, paths, sealReadings } from "../../bot/bot.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const RELEASE = 100_000_000_000_000n;
const HOUR = 1_200;
const OP = Signer.fromSeed("fc3-seal-test-only");

function world(opts: { height: number; config?: Record<string, string>; koin?: string; questions?: any[] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc3-seal-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  const onchain: any[] = (opts.questions ?? []).map((q) => ({ week: "0", k: 4, window_end: String(q.windowEnd), outcome: 0, params_hash: "0x" + q.paramsHash }));
  if (opts.questions) fs.writeFileSync(path.join(P.questions, "W000-D3.json"), JSON.stringify({ ...day, questions: opts.questions }));
  const sent: any[] = [];
  const cfg = { owner: "1Owner", operator: "1Op", genesis_time: "1792368000000", week_length: String(7 * 86_400_000), close_delay: "43200000", min_stake: "100000000", min_sponsor_rc: "50000000", ...(opts.config ?? {}) };
  let height = opts.height;
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height, lib: height - 100 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: String(height), time: String(1_792_368_000_000 + 3 * 86_400_000), config: cfg,
        totals: { weeks_closed: "0", weeks_finalized: "0", next_question_id: onchain.length, seed_koin: "0", creator_fee: "0" }, koin_balance: opts.koin ?? "0" };
      if (method === "get_week") return { week: { questions: onchain.length, resolved: onchain.filter((x) => x.outcome).length } };
      if (method === "get_question") return { question: onchain[Number(args.id)] };
      if (method === "list_players") return { rows: [] };
      return {};
    },
    async send(calls: any[]) {
      for (const c of calls) { sent.push(c); if (c.method === "resolve_question") onchain[c.args.id].outcome = c.args.outcome === 1000 ? 1000 : c.args.outcome + 1; }
      return { ok: true };
    },
  };
  const run = async (op = OP, extra: any = {}) => {
    const ctx: any = { ...extra, chain, operator: op, P, dryRun: false, problems: [] as string[], generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true };
    await tick(ctx);
    return ctx.problems as string[];
  };
  return { dir, P, cfg, sent, onchain, run, setHeight: (h: number) => { height = h; } };
}
const stateFile = (w: { P: any }) => w.P.botState as string;
function m9WithReadings(op: Signer, swingAt: number | null) {
  const q = structuredClone(day.questions.find((x: any) => x.template === "M9"));
  delete q.chainId;
  q.model.rates = { ...q.model.rates, [q.subjects[0]]: 0.0075 };
  q.model.vhp = { [q.subjects[0]]: RELEASE.toString() };
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  q.paramsHash = paramsHashOf(q);
  q.chainId = 0;
  q.vhpReadings = [];
  let i = 0;
  for (let h = q.windowStart + 140; h <= q.windowEnd; h += HOUR, i++) {
    const v = i === swingAt ? (RELEASE * 120n) / 100n : RELEASE;
    const r = { height: h, readAt: new Date(1_792_627_200_000 + i * 3_600_000).toISOString(), values: { [q.subjects[0]]: v.toString() } };
    q.vhpReadings.push(r);
  }
  sealReadings(op, q);   // as the bot writes them: each reading and the whole list
  return q;
}
function blocksCsv(dir: string, q: any) {
  const width = q.windowEnd - q.windowStart + 1, who = q.subjects[0];
  let acc = 0; const rows: string[] = [];
  for (let i = 0; i < width; i++) { acc += 0.0075; let s = "1Filler"; if (acc >= 1) { s = who; acc -= 1; } rows.push(`${q.windowStart + i},${1_792_627_200_000 + i * 3000},${s},0,0`); }
  fs.writeFileSync(path.join(dir, "blocks.csv"), rows.join("\n") + "\n");
}

test("rotation with PREVIOUS_OPERATOR_WIF: the old key's readings still count and are re-sealed with the new key", async () => {
  const oldKey = Signer.fromSeed("rotation-old-operator");
  const q = m9WithReadings(oldKey, 5);
  const w = world({ height: q.windowEnd + 500, questions: [q] });
  blocksCsv(w.dir, q);
  const p = await w.run(OP, { previousOperator: oldKey });
  assert.equal(w.onchain[0].outcome, 1000, `the +20% reading sealed with the old key voids: ${JSON.stringify(p)}`);
  assert.ok(!p.some((x) => /VHP reading/.test(x)), JSON.stringify(p));
  const saved = JSON.parse(fs.readFileSync(path.join(w.P.questions, "W000-D3.json"), "utf8")).questions[0];
  assert.equal(saved.vhpSeal, (() => { const c = structuredClone(saved); sealReadings(OP, c); return c.vhpSeal; })(), "re-sealed with the new key");
});

test("rotation without PREVIOUS_OPERATOR_WIF: the question is held and reported", async () => {
  const q = m9WithReadings(Signer.fromSeed("rotation-old-operator"), 5);
  const w = world({ height: q.windowEnd + 500, questions: [q] });
  blocksCsv(w.dir, q);
  const p = await w.run(OP);
  assert.equal(w.onchain[0].outcome, 0);
  assert.ok(p.some((x) => /VHP readings are not the list this bot recorded/.test(x) && /PREVIOUS_OPERATOR_WIF/.test(x)), JSON.stringify(p));
});
