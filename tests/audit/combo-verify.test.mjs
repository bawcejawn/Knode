// The Combo verify job (tools/combo-verify.mjs, Repo Lens fix-check 3 FC3-3): it runs with no installed packages, confirms
// newly fixed slots against the chain and every new final card against the shared scoring, and the publish job publishes
// only the day files it confirmed. Its copies of Block X's moved-VHP decoder and of the list_picks encoding must give
// exactly what blockx.ts and koilib give.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
process.env.APP ||= ".";
const F = await import("./repolens-fc-combo/D-R.fixtures.mjs");
const { run, M, X, C, H1, H2, H3, ALICE, BOB, W3, heightAt, raceDir, blockxDir, node, quiet, read, tmp, VAULT, PICKS } = F;
const V = await import("../../tools/combo-verify.mjs");
const VI = await import("../../bot/games/vhp-inflows.mjs");
const BX = await import("../../bot/games/blockx.ts");
const { MAINNET_VHP } = await import("../../common.ts");
const { Serializer, utils } = await import("koilib");
const D3 = C.utcDay(W3), S0 = C.slotRound(D3, 0), dn = (d) => `D${String(d).padStart(5, "0")}.json`;

/** The verifier's JSON-RPC view of a fixtures node (the recorder's koilib view of the same chain). */
function vnode(n) {
  return {
    async call(method, params) {
      if (method === "chain.get_head_info") return n.getHeadInfo();
      if (method === "chain.read_contract") return n.readContract(params);
      if (method === "block_store.get_blocks_by_height" && params.return_receipt) {
        const s = Number(params.ancestor_start_height);
        return { block_items: Array.from({ length: params.num_blocks }, (_, k) => ({ block_height: String(s + k), receipt: { events: [] } })) };
      }
      return n.call(method, params);
    },
  };
}
const twoCards = (round) => {
  const sent = D3 * M.DAY + 2 * 3600000, r6 = D3 * 4 + 1;
  const c = (p, l2) => ({ player: p, legs: [{ code: C.WIN, round: r6, producer: H1 }, l2], time: sent, height: heightAt(sent), changes: 0 });
  return round === S0 ? [c(ALICE, { code: C.SHOW, round: r6, producer: H2 }), c(BOB, { code: C.SHOW, round: r6, producer: H3 })] : [];
};
async function honest(t = M.weekStart(4) + 13 * 3600000) {
  const out = tmp(), race = raceDir(), bx = blockxDir();
  await quiet(() => run({ p: node({ t, cards: twoCards }), check: node({ t, cards: twoCards }), out, raceDir: race, blockxDir: bx, picksContract: PICKS, knodeGame: VAULT, now: t, vhpMovesOf: async () => 0n }));
  return { out, race, bx, t };
}
const verifyOf = (h, o = {}) => V.verify({ incoming: h.out, published: o.published ?? tmp(), race: h.race, blockx: h.bx, p: o.p ?? vnode(node({ t: h.t, cards: o.cards ?? twoCards })), check: o.check ?? vnode(node({ t: h.t, cards: o.cards ?? twoCards })), picks: PICKS, now: o.now ?? h.t, vhpMovesOf: async () => 0n });
const edit = (dir, f, fn) => { const j = read(dir, f); fn(j); fs.writeFileSync(path.join(dir, f), JSON.stringify(j) + "\n"); };
const approvedDays = (r) => new Set(r.approved.map((x) => x.name));

test("verify: the verifier and its scoring run with no installed packages (only node: imports and this repository's own files)", () => {
  for (const f of ["tools/combo-verify.mjs", "bot/games/combo-score.mjs", "bot/games/vhp-inflows.mjs"]) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*import[^"'\n]*["']([^"']+)["']|await import\(["']([^"']+)["']\)/g)) {
      const spec = m[1] ?? m[2];
      assert.ok(spec.startsWith("node:") || spec.startsWith("."), `${f} imports ${spec}`);
      if (spec.startsWith(".")) assert.ok(!/\.ts$/.test(spec), `${f} imports TypeScript (${spec}): it must run with plain node`);
    }
  }
  // And it really runs under plain node (no tsx), outside node_modules.
  const out = execFileSync(process.execPath, ["-e", "import('./tools/combo-verify.mjs').then((m) => console.log(typeof m.verify))"], { env: { ...process.env, NODE_PATH: "" } }).toString().trim();
  assert.equal(out, "function");
  assert.equal(fs.readFileSync("tools/combo-verify.mjs", "utf8").match(/MAINNET_VHP = "([^"]+)"/)[1], MAINNET_VHP, "the same VHP contract as common.ts");
});

test("verify: its copy of Block X's moved-VHP decoder gives exactly what blockx.ts gives, transfer by transfer", () => {
  const who = H1, vhp = "1VHPVHPVHPVHPVHPVHPVHPVHPVHPVHPVHPV".slice(0, 34);
  const addr = (a) => Array.from(utils.decodeBase58(a));
  const vint = (v) => { const o = []; let x = BigInt(v); do { let b = Number(x & 0x7fn); x >>= 7n; if (x) b |= 0x80; o.push(b); } while (x); return o; };
  const ev = (bytes, name = "vhp.transfer", impacted = [who]) => ({ source: vhp, name, impacted, data: Buffer.from(bytes).toString("base64") });
  const from = addr(H2), to = addr(who);
  const cases = [
    [0x0a, from.length, ...from, 0x12, to.length, ...to, 0x18, ...vint(123456789)],
    [0x0a, from.length, ...from, 0x12, to.length, ...to, 0x18, ...vint(0)],
    [0x0a, from.length, ...from, 0x12, to.length, ...to, 0x18, ...vint(5), 0x22, 0],
    [0x12, to.length, ...to, 0x0a, from.length, ...from, 0x18, 5],                       // out of order
    [0x0a, from.length, ...from, 0x12, to.length, ...to, 0x18, 0x85, 0x00],              // not the shortest varint
    [0x0a, from.length, ...from, 0x12, from.length, ...from, 0x18, 5],                   // `to` isn't the receiver
    [0x0a, 40, ...from],                                                                 // a length past the end
  ];
  for (let k = 0; k < 200; k++) cases.push(Array.from(crypto.randomBytes(1 + (k % 60))));
  for (const b of cases) {
    const receipt = { events: [ev(b)], transaction_receipts: [{ events: [ev([0x10, ...vint(77)], "vhp.mint")] }] };
    let a, c;
    try { a = BX.vhpInflows(receipt, vhp, who); } catch (e) { a = e.constructor.name + ":" + e.message; }
    try { c = VI.vhpInflows(receipt, vhp, who); } catch (e) { c = e.constructor.name + ":" + e.message; }
    assert.deepEqual(c, a, `bytes ${Buffer.from(b).toString("hex")}`);
  }
  for (const a of [H1, H2, ALICE, "1" + "1".repeat(33)]) assert.equal(VI.encodeBase58(VI.decodeBase58(a)), a);
});

test("verify: list_picks is encoded and decoded exactly as koilib does with the Picks ABI", async () => {
  const abi = JSON.parse(fs.readFileSync("picks/abi/picks.koilib.json", "utf8")), ser = new Serializer(abi.koilib_types);
  const args = await ser.deserialize(V.encodeListPicks(8, 62298, ALICE, 100), abi.methods.list_picks.argument);
  assert.deepEqual({ ...args }, { game: 8, round: "62298", start_after: ALICE, limit: 100 });
  const rows = [{ player: BOB, pick: { producers: [], number: "0", height: "48000123", time: "1792000000000", changes: 2, legs: [{ code: 1, round: "83010", producer: H1 }, { code: 4, round: "4030", producer: H2 }] } }];
  const enc = utils.encodeBase64url(await ser.serialize({ rows }, abi.methods.list_picks.return));
  assert.deepEqual(V.decodeListPicks(enc), [{ player: BOB, legs: [{ code: 1, round: 83010, producer: H1 }, { code: 4, round: 4030, producer: H2 }], time: 1792000000000, height: 48000123, changes: 2 }]);
});

test("verify: an honest run's day files are all confirmed", async () => {
  const h = await honest(), r = await verifyOf(h);
  assert.deepEqual(r.problems, []);
  assert.ok(approvedDays(r).has(dn(D3)), "Monday (two final cards on a newly fixed slot) is confirmed");
  for (const x of r.approved) assert.equal(x.sha256, crypto.createHash("sha256").update(fs.readFileSync(path.join(h.out, x.name))).digest("hex"));
});

test("verify: a card the chain doesn't have, on a slot fixed for the first time, holds its day (with an alert)", async () => {
  const h = await honest(), MAL = "1KmVYHLrwBXcP6hnQaBz7wmS9VQCVMYgGU";
  edit(h.out, dn(D3), (j) => { const s = j.slots.find((x) => x.round === S0); s.cards.push({ ...s.cards[0], player: MAL }); });
  const r = await verifyOf(h);
  assert.ok(!approvedDays(r).has(dn(D3)));
  assert.ok(r.problems.some((x) => x.day === D3 && x.alert && /exactly the cards the Picks contract has/.test(x.why)));
});

test("verify: a new final card that isn't what its sources give (a worth, a result, settled) holds its day (with an alert)", async () => {
  for (const change of [(c) => { c.legs[0][3] = c.legs[0][3] === 300 ? 299 : c.legs[0][3] + 1; }, (c) => { c.settled -= 3600000; }, (c) => { c.legs[1][4] = c.legs[1][4] === "hit" ? "miss" : "hit"; }]) {
    const h = await honest();
    edit(h.out, dn(D3), (j) => { const c = j.slots.find((x) => x.round === S0).cards[0]; change(c); });
    const r = await verifyOf(h);
    assert.ok(!approvedDays(r).has(dn(D3)), String(change));
    assert.ok(r.problems.some((x) => x.day === D3 && x.alert), String(change));
  }
});

test("verify: no confirmation without two nodes, or with a node over 30 minutes behind (held, no false alarm)", async () => {
  const h = await honest();
  const down = { async call() { throw new Error("no answer"); } };
  for (const o of [{ check: down }, { check: vnode(node({ t: h.t, headTime: h.t - 40 * 60000, cards: twoCards })) }]) {
    const r = await verifyOf(h, o);
    assert.ok(!approvedDays(r).has(dn(D3)));
    assert.ok(r.problems.every((x) => x.alert === false));
  }
  const r = await verifyOf(h, { check: vnode(node({ t: h.t, cards: (rd) => (rd === S0 ? twoCards(rd).slice(0, 1) : []) })) });
  assert.ok(!approvedDays(r).has(dn(D3)) && r.problems.some((x) => /disagree/.test(x.why)), "the two nodes must agree about the cards");
});

test("verify: a day with nothing newly fixed or final needs no chain read and is confirmed", async () => {
  const h = await honest(), pub = tmp();
  for (const f of fs.readdirSync(h.out)) if (/^D\d{5}/.test(f)) fs.copyFileSync(path.join(h.out, f), path.join(pub, f));
  const down = { async call() { throw new Error("no answer"); } };
  const r = await verifyOf(h, { published: pub, p: down, check: down });
  assert.deepEqual(r.problems, []);
  assert.ok(approvedDays(r).has(dn(D3)));
});

test("verify: the workflow wires it as designed (no packages, no write token; publish needs its confirmation)", () => {
  const y = fs.readFileSync(".github/workflows/combo.yml", "utf8");
  const verifyJob = y.slice(y.indexOf("\n  verify:\n"), y.indexOf("\n  publish:\n")), publishJob = y.slice(y.indexOf("\n  publish:\n"));
  assert.ok(verifyJob.includes("contents: read") && !/contents: write/.test(verifyJob), "verify has a read-only token");
  assert.ok(!/npm (ci|install)|npx /.test(verifyJob), "verify installs nothing");
  assert.match(verifyJob, /node tools\/combo-verify\.mjs/);
  assert.match(publishJob, /needs: \[record, verify\]/);
  assert.match(publishJob, /COMBO_VERIFY: required/);
  assert.match(publishJob, /VERIFIED: \$\{\{ needs\.verify\.outputs\.approved \}\}/);
});

test("verify: with COMBO_VERIFY=required the publish check publishes only the day files the verify job confirmed", async () => {
  const h = await honest(), y = fs.readFileSync(".github/workflows/combo.yml", "utf8");
  const py = y.split("<<'PY'\n")[1].split("\n          PY\n")[0].split("\n").map((l) => (l.startsWith("          ") ? l.slice(10) : l)).join("\n");
  const script = path.join(tmp(), "check.py"); fs.writeFileSync(script, py);
  const pub = tmp(), held = path.join(tmp(), "held");
  const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(h.out, f))).digest("hex");
  const days = fs.readdirSync(h.out).filter((f) => /^D\d{5}/.test(f));
  const runCheck = (verified) => {
    try { execFileSync("python3", ["-I", script, h.out, pub, held, h.race, h.bx], { env: { ...process.env, CHECK_NOW_MS: String(h.t + 60000), COMBO_VERIFY: "required", VERIFIED: verified }, stdio: "pipe" }); } catch {}
    return fs.readFileSync(held, "utf8").split("\n").filter((x) => x && x !== "!alert");
  };
  assert.deepEqual(runCheck(days.map((f) => `${f} ${sha(f)}`).join("\n")).filter((x) => /D\d{5}/.test(x)), [], "all confirmed: none held");
  const h2 = runCheck(days.filter((f) => f !== dn(D3)).map((f) => `${f} ${sha(f)}`).join("\n"));
  assert.ok(h2.includes(`combo/${dn(D3)}`), "an unconfirmed day file is held");
  const h3 = runCheck(days.map((f) => `${f} ${"0".repeat(64)}`).join("\n"));
  assert.ok(h3.includes(`combo/${dn(D3)}`), "a day file whose bytes aren't the confirmed ones is held");
});
