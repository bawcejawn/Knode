// Replaces the audit's proof tests for AB-001 (resolver.audit-AB-001.test.ts) and AB-012
// (resolver-producer-steer.redteam.test.ts). Those asserted that nobody can move a result and that the project's own
// producers are never asked about. The owner chose to keep both (decision 2026-10: gaming is allowed; the Desk and the
// owner's node stay in questions), so instead this file tests what was decided:
//   1. the website and the docs say so in plain words;
//   2. the new VHP-swing void rule (game.json model.voidVhpSwing), on the real questions as the audit saw them;
//   3. the params hash covers the release snapshot, and every published hash still reproduces.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scoreQuestion, paramsHashOf, vhpSubjects, NETWORK_VHP } from "../../resolver.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const byT = (t: string) => structuredClone(day.questions.find((q: any) => q.template === t));
const DESK = "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR";
const FILLER = "1FillerCoreProducerXXXXXXXXXXXXXXX";

/** Blocks for a question's window where each producer signs at its published rate; the rest is filler. */
function history(q: any, ntx: (i: number) => number = () => 0) {
  const width = q.windowEnd - q.windowStart + 1;
  const sig: string[] = new Array(width).fill(FILLER);
  for (const [who, r] of Object.entries((q.model.rates ?? {}) as Record<string, number>)) {
    const n = Math.round(width * r);
    for (let j = 0; j < n; j++) {
      let i = Math.floor(((j + 0.5) * width) / n);
      while (i < width && sig[i] !== FILLER) i++;
      if (i < width) sig[i] = who;
    }
  }
  return sig.map((s, i) => ({ h: q.windowStart + i, ts: 1_792_627_200_000 + i * 3000, signer: s, ntx: ntx(i), compute: 0 }));
}
/** The question as the generator now releases it: with a VHP snapshot and the 10% limit. */
function withSnapshot(q: any, vhp = 1_000_000n * 100_000_000n) {
  q.model.vhp = Object.fromEntries(vhpSubjects(q).map((w) => [w, vhp.toString()]));
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  return q;
}
const endWith = (q: any, change: (who: string, start: bigint) => bigint) => ({
  height: q.windowEnd + 300,
  values: Object.fromEntries(vhpSubjects(q).map((w) => [w, change(w, BigInt(q.model.vhp[w])).toString()])),
});

// ───────────── 1. the disclosure ─────────────

test("the How it works page says plainly that anyone can influence results, and that the project's own producers take part", () => {
  const html = fs.readFileSync("site/index.html", "utf8");
  const how = html.slice(html.indexOf('id="view-how"'), html.indexOf("</section>", html.indexOf('id="view-how"')));
  assert.match(how, /Koinos is an open network/);
  assert.match(how, /stake VHP, run a block producer or send transactions/);
  assert.match(how, /influence the results/);
  assert.match(how, new RegExp(DESK));
  assert.match(how, /block-producer node of its own/);
  assert.match(how, /can appear in questions/);
  assert.match(how, /more than 10% of its VHP/);
});

test("the docs say the same, and explain the exact VHP-swing rule", () => {
  const md = fs.readFileSync("README.md", "utf8");
  assert.match(md, /## Open network: anyone can influence the results/);
  assert.match(md, new RegExp(DESK));
  assert.match(md, /block-producer node of its own/);
  assert.match(md, /voidVhpSwing/);
  assert.match(md, /first run at or after the window's last block/);
  const g = JSON.parse(fs.readFileSync("game-data/game.json", "utf8"));
  assert.equal(g.model.voidVhpSwing, 0.1, "game.json starts the rule at 10%");
});

test("(decision kept) sending transactions may move a network question: allowed and disclosed, not voided", () => {
  // The audit's AB-001 attack, unchanged: 40 cheap transactions move M7. With a VHP snapshot the question still counts
  // (the network's VHP did not move), because influencing results is part of the game.
  const q = withSnapshot(byT("M7"));
  const honest = Array.from({ length: 45 }, (_, k) => k * 100 + 7), extra = Array.from({ length: 40 }, (_, k) => k * 100 + 57);
  const end = endWith(q, (_w, a) => a);
  const before = scoreQuestion(q, history(q, (i) => (honest.includes(i) ? 1 : 0)), { vhpEnd: end });
  const after = scoreQuestion(q, history(q, (i) => (honest.includes(i) || extra.includes(i) ? 1 : 0)), { vhpEnd: end });
  assert.ok(before.ok && after.ok && !before.result.void && !after.result.void);
  assert.notEqual(after.result.option, before.result.option);
});

// ───────────── 2. the VHP-swing void ─────────────

test("a subject that gains or loses MORE than 10% of its VHP voids the question; exactly 10% does not", () => {
  const q = withSnapshot(byT("M9"));
  const blocks = history(q);
  const at = (f: (a: bigint) => bigint) => scoreQuestion(q, blocks, { vhpEnd: endWith(q, (_w, a) => f(a)) });
  const exact = at((a) => a + a / 10n);
  assert.ok(exact.ok && !exact.result.void, "+10.00% is not more than 10%");
  const over = at((a) => a + a / 10n + 1n);
  assert.ok(over.ok && over.result.void && /changed by more than 10%/.test(over.result.reason!), "+10% and one unit is void");
  const down = at((a) => (a * 88n) / 100n);
  assert.ok(down.ok && down.result.void, "−12% is void");
  assert.equal(down.ok && down.result.vhpCheck?.values[q.subjects[0]].change, "−12.00%");
  assert.equal(down.ok && down.result.vhpCheck?.endHeight, q.windowEnd + 300);
});

test("every member of a group question counts (M10, which names the Desk), and only members count", () => {
  const q = withSnapshot(byT("M10"));
  assert.ok(q.group.includes(DESK), "(context) the live group question names the Desk");
  const blocks = history(q);
  const desk = scoreQuestion(q, blocks, { vhpEnd: endWith(q, (w, a) => (w === DESK ? a * 2n : a)) });
  assert.ok(desk.ok && desk.result.void && desk.result.reason!.includes(DESK), "VHP swapped into the Desk voids the group question");
  const outsider = scoreQuestion(q, blocks, { vhpEnd: { ...endWith(q, (_w, a) => a), values: { ...endWith(q, (_w, a) => a).values, "1SomeoneElse": "1" } } });
  assert.ok(outsider.ok && !outsider.result.void);
});

test("network-wide questions (M4–M7) use the whole network's VHP", () => {
  for (const t of ["M5", "M6", "M7"]) {
    const q = withSnapshot(byT(t));
    assert.deepEqual(vhpSubjects(q), [NETWORK_VHP]);
    const calm = scoreQuestion(q, history(q), { vhpEnd: endWith(q, (_w, a) => a + a / 20n) });
    assert.ok(calm.ok && !calm.result.void, `${t}: +5% of the network is fine`);
    const swing = scoreQuestion(q, history(q), { vhpEnd: endWith(q, (_w, a) => a - a / 5n) });
    assert.ok(swing.ok && swing.result.void && /the network's VHP/.test(swing.result.reason!), `${t}: −20% of the network voids it`);
  }
});

test("without the window-end reading a snapshot question waits; old questions keep their old rules", () => {
  const q = withSnapshot(byT("M9"));
  const r = scoreQuestion(q, history(q));
  assert.ok(!r.ok && r.pending && /VHP reading/.test(r.reason));
  const old = byT("M9");                                         // posted before the rule: no snapshot
  const o = scoreQuestion(old, history(old), { vhpEnd: { height: 1, values: {} } });
  assert.ok(o.ok && o.result.vhpCheck === undefined);
});

test("the offline void is unchanged, and both reasons are given when both apply", () => {
  const q = withSnapshot(byT("M9"));
  const who = q.subjects[0];
  const silent = history(q).map((b) => (b.signer === who ? { ...b, signer: FILLER } : b));
  const r = scoreQuestion(q, silent, { vhpEnd: endWith(q, (_w, a) => a * 2n) });
  assert.ok(r.ok && r.result.void);
  assert.match(r.result.reason!, new RegExp(`${who} went offline during the window; ${who}'s VHP changed by more than 10%`));
  const offlineOnly = scoreQuestion(q, silent, { vhpEnd: endWith(q, (_w, a) => a) });
  assert.equal(offlineOnly.ok && offlineOnly.result.reason, `${who} went offline during the window`);
});

// ───────────── 3. the params hash ─────────────

test("the release snapshot is part of the published params hash", () => {
  const q = withSnapshot(byT("M9"));
  const h = paramsHashOf(q);
  const edited = structuredClone(q);
  edited.model.vhp[q.subjects[0]] = "1";
  assert.notEqual(paramsHashOf(edited), h);
  const later = { ...structuredClone(q), chainId: 7, chainOutcome: 2, vhpEnd: { height: 1, values: {} }, result: {}, corrections: [] };
  assert.equal(paramsHashOf(later), h, "what the bot adds after release does not change it");
});

test("every published question still hashes to its paramsHash", () => {
  const dir = "game-data/questions";
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    for (const q of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).questions ?? []) assert.equal(paramsHashOf(q), q.paramsHash, `${f} ${q.id}`);
  }
});
