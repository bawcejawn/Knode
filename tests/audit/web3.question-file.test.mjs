// Red-team (WEB ATTACKER, fix check d198283). Target: the params-hash gate in site/app.js (paramsHashOf :43-50,
// checkFiles :192-206, canAnswer :733) and what the page still shows from the question file that the hash does not
// cover (AFTER_RELEASE fields: chainId, chainOutcome, result, ...). Attacker: whoever can publish game-data/questions
// (a bad bot run, the merge step in bot.yml) but not deployment.json or the chain.
// The whole site/app.js runs in a vm with a fake DOM, fetch and contract; the final `start();` is replaced by a hook
// that exposes S, loadQuestions, questionCard, renderResults and paramsHashOf. Each case asserts the SAFE behaviour,
// so a failing case is a proven problem. Offline, nothing is fetched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const APP = process.env.APP || ".";
const src = fs.readFileSync(`${APP}/app.js`, "utf8");
const END = /\r?\n  start\(\);\r?\n\}\)\(\);\s*$/;
assert.match(src, END, "site/app.js ends with start(); })();");
const patched = src.replace(END, "\n  globalThis.__T = { S, loadQuestions, questionCard, renderResults, paramsHashOf };\n})();\n");

// ── fake DOM ──
function mk(tag) {
  let text = "";
  const e = {
    tag, nodeType: 1, attrs: {}, on: {}, children: [], hidden: false, style: {}, dataset: {}, value: "", className: "",
    setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; }, getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(t, f) { this.on[t] = f; }, append(...k) { this.children.push(...k); }, replaceChildren(...k) { this.children = k; text = ""; },
    remove() {}, focus() {}, showModal() {}, querySelector: () => mk("div"), querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
  Object.defineProperty(e, "textContent", { get: () => text + e.children.map(textOf).join(""), set: (v) => { text = String(v); e.children = []; } });
  Object.defineProperty(e, "nextElementSibling", { get: () => mk("span") });
  return e;
}
const textOf = (n) => (n == null ? "" : typeof n === "string" ? n : n.textContent);
const walk = (n, out = []) => { if (n && typeof n === "object") { out.push(n); for (const c of n.children || []) walk(c, out); } return out; };
const optButtons = (card) => walk(card).filter((n) => n.tag === "button" && /\bopt\b/.test(n.className));
const byClass = (root, cls) => walk(root).filter((n) => typeof n.className === "string" && n.className.split(/\s+/).includes(cls));

function harness() {
  const els = new Map();
  const files = new Map();             // "./game-data/<path>" -> JSON text
  const chain = new Map();             // question id -> { params_hash, outcome } ; null = read fails
  const store = new Map();
  const ctx = {
    document: {
      querySelector: (s) => { if (!els.has(s)) els.set(s, mk("div")); return els.get(s); },
      querySelectorAll: () => [], createElement: mk, getElementById: () => null, head: mk("head"), body: mk("body"),
    },
    location: { pathname: "/", search: "", hash: "", href: "https://knode.test/" },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    crypto: webcrypto, TextEncoder, Uint8Array,
    fetch: async (url) => {
      const t = files.get(String(url));
      if (t === undefined) return { ok: false, status: 404, json: async () => { throw new Error("404"); } };
      return { ok: true, status: 200, json: async () => JSON.parse(t) };
    },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  };
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.scrollTo = () => {};
  vm.createContext(ctx);
  vm.runInContext(patched, ctx);
  const T = ctx.__T;
  // uint32 arguments are encoded with >>> 0, as protobufjs does for get_question's id.
  T.S.game = { functions: { get_question: async ({ id }) => {
    const q = chain.get(Number(id) >>> 0);
    if (q === null) throw new Error("rpc down");
    return { result: q ? { question: { params_hash: q.params_hash, outcome: q.outcome ?? 0, ...(q.facts ?? {}) } } : {} };
  } } };
  const publish = (questions, raw) => {
    files.set("./game-data/index.json", JSON.stringify({ days: ["questions/W001-D2.json"] }));
    files.set("./game-data/questions/W001-D2.json", raw ?? JSON.stringify({ week: 1, day: 2, questions }));
  };
  return { T, S: T.S, chain, publish, $: ctx.document.querySelector };
}

const A = "14f34kUNZugf2DK4hPJGy4AkmBM7Y4pvVu", B = "1G2QjRtNwEfqGwX7SMD8LNjWgJdWA7XtSU";
/** A question as the bot releases it (hashRule 2: wording hashed), before it gets its chain id. */
function released(n = 1, { hashRule = 2, lockIn = 86400000 } = {}) {
  const q = {
    id: `W001-D2-${n}`, date: "W001-D2", week: 1, day: 2, tier: "Easy", template: "E2s",
    releaseHeight: 40500000, lockHeight: 40514700, lockTime: Date.now() + lockIn,
    title: "Head-to-head with spread",
    text: `Producer ${A}'s blocks minus producer ${B}'s blocks, between block 40,514,701 and block 40,524,700: will the difference be more than 298?`,
    subjects: [A, B], unit: "count", windowStart: 40514701 + n, windowEnd: 40524700 + n, thresholds: [298],
    options: [{ index: 0, label: "No — 298 or less", min: null, max: 298 }, { index: 1, label: "Yes — 299 or more", min: 299, max: null }],
  };
  if (hashRule != null) q.hashRule = hashRule;
  return q;
}
/** Posts q as the contract stores it: its fingerprint plus the lock time, window and option count it enforces. */
const factsOf = (q) => ({ k: (q.options || []).length, lock_time: String(q.lockTime ?? 0), window_start: String(q.windowStart ?? 0), window_end: String(q.windowEnd ?? 0) });
async function post(h, id, q, outcome = 0) { h.chain.set(id, { params_hash: await h.T.paramsHashOf(structuredClone(q)), outcome, facts: factsOf(q) }); }
const qOf = (h, id) => h.S.questions.find((q) => Number(q.chainId) === id);

test("WEB3-01 control: a published file identical to what was posted is offered; a relabelled one is not", async () => {
  const h = harness();
  const q = released(1);
  await post(h, 5, q);
  h.publish([{ ...structuredClone(q), chainId: 5 }]);
  await h.T.loadQuestions();
  assert.equal(qOf(h, 5).hashOk, true);
  assert.ok(optButtons(h.T.questionCard(qOf(h, 5), "open")).every((b) => b.attrs.disabled === undefined), "genuine question answerable");

  const h2 = harness();
  await post(h2, 5, q);
  const bad = { ...structuredClone(q), chainId: 5 };
  bad.options = [{ ...bad.options[0], label: "Yes — 299 or more" }, { ...bad.options[1], label: "No — 298 or less" }];
  h2.publish([bad]);
  await h2.T.loadQuestions();
  assert.equal(qOf(h2, 5).hashOk, false);
  assert.ok(optButtons(h2.T.questionCard(qOf(h2, 5), "open")).every((b) => b.attrs.disabled !== undefined), "relabelled question not answerable");
});

test("WEB3-02 an unhashed chainOutcome in the file must not mark an option 'correct' while answers are still open", async () => {
  const h = harness();
  const q = released(1);
  await post(h, 5, q);                                         // on chain: open, no outcome
  h.publish([{ ...structuredClone(q), chainId: 5, chainOutcome: 2 }]);   // attacker: "B is correct"
  await h.T.loadQuestions();
  assert.equal(qOf(h, 5).hashOk, true, "chainOutcome is not hashed, so the file still verifies");
  const btns = optButtons(h.T.questionCard(qOf(h, 5), "open"));
  const marked = btns.filter((b) => /\bcorrect\b|\bwrong\b/.test(b.className)).map((b) => b.textContent);
  assert.deepEqual(marked, [], `open, verified question shows a file-supplied answer as correct: ${marked.join(", ")}`);
});

test("WEB3-03 an unhashed result in the file must not print an 'actual' outcome on a question that is still open", async () => {
  const h = harness();
  const q = released(1);
  await post(h, 5, q);
  h.publish([{ ...structuredClone(q), chainId: 5, result: { option: 1, value: "412", dataHash: "00" } }]);
  await h.T.loadQuestions();
  const card = h.T.questionCard(qOf(h, 5), "open");
  const actual = byClass(card, "q-actual").map(textOf);
  assert.deepEqual(actual, [], `open card prints a made-up result: ${actual.join(" | ")}`);
  assert.equal(byClass(card, "correct").length, 0, "open card highlights the made-up result");
});

test("WEB3-04 the Results page must show the on-chain outcome, not the file's unhashed result", async () => {
  const h = harness();
  const q = released(1, { lockIn: -86400000 });
  await post(h, 5, q, 1);                                      // chain: outcome 1 = option A
  h.publish([{ ...structuredClone(q), chainId: 5, result: { option: 1, value: "412", dataHash: "ab".repeat(32) } }]); // file: B
  await h.T.loadQuestions();
  h.S.height = q.windowEnd + 1000;
  h.T.renderResults();
  const letters = byClass(h.$("#results-list"), "res-letter").map(textOf);
  assert.equal(qOf(h, 5).hashOk, true);
  assert.deepEqual(letters, ["A"], `Results shows "Final" answer ${letters.join(",")} from the file while the chain says A`);
});

test("WEB3-05 a question whose option wording is not covered by the hash (no hashRule) must not be offered for answering", async () => {
  const h = harness();
  const q = released(1, { hashRule: null });                  // released before hashRule 2 (e.g. game-data W000-D1)
  await post(h, 5, q);
  const bad = { ...structuredClone(q), chainId: 5 };
  bad.options = [{ ...bad.options[0], label: "Yes — 299 or more" }, { ...bad.options[1], label: "No — 298 or less" }];
  h.publish([bad]);
  await h.T.loadQuestions();
  const btns = optButtons(h.T.questionCard(qOf(h, 5), "open"));
  const yes = btns.find((b) => /Yes/.test(b.textContent));
  assert.ok(btns.every((b) => b.attrs.disabled !== undefined),
    `swapped labels verify (hashOk=${qOf(h, 5).hashOk}) and are answerable: the button labelled "Yes" sends option ${yes && /^Option ([A-Z])/.exec(yes.attrs["aria-label"])[1]}, which is "No — 298 or less" in the posted question`);
});

test("WEB3-06 one file result with an out-of-range option must not take down the whole Results page", async () => {
  const h = harness();
  const q1 = released(1, { lockIn: -86400000 }), q2 = released(2, { lockIn: -86400000 });
  await post(h, 5, q1, 1); await post(h, 6, q2, 2);
  h.publish([{ ...structuredClone(q1), chainId: 5, result: { option: 0, value: "1", dataHash: "00" } },
    { ...structuredClone(q2), chainId: 6, result: { option: 7, value: "1", dataHash: "00" } }]);
  await h.T.loadQuestions();
  h.S.height = q2.windowEnd + 1000;
  assert.doesNotThrow(() => h.T.renderResults(), "renderResults throws on result.option 7 (q.options[7].label)");
  assert.ok(byClass(h.$("#results-list"), "res").length >= 1, "the good result is still listed");
});

test("WEB3-07 a chainId written as a string (unhashed) must not hide the player's own on-chain answer", async () => {
  const h = harness();
  const q = released(1);
  await post(h, 5, q);
  h.publish([{ ...structuredClone(q), chainId: "5" }]);
  await h.T.loadQuestions();
  h.S.entry = { answers: [{ question_id: 5, option: 1 }] };   // the chain says: this player answered B
  const q5 = qOf(h, 5);
  assert.equal(q5.hashOk, true, "a string chainId still verifies");
  const btns = optButtons(h.T.questionCard(q5, "open"));
  assert.ok(btns.some((b) => /\bpicked\b/.test(b.className)), "the player's answer B is not shown");
  assert.ok(btns.every((b) => b.attrs.disabled !== undefined), "the answered question is offered again (a second answer is refused on chain and burns the player's Mana)");
});

test("WEB3-08 control: a file's own hashOk, a chainId re-pointed at a sibling, or an unreachable chain never enable answering", async () => {
  const h = harness();
  const q1 = released(1), q2 = released(2);
  await post(h, 5, q1); await post(h, 6, q2);
  h.chain.set(7, null);                                        // reading question 7 fails
  h.publish([
    { ...structuredClone(q1), chainId: 6 },                    // q1's file pointing at q2's id
    { ...structuredClone(released(3)), chainId: 7, hashOk: true }, // claims to be checked, chain unreachable
  ]);
  await h.T.loadQuestions();
  const repointed = h.S.questions.find((q) => q.id === "W001-D2-1"), unchecked = h.S.questions.find((q) => q.id === "W001-D2-3");
  assert.equal(repointed.hashOk, false);
  assert.equal(unchecked.hashOk, null);
  for (const q of [repointed, unchecked]) assert.ok(optButtons(h.T.questionCard(q, "open")).every((b) => b.attrs.disabled !== undefined), q.id);
});

test("W1-04 a file whose lock time or window differs from what the contract enforces is not offered", async () => {
  const h = harness();
  const q = released(1);
  await post(h, 5, q);
  h.chain.get(5).facts.lock_time = String(Number(q.lockTime) + 3_600_000);   // the chain closes answers an hour later
  h.publish([{ ...structuredClone(q), chainId: 5 }]);
  await h.T.loadQuestions();
  assert.equal(qOf(h, 5).hashOk, false);
});
