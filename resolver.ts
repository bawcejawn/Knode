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
    vhp?: Record<string, string>; vhpHeight?: number; voidVhpSwing?: number;
    /** Below this chance of the remaining blocks changing the option, the answer counts as decided (see decidedHeight);
     *  0 = only when certain. Saved at release with the VHP rule; questions without it use DECIDED_CHANCE. */
    decidedChance?: number };
};

/** A VHP reading: the block height it was taken at (at the latest) and the same keys as model.vhp. Only readings
 *  whose height is inside the question's window count (see vhpSwingCheck). */
export type VhpReading = { height: number; readAt?: string; values: Record<string, string> };

/** Key used for the whole network's VHP (the VHP token's total supply) in model.vhp. */
export const NETWORK_VHP = "network";

/** Fields the bot adds to a question file after it was released. They are not part of the published parameters. */
const AFTER_RELEASE = ["paramsHash", "result", "text", "title", "options", "chainId", "chainOutcome", "postSkipped", "vhpEnd", "vhpReadings", "vhpSeal", "corrections", "chainDataHash"];

/** Released with hashRule 2 or later: the wording players see (title, text, option labels and ranges) is hashed too. */
export const HASH_RULE = 2;
const WORDING = ["title", "text", "options"];

/** The params hash published on chain: sha256 of the question as released, without the bot's later bookkeeping.
 *  Questions released with hashRule ≥ 2 include their wording; older ones keep the rule they were posted with (no
 *  wording). Anyone can recompute it from the public question file. */
export function paramsHashOf(q: Record<string, any>): string {
  const withWording = Number(q.hashRule ?? 0) >= HASH_RULE;
  const canonical: Record<string, any> = Object.create(null);   // so a "__proto__" member is a key like any other
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
 *  decided." Exact integer arithmetic: |reading − release| × 1,000,000 > release × round(swing × 1,000,000).
 *  - Only readings with windowStart ≤ height ≤ decidedHeight count (decidedHeight: the block from which the window's
 *    blocks already decide the option, see decidedHeight(); windowEnd by default). A reading taken after that block
 *    never voids (by then the outcome is public), whatever it shows.
 *  - A group question (M10) is checked on its members' combined VHP, not member by member.
 *  - With no reading counted, the rule is skipped and the question resolves on its blocks alone. `inWindow` says how
 *    many readings were taken in the window at all (all of them after decidedHeight when the answer was decided before
 *    the bot's first reading).
 *  - A subject whose release VHP is 0 is not checked (any amount would be an infinite change). */
export function vhpSwingCheck(q: QuestionInput, readings: VhpReading[], decidedAt = q.windowEnd):
  | { ok: true; swung: string[]; heights: number[]; inWindow: number; detail: Record<string, { release: string; end: string; change: string; height?: number }> }
  | { ok: false; pending: boolean; reason: string } {
  const start = q.model?.vhp ?? {};
  const limit = q.model?.voidVhpSwing ?? 0;
  const ppm = BigInt(Math.round(limit * 1_000_000));
  const last = Math.min(decidedAt, q.windowEnd);
  const all = readings.filter((r) => Number.isInteger(r?.height) && r.height >= q.windowStart && r.height <= q.windowEnd)
    .sort((a, b) => a.height - b.height);
  const inWindow = all.filter((r) => r.height <= last);
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
    detail[who] = { release: a.toString(), end: best.b.toString(), change: `${best.b >= a ? "+" : "−"}${pct}%`, height: best.height };
    if (best.diff * 1_000_000n > a * ppm) swung.push(who);
  }
  return { ok: true, swung, heights: inWindow.map((r) => r.height), inWindow: all.length, detail };
}

/** Default for model.decidedChance: below this chance of changing, the answer counts as decided. */
export const DECIDED_CHANCE = 1e-9;

/** An upper bound on a block rate that holds except with probability δ, after `k` blocks out of `n` (Chernoff:
 *  P(K ≤ k) ≤ exp(−(μ − k)² / 2μ) for K with mean μ = n·p). */
export function rateUpper(k: number, n: number, delta: number): number {
  if (n <= 0) return 1;
  const L = Math.log(1 / delta);
  return Math.min(1, (k + L + Math.sqrt(L * L + 2 * k * L)) / n);
}

/** An upper bound on P(X ≥ m) for X binomial(r, p) (Chernoff: exp(−μ)(eμ/m)^m when m > μ = r·p). */
export function upperTail(r: number, p: number, m: number): number {
  if (m <= 0) return 1;
  if (m > r) return 0;
  const mu = r * p;
  if (m <= mu) return 1;
  return Math.exp(m - mu + m * Math.log(mu / m));
}

/** The height of the block from which the window's blocks already decide the option, or windowEnd when that cannot be
 *  told earlier. VHP readings taken after it never void, and the offline rule stops looking there.
 *  - Certain: no way the remaining blocks could change the option (each block adds at most 1 to a producer's or a
 *    group member's count, and moves a difference by at most 1). A longest gap or a transaction count is certain only
 *    once it passed the top threshold; an average interval only at the last block.
 *  - Statistically decided (model.decidedChance, default 1e-9; 0 = certain only): the chance that the remaining blocks
 *    change the option is below decidedChance. Each producer that could move the answer is taken to produce each
 *    remaining block at most at rateUpper() of its own blocks so far in this window (the empty-block share likewise),
 *    and the chance is the sum of the Chernoff bounds (upperTail) of every way the option could change, plus the chance
 *    that a rate bound is wrong. Counts, differences and the empty-block share only; the network's transactions, gaps
 *    and intervals have no such model. */
export function decidedHeight(q: QuestionInput, win: Blk[]): number {
  const kind = KINDS[q.template], t = q.thresholds, top = t[t.length - 1], n = win.length;
  if (!n || !t.length) return q.windowEnd;
  const chance = q.model?.decidedChance ?? DECIDED_CHANCE;
  // Each rate bound may be wrong with probability chance/8 (at most four are used); the tails get the other half.
  const delta = chance / 8, tailBudget = chance / 2;
  const up = (k: number, i: number) => rateUpper(k, i + 1, delta);
  /** Smallest value above v that gives another option, or undefined at the top. */
  const nextAbove = (v: number, th: number[]) => { const o = optionFor(v, th); return o < th.length ? th[o] + 1 : undefined; };
  /** Largest value below v that gives another option, or undefined at the bottom. */
  const nextBelow = (v: number, th: number[]) => { const o = optionFor(v, th); return o > 0 ? th[o - 1] : undefined; };
  if (kind === "single" || kind === "tail") {
    // A group member listed twice counts twice (as scoreQuestion counts it), so a block can add up to `most`.
    const weight = new Map<string, number>();
    for (const w of kind === "single" ? [q.subjects[0]] : q.group ?? []) weight.set(w, (weight.get(w) ?? 0) + 1);
    const most = Math.max(1, ...weight.values());
    let v = 0, hits = 0;
    for (let i = 0; i < n; i++) {
      const w = weight.get(win[i].signer) ?? 0;
      v += w; if (w) hits++;
      const r = n - 1 - i, next = nextAbove(v, t);
      if (next === undefined || next > v + r * most) return win[i].h;
      if (chance > 0 && upperTail(r, up(hits, i), Math.ceil((next - v) / most)) < tailBudget) return win[i].h;
    }
    return q.windowEnd;
  }
  if (q.template === "M7" || q.template === "M4") {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = q.template === "M7" ? v + win[i].ntx : i ? Math.max(v, win[i].ts - win[i - 1].ts) : 0;
      if (v > top) return win[i].h;
    }
    return q.windowEnd;
  }
  /** The chance that a difference now at d changes option over r blocks, with the producers' counts so far. */
  const lineChance = (d: number, th: number[], r: number, i: number, kUp: number, kDown: number) => {
    const hi = nextAbove(d, th), lo = nextBelow(d, th);
    const rise = hi === undefined ? 0 : hi - d, fall = lo === undefined ? 0 : d - lo;
    if ((hi === undefined || rise > r) && (lo === undefined || fall > r)) return 0;   // certain
    if (chance <= 0) return 1;
    return (hi === undefined ? 0 : upperTail(r, up(kUp, i), rise)) + (lo === undefined ? 0 : upperTail(r, up(kDown, i), fall));
  };
  if (kind === "h2h" || kind === "combo") {
    const [a, b, c, d] = q.subjects;
    let ka = 0, kb = 0, kc = 0, kd = 0;
    for (let i = 0; i < n; i++) {
      const s = win[i].signer, r = n - 1 - i;
      ka += s === a ? 1 : 0; kb += s === b ? 1 : 0; kc += s === c ? 1 : 0; kd += s === d ? 1 : 0;
      const p = kind === "h2h" ? lineChance(ka - kb, t, r, i, ka, kb)
        : lineChance(ka - kb, [t[0]], r, i, ka, kb) + lineChance(kc - kd, [t[1]], r, i, kc, kd);
      if (p === 0 || p < tailBudget) return win[i].h;
    }
    return q.windowEnd;
  }
  if (q.template === "M6") {
    let e = 0;
    for (let i = 0; i < n; i++) {
      if (win[i].ntx === 0) e++;
      const r = n - 1 - i, now = Math.round((1000 * e) / n), o = optionFor(now, t);
      if (o === optionFor(Math.round((1000 * (e + r)) / n), t)) return win[i].h;
      if (chance > 0) {
        // The fewest further empty blocks that move the share into the next option (round(x) > T once x ≥ T + 0.5).
        let m = Math.max(1, Math.ceil(((t[o] + 0.5) * n) / 1000) - e - 1);
        while (m <= r && optionFor(Math.round((1000 * (e + m)) / n), t) === o) m++;
        if (upperTail(r, up(e, i), m) < tailBudget) return win[i].h;
      }
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
  vhpCheck?: { limit: number; releaseHeight?: number; decidedHeight?: number; readings: number[]; readingsInWindow?: number; skipped?: string;
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
  const alpha = q.model?.voidAlpha ?? VOID_ALPHA_V5;
  const minVoid = q.model?.minVoidBlocks ?? MIN_VOID_BLOCKS_V5;
  const offline: string[] = [];
  // Questions released with the VHP-swing rule: a silence after the answer was decided no longer voids (the outcome is
  // public by then). Older questions keep looking at every block of the window.
  const vhpRule = !!q.model?.vhp && q.model.voidVhpSwing !== undefined;
  const decided = vhpRule ? decidedHeight(q, win) : q.windowEnd;
  const width = win.length, upTo = decided - q.windowStart + 1;
  for (const who of q.subjects ?? []) {
    const rate = q.model?.rates?.[who];
    if (typeof rate !== "number" || !(rate > 0 && rate < 1)) {
      return { ok: false, pending: false, reason: `no release-time rate for ${who}, so an offline check would be a guess` };
    }
    // Gaps are measured only inside the window. The block before windowStart is not treated as part of the absence.
    let last = -1, gap = 0;
    for (let i = 0; i < upTo; i++) if (win[i].signer === who) { gap = Math.max(gap, i - last - 1); last = i; }
    gap = Math.max(gap, upTo - 1 - last);
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
    const v = vhpSwingCheck(q, [...(opts.vhpReadings ?? []), ...(opts.vhpEnd ? [opts.vhpEnd] : [])], decided);
    if (!v.ok) return v;
    swung = v.swung;
    vhpCheck = { limit: q.model.voidVhpSwing, releaseHeight: q.model.vhpHeight, decidedHeight: decided, readings: v.heights, readingsInWindow: v.inWindow, values: v.detail };
    if (!v.heights.length) {
      vhpCheck.skipped = v.inWindow
        ? `the window's blocks decided the answer at block ${decided}, before the first VHP reading`
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
