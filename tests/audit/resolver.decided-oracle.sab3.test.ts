// Red-team SABOTEUR (fix check d198283): decidedHeight() (resolver.ts:147-186) must never call a question decided TOO
// EARLY: if it did, a real VHP swing taken between its height and the true decision would be ignored and a manipulated
// question would resolve instead of voiding. Randomised, deterministic histories for every template kind; at the
// returned height (when before windowEnd) an independent oracle checks that NO completion of the window could change
// the option, and that the option equals the final one.
// Expected to PASS (control): a failure prints the template, seed and window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidedHeight, scoreQuestion } from "../../resolver.ts";

const T0 = 1_792_627_200_000;
const optionOf = (v: number, t: number[]) => t.filter((x) => v > x).length;
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const [A, B, C, D, F] = ["1AAA", "1BBB", "1CCC", "1DDD", "1FFF"];

type W = { h: number; ts: number; signer: string; ntx: number; compute: number };
/** Exact (own) value of a prefix [0..k] of the window, per template. */
function prefix(tpl: string, w: W[], k: number) {
  let a = 0, b = 0, c = 0, d = 0, ntx = 0, empty = 0, gap = 0;
  for (let i = 0; i <= k; i++) {
    const s = w[i].signer;
    a += s === A ? 1 : 0; b += s === B ? 1 : 0; c += s === C ? 1 : 0; d += s === D ? 1 : 0;
    ntx += w[i].ntx; empty += w[i].ntx === 0 ? 1 : 0;
    if (i > 0) gap = Math.max(gap, w[i].ts - w[i - 1].ts);
  }
  return { a, b, c, d, ntx, empty, gap };
}
/** True when no completion of the window after index k could give a different option than `final`. */
function certain(tpl: string, w: W[], k: number, t: number[], final: number): boolean {
  const n = w.length, r = n - 1 - k, p = prefix(tpl, w, k);
  const all = (vals: number[], f: (v: number) => number) => vals.every((v) => f(v) === final);
  const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  switch (tpl) {
    case "M9": return all(range(p.a, p.a + r), (v) => optionOf(v, t));
    case "M10": return all(range(p.a + p.b, p.a + p.b + r), (v) => optionOf(v, t));
    case "E2s": return all(range(p.a - p.b - r, p.a - p.b + r), (v) => optionOf(v, t));
    case "H2s": {
      for (let x = -r; x <= r; x++) for (let y = -(r - Math.abs(x)); y <= r - Math.abs(x); y++) {
        const o = (p.a - p.b + x > t[0] ? 2 : 0) + (p.c - p.d + y > t[1] ? 1 : 0);
        if (o !== final) return false;
      }
      return true;
    }
    case "M6": return all(range(p.empty, p.empty + r), (e) => optionOf(Math.round((1000 * e) / n), t));
    case "M7": return optionOf(p.ntx, t) === t.length && final === t.length; // more transactions can always come
    case "M4": return optionOf(p.gap, t) === t.length && final === t.length; // a longer gap can always come
    default: return false; // M5: the average is not fixed before the last block
  }
}
function thresholdsAround(v: number, spread: number, k: number, R: () => number) {
  const s = new Set<number>();
  while (s.size < k) s.add(v + Math.round((R() * 2 - 1) * spread));
  return [...s].sort((x, y) => x - y);
}

test("SAB3-8 (control): decidedHeight is never earlier than the true decision, for every template kind", () => {
  const tpls = ["M9", "M10", "E2s", "H2s", "M6", "M7", "M4", "M5"];
  let early = 0, checked = 0;
  const fails: string[] = [];
  for (const tpl of tpls) for (let seed = 1; seed <= 250; seed++) {
    const R = rng(seed * 101 + tpl.charCodeAt(0) * 7 + tpl.length);
    const n = 30 + Math.floor(R() * 120);
    const weights = [A, B, C, D, F].map(() => R());
    const sum = weights.reduce((s, x) => s + x, 0);
    const pEmpty = R();
    const w: W[] = [];
    let ts = T0;
    for (let i = 0; i < n; i++) {
      let u = R() * sum, j = 0;
      while (u > weights[j] && j < 4) { u -= weights[j]; j++; }
      if (i > 0) ts += R() < 0.05 ? 3000 + Math.floor(R() * 20000) : 2900 + Math.floor(R() * 300);
      w.push({ h: 5000 + i, ts, signer: [A, B, C, D, F][j], ntx: R() < pEmpty ? 0 : 1 + Math.floor(R() * 3), compute: 0 });
    }
    const p = prefix(tpl, w, n - 1);
    let t: number[], final: number;
    if (tpl === "H2s") {
      t = [p.a - p.b + Math.round((R() * 2 - 1) * 6), p.c - p.d + Math.round((R() * 2 - 1) * 6)];
      final = (p.a - p.b > t[0] ? 2 : 0) + (p.c - p.d > t[1] ? 1 : 0);
    } else {
      const v = tpl === "M9" ? p.a : tpl === "M10" ? p.a + p.b : tpl === "E2s" ? p.a - p.b : tpl === "M6" ? Math.round((1000 * p.empty) / n)
        : tpl === "M7" ? p.ntx : tpl === "M4" ? p.gap : Math.round((w[n - 1].ts - w[0].ts) / (n - 1));
      const spread = tpl === "M6" ? 150 : tpl === "M4" ? 6000 : tpl === "M5" ? 300 : tpl === "M7" ? n : Math.max(4, n / 4);
      t = thresholdsAround(v, spread, tpl === "E2s" ? 1 : 3, R);
      final = optionOf(v, t);
    }
    const q: any = {
      template: tpl, unit: "count", windowStart: 5000, windowEnd: 5000 + n - 1, thresholds: t,
      subjects: tpl === "M9" ? [A] : tpl === "E2s" ? [A, B] : tpl === "H2s" ? [A, B, C, D] : [],
      group: tpl === "M10" ? [A, B] : undefined,
      model: { rates: { [A]: 0.2, [B]: 0.2, [C]: 0.2, [D]: 0.2 }, minVoidBlocks: 100000 },
    };
    // Cross-check the oracle's final option with scoreQuestion's (same blocks, no VHP rule).
    const s = scoreQuestion(q, w);
    if (s.ok && s.result.option !== undefined && s.result.option !== final) fails.push(`${tpl} seed ${seed}: oracle option ${final} != scoreQuestion ${s.result.option}`);
    const h = decidedHeight(q, w);
    if (!Number.isInteger(h) || h < q.windowStart || h > q.windowEnd) { fails.push(`${tpl} seed ${seed}: decidedHeight ${h} outside the window`); continue; }
    if (h === q.windowEnd) continue;
    checked++;
    if (!certain(tpl, w, h - q.windowStart, t, final)) { early++; fails.push(`${tpl} seed ${seed}: decidedHeight ${h} (index ${h - q.windowStart} of ${n}) but the option could still change; thresholds ${JSON.stringify(t)}`); }
  }
  assert.ok(checked > 100, `setup: enough early decisions were exercised (${checked})`);
  assert.equal(fails.length, 0, `SAB3-8: ${early} too-early decision(s):\n${fails.slice(0, 15).join("\n")}`);
});
