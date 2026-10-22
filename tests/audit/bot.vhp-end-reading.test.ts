// Proof test (audit fix check, AB-021): the VHP-swing void must not be decided by a reading taken after the question's
// window, when the outcome is already public. Owner's rule: only readings the bot takes DURING the window count.
// SAB-VHP-2 was adapted to that rule: the in-window reading comes from an earlier bot run (inside the window), not from
// a history-aware "as of windowEnd" read, which the bot does not do.
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
const M9 = () => { const q = structuredClone(day.questions.find((x: any) => x.template === "M9")); delete q.chainId; return q; };
const WEEK = 7 * 86_400_000, GENESIS = 1_792_368_000_000;

// ── world(): copied from tests/audit/bot.alerts.test.ts (unchanged except `height` is always explicit) ──
function csvFor(q: any) {
  const width = q.windowEnd - q.windowStart + 1, [who] = q.subjects, n = Math.round(width * q.model.rates[who]);
  const sig = new Array(width).fill("1Filler");
  for (let j = 0; j < n; j++) sig[Math.floor(((j + 0.5) * width) / n)] = who;
  return sig.map((s, i) => `${q.windowStart + i},${1_792_627_200_000 + i * 3000},${s},0,0`).join("\n") + "\n";
}
function world(questions: any[], onchain: any[], height: number) {
  const setHeight = (h: number) => { height = h; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sab-vhp-"));
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
  const ctx = (extra: any = {}) => ({ chain, operator: Signer.fromSeed("sab-vhp-test-only"), P, dryRun: false, problems: [] as string[],
    generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true, ...extra } as any);
  return { sent, ctx, setHeight };
}

const RELEASE = 100_000_000_000_000n;                 // 1,000,000 VHP at release
function snapshotQuestion() {
  const q = M9();
  q.model.vhp = { [q.subjects[0]]: RELEASE.toString() };
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  q.paramsHash = paramsHashOf(q);
  return q;
}
const onchainFor = (q: any) => ({ week: "0", k: 4, window_end: String(q.windowEnd), outcome: 0, params_hash: "0x" + q.paramsHash });

/** A VHP reader that knows history: asked "as of height h <= windowEnd" it answers with the window-end values;
 *  asked with no height (what vhpEndPass does today) it answers with the values at the current head. */
function historyAwareVhp(q: any, atEnd: bigint, now: bigint, headHeight: number) {
  return async (who: string[], at?: any) => {
    const asOf = typeof at === "number" ? at : typeof at === "bigint" ? Number(at) : at && typeof at === "object" && at.height !== undefined ? Number(at.height) : undefined;
    const v = asOf !== undefined && asOf <= q.windowEnd ? atEnd : now;
    return { height: asOf !== undefined && asOf <= q.windowEnd ? asOf : headHeight, values: Object.fromEntries(who.map((w) => [w, v.toString()])) };
  };
}
const resolves = (sent: any[]) => sent.filter((c) => c.method === "resolve_question");

test("SAB-VHP-1: VHP moved into the subject AFTER the window ended (outcome already public) must not void the question", async () => {
  const q = snapshotQuestion();
  const head = q.windowEnd + 500;                    // the bot's next hourly run: ~25 min after the window's last block
  const w = world([q], [onchainFor(q)], head);
  // At windowEnd the subject still had exactly its release VHP. Then the attacker swapped/gifted +20% into it.
  const c = w.ctx({ vhp: historyAwareVhp(q, RELEASE, (RELEASE * 120n) / 100n, head) });
  await tick(c);
  const r = resolves(w.sent);
  assert.ok(!r.some((x) => x.args.outcome === 1000),
    "SAB-VHP-1: the question was voided by a VHP change made after its window ended (the end reading is taken at the bot's run, not at windowEnd)");
});

test("SAB-VHP-2 (inverse): a subject that was 30% down during the window and restored before the bot's next run must still void the question", async () => {
  const q = snapshotQuestion();
  const inWindow = q.windowEnd - 200;               // the bot's last run inside the window saw the −30%
  const w = world([q], [onchainFor(q)], inWindow);
  await tick(w.ctx({ vhp: historyAwareVhp(q, (RELEASE * 70n) / 100n, (RELEASE * 70n) / 100n, inWindow) }));
  const head = q.windowEnd + 500;
  w.setHeight(head);
  const c = w.ctx({ vhp: historyAwareVhp(q, (RELEASE * 70n) / 100n, RELEASE, head) });
  await tick(c);
  const r = resolves(w.sent);
  assert.equal(r.length, 1, "SAB-VHP-2: the question should be resolved (as VOID) from the in-window VHP reading");
  assert.equal(r[0].args.outcome, 1000,
    "SAB-VHP-2: VHP was −30% during the window but put back before the bot's next run: the question was kept instead of voided");
});

test("SAB-VHP-3: a reading taken hours after the window (bot late/down) is not silently used to void", async () => {
  const q = snapshotQuestion();
  const head = q.windowEnd + 7_200;                  // 6 hours late (cron backlog, outage, failing runs)
  const w = world([q], [onchainFor(q)], head);
  // A reader that only knows "now" (as today): +20% now, and nobody can tell whether it moved inside the window.
  const c = w.ctx({ vhp: async (who: string[]) => ({ height: head, values: Object.fromEntries(who.map((x) => [x, ((RELEASE * 120n) / 100n).toString()])) }) });
  await tick(c);
  const voided = resolves(w.sent).some((x) => x.args.outcome === 1000);
  assert.ok(!voided || c.problems.some((p: string) => /VHP/.test(p) && /late|after the window|hours/i.test(p)),
    "SAB-VHP-3: a VHP reading taken 7,200 blocks after windowEnd decided a VOID with no warning (README promises the change is measured to the END of the window)");
});
