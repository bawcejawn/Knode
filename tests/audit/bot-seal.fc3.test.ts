// Audit fix check 3: attacks on the bot-state / VHP-reading seals (07265d8, AB-040). Every case asserts the SAFE
// behaviour; a failing case is a proven problem. All need push access to main (insider), like AB-040 itself.
// FC3-SEAL-1 (bypass): deleting bot-state.json instead of editing it: no seal is checked, nothing is emailed, and the
//   owner-settings baseline is gone, so a settings change made with a stolen owner key is never reported.
// FC3-SEAL-2 (bypass): an edit that breaks the seal is emailed once, but the fields the bot does not reset
//   (lastCompound, producedByDay, ...) are then re-sealed as if the bot had written them: compounding stops for good.
// FC3-SEAL-3 (bypass): each VHP reading is sealed on its own, so deleting the one sealed reading that shows the swing
//   leaves a file the bot fully trusts: the question resolves to an option, with no email.
// FC3-SEAL-4 (legitimate use): rotating OPERATOR_WIF (as AB-008 recommends) while a window is open drops that
//   question's earlier readings; a real swing is then missed.
// FC3-SEAL-0 (original): a hand edit with a broken seal is emailed and the alert history is not trusted.
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
  const run = async (op = OP) => {
    const ctx: any = { chain, operator: op, P, dryRun: false, problems: [] as string[], generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true };
    await tick(ctx);
    return ctx.problems as string[];
  };
  return { dir, P, cfg, sent, onchain, run, setHeight: (h: number) => { height = h; } };
}
const stateFile = (w: { P: any }) => w.P.botState as string;

test("FC3-SEAL-0: a hand edit that breaks the seal is emailed, and planted alert history is not trusted", async () => {
  const w = world({ height: 40_000_000 });
  await w.run();
  const s = JSON.parse(fs.readFileSync(stateFile(w), "utf8"));
  assert.ok(typeof s.seal === "string" && s.seal.length === 64, "setup: the bot seals its state");
  s.notified = ["settings:anything"]; s.orphans = [5];
  fs.writeFileSync(stateFile(w), JSON.stringify(s));
  const p = await w.run();
  assert.ok(p.some((x) => /not written by this bot/.test(x)), `FC3-SEAL-0: no email for a broken seal: ${JSON.stringify(p)}`);
});

test("FC3-SEAL-1: deleting bot-state.json does not silently hide an owner-settings change", async () => {
  // Control: with the sealed file kept, a min_sponsor_rc change between runs is emailed.
  const a = world({ height: 40_000_000 });
  await a.run();
  a.cfg.min_sponsor_rc = "1";
  const pa = await a.run();
  assert.ok(pa.some((x) => /settings changed/.test(x)), `setup: the change is reported when the file is kept: ${JSON.stringify(pa)}`);
  // Attack: the same change, and bot-state.json deleted on main before the next run.
  const b = world({ height: 40_000_000 });
  await b.run();
  b.cfg.min_sponsor_rc = "1";
  fs.rmSync(stateFile(b));
  const pb = await b.run();
  assert.ok(pb.some((x) => /settings|bot-state/.test(x)),
    `FC3-SEAL-1: min_sponsor_rc changed on chain and bot-state.json was deleted: the run emailed nothing about either (${JSON.stringify(pb)})`);
});

test("FC3-SEAL-2: fields kept from an unsealed bot-state.json are not re-sealed as trusted", async () => {
  const w = world({ height: 40_000_000, koin: "500000000" });   // 5 KOIN of block rewards to compound
  await w.run();
  assert.ok(w.sent.some((c) => c.method === "compound"), "setup: the bot compounds");
  const planted = 10 ** 12;
  const s = JSON.parse(fs.readFileSync(stateFile(w), "utf8"));
  s.lastCompound = planted; s.seal = "0".repeat(64);
  fs.writeFileSync(stateFile(w), JSON.stringify(s));
  w.sent.length = 0;
  const p2 = await w.run();
  assert.ok(p2.some((x) => /not written by this bot/.test(x)), "setup: the broken seal is emailed once");
  w.setHeight(40_000_000 + 2 * 28_800);     // two days later, a normal run
  const p3 = await w.run();
  const saved = JSON.parse(fs.readFileSync(stateFile(w), "utf8"));
  assert.ok(w.sent.some((c) => c.method === "compound") || saved.lastCompound !== planted,
    `FC3-SEAL-2: lastCompound ${planted} from the hand-edited file was re-sealed (seal ${saved.seal.slice(0, 8)}…); ` +
    `two days later the bot still does not compound and says nothing (${JSON.stringify(p3)})`);
});

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

test("FC3-SEAL-3: deleting the sealed reading that shows the swing does not go unnoticed", async () => {
  // Control: all sealed readings present → void.
  const qa = m9WithReadings(OP, 5);
  const a = world({ height: qa.windowEnd + 500, questions: [qa] });
  blocksCsv(a.dir, qa);
  await a.run();
  assert.equal(a.onchain[0].outcome, 1000, "setup: the +20% reading voids the question");
  // Attack: the same file with reading #5 removed (a push to main before the run).
  const qb = m9WithReadings(OP, 5);
  qb.vhpReadings.splice(5, 1);
  const b = world({ height: qb.windowEnd + 500, questions: [qb] });
  blocksCsv(b.dir, qb);
  const p = await b.run();
  assert.ok(b.onchain[0].outcome === 1000 || p.some((x) => /VHP reading/.test(x)),
    `FC3-SEAL-3: with the sealed +20% reading deleted the question resolved to stored outcome ${b.onchain[0].outcome} and nothing was emailed (${JSON.stringify(p)})`);
});

test("FC3-SEAL-4: rotating OPERATOR_WIF during a window does not make the bot miss a swing it had recorded", async () => {
  const oldKey = Signer.fromSeed("fc3-seal-old-operator");
  const q = m9WithReadings(oldKey, 5);
  const w = world({ height: q.windowEnd + 500, questions: [q] });
  blocksCsv(w.dir, q);
  const p = await w.run(OP);             // the first run after the owner rotated the operator key
  assert.ok(w.onchain[0].outcome === 1000 || w.onchain[0].outcome === 0,
    `FC3-SEAL-4: after a key rotation the bot dropped the readings it sealed itself and posted stored outcome ${w.onchain[0].outcome} ` +
    `although its own +20% reading was in the file. Email: ${JSON.stringify(p.filter((x) => /VHP/.test(x)))}`);
});
