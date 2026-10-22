/**
 * Scores a published question from block history alone.
 *
 * The correct option is a pure function of the question file (the window, the thresholds, the
 * release-time rates and the void rule saved with the question) and the blocks whose heights are
 * inside that window. Nothing else is consulted: not the clock, and not a settings file that might
 * have been edited after the question was posted.
 *
 * Questions released with a VHP snapshot (model.vhp, model.voidVhpSwing) also use the VHP readings the bot took while
 * the window was open (see vhpSwingCheck). All readings are published, so anyone can check the decision.
 *
 * The window is inclusive on both ends. The closing block — the last block in which a player answer
 * can still be included, the height just before windowStart — is not one of the blocks the question
 * asks about, so it never changes the result. The block after windowEnd does not either.
 */
import { createHash } from "node:crypto";
import { fmt, optionFor, type Blk } from "./common.ts";

/** What the contract stores for a voided question. A real option is posted as 0, 1, 2, … and the contract adds 1. */
export const CHAIN_VOID = 1000;

/** The void rule shipped with question model v5. Used only when an older question file did not save its own copy. */
export const VOID_ALPHA_V5 = 0.001;
export const MIN_VOID_BLOCKS_V5 = 600;

const KINDS: Record<string, "single" | "h2h" | "combo" | "tail" | "agg"> = {
  E1: "single", E3: "single", M1: "single", M9: "single", H1: "single", E1s: "single", H3: "single",
  E2: "h2h", E2s: "h2h",
  H2: "combo", H2s: "combo",
  M10: "tail",
  M4: "agg", M5: "agg", M6: "agg", M7: "agg",
};

export type QuestionInput = {
  id?: string;
  template: string;
  subjects: string[];
  group?: string[];
  unit: string;
  windowStart: number;
  windowEnd: number;
  thresholds: number[];
  options?: { index: number }[];
  model?: { rates?: Record<string, number>; voidAlpha?: number; minVoidBlocks?: number;
    /** VHP (in 1e-8 units, as text) of each producer the question is about, or of the whole network ("network"), read
     *  at release; and the largest change (0.10 = 10%) allowed by the window's end before the question is void. */
    vhp?: Record<string, string>; vhpHeight?: number; voidVhpSwing?: number };
};

/** A VHP reading: the block height it was taken at (at the latest) and the same keys as model.vhp. Only readings
 *  whose height is inside the question's window count (see vhpSwingCheck). */
export type VhpReading = { height: number; readAt?: string; values: Record<string, string> };

/** Key used for the whole network's VHP (the VHP token's total supply) in model.vhp. */
export const NETWORK_VHP = "network";

/** Fields the bot adds to a question file after it was released. They are not part of the published parameters. */
const AFTER_RELEASE = ["paramsHash", "result", "text", "title", "options", "chainId", "chainOutcome", "postSkipped", "vhpEnd", "vhpReadings", "corrections", "chainDataHash"];

/** Released with hashRule 2 or later: the wording players see (title, text, option labels and ranges) is hashed too. */
export const HASH_RULE = 2;
const WORDING = ["title", "text", "options"];

/** The params hash published on chain: sha256 of the question as released, without the bot's later bookkeeping.
 *  Questions released with hashRule ≥ 2 include their wording; older ones keep the rule they were posted with (no
 *  wording). Anyone can recompute it from the public question file. */
export function paramsHashOf(q: Record<string, any>): string {
  const withWording = Number(q.hashRule ?? 0) >= HASH_RULE;
  const canonical: Record<string, any> = {};
  for (const [k, v] of Object.entries(q)) if (!AFTER_RELEASE.includes(k) || (withWording && WORDING.includes(k))) canonical[k] = v;
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Whose VHP decides a VHP-swing void: the producers a question is about (every member of a group question), or the
 *  whole network for network-wide questions (M4–M7). */
export function vhpSubjects(q: Pick<QuestionInput, "template" | "subjects" | "group">): string[] {
  const kind = KINDS[q.template];
  if (kind === "agg") return [NETWORK_VHP];
  if (kind === "tail") return [...(q.group ?? [])];
  return [...(q.subjects ?? [])];
}

/** "Void if a producer it is about (or the network) gained or lost MORE than voidVhpSwing of its VHP, compared with
 *  the release snapshot, in any VHP reading taken during the window." Exact integer arithmetic:
 *  |reading − release| × 1,000,000 > release × round(swing × 1,000,000).
 *  - Only readings with windowStart ≤ height ≤ windowEnd count. A reading taken after the window's last block never
 *    voids (by then the outcome is public), whatever it shows.
 *  - With no reading inside the window at all, the rule is skipped and the question resolves on its blocks alone.
 *  - A subject whose release VHP is 0 is not checked (any amount would be an infinite change). */
export function vhpSwingCheck(q: QuestionInput, readings: VhpReading[]):
  | { ok: true; swung: string[]; heights: number[]; detail: Record<string, { release: string; end: string; change: string; height?: number }> }
  | { ok: false; pending: boolean; reason: string } {
  const start = q.model?.vhp ?? {};
  const limit = q.model?.voidVhpSwing ?? 0;
  const ppm = BigInt(Math.round(limit * 1_000_000));
  const inWindow = readings.filter((r) => Number.isInteger(r?.height) && r.height >= q.windowStart && r.height <= q.windowEnd)
    .sort((a, b) => a.height - b.height);
  const swung: string[] = [], detail: Record<string, { release: string; end: string; change: string; height?: number }> = {};
  for (const who of vhpSubjects(q)) {
    if (start[who] === undefined) return { ok: false, pending: false, reason: `the release snapshot has no VHP for ${who}` };
    const a = BigInt(start[who]);
    if (a === 0n) { detail[who] = { release: start[who], end: "", change: "not checked (no VHP at release)" }; continue; }
    // The reading with the largest change decides (the latest one on a tie).
    let best: { b: bigint; diff: bigint; height: number } | undefined;
    for (const r of inWindow) {
      if (r.values?.[who] === undefined || !/^\d+$/.test(String(r.values[who]))) {
        return { ok: false, pending: false, reason: `the VHP reading at block ${r.height} has no valid value for ${who}` };
      }
      const b = BigInt(r.values[who]), diff = b > a ? b - a : a - b;
      if (!best || diff >= best.diff) best = { b, diff, height: r.height };
    }
    if (!best) { detail[who] = { release: start[who], end: "", change: "no reading during the window" }; continue; }
    const pct = (Number((best.diff * 1_000_000n) / a) / 10_000).toFixed(2);
    detail[who] = { release: start[who], end: best.b.toString(), change: `${best.b >= a ? "+" : "−"}${pct}%`, height: best.height };
    if (best.diff * 1_000_000n > a * ppm) swung.push(who);
  }
  return { ok: true, swung, heights: inWindow.map((r) => r.height), detail };
}

export type AnswerResult = {
  void: boolean;
  option?: number;
  value: string;
  dataHash: string;
  reason?: string;
  resolvedAt: string;
  /** The VHP-swing rule's inputs and outcome (questions released with a VHP snapshot only): the heights of the readings
   *  taken during the window, and per subject the reading with the largest change. `skipped` says why the rule was not
   *  applied (no reading during the window). */
  vhpCheck?: { limit: number; releaseHeight?: number; readings: number[]; skipped?: string;
    values: Record<string, { release: string; end: string; change: string; height?: number }> };
};

export type ScoreOutcome =
  | { ok: true; result: AnswerResult }
  | { ok: false; pending: boolean; reason: string };

/** The number the bot sends to resolve_question. The contract turns option 0 into stored outcome 1, and 1000 stays void. */
export function chainOutcome(result: { void: boolean; option?: number }): number {
  if (result.void) return CHAIN_VOID;
  if (result.option === undefined || !Number.isInteger(result.option) || result.option < 0) {
    throw new Error("a non-void answer has no option");
  }
  return result.option;
}

/** The outcome stored on the question after the contract accepts chainOutcome (option 0 is stored as 1). */
export function storedOutcome(result: { void: boolean; option?: number }): number {
  const posted = chainOutcome(result);
  return posted === CHAIN_VOID ? CHAIN_VOID : posted + 1;
}

/** Fingerprint of exactly the blocks the answer used, in height order. Anyone with those blocks gets the same hash. */
export function dataHashOf(win: Blk[]): string {
  return createHash("sha256").update(win.map((x) => `${x.h},${x.signer},${x.ts},${x.ntx}`).join("\n")).digest("hex");
}

function valueText(unit: string, value: number): string {
  return unit === "ms" ? (value / 1000).toFixed(3) + " s" : unit === "permille" ? (value / 10).toFixed(1) + "%" : fmt(value);
}

/**
 * Score `q` from `blocks`. Blocks outside [windowStart, windowEnd] are ignored. If the history
 * does not yet reach windowEnd, the result is pending (try again later) — it is never a void.
 * A hole or a duplicate inside the window is a hard failure: guessing would not be a 100% answer.
 */
export function scoreQuestion(q: QuestionInput, blocks: Blk[], opts: { vhpReadings?: VhpReading[]; vhpEnd?: VhpReading } = {}): ScoreOutcome {
  const kind = KINDS[q.template];
  if (!kind) return { ok: false, pending: false, reason: `unknown template ${q.template}` };
  if (!Number.isInteger(q.windowStart) || !Number.isInteger(q.windowEnd) || q.windowEnd < q.windowStart) {
    return { ok: false, pending: false, reason: "the window heights are not valid" };
  }
  const need = q.windowEnd - q.windowStart + 1;
  if (blocks.length === 0) return { ok: false, pending: true, reason: "no block history yet" };
  let maxH = -Infinity;
  for (const b of blocks) if (b.h > maxH) maxH = b.h;
  if (maxH < q.windowEnd) return { ok: false, pending: true, reason: "the window has not closed in the stored history" };

  const byH = new Map<number, Blk>();
  for (const b of blocks) {
    if (b.h < q.windowStart || b.h > q.windowEnd) continue;
    if (byH.has(b.h)) return { ok: false, pending: false, reason: `duplicate block at height ${b.h}` };
    byH.set(b.h, b);
  }
  if (byH.size !== need) {
    return { ok: false, pending: false, reason: `block history is missing ${need - byH.size} block(s) from ${q.windowStart} to ${q.windowEnd}` };
  }
  const win: Blk[] = [];
  for (let h = q.windowStart; h <= q.windowEnd; h++) win.push(byH.get(h)!);

  const dataHash = dataHashOf(win);
  const countOf = (who: string) => win.reduce((n, x) => n + (x.signer === who ? 1 : 0), 0);
  const width = win.length;
  const alpha = q.model?.voidAlpha ?? VOID_ALPHA_V5;
  const minVoid = q.model?.minVoidBlocks ?? MIN_VOID_BLOCKS_V5;
  const offline: string[] = [];
  for (const who of q.subjects ?? []) {
    const rate = q.model?.rates?.[who];
    if (typeof rate !== "number" || !(rate > 0 && rate < 1)) {
      return { ok: false, pending: false, reason: `no release-time rate for ${who}, so an offline check would be a guess` };
    }
    // Gaps are measured only inside the window. The block before windowStart is not treated as part of the absence.
    let last = -1, gap = 0;
    for (let i = 0; i < width; i++) if (win[i].signer === who) { gap = Math.max(gap, i - last - 1); last = i; }
    gap = Math.max(gap, width - 1 - last);
    const limit = Math.max(minVoid, Math.log(alpha / width) / Math.log(1 - rate));
    if (gap > limit) offline.push(who);
  }

  let value = 0, option = 0, text = "";
  if (kind === "h2h") {
    if (q.subjects.length < 2) return { ok: false, pending: false, reason: "a head-to-head question needs two producers" };
    value = countOf(q.subjects[0]) - countOf(q.subjects[1]);
    option = optionFor(value, q.thresholds);
  } else if (kind === "combo") {
    if (q.subjects.length < 4 || q.thresholds.length < 2) return { ok: false, pending: false, reason: "a combined question needs four producers and two lines" };
    const d1 = countOf(q.subjects[0]) - countOf(q.subjects[1]);
    const d2 = countOf(q.subjects[2]) - countOf(q.subjects[3]);
    value = d1;
    text = `line 1 = ${d1}, line 2 = ${d2}`;
    option = (d1 > q.thresholds[0] ? 2 : 0) + (d2 > q.thresholds[1] ? 1 : 0);
  } else if (kind === "tail") {
    value = (q.group ?? []).reduce((s, who) => s + countOf(who), 0);
    option = optionFor(value, q.thresholds);
  } else if (kind === "single") {
    if (q.subjects.length < 1) return { ok: false, pending: false, reason: "this question names no producer" };
    value = countOf(q.subjects[0]);
    option = optionFor(value, q.thresholds);
  } else {
    if (width < 2 && (q.template === "M4" || q.template === "M5")) {
      return { ok: false, pending: false, reason: "an interval question needs at least two blocks" };
    }
    const ts = win.map((x) => x.ts);
    value = q.template === "M4" ? Math.max(...ts.slice(1).map((t, i) => t - ts[i]))
      : q.template === "M5" ? Math.round((ts[ts.length - 1] - ts[0]) / (ts.length - 1))
      : q.template === "M6" ? Math.round((1000 * win.filter((x) => x.ntx === 0).length) / width)
      : win.reduce((s, x) => s + x.ntx, 0);
    option = optionFor(value, q.thresholds);
  }
  if (!Number.isInteger(option) || option < 0 || (q.options && option >= q.options.length)) {
    return { ok: false, pending: false, reason: `option ${option} is not one of the published choices` };
  }
  if (!text) text = valueText(q.unit, value);
  const resolvedAt = new Date(win[win.length - 1].ts).toISOString();
  // Questions released with a VHP snapshot: void when a producer it is about (or the network) moved its VHP too much.
  let swung: string[] = [], vhpCheck: AnswerResult["vhpCheck"];
  if (q.model?.vhp && q.model.voidVhpSwing !== undefined) {
    // vhpEnd: the single reading files from before this rule change carried. It counts like any other reading.
    const v = vhpSwingCheck(q, [...(opts.vhpReadings ?? []), ...(opts.vhpEnd ? [opts.vhpEnd] : [])]);
    if (!v.ok) return v;
    swung = v.swung;
    vhpCheck = { limit: q.model.voidVhpSwing, releaseHeight: q.model.vhpHeight, readings: v.heights, values: v.detail };
    if (!v.heights.length) vhpCheck.skipped = "no VHP reading was taken during the window";
  }
  const reasons: string[] = [];
  if (offline.length) reasons.push(`${offline.join(", ")} went offline during the window`);
  if (swung.length) reasons.push(`${swung.map((w) => (w === NETWORK_VHP ? "the network's VHP" : `${w}'s VHP`)).join(", ")} changed by more than ${q.model!.voidVhpSwing! * 100}% during the window`);
  const result: AnswerResult = reasons.length
    ? { void: true, reason: reasons.join("; "), value: text, dataHash, resolvedAt }
    : { void: false, option, value: text, dataHash, resolvedAt };
  if (vhpCheck) result.vhpCheck = vhpCheck;
  return { ok: true, result };
}
