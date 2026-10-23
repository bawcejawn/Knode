// Audit fix check 2 (AB-021 residual): attacks on the in-window VHP-swing rule.
// MINE-VHP-1: once the blocks already decide a question (an over/under count passed its top threshold), a VHP swing
//   first seen by a LATER in-window reading must not void it: by then the outcome is public, so a loser can buy a void
//   (gift >10% of a small subject's VHP before the next hourly run at minute 7).
// MINE-VHP-2: when no reading was taken during the window (bot down, cron backlog, every read failing), the bot must
//   say so in its problems (emailed), not only in the log, before resolving without the rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { scoreQuestion, paramsHashOf } from "../../resolver.ts";
import { tick, paths } from "../../bot/bot.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const RELEASE = 100_000_000_000_000n;
const HOUR = 1_200;                         // blocks per hour at 3 s

function m9(rate: number) {
  const q = structuredClone(day.questions.find((x: any) => x.template === "M9"));
  delete q.chainId;
  q.model.rates = { ...q.model.rates, [q.subjects[0]]: rate };
  q.model.vhp = { [q.subjects[0]]: RELEASE.toString() };
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  return q;
}
function blocksFor(q: any) {
  const width = q.windowEnd - q.windowStart + 1, who = q.subjects[0], n = Math.round(width * q.model.rates[who]);
  const sig: string[] = new Array(width).fill("1Filler");
  for (let j = 0; j < n; j++) sig[Math.floor(((j + 0.5) * width) / n)] = who;
  return sig.map((s, i) => ({ h: q.windowStart + i, ts: 1_792_627_200_000 + i * 3000, signer: s, ntx: 0, compute: 0 }));
}

test("MINE-VHP-1: a swing first seen after the blocks already decided the question must not void it", () => {
  const q = m9(0.013);                       // ~260 blocks expected; top threshold is 219 → option D
  const blocks = blocksFor(q);
  const top = q.thresholds[q.thresholds.length - 1];
  let count = 0, decidedAt = -1;
  for (const b of blocks) if (b.signer === q.subjects[0] && ++count >= top && decidedAt < 0) decidedAt = b.h;
  assert.ok(decidedAt > 0 && decidedAt < q.windowEnd - 2 * HOUR, "setup: the count passes the top threshold well before the end");
  // Hourly readings (minute 7). Before decidedAt the subject sits at its release VHP; the first reading after it sees +11%.
  const readings = [] as any[];
  for (let h = q.windowStart + 140; h <= q.windowEnd; h += HOUR) {
    const v = h > decidedAt ? (RELEASE * 111n) / 100n : RELEASE;
    readings.push({ height: h, values: { [q.subjects[0]]: v.toString() } });
  }
  const r = scoreQuestion(q, blocks, { vhpReadings: readings });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const after = readings.find((x) => x.height > decidedAt)!.height;
  assert.ok(!r.result.void,
    `MINE-VHP-1: count reached ${top} (option D certain) at block ${decidedAt}, ${q.windowEnd - decidedAt} blocks before the window's end; ` +
    `a +11% VHP gift seen by the reading at ${after} voided it: ${r.result.reason}`);
});

test("MINE-VHP-2: a question resolved without any in-window VHP reading is reported as a problem", async () => {
  const q = m9(0.01);
  q.paramsHash = paramsHashOf(q);
  const onchain = [{ week: "0", k: 4, window_end: String(q.windowEnd), outcome: 0, params_hash: "0x" + q.paramsHash }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mine-vhp-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  fs.writeFileSync(path.join(P.questions, "W000-D3.json"), JSON.stringify({ ...day, questions: [q] }));
  fs.writeFileSync(path.join(dir, "blocks.csv"), blocksFor(q).map((b) => `${b.h},${b.ts},${b.signer},0,0`).join("\n") + "\n");
  const height = q.windowEnd + 500;          // first run after a bot outage covering the whole window
  const sent: any[] = [];
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height, lib: height - 100 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: String(height), time: String(1_792_368_000_000 + 3 * 86_400_000),
        config: { owner: "1Owner", operator: "1Op", genesis_time: "1792368000000", week_length: String(7 * 86_400_000), close_delay: "43200000", min_stake: "100000000" },
        totals: { weeks_closed: "0", weeks_finalized: "0", next_question_id: 1 }, koin_balance: "0" };
      if (method === "get_week") return { week: { questions: 1, resolved: onchain.filter((x) => x.outcome).length } };
      if (method === "get_question") return { question: onchain[Number(args.id)] };
      if (method === "list_players") return { rows: [] };
      return {};
    },
    async send(calls: any[]) { for (const c of calls) { sent.push(c); if (c.method === "resolve_question") onchain[0].outcome = c.args.outcome === 1000 ? 1000 : c.args.outcome + 1; } return { ok: true }; },
  };
  const ctx: any = { chain, operator: Signer.fromSeed("mine-vhp-test-only"), P, dryRun: false, problems: [] as string[],
    generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true,
    vhp: async (who: string[]) => ({ height, values: Object.fromEntries(who.map((w) => [w, ((RELEASE * 150n) / 100n).toString()])) }) };
  await tick(ctx);
  const resolved = sent.filter((c) => c.method === "resolve_question");
  assert.equal(resolved.length, 1, "setup: the question is resolved on its blocks");
  assert.ok(ctx.problems.some((p: string) => /VHP/.test(p)),
    `MINE-VHP-2: resolved as ${resolved[0].args.outcome} with the VHP-swing rule skipped (no in-window reading) and nothing in problems: ${JSON.stringify(ctx.problems)}`);
});
