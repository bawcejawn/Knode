// Audit fix check 3: attacks on "VHP readings count only until the blocks decide the answer" (43b945a) and the
// group-total check. Every case asserts the SAFE behaviour; a failing case is a proven problem.
// FC3-VHP-1 (AB-035, bypass): a LOWER option is never "decided" before the last block, so a reading taken when the
//   outcome is practically certain (probability of change < 1e-9) still counts and a loser can buy the void.
// FC3-VHP-2 (AB-035, inverse): the cut-off also hides the subject's OWN boost: a small producer that borrows VHP,
//   passes the top threshold before the first hourly reading, then keeps producing, is never checked.
// FC3-VHP-3 (new surface): a healthy bot whose readings all came after an early decision gets the
//   "resolved without the VHP-swing rule ... was the bot down" email.
// FC3-GRP-1/2 (AB-036, original + legitimate use): group questions use the combined VHP.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { scoreQuestion, paramsHashOf, decidedHeight } from "../../resolver.ts";
import { tick, paths } from "../../bot/bot.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const RELEASE = 100_000_000_000_000n;
const HOUR = 1_200;

function m9(rate: number) {
  const q = structuredClone(day.questions.find((x: any) => x.template === "M9"));
  delete q.chainId;
  q.model.rates = { ...q.model.rates, [q.subjects[0]]: rate };
  q.model.vhp = { [q.subjects[0]]: RELEASE.toString() };
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  return q;
}
/** Evenly spread blocks for `who` at `rate`, optionally a different rate before block index `until`. */
function blocksFor(q: any, rate: number, early?: { rate: number; until: number }) {
  const width = q.windowEnd - q.windowStart + 1, who = q.subjects[0];
  const sig: string[] = new Array(width).fill("1Filler");
  let acc = 0;
  for (let i = 0; i < width; i++) {
    acc += early && i < early.until ? early.rate : rate;
    if (acc >= 1) { sig[i] = who; acc -= 1; }
  }
  return sig.map((s, i) => ({ h: q.windowStart + i, ts: 1_792_627_200_000 + i * 3000, signer: s, ntx: 0, compute: 0 }));
}
/** log P(X ≥ k) for X ~ Binomial(n, p): an upper bound by the Chernoff bound, enough to show "practically certain". */
function logUpperTail(n: number, p: number, k: number) {
  const a = k / n;
  if (a <= p) return 0;
  return -n * (a * Math.log(a / p) + (1 - a) * Math.log((1 - a) / (1 - p)));
}

test("FC3-VHP-1: a reading taken when a lower option is practically certain must not void the question", () => {
  const rate = 0.0075;                       // ~150 blocks over 20,000; thresholds 184/200/219 → option A
  const q = m9(rate);
  const blocks = blocksFor(q, rate);
  const who = q.subjects[0], first = q.thresholds[0];
  const at = q.windowEnd - 600;              // 30 minutes before the window's end
  const count = blocks.filter((b) => b.h <= at && b.signer === who).length;
  const need = first + 1 - count, left = q.windowEnd - at;
  const logP = logUpperTail(left, rate, need);
  assert.ok(logP < Math.log(1e-9), `setup: option A should be practically certain (log P = ${logP})`);
  // The owner's rule is now "statistically decided": the premise is that option A is practically, not mathematically,
  // certain (the remaining blocks could still reach the next threshold).
  assert.ok(count + left > first, "setup: not mathematically certain");
  const readings = [] as any[];
  for (let h = q.windowStart + 140; h <= q.windowEnd; h += HOUR) readings.push({ height: h, values: { [who]: RELEASE.toString() } });
  readings.push({ height: at + 10, values: { [who]: ((RELEASE * 111n) / 100n).toString() } });
  const r = scoreQuestion(q, blocks, { vhpReadings: readings });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.ok(!r.result.void,
    `FC3-VHP-1: count ${count} with ${left} blocks left needs ${need} more (P < 1e-9 at the release rate), so option A was public; ` +
    `a +11% gift seen by the reading at ${at + 10} voided it: ${r.result.reason}`);
});

// Open (owner decision pending): readings count only up to the decided block, so a boost that decides the question
// before the bot's first reading is not checked. Catching it needs a reading after that block to count.
test("FC3-VHP-2: the subject's own borrowed-VHP boost that decides the question before the first reading is still caught", { todo: "owner decision: readings after the decided block never count" }, () => {
  const rate = 0.0075;
  const q = m9(rate);
  const who = q.subjects[0], top = q.thresholds[q.thresholds.length - 1];
  // 30× VHP from the window's start (borrowed, e.g. a friend's transfer): ~22% of blocks → passes 219 in ~980 blocks.
  const blocks = blocksFor(q, rate * 30);
  const win = blocks.filter((b) => b.h >= q.windowStart && b.h <= q.windowEnd);
  const decided = decidedHeight(q, win);
  const firstReading = q.windowStart + 1_150;  // the first run at minute 7 inside the window
  assert.ok(decided < firstReading, `setup: decided at ${decided}, first reading ${firstReading}`);
  const readings = [] as any[];
  for (let h = firstReading; h <= q.windowEnd; h += HOUR) readings.push({ height: h, values: { [who]: (RELEASE * 30n).toString() } });
  const r = scoreQuestion(q, blocks, { vhpReadings: readings });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const n = win.filter((b) => b.signer === who).length;
  assert.ok(r.result.void,
    `FC3-VHP-2: ${who} held 30× its release VHP in every reading of the window and produced ${n} blocks (top threshold ${top}); ` +
    `decided at ${decided}, before the first reading at ${firstReading}, so the rule was skipped and option ${r.result.option} stands (${JSON.stringify(r.result.vhpCheck?.skipped)})`);
});

test("FC3-VHP-3: a healthy bot is not told 'was the bot down' when the blocks decided before its first reading", async () => {
  const rate = 0.0075;
  const q = m9(rate);
  q.paramsHash = paramsHashOf(q);
  const blocks = blocksFor(q, rate * 30);
  const onchain = [{ week: "0", k: 4, window_end: String(q.windowEnd), outcome: 0, params_hash: "0x" + q.paramsHash }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc3-vhp-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  const op = Signer.fromSeed("fc3-vhp-test-only");
  // A healthy bot: one sealed reading every hour of the window (all after the early decision).
  const { sealReadings } = await import("../../bot/bot.ts");
  q.vhpReadings = [];
  for (let h = q.windowStart + 1_150; h <= q.windowEnd; h += HOUR) {
    const r = { height: h, readAt: new Date(1_792_627_200_000 + (h - q.windowStart) * 3000).toISOString(), values: { [q.subjects[0]]: RELEASE.toString() } };
    q.vhpReadings.push(r);
  }
  sealReadings(op, q);   // as the bot writes them: each reading and the whole list
  fs.writeFileSync(path.join(P.questions, "W000-D3.json"), JSON.stringify({ ...day, questions: [q] }));
  fs.writeFileSync(path.join(dir, "blocks.csv"), blocks.map((b) => `${b.h},${b.ts},${b.signer},0,0`).join("\n") + "\n");
  const height = q.windowEnd + 500;
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
    async send(calls: any[]) { for (const c of calls) if (c.method === "resolve_question") onchain[0].outcome = c.args.outcome === 1000 ? 1000 : c.args.outcome + 1; return { ok: true }; },
  };
  const ctx: any = { chain, operator: op, P, dryRun: false, problems: [] as string[], generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true };
  await tick(ctx);
  assert.ok(onchain[0].outcome !== 0, "setup: the question was resolved");
  const scary = ctx.problems.filter((p: string) => /without the VHP-swing rule/.test(p));
  assert.deepEqual(scary, [], `FC3-VHP-3: ${q.vhpReadings.length} hourly readings were taken, yet the owner is emailed: ${scary[0]}`);
});

function m10() {
  const q = structuredClone(day.questions.find((x: any) => x.template === "M10"));
  delete q.chainId;
  q.model.vhp = Object.fromEntries(q.group.map((w: string, i: number) => [w, String(BigInt(i + 1) * 1_000_000_000_000n)]));
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  return q;
}
function groupBlocks(q: any) {
  const width = q.windowEnd - q.windowStart + 1;
  return Array.from({ length: width }, (_, i) => ({ h: q.windowStart + i, ts: 1_792_627_200_000 + i * 3000, signer: i % 50 === 0 ? q.group[i % q.group.length] : "1Core", ntx: 0, compute: 0 }));
}

test("FC3-GRP-1: a gift of 10% of the smallest member's VHP no longer voids a group question (AB-036)", () => {
  const q = m10();
  const v = { ...q.model.vhp };
  v[q.group[0]] = ((BigInt(v[q.group[0]]) * 150n) / 100n).toString();   // smallest member +50%
  const r = scoreQuestion(q, groupBlocks(q), { vhpReadings: [{ height: q.windowStart + 100, values: v }] });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.ok(!r.result.void, `FC3-GRP-1: voided by one small member: ${r.result.reason}`);
});

test("FC3-GRP-2: the group's combined VHP moving more than 10% still voids (and exactly 10% does not)", () => {
  const q = m10();
  const total = Object.values(q.model.vhp as Record<string, string>).reduce((s, x) => s + BigInt(x), 0n);
  const exact = { ...q.model.vhp }, over = { ...q.model.vhp };
  const big = q.group[q.group.length - 1];
  exact[big] = (BigInt(exact[big]) + total / 10n).toString();
  over[big] = (BigInt(over[big]) + total / 10n + 1n).toString();
  const a = scoreQuestion(q, groupBlocks(q), { vhpReadings: [{ height: q.windowStart + 100, values: exact }] });
  const b = scoreQuestion(q, groupBlocks(q), { vhpReadings: [{ height: q.windowStart + 100, values: over }] });
  assert.ok(a.ok && b.ok);
  assert.ok(!a.result.void, `FC3-GRP-2: exactly +10% of the group voided: ${a.result.reason}`);
  assert.ok(b.result.void, "FC3-GRP-2: +10% + 1 unit of the group's combined VHP did not void");
  // Moving VHP between members (total unchanged) does not void.
  const moved = { ...q.model.vhp };
  moved[q.group[0]] = "0"; moved[big] = (BigInt(moved[big]) + BigInt(q.model.vhp[q.group[0]])).toString();
  const c = scoreQuestion(q, groupBlocks(q), { vhpReadings: [{ height: q.windowStart + 100, values: moved }] });
  assert.ok(c.ok && !c.result.void, "FC3-GRP-2: a transfer between members (same total) voided");
});
