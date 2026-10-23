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

/** Key used for a group question's combined VHP (the sum of its members') in the VHP-swing check. */
export const GROUP_VHP = "group";

/** "Void if a producer it is about (or the network, or a group's combined VHP) gained or lost MORE than voidVhpSwing of
 *  its VHP, compared with the release snapshot, in any VHP reading taken during the window before the outcome was
 *  certain." Exact integer arithmetic: |reading − release| × 1,000,000 > release × round(swing × 1,000,000).
 *  - Only readings with windowStart ≤ height ≤ decidedHeight count (decidedHeight: the block from which the window's
 *    blocks already decide the option, see decidedHeight(); windowEnd by default). A reading taken after that block
 *    never voids (by then the outcome is public), whatever it shows.
 *  - A group question (M10) is checked on its members' combined VHP, not member by member.
 *  - With no reading counted at all, the rule is skipped and the question resolves on its blocks alone.
 *  - A subject whose release VHP is 0 is not checked (any amount would be an infinite change). */
export function vhpSwingCheck(q: QuestionInput, readings: VhpReading[], decidedAt = q.windowEnd):
  | { ok: true; swung: string[]; heights: number[]; detail: Record<string, { release: string; end: string; change: string; height?: number }> }
  | { ok: false; pending: boolean; reason: string } {
  const start = q.model?.vhp ?? {};
  const limit = q.model?.voidVhpSwing ?? 0;
  const ppm = BigInt(Math.round(limit * 1_000_000));
  const last = Math.min(decidedAt, q.windowEnd);
  const inWindow = readings.filter((r) => Number.isInteger(r?.height) && r.height >= q.windowStart && r.height <= last)
    .sort((a, b) => a.height - b.height);
  const group = KINDS[q.template] === "tail";
  const members = vhpSubjects(q);
  for (const who of members) if (start[who] === undefined) return { ok: false, pending: false, reason: `the release snapshot has no VHP for ${who}` };
  // The value of one checked subject in a reading (a group's is the sum of its members').
  const valueOf = (r: VhpReading, who: string): bigint | string => {
    const ws = who === GROUP_VHP ? members : [who];
    let s = 0n;
    for (const w of ws) {
      if (r.values?.[w] === undefined || !/^\d+$/.test(String(r.values[w]))) return `the VHP reading at block ${r.height} has no valid value for ${w}`;
      s += BigInt(r.values[w]);
    }
    return s;
  };
  const releaseOf = (who: string) => (who === GROUP_VHP ? members.reduce((s, w) => s + BigInt(start[w]), 0n) : BigInt(start[who]));
  const swung: string[] = [], detail: Record<string, { release: string; end: string; change: string; height?: number }> = {};
  for (const who of group ? [GROUP_VHP] : members) {
    const a = releaseOf(who);
    if (a === 0n) { detail[who] = { release: a.toString(), end: "", change: "not checked (no VHP at release)" }; continue; }
    // The reading with the largest change decides (the latest one on a tie).
    let best: { b: bigint; diff: bigint; height: number } | undefined;
    for (const r of inWindow) {
      const b = valueOf(r, who);
      if (typeof b === "string") return { ok: false, pending: false, reason: b };
      const diff = b > a ? b - a : a - b;
      if (!best || diff >= best.diff) best = { b, diff, height: r.height };
    }
    if (!best) { detail[who] = { release: a.toString(), end: "", change: "no reading during the window" }; continue; }
    const pct = (Number((best.diff * 1_000_000n) / a) / 10_000).toFixed(2);
    detail[who] = { release: start[who], end: best.b.toString(), change: `${best.b >= a ? "+" : "−"}${pct}%`, height: best.height };
    if (best.diff * 1_000_000n > a * ppm) swung.push(who);
  }
  return { ok: true, swung, heights: inWindow.map((r) => r.height), detail };
}

/** The height of the block from which the window's blocks already decide the option (the question's outcome became
 *  certain), or windowEnd when that cannot be told earlier. VHP readings taken after it never void.
 *  - Over/under counts (one producer's blocks, a group's blocks, the network's transactions) and the longest interval:
 *    the value only grows, so the block where it passed the top threshold.
 *  - Head-to-head and combined differences: the block after which even every remaining block going one way could not
 *    change the option (each block moves a difference by at most 1).
 *  - Share of empty blocks: the block after which neither all-empty nor no-empty remaining blocks change the option.
 *  - Average interval: not knowable before the last block (windowEnd).
 *  The offline-void rule is separate: it still applies to every block of the window. */
export function decidedHeight(q: QuestionInput, win: Blk[]): number {
  const kind = KINDS[q.template], t = q.thresholds, top = t[t.length - 1], n = win.length;
  if (!n || !t.length) return q.windowEnd;
  const passedTop = (step: (i: number) => number) => {
    let v = 0;
    for (let i = 0; i < n; i++) { v += step(i); if (v > top) return win[i].h; }
    return q.windowEnd;
  };
  const is = (who: string) => (i: number) => (win[i].signer === who ? 1 : 0);
  if (kind === "single") return passedTop(is(q.subjects[0]));
  if (kind === "tail") { const g = new Set(q.group ?? []); return passedTop((i) => (g.has(win[i].signer) ? 1 : 0)); }
  if (q.template === "M7") return passedTop((i) => win[i].ntx);
  if (q.template === "M4") {
    let g = 0;
    for (let i = 1; i < n; i++) { g = Math.max(g, win[i].ts - win[i - 1].ts); if (g > top) return win[i].h; }
    return q.windowEnd;
  }
  const sure = (lo: number, hi: number, th: number[]) => optionFor(lo, th) === optionFor(hi, th);
  if (kind === "h2h" || kind === "combo") {
    const [a, b, c, d] = q.subjects;
    let d1 = 0, d2 = 0;
    for (let i = 0; i < n; i++) {
      const s = win[i].signer, r = n - 1 - i;
      d1 += (s === a ? 1 : 0) - (s === b ? 1 : 0);
      if (kind === "h2h") { if (sure(d1 - r, d1 + r, t)) return win[i].h; continue; }
      d2 += (s === c ? 1 : 0) - (s === d ? 1 : 0);
      if (sure(d1 - r, d1 + r, [t[0]]) && sure(d2 - r, d2 + r, [t[1]])) return win[i].h;
    }
    return q.windowEnd;
  }
  if (q.template === "M6") {
    let e = 0;
    for (let i = 0; i < n; i++) {
      if (win[i].ntx === 0) e++;
      const r = n - 1 - i;
      if (sure(Math.round((1000 * e) / n), Math.round((1000 * (e + r)) / n), t)) return win[i].h;
    }
  }
  return q.windowEnd;
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
  vhpCheck?: { limit: number; releaseHeight?: number; decidedHeight?: number; readings: number[]; skipped?: string;
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
    const decided = decidedHeight(q, win);
    const v = vhpSwingCheck(q, [...(opts.vhpReadings ?? []), ...(opts.vhpEnd ? [opts.vhpEnd] : [])], decided);
    if (!v.ok) return v;
    swung = v.swung;
    vhpCheck = { limit: q.model.voidVhpSwing, releaseHeight: q.model.vhpHeight, decidedHeight: decided, readings: v.heights, values: v.detail };
    if (!v.heights.length) {
      vhpCheck.skipped = decided < q.windowEnd
        ? `no VHP reading was taken during the window before block ${decided}, where its blocks decided the answer`
        : "no VHP reading was taken during the window";
    }
  }
  const reasons: string[] = [];
  if (offline.length) reasons.push(`${offline.join(", ")} went offline during the window`);
  if (swung.length) reasons.push(`${swung.map((w) => (w === NETWORK_VHP ? "the network's VHP" : w === GROUP_VHP ? "the group's combined VHP" : `${w}'s VHP`)).join(", ")} changed by more than ${q.model!.voidVhpSwing! * 100}% during the window`);
  const result: AnswerResult = reasons.length
    ? { void: true, reason: reasons.join("; "), value: text, dataHash, resolvedAt }
    : { void: false, option, value: text, dataHash, resolvedAt };
  if (vhpCheck) result.vhpCheck = vhpCheck;
  return { ok: true, result };
}
