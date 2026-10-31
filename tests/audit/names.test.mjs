// Producer names (names.js rules + display, bot/names.ts checker, names.yml publish/reply, the pages).
// Signatures are made with koilib, exactly as Kondor's signMessage does (sha256 of the text, 65-byte recoverable).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Signer, utils } from "koilib";

const APP = process.env.APP || ".";
await import(path.resolve(APP, "names.js"));
const K = globalThis.KNames, R = K.rules;
const N = await import(path.resolve(APP, "bot/names.ts"));
const LIB = { Signer, utils };
const DAY = 86400000;
const NOW = Date.parse("2026-11-10T12:00:00Z");
const A = Signer.fromSeed("names test producer A"), B = Signer.fromSeed("names test producer B"), C = Signer.fromSeed("names test not a producer");
const PRODUCERS = new Set([A.getAddress(), B.getAddress()]);
const isEligible = (a) => PRODUCERS.has(a);

async function claim(signer, name, date, address = signer.getAddress()) {
  const sig = utils.encodeBase64url(await signer.signMessage(R.message(name, address, date)));
  return R.claimText(name, address, date, sig);
}
const apply = (db, text, now = NOW) => R.applyClaim(db, R.parseClaim(text), { now, lib: LIB, isEligible });

// ── rules ──
test("name rules: length, characters, spaces, at least 2 letters or digits", () => {
  for (const ok of ["Blue Harbor", "node_42", "O'Brien.Node", "abc", "A".repeat(24)]) assert.equal(R.checkName(ok), null, ok);
  for (const bad of ["ab", "A".repeat(25), " Lead", "Trail ", "Two  spaces", "Ünïcode", "<script>", "emoji 🙂", "a|b", "...", "-_-"]) assert.notEqual(R.checkName(bad), null, bad);
});

test("reserved names and lookalikes of them are refused", () => {
  for (const n of ["Knode", "knode games", "KN0DE", "Knode Games pool", "My Knode", "Koinos", "K0inos", "Koinos Foundation", "koinosfoundation fan", "admin", "Adm1n", "official", "The Official Node", "Support", "SUPP0RT"]) {
    assert.equal(R.checkName(n), "That name is reserved.", n);
  }
  assert.equal(R.checkName("Koinos Blocks"), null, "Koinos alone is reserved, not every name containing it");
  for (const n of ["Blocknode", "Block Node", "Kode Node"]) assert.equal(R.checkName(n), null, `${n}: knode inside a word is fine`);
  for (const n of ["KnodeX", "My-Kn0de", "Super KNODEGAMES fan", "blockknodegames"]) assert.equal(R.checkName(n), "That name is reserved.", n);
});

test("lookalikes fold to the same form (case, spaces, 0/O, 1/l/I, 5/S, rn/m)", () => {
  const same = [["Blue Harbor", "blueharbor"], ["NODE0", "nodeo"], ["Ill1", "llll"], ["S5", "ss"], ["Corn", "com"], ["a.b-c_d'e f", "abcdef"]];
  for (const [x, y] of same) assert.equal(R.fold(x), R.fold(y), `${x} ~ ${y}`);
  assert.notEqual(R.fold("Blue Harbor"), R.fold("Blue Harbour"));
});

test("parseClaim: finds the two lines in an issue body (code fence, CRLF, extra text), nothing else", async () => {
  const text = await claim(A, "Blue Harbor", "2026-11-09");
  const body = `### Claim\r\n\r\n\`\`\`text\r\n${text.replace("\n", "\r\n")}\r\n\`\`\`\r\n\r\nthanks!`;
  const c = R.parseClaim(body);
  assert.equal(c.name, "Blue Harbor"); assert.equal(c.address, A.getAddress()); assert.equal(c.date, "2026-11-09");
  assert.equal(c.message, R.message("Blue Harbor", A.getAddress(), "2026-11-09"));
  assert.equal(R.parseClaim("Knode Games name: X | 1abc | 2026-11-09"), null);
  assert.equal(R.parseClaim(text.replace("Knode Games name:", "Knode Games producer name:")), null, "only the current prefix");
  assert.equal(R.parseClaim(text.split("\n")[0]), null, "no signature line");
  assert.equal(R.parseClaim("x".repeat(30000)), null);
});

// ── signatures, replay, dates ──
test("signature: the right key is accepted; a wrong key, or a claim for someone else's address, is refused", async () => {
  let r = await apply(null, await claim(A, "Blue Harbor", "2026-11-09"));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.db.names[A.getAddress()].name, "Blue Harbor");
  r = await apply(null, await claim(B, "Blue Harbor", "2026-11-09", A.getAddress()));   // B signs a claim for A's address
  assert.equal(r.ok, false); assert.match(r.reason, /signature doesn't match/);
  const t = await claim(A, "Blue Harbor", "2026-11-09");
  r = await apply(null, t.replace("Blue Harbor", "Red Harbor"));                        // text changed after signing
  assert.equal(r.ok, false); assert.match(r.reason, /signature doesn't match/);
  r = await apply(null, await claim(C, "Gamma Node", "2026-11-09"));                    // valid signature, not eligible
  assert.equal(r.ok, false); assert.match(r.reason, /can't take a name yet/);
});

test("replay: the same claim twice, an old date, a future date", async () => {
  const t = await claim(A, "Blue Harbor", "2026-11-09");
  const first = await apply(null, t);
  assert.equal(first.ok, true);
  const again = await apply(first.db, t);
  assert.equal(again.ok, false); assert.match(again.reason, /already has a claim with this date/);
  const old = await apply(null, await claim(A, "Blue Harbor", "2026-11-02"));
  assert.equal(old.ok, false); assert.match(old.reason, /more than 7 days old/);
  assert.equal((await apply(null, await claim(A, "Blue Harbor", "2026-11-03"))).ok, true, "7 days old is still fine");
  const fut = await apply(null, await claim(A, "Blue Harbor", "2026-11-12"));
  assert.equal(fut.ok, false); assert.match(fut.reason, /future/);
  assert.equal((await apply(null, await claim(A, "Blue Harbor", "2026-13-01"))).ok, false, "not a real date");
});

test("one change every 7 days; the newest valid claim wins", async () => {
  const one = await apply(null, await claim(A, "Blue Harbor", "2026-11-01"), Date.parse("2026-11-01T10:00:00Z"));
  assert.equal(one.ok, true);
  const soon = await apply(one.db, await claim(A, "Green Harbor", "2026-11-07"), Date.parse("2026-11-07T10:00:00Z"));
  assert.equal(soon.ok, false); assert.match(soon.reason, /dated 2026-11-08 or later/);
  const later = await apply(one.db, await claim(A, "Green Harbor", "2026-11-08"), Date.parse("2026-11-08T10:00:00Z"));
  assert.equal(later.ok, true);
  assert.equal(later.db.names[A.getAddress()].name, "Green Harbor");
  const older = await apply(later.db, await claim(A, "Blue Harbor", "2026-11-05"), Date.parse("2026-11-08T11:00:00Z"));
  assert.equal(older.ok, false, "an older claim sent later never wins");
});

test("unique: another wallet can't take a name or its lookalike; keeping your own name is fine", async () => {
  const a = await apply(null, await claim(A, "Blue Harbor", "2026-11-01"), Date.parse("2026-11-01T10:00:00Z"));
  for (const n of ["Blue Harbor", "BLUE HARBOR", "blue-harbor", "B1ue Harb0r"]) {
    const r = await apply(a.db, await claim(B, n, "2026-11-09"));
    assert.equal(r.ok, false, n); assert.match(r.reason, /looks the same/);
  }
  assert.equal((await apply(a.db, await claim(A, "Blue Harbor", "2026-11-09"))).ok, true, "A renews its own name");
});

test("the Knode Games nodes' addresses can't be claimed", async () => {
  const c = R.parseClaim(await claim(A, "Fake Pool", "2026-11-09"));
  c.address = "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr";
  assert.match(R.precheck(R.emptyDb(), c, NOW), /Knode Games node/);
});

test("hide and unhide: a hidden address shows its short address, can't claim, and comes back on unhide", async () => {
  const a = await apply(null, await claim(A, "Blue Harbor", "2026-11-01"), Date.parse("2026-11-01T10:00:00Z"));
  const h = R.hide(a.db, A.getAddress(), "impersonation report", NOW);
  K._test.use(h);
  assert.equal(K.name(A.getAddress()), "");
  assert.equal(K.of(A.getAddress()), K.short(A.getAddress()));
  const r = await apply(h, await claim(A, "Other Name", "2026-11-09"));
  assert.equal(r.ok, false); assert.match(r.reason, /hidden/);
  const u = R.unhide(h, A.getAddress(), NOW);
  K._test.use(u);
  assert.equal(K.of(A.getAddress()), `Blue Harbor · ${K.short(A.getAddress())}`);
  assert.throws(() => R.unhide(u, A.getAddress(), NOW), /isn't hidden/);
  assert.throws(() => R.hide(u, "not-an-address", "", NOW), /not a Koinos address/);
  K._test.use(R.emptyDb());
});

// ── display ──
test("display: a name always comes with the short address; built-in Knode names; bad entries in names.json are ignored", () => {
  K._test.use({ v: 1, updated: "", hidden: {}, names: {
    [A.getAddress()]: { name: "Blue Harbor", date: "2026-11-01", signature: "A".repeat(87) },
    [B.getAddress()]: { name: "<img src=x onerror=alert(1)>", date: "2026-11-01", signature: "A".repeat(87) },
    "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": { name: "Not The Pool", date: "2026-11-01", signature: "A".repeat(87) },
    "nonsense": { name: "Whatever", date: "2026-11-01", signature: "A".repeat(87) },
  } });
  assert.equal(K.of(A.getAddress()), `Blue Harbor · ${A.getAddress().slice(0, 6)}…${A.getAddress().slice(-4)}`);
  assert.equal(K.of(B.getAddress()), K.short(B.getAddress()), "a name that fails the rules is not shown");
  assert.equal(K.of("1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr"), "Knode Games pool · 1Mpmf2…T1sr");
  assert.equal(K.of("1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR"), "Knode Games Swap · 1FKTpX…sRmR");
  assert.equal(K.name("nonsense"), "");
  // node(): names go in with textContent only.
  const made = [];
  const fake = (tag) => { const n = { tag, kids: [], className: "", title: "", textContent: "", append(...k) { this.kids.push(...k); } }; made.push(n); return n; };
  const saved = globalThis.document;
  globalThis.document = { createElement: fake };
  try {
    const n = K.node(A.getAddress());
    assert.equal(n.className, "kn");
    assert.deepEqual(n.kids.map((k) => (typeof k === "string" ? k : `${k.tag}.${k.className}=${k.textContent}`)),
      ["b.kn-name=Blue Harbor", " ", `span.kn-addr=${K.short(A.getAddress())}`]);
    assert.ok(!made.some((m) => "innerHTML" in m));
  } finally { globalThis.document = saved; K._test.use(R.emptyDb()); }
  const src = fs.readFileSync(`${APP}/names.js`, "utf8") + fs.readFileSync(`${APP}/names-page.js`, "utf8");
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});

// ── producer evidence and the workflow's checker ──
test("producers: race cards from the last 30 days (field and paddock) and the recent-blocks signers", () => {
  const card = (at, ...as) => ({ at, field: as.slice(0, 1).map((a) => ({ a })), paddock: as.slice(1).map((a) => ({ a })) });
  const files = {
    "W003.json": JSON.stringify({ races: [{ cards: [card(NOW - 2 * DAY, A.getAddress(), "1JrsQXbrDqkT9yUH6gtj4yhQi1kgWwsohh"), card(NOW - 40 * DAY, C.getAddress())] }] }),
    "recent-blocks.json": JSON.stringify({ signers: [B.getAddress(), "junk"] }),
    "W004.json": "not json",
    "other.json": JSON.stringify({ signers: [C.getAddress()] }),
  };
  const p = N.producersFrom(files, NOW);
  assert.deepEqual([...p].sort(), [A.getAddress(), B.getAddress(), "1JrsQXbrDqkT9yUH6gtj4yhQi1kgWwsohh"].sort());
});

test("verifyIssues: claims in order, each against the list the earlier ones left; outcomes per issue", async () => {
  const issues = [
    { number: 5, body: `Claim:\n${await claim(A, "Blue Harbor", "2026-11-09")}` },
    { number: 6, body: await claim(B, "blue-harbor", "2026-11-09") },          // lookalike of #5, which came first
    { number: 7, body: "hello, no claim here" },
    { number: 8, body: await claim(B, "Red Rock", "2026-11-09") },
    { number: -1, body: "x" },
  ];
  const r = await N.verifyIssues(null, issues, NOW, isEligible);
  assert.deepEqual(r.results.map((x) => [x.issue, x.accepted]), [[5, true], [6, false], [7, false], [8, true]]);
  assert.match(r.results[1].reason, /looks the same/);
  assert.match(r.results[2].reason, /No claim found/);
  assert.deepEqual(Object.values(r.db.names).map((e) => e.name).sort(), ["Blue Harbor", "Red Rock"]);
  const none = await N.verifyIssues(null, [{ number: 1, body: "nothing" }], NOW, isEligible);
  assert.equal(none.db, null, "nothing accepted: no names.json to publish");
  const s = N.serialize(r.db);
  assert.equal(s, N.serialize(JSON.parse(s)), "stable output");
});

// ── names.yml: run the publish check and the reply text exactly as the workflow does ──
const wf = fs.readFileSync(`${APP}/.github/workflows/names.yml`, "utf8");
const heredocs = [...wf.matchAll(/<<'PY'\n([\s\S]*?)\n\s*PY\n/g)].map((m) => m[1].replace(/^ {10}/gm, ""));
const runPy = (code, args) => spawnSync("/usr/bin/python3", ["-", ...args], { input: code, encoding: "utf8" });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "names-"));

test("names.yml publish: accepts names.json as bot/names.ts writes it, refuses anything else", async () => {
  const pub = heredocs.find((c) => c.includes("names.json: top level"));
  assert.ok(pub, "publish check found");
  const r = await N.verifyIssues(null, [{ number: 1, body: await claim(A, "Blue Harbor", "2026-11-09") }], NOW, isEligible);
  const d = tmp();
  const write = (db, res = { base: "", changed: true, results: [{ issue: 1, accepted: true }] }) => {
    fs.writeFileSync(path.join(d, "names.json"), typeof db === "string" ? db : JSON.stringify(db));
    fs.writeFileSync(path.join(d, "r.json"), JSON.stringify(res));
    return runPy(pub, [path.join(d, "names.json"), path.join(d, "r.json")]);
  };
  const good = write(N.serialize(R.hide(r.db, B.getAddress(), "test", NOW)));
  assert.equal(good.status, 0, good.stderr); assert.equal(good.stdout.trim(), "");
  const base = "a".repeat(40);
  assert.equal(write(N.serialize(r.db), { base, changed: true, results: [{ accepted: true }] }).stdout.trim(), base);
  const bads = [
    { ...r.db, extra: 1 },
    { ...r.db, names: { [A.getAddress()]: { name: "<b>x</b>", date: "2026-11-09", signature: "A".repeat(87) } } },
    { ...r.db, names: { [A.getAddress()]: { name: "Two  spaces", date: "2026-11-09", signature: "A".repeat(87) } } },
    { ...r.db, names: { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": { name: "Fake Pool", date: "2026-11-09", signature: "A".repeat(87) } } },
    { ...r.db, names: { [A.getAddress()]: { name: "Blue Harbor", date: "2026-11-09", signature: "A".repeat(87), url: "x" } } },
    { ...r.db, hidden: { [A.getAddress()]: { reason: "x".repeat(201), date: "2026-11-09" } } },
  ];
  for (const b of bads) assert.notEqual(write(b).status, 0, JSON.stringify(b).slice(0, 120));
  assert.notEqual(write(r.db, { base: "", changed: false, results: [{ accepted: false }] }).status, 0, "nothing changed");
  assert.notEqual(write(r.db, { base: "main", changed: true, results: [] }).status, 0, "base must be a commit");
  const withNicks = N.withNicknames(r.db, { [B.getAddress()]: "jga" }, NOW);
  assert.equal(write(N.serialize(withNicks)).status, 0, "nicknames accepted");
  for (const n of ["JGA", "-x", "a b", "<x>", "x".repeat(33)]) {
    assert.notEqual(write({ ...JSON.parse(N.serialize(withNicks)), nicknames: { [B.getAddress()]: n } }).status, 0, `bad nickname ${n}`);
  }
  assert.notEqual(write({ ...JSON.parse(N.serialize(withNicks)), nicknames: { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "pool" } }).status, 0, "no nickname for a Knode node");
});

test("names.yml reply: fixed texts only; accepted claims are closed only once published; odd reasons are replaced", () => {
  const reply = heredocs.find((c) => c.includes("not planned"));
  assert.ok(reply, "reply script found");
  const d = tmp(), out = path.join(d, "c");
  fs.mkdirSync(out);
  const results = { base: "", results: [
    { issue: 3, accepted: true, name: "Blue Harbor", address: A.getAddress() },
    { issue: 4, accepted: false, reason: "That name is reserved." },
    { issue: 5, accepted: false, reason: "@everyone see [this](https://evil.example) `code`" },
    { issue: "6; rm -rf /", accepted: false, reason: "x" },
    { issue: 7, accepted: true, name: "<script>", address: A.getAddress() },
  ] };
  fs.writeFileSync(path.join(d, "r.json"), JSON.stringify(results));
  let p = runPy(reply, [path.join(d, "r.json"), "success", out, "3,4,5,6,7"]);
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(p.stdout.trim().split("\n"), ["3 completed", "4 not planned", "5 not planned"]);
  assert.match(fs.readFileSync(path.join(out, "3.md"), "utf8"), /^Accepted: `Blue Harbor` is now the name for `1/);
  // Only the issues the find step listed are answered (audit PN-15).
  assert.deepEqual(runPy(reply, [path.join(d, "r.json"), "success", out, "4"]).stdout.trim().split("\n"), ["4 not planned"]);
  assert.equal(runPy(reply, [path.join(d, "r.json"), "success", out, ""]).stdout.trim(), "");
  assert.match(fs.readFileSync(path.join(out, "4.md"), "utf8"), /^Not accepted: That name is reserved\./);
  const five = fs.readFileSync(path.join(out, "5.md"), "utf8");
  assert.doesNotMatch(five, /@everyone|evil|`/); assert.match(five, /didn't pass the checks/);
  p = runPy(reply, [path.join(d, "r.json"), "failure", out, "3,4,5,6,7"]);
  assert.deepEqual(p.stdout.trim().split("\n"), ["4 not planned", "5 not planned"], "not published: accepted claims stay open for the next run");
  // Every real reason the rules can give passes the reply's own filter (so producers see why, not a generic text).
  const allowed = /^[A-Za-z0-9 .,:;'"()?/+_\-–…“”]+$/;
  const reasons = [...fs.readFileSync(`${APP}/names.js`, "utf8").matchAll(/return (?:\{ ok: false, reason: )?("(?:[^"\\]|\\.)*"|`[^`]*`)/g)]
    .map((m) => m[1].slice(1, -1)).filter((t) => /^(That|The|No |A |One|Use|Enter|This)/.test(t));
  assert.ok(reasons.length >= 12, `found ${reasons.length} reasons`);
  for (const raw of reasons) {
    const text = raw.replace(/\$\{[^}]*\}/g, "7").replace(/\\"/g, '"');
    assert.match(text, allowed, text);
  }
});

test("names.yml: no issue trigger, issue text only read as data, publish pushes only names.json to names-data", () => {
  assert.doesNotMatch(wf.match(/^on:[\s\S]*?^concurrency:/m)[0], /issues/);
  assert.deepEqual([...new Set([...wf.matchAll(/github\.event[a-z_.]*/g)].map((m) => m[0]))].sort(), ["github.event.schedule", "github.event_name"],
    "only the trigger's name and schedule are read from the event, never issue data");
  assert.match(wf, /vars\.NAMES_ENABLED == 'true' && github\.ref == 'refs\/heads\/main'/);
  assert.match(wf, /printf '100644 blob %s\\tnames\.json\\n' "\$blob" \| git mktree/);
  assert.match(wf, /git push -q "\$remote" "\$commit:refs\/heads\/names-data"/);
  assert.equal([...wf.matchAll(/git push/g)].length, 1);
  assert.match(wf, /if \[ "\$head" != "\$base" \]/, "refused if names-data moved since the check read it");
});

// ── the pages ──
const pages = fs.readdirSync(APP).filter((f) => f.endsWith(".html"));
const read = (f) => fs.readFileSync(`${APP}/${f}`, "utf8");
test("every page that loads names.js may read names-data, and loads it before its own page script", () => {
  const users = pages.filter((p) => /<script src="names\.js"><\/script>/.test(read(p)));
  assert.deepEqual(users.sort(), ["index.html", "names.html", "node.html", "pulse.html"]);
  for (const p of users) {
    const h = read(p);
    assert.match(h.match(/connect-src ([^;"]*)/)[1], /https:\/\/raw\.githubusercontent\.com\/bawcejawn\/Knode\/names-data\//, p);
    const own = { "index.html": "app.js", "pulse.html": "pulse.js", "node.html": "node-page.js", "names.html": "names-page.js" }[p];
    assert.ok(h.indexOf('src="names.js"') < h.indexOf(`src="${own}"`), `${p}: names.js before ${own}`);
  }
  assert.match(read("index.html"), /src="names\.js"[\s\S]*src="results\.js"/, "results.js (on index.html) can use it too");
});

test("names.html signs one message and never sends anything", () => {
  const js = read("names-page.js");
  assert.match(js, /\.signMessage\(\$\("message"\)\.value\)/);
  assert.doesNotMatch(js, /signTransaction|sendTransaction|\.send\(|KWallet\.send|localStorage|sessionStorage|privateKey|wif/i);
  assert.match(js, /await R\.verifySignature\(c, lib\)/, "the signature is checked before the claim is shown");
  const h = read("names.html");
  assert.ok(h.indexOf('src="wallet.js"') < h.indexOf('src="names-page.js"'), "wallet.js (frame buster) first");
  assert.match(h, /href="https:\/\/github\.com\/bawcejawn\/Knode\/issues\/new\?template=producer-name\.yml"/);
  const form = fs.readFileSync(`${APP}/.github/ISSUE_TEMPLATE/producer-name.yml`, "utf8");
  assert.match(form, /id: claim/, "the page prefills the form's claim field (&claim=)");
  assert.match(js, /&claim=\$\{encodeURIComponent\(text\)\}/);
});

test("the pages that show producers use KNames (with their old fallback if names.js is missing)", () => {
  for (const [f, re] of [["app.js", /window\.KNames\.of\(a\)/], ["app.js", /window\.KNames\.of\(b\.signer\)/], ["pulse.js", /window\.KNames\.of\(a\)/],
    ["node-page.js", /window\.KNames\.of\(a\)/], ["node-page.js", /window\.KNames\.of\(addr\)/], ["results.js", /window\.KNames\.of\(a\)/]]) {
    assert.match(read(f), re, f);
  }
});

// ── wallets of every kind, nicknames, the chain ──
test("eligibility: a producer, or 1 VHP in the wallet or staked; a failing node falls back to the next one", async () => {
  const P = "1JrsQXbrDqkT9yUH6gtj4yhQi1kgWwsohh";
  const chain = (vhp, stake, fail = false) => ({ vhp: async () => { if (fail) throw new Error("down"); return vhp; }, stake: async () => stake, players: async () => [], nickname: async () => null });
  assert.equal(await N.eligibility(new Set([P]), [chain(0n, 0n)])(P), true, "a producer");
  assert.equal(await N.eligibility(new Set(), [chain(100000000n, 0n)])(A.getAddress()), true, "1 VHP held");
  assert.equal(await N.eligibility(new Set(), [chain(99999999n, 0n)])(A.getAddress()), false, "just under 1 VHP");
  assert.equal(await N.eligibility(new Set(), [chain(0n, 100000000n)])(A.getAddress()), true, "1 VHP staked (any game)");
  assert.equal(await N.eligibility(new Set(), [chain(0n, 0n, true), chain(5n * 100000000n, 0n)])(A.getAddress()), true, "first node down");
  assert.equal(await N.eligibility(new Set(), [chain(0n, 0n, true)])(A.getAddress()), false, "no node answers: refused");
});

test("nicknames: only when both nodes agree; shown with @; a Knode Games name wins; hidden hides both", async () => {
  const P = "1JrsQXbrDqkT9yUH6gtj4yhQi1kgWwsohh", Q = "1UG4UUn7Da9JqE4PKbYUWgjbNwE5F9531", X = "14f34kUNZugf2DK4hPJGy4AkmBM7Y4pvVu";
  const one = { [A.getAddress()]: "jga", [P]: "blocknode", [Q]: "liar", [X]: "knode" };
  const two = { [A.getAddress()]: "jga", [P]: "blocknode", [Q]: "honest", [X]: "knode" };
  const chain = (m, failFor) => ({ vhp: async () => 0n, stake: async () => 0n, players: async () => [], nickname: async (a) => { if (a === failFor) throw new Error("x"); return m[a] ?? null; } });
  let nicks = await N.nicknames(new Set([A.getAddress(), P, Q, X, "junk"]), [chain(one), chain(two)]);
  assert.deepEqual(nicks, { [A.getAddress()]: "jga", [P]: "blocknode", [X]: "knode" }, "disagreement dropped");
  nicks = await N.nicknames(new Set([P]), [chain(one, P), chain(two)]);
  assert.deepEqual(nicks, {}, "a node that fails counts as disagreement");
  const db = N.withNicknames(R.emptyDb(), { [A.getAddress()]: "jga", [P]: "blocknode", [X]: "knode" }, NOW);
  assert.deepEqual(db.nicknames, { [A.getAddress()]: "jga", [P]: "blocknode" }, "a reserved nickname (knode) is skipped");
  assert.equal(N.withNicknames(db, { [A.getAddress()]: "jga", [P]: "blocknode" }, NOW), null, "nothing changed");
  K._test.use(db);
  assert.equal(K.of(P), `@blocknode · ${K.short(P)}`);
  const named = await apply(db, await claim(A, "Blue Harbor", "2026-11-09"));
  K._test.use(named.db);
  assert.equal(K.of(A.getAddress()), `Blue Harbor · ${K.short(A.getAddress())}`, "the Knode Games name wins over @jga");
  K._test.use(R.hide(named.db, P, "test", NOW));
  assert.equal(K.of(P), K.short(P), "hidden: no nickname either");
  K._test.use(R.emptyDb());
});

test("a Knode Games name can't copy another wallet's nickname (or a lookalike); your own nickname is fine", async () => {
  const db = N.withNicknames(R.emptyDb(), { [B.getAddress()]: "bluenode", [A.getAddress()]: "harbor" }, NOW);
  for (const n of ["bluenode", "Blue Node", "B1ue-N0de"]) {
    const r = await apply(db, await claim(A, n, "2026-11-09"));
    assert.equal(r.ok, false, n); assert.match(r.reason, /Koinos nickname/);
  }
  assert.equal((await apply(db, await claim(A, "Harbor", "2026-11-09"))).ok, true, "A may take its own nickname as its name");
});

test("players: leaderboard wallets are looked up for nicknames", () => {
  const board = { v: 1, today: { rows: [{ a: A.getAddress() }] }, week: { rows: [{ a: B.getAddress() }, { a: "junk" }] }, lastWeek: null, allTime: { rows: [] } };
  assert.deepEqual([...N.boardPlayers({ "board.json": JSON.stringify(board) })].sort(), [A.getAddress(), B.getAddress()].sort());
  assert.deepEqual([...N.boardPlayers({ "board.json": "nope" })], []);
});

test("chain reads: the entry points the checker and the claim page use are the real ones", () => {
  const game = JSON.parse(fs.readFileSync(`${APP}/game/abi/kpred.koilib.json`, "utf8")).methods;
  const src = fs.readFileSync(`${APP}/bot/names.ts`, "utf8") + fs.readFileSync(`${APP}/names-page.js`, "utf8");
  for (const [fn, ep] of [["get_player", game.get_player.entry_point], ["list_players", game.list_players.entry_point], ["balance_of", 0x5c721497]]) {
    const uses = [...src.matchAll(new RegExp(`${fn}: \\{ entry_point: (0x[0-9a-f]+)`, "g"))].map((m) => Number(m[1]));
    assert.ok(uses.length >= 1, fn);
    for (const u of uses) assert.equal(u, ep, `${fn} entry point`);
  }
  assert.equal(utils.nicknamesAbi.methods.get_main_token.entry_point, 1053665215, "koilib's Nicknames ABI (get_main_token)");
  assert.match(fs.readFileSync(`${APP}/bot/names.ts`, "utf8"), /const NICKNAMES = "1KD9Es7LBBjA1FY3ViCgQJ7e6WH1ipKbhz"/);
});

test("names show on the leaderboards and on your own wallet button", () => {
  assert.match(read("board.js"), /window\.KNames \? window\.KNames\.of\(a\) : short\(a\)/);
  assert.match(read("board.js"), /window\.KNames\.onChange\(\(\) => \{ if \(data\) render\(\); \}\)/);
  assert.match(read("leaders.js"), /name: \(a\) => \(window\.KNames \? window\.KNames\.of\(a\) : short\(a\)\)/);
  assert.match(read("app.js"), /youLabel\(\) : walletName\(s\.address\)/);
  assert.match(read("header-wallet.js"), /window\.KNames\.name\(W\.address\)/);
});

test("Get a Koinos @name: mints only on the Nicknames contract, to the connected wallet, with its own Mana", () => {
  const src = fs.readFileSync(`${APP}/names-page.js`, "utf8");
  assert.match(src, /const NICKNAMES = "1KD9Es7LBBjA1FY3ViCgQJ7e6WH1ipKbhz"/);
  assert.match(src, /abi: lib\.utils\.nicknamesAbi/);
  assert.match(src, /mint\(\{ to: who, token_id: nickHex\(n\) \}, \{ payer: who, rcLimit: limit \}\)/);
  assert.match(src, /NICK_MANA = "1000000000"/);
  const html = fs.readFileSync(`${APP}/names.html`, "utf8");
  assert.match(html, /id="nick-mint"/);
});
