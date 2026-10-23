// Red-team (WEB ATTACKER, fix check d198283). Target: the canonical form of the site's paramsHashOf (site/app.js
// between params-hash:start/end, :41-50; the same code as resolver.ts:67-72). Question: can a file that differs from the
// posted question still hash the same, in a way the page would act on? The file text goes through JSON.parse exactly
// as fetch().json() does in the page. Each case asserts the SAFE behaviour, so a failing case is a proven problem.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const APP = process.env.APP || ".";
const app = fs.readFileSync(`${APP}/site/app.js`, "utf8");
const a = app.indexOf("// params-hash:start"), b = app.indexOf("// params-hash:end");
assert.ok(a > 0 && b > a, "params-hash markers in site/app.js");
const ctx = vm.createContext({ crypto: webcrypto, TextEncoder, Uint8Array });
vm.runInContext(app.slice(a, b) + "\nthis.paramsHashOf = paramsHashOf;", ctx);
const hash = (q) => ctx.paramsHashOf(q);

const A = "14f34kUNZugf2DK4hPJGy4AkmBM7Y4pvVu", B = "1G2QjRtNwEfqGwX7SMD8LNjWgJdWA7XtSU";
const posted = () => ({
  id: "W001-D2-1", week: 1, day: 2, template: "E2s", lockHeight: 40514700, lockTime: 1792540800000,
  title: "Head-to-head with spread", text: `Producer ${A}'s blocks minus producer ${B}'s blocks: will the difference be more than 298?`,
  subjects: [A, B], windowStart: 40514701, windowEnd: 40524700, thresholds: [298],
  options: [{ index: 0, label: "No — 298 or less", min: null, max: 298 }, { index: 1, label: "Yes — 299 or more", min: 299, max: null }],
  hashRule: 2,
});
const asFile = (text) => JSON.parse(text);   // what the page gets from fetch().json()

test("WEB3-30 a top-level \"__proto__\" member is part of the file but must not vanish from the hash", async () => {
  const q = posted();
  const tampered = asFile(JSON.stringify(q).replace(/^\{/, '{"__proto__":{"options":[{"index":1,"label":"No — 298 or less"},{"index":0,"label":"Yes — 299 or more"}]},'));
  assert.ok(Object.hasOwn(tampered, "__proto__"), "JSON.parse keeps __proto__ as an own key");
  // canonical["__proto__"] = v sets the canonical object's prototype instead of a key, and JSON.stringify skips it.
  // No page code reads an own __proto__ key today (spread copies it as a plain key), so this is informational.
  assert.notEqual(await hash(tampered), await hash(q), "an extra __proto__ member hashes the same as the posted question");
});

// Open by design: a question posted before hashRule 2 has an on-chain params_hash that never covered its wording, so no
// page-side hash can tell its labels apart. The page instead does not offer such questions (WEB3-05).
test("WEB3-31 a question released without hashRule 2 must not hash the same once its option labels are swapped", { todo: "the on-chain hash of pre-hashRule-2 questions never covered their wording; WEB3-05 covers the safe behaviour" }, async () => {
  const q = posted(); delete q.hashRule;                     // the rule game-data/questions/W000-D1.json was posted with
  const swapped = structuredClone(q);
  swapped.options = [{ ...q.options[0], label: q.options[1].label }, { ...q.options[1], label: q.options[0].label }];
  swapped.text = "Will producer B out-sign producer A?"; swapped.title = "Anything";
  // site/app.js:733 offers it when this matches, so the button reading "Yes" would send index 0 ("No").
  assert.notEqual(await hash(swapped), await hash(q), "legacy question: wording and option labels are not hashed");
});

test("WEB3-32 control: the hash can't be downgraded to the legacy rule (hashRule is itself hashed)", async () => {
  const q = posted();
  for (const v of [undefined, 1, "1", "2", 2.0001, null]) {
    const t = structuredClone(q); if (v === undefined) delete t.hashRule; else t.hashRule = v;
    t.options = [...t.options].reverse();
    assert.notEqual(await hash(t), await hash(q), `hashRule ${JSON.stringify(v)}`);
  }
});

test("WEB3-33 control: duplicate keys and number spellings in the file give no parser gap between the page and the hash", async () => {
  const q = posted();
  const genuine = JSON.stringify(q);
  // a second "options" later in the text wins in JSON.parse, and the page hashes and shows that same value: mismatch
  const dup = asFile(genuine.replace(/\}$/, ',"options":[{"index":0,"label":"Yes — 299 or more","min":null,"max":298},{"index":1,"label":"No — 298 or less","min":299,"max":null}]}'));
  assert.notEqual(await hash(dup), await hash(q));
  // the same numbers written differently are the same values: same hash, nothing different to show
  const spelled = asFile(genuine.replace('"lockTime":1792540800000', '"lockTime":1.7925408e12').replace('"lockHeight":40514700', '"lockHeight":40514700.0'));
  assert.equal(spelled.lockTime, q.lockTime);
  assert.equal(await hash(spelled), await hash(q));
  // a changed number is caught
  assert.notEqual(await hash(asFile(genuine.replace('"thresholds":[298]', '"thresholds":[299]'))), await hash(q));
});
