// Red-team SABOTEUR (fix check 1dbc129): end-to-end through the real bot tick (fake in-memory chain, no network).
// Attack: the bot's last hourly run inside the window happens 20 blocks (1 minute) before windowEnd. 19,980 of the
// window's 20,000 blocks are public. Just before it, anyone sends 11% of the subject's VHP to the subject (or the subject
// parks its own VHP elsewhere: Mana only). The reading lands in the window, and the next run resolves the question VOID.
// Asserts the SAFE behaviour (no void decided by a VHP move made when the outcome was already public): FAILS today.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { tick, paths } from "../../bot/bot.ts";
import { paramsHashOf } from "../../resolver.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const M9 = () => { const q = structuredClone(day.questions.find((x: any) => x.template === "M9")); delete q.chainId; return q; };
const WEEK = 7 * 86_400_000, GENESIS = 1_792_368_000_000;

// ── world(): copied from tests/audit/bot.vhp-end-reading.test.ts (unchanged) ──
function csvFor(q: any) {
  const width = q.windowEnd - q.windowStart + 1, [who] = q.subjects, n = Math.round(width * q.model.rates[who]);
  const sig = new Array(width).fill("1Filler");
  for (let j = 0; j < n; j++) sig[Math.floor(((j + 0.5) * width) / n)] = who;
  return sig.map((s, i) => `${q.windowStart + i},${1_792_627_200_000 + i * 3000},${s},0,0`).join("\n") + "\n";
}
function world(questions: any[], onchain: any[], height: number) {
  const setHeight = (h: number) => { height = h; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sab2-vhp-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  fs.writeFileSync(path.join(P.questions, "W000-D3.json"), JSON.stringify({ ...day, questions }));
  fs.writeFileSync(path.join(dir, "blocks.csv"), csvFor(questions[0]));
  const sent: any[] = [];
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height, lib: height - 100 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: String(height), time: String(GENESIS + 3 * 86_400_000),
        config: { owner: "1Owner", operator: "1Op", genesis_time: String(GENESIS), week_length: String(WEEK), close_delay: "43200000", min_stake: "100000000" },
        totals: { weeks_closed: "0", weeks_finalized: "0", next_question_id: onchain.length }, koin_balance: "0" };
      if (method === "get_week") return { week: { questions: onchain.length, resolved: onchain.filter((x) => x.outcome).length } };
      if (method === "get_question") return { question: onchain[Number(args.id)] };
      if (method === "list_players") return { rows: [] };
      return {};
    },
    async send(calls: any[]) {
      for (const c of calls) {
        sent.push(c);
        if (c.method === "resolve_question") { const x = onchain[Number(c.args.id)]; x.outcome = c.args.outcome === 1000 ? 1000 : c.args.outcome + 1; }
      }
      return { ok: true };
    },
  };
  const ctx = (extra: any = {}) => ({ chain, operator: Signer.fromSeed("sab2-vhp-test-only"), P, dryRun: false, problems: [] as string[],
    generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true, ...extra } as any);
  return { sent, ctx, setHeight, P };
}

const RELEASE = 100_000_000_000_000n;
function snapshotQuestion() {
  const q = M9();
  q.model.vhp = { [q.subjects[0]]: RELEASE.toString() };
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  q.paramsHash = paramsHashOf(q);
  return q;
}
const onchainFor = (q: any) => ({ week: "0", k: 4, window_end: String(q.windowEnd), outcome: 0, params_hash: "0x" + q.paramsHash });
const reader = (v: bigint, h: () => number) => async (who: string[]) => ({ height: h(), values: Object.fromEntries(who.map((w) => [w, v.toString()])) });

// Attack: last in-window run at windowEnd − 20 sees the subject +11% (gift made with 99.9% of the window public).
// Safe: the question is resolved on its blocks, not voided.
test("SAB2-VHP-5: a VHP gift seen only by the bot's last in-window run (1 minute before windowEnd) must not void the question", async () => {
  const q = snapshotQuestion();
  let head = q.windowStart + 100;
  const w = world([q], [onchainFor(q)], head);
  // Honest hourly readings early and mid-window: no change.
  await tick(w.ctx({ vhp: reader(RELEASE, () => head) }));
  head = q.windowStart + 10_000; w.setHeight(head);
  await tick(w.ctx({ vhp: reader(RELEASE, () => head) }));
  // Attacker moves VHP right before the last run inside the window.
  head = q.windowEnd - 20; w.setHeight(head);
  await tick(w.ctx({ vhp: reader((RELEASE * 111n) / 100n, () => head) }));
  // First run after the window: resolve.
  head = q.windowEnd + 500; w.setHeight(head);
  await tick(w.ctx({ vhp: reader(RELEASE, () => head) }));
  const r = w.sent.filter((c) => c.method === "resolve_question");
  assert.equal(r.length, 1, "the question is resolved once");
  const saved = JSON.parse(fs.readFileSync(path.join(w.P.questions, "W000-D3.json"), "utf8")).questions[0];
  assert.notEqual(r[0].args.outcome, 1000,
    `SAB2-VHP-5: voided by a VHP move first seen at height ${q.windowEnd - 20} (${(100 * (q.windowEnd - 20 - q.windowStart + 1) / (q.windowEnd - q.windowStart + 1)).toFixed(2)}% of the window public); readings kept: ${JSON.stringify((saved.vhpReadings ?? []).map((x: any) => x.height))}`);
});
