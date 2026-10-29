// The site checks every question file against the params_hash posted on chain before offering its answer buttons.
// Its hash function (site/app.js) must give exactly what resolver.ts paramsHashOf gives, for every published question.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { paramsHashOf } from "../../resolver.ts";

const app = fs.readFileSync("app.js", "utf8");
const a = app.indexOf("// params-hash:start"), b = app.indexOf("// params-hash:end");
assert.ok(a > 0 && b > a, "params-hash markers in site/app.js");
const ctx = vm.createContext({ crypto: webcrypto, TextEncoder, Uint8Array });
vm.runInContext(app.slice(a, b) + "\nthis.paramsHashOf = paramsHashOf;", ctx);

const questions = () => {
  const out = [];
  const dirs = ["game-data/questions"].filter((d) => fs.existsSync(d));
  for (const d of dirs) for (const f of fs.readdirSync(d).filter((n) => n.endsWith(".json"))) out.push(...(JSON.parse(fs.readFileSync(`${d}/${f}`, "utf8")).questions ?? []));
  out.push(...JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8")).questions);
  return out;
};

test("the site's params hash equals the resolver's for every published question (with and without hashRule 2)", async () => {
  const qs = questions();
  assert.ok(qs.length > 0);
  for (const q of qs) {
    assert.equal(await ctx.paramsHashOf(q), paramsHashOf(q), q.id);
    const r2 = { ...structuredClone(q), hashRule: 2 };
    assert.equal(await ctx.paramsHashOf(r2), paramsHashOf(r2), `${q.id} (hashRule 2)`);
  }
});

test("a relabelled hashRule-2 question no longer matches, so the site would not offer it", async () => {
  const q = { ...structuredClone(questions()[0]), hashRule: 2 };
  const posted = paramsHashOf(q);
  q.options = [...q.options].reverse();
  assert.notEqual(await ctx.paramsHashOf(q), posted);
});

test("the answer buttons need a matching hash (outside the demo)", () => {
  assert.match(app, /canAnswer = mode === "open" && mine === null && q\.hashOk !== false && \(S\.demo \|\| q\.hashOk === true\)/);
});
