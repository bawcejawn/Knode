// Repo Lense fix-check round 2, reviewer M-H: failing tests for the publish job's history check.
// NOT RUN HERE (static review). Drop into tests/audit/ next to lastnode-vault.test.mjs; they drive the REAL recorder
// (bot/games/lastnode.ts run(), real makeField/loadDay) and the REAL publish shell extracted from lastnode.yml, exactly as
// that file's publisher() does (copy publishScript()/publisher()/dayFile()/boardOf()/raceFiles() from it).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withBash } from "./lib/platform.mjs";
const APP = fileURLToPath(new URL("../..", import.meta.url));
const { run } = await import(pathToFileURL(path.resolve(APP, "bot/games/lastnode.ts")).href);
const L = globalThis.KLastNode;
const A = (c) => "1" + c.repeat(33);
// import or paste: publisher, dayFile, boardOf, raceFiles, idx, PICKS, NODES (tests/audit/lastnode-vault.test.mjs)
import { publisher, dayFile, boardOf, raceFiles, idx, PICKS, NODES, CUT_ORDER, WINNER, chainFor, gamed, dayG, vgood, history, REST_W3, voidDay } from "./lastnode-vault.helpers.mjs";

const linux = withBash;   // the publish job's real shell: Linux (GitHub Actions); skipped with a reason elsewhere
const card = (at) => ({ at, field: NODES.slice(0, 4).map((a, i) => ({ a, vhp: 4000 - i * 1000, k: 600 })), paddock: [] });

// M-H-n1: the recorder's second run must publish (loadDay keeps field.vt and hours[i].card === null).
linux("M-H-n1: an honest second run after a field is published is accepted (field.vt survives loadDay)", async () => {
  const day = "2026-11-10", start = Date.parse(`${day}T14:00:00Z`), opens = start - 24 * 3600000 - 5 * 60000;
  const race = raceFiles([card(start - 26 * 3600000)]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-n1-"));
  const go = (now) => run({ p: "m", check: null, prev: dir, out: dir, raceDir: race, picksContract: null, windowOf: async () => ({ from: 0, to: 0, counts: {} }),
    hoursOf: async (_n, _a, n) => Array.from({ length: n }, () => ({})), picksOf: async () => [], rankedOf: async (w) => new Set(w), trials: 200, allowNoForm: true, now: { time: now, libTime: now } });   // N-10 launch gate: this test has no samples, so the owner's override
  const pub = publisher();
  await go(opens + 3 * 3600000 + 60000);                      // run 1: the field (form given up on, so it is set now)
  const files = (d) => Object.fromEntries(fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => [f, JSON.parse(fs.readFileSync(path.join(d, f), "utf8"))]));
  assert.ok(files(dir)[`D${day}.json`].field.vt > 0, "makeField sets vt");
  assert.equal(pub.publish(files(dir), { FAKE_RACE: race }).status, 0);
  await go(opens + 3 * 3600000 + 6 * 60000);                  // run 2, five minutes later: nothing new
  assert.ok(files(dir)[`D${day}.json`].field.vt > 0, "loadDay must keep vt");                   // fails today
  const r2 = pub.publish(files(dir), { FAKE_RACE: race });
  assert.equal(r2.status, 0, r2.out);                                                            // fails today: "the field changed after it was published"
});

// M-H-n2: one bad run can't append invented hours/picks; at minimum the run must hold the vault file for review.
linux("M-H-n2: invented hours appended by one run don't reach a vault file without the owner's release", () => {
  const pub = publisher();
  const seed = dayFile("2026-11-15", PICKS, { hours: 1 });                    // Sunday of week 3, hour 0 published
  pub.publish({ "D2026-11-15.json": seed, "index.json": { ...idx, days: ["2026-11-15"] } }, { KG_TEST_NOW: String(Date.parse("2026-11-15T15:10:00Z")) });
  const forged = dayFile("2026-11-15", PICKS, { hours: 10 });                 // the rest of the event, invented
  const brd = boardOf([forged]);
  const v = { game: 13, week: 3, final: true, rows: brd.lastWeek.rows.filter((r) => r.pts >= 1).map((r) => ({ player: r.a, points: r.pts })), first: [], second: [] };
  const r = pub.publish({ "D2026-11-15.json": forged, "board.json": brd, "index.json": { ...idx, days: ["2026-11-15"] }, "vault/W3.json": v }, { KG_TEST_NOW: String(Date.parse("2026-11-16T12:30:00Z")) });
  assert.equal(pub.show("vault/W3.json"), null, r.out);                                         // fails today: published, exit 0
});

// N-1, the chain itself: hours whose counts aren't the chain's are refused, whatever the run's own files add up to.
linux("N-1: a run's new hours are read again on two nodes; invented counts, a skipped block or a disagreeing node are refused", () => {
  const day = "2026-11-10", rest = Object.fromEntries(REST_W3.map((x) => [`D${x}.json`, voidDay(x)])), ix = { ...idx, days: [day, ...REST_W3] };
  const honest = dayFile(day, PICKS);
  // The forged run: the same field and picks, but the winner's and another node's blocks swapped from hour 3 on, so a
  // chosen node wins; the run's files are internally consistent (cuts, players and board all follow from them).
  const swapped = dayFile(day, PICKS);
  for (const h of swapped.hours) if (h.i >= 3) { const x = h.blocks[WINNER]; h.blocks[WINNER] = h.blocks[CUT_ORDER[8]]; h.blocks[CUT_ORDER[8]] = x; }
  const L = globalThis.KLastNode, res = L.cutsFrom(swapped.field, swapped.hours);
  Object.assign(swapped, { cuts: res.cuts, standing: res.standing, winner: res.winner, done: res.done });
  swapped.players = PICKS.map(([w, s0, b]) => ({ a: w, r: L.playerResult(swapped.field, res, { start: s0, backup: b || null }) })).filter((x) => x.r.entered)
    .map(({ a, r }) => ({ a, start: r.start, jumpTo: r.jumpTo, out: r.out, survived: r.survived, rode: r.rode, jumped: r.jumped, points: r.points, ranked: true })).sort((x, y) => y.points - x.points || (x.a < y.a ? -1 : 1));
  assert.notEqual(swapped.winner, honest.winner, "the forgery changes the winner");
  const pub = publisher(); pub.chain(chainFor([day]));
  const r = pub.publish({ [`D${day}.json`]: swapped, ...rest, "board.json": boardOf([swapped]), "index.json": ix });
  assert.notEqual(r.status, 0); assert.match(r.out, /hour \d's block counts aren't the chain's/); assert.equal(pub.show(`D${day}.json`), null);
  // A window that leaves out its last block (to < the real last block) is refused too.
  const short = dayFile(day, PICKS, { hours: 1 }); short.hours[0].to -= 1;
  const r2 = publisher().publish({ [`D${day}.json`]: short, "index.json": { ...idx, days: [day] } });
  assert.notEqual(r2.status, 0); assert.match(r2.out, /isn't at or after its end/);
  // The two nodes disagree: refused (tried again next run).
  const pub3 = publisher(); const ch = chainFor([day]); pub3.chain({ ...ch, b: { windows: ch.windows.map((w, k) => (k === 0 ? { ...w, counts: { ...w.counts, [WINNER]: 99 } } : w)) } });
  const r3 = pub3.publish({ [`D${day}.json`]: dayFile(day, PICKS, { hours: 1 }), "index.json": { ...idx, days: [day] } });
  assert.notEqual(r3.status, 0); assert.match(r3.out, /the two nodes disagree about its blocks/);
  // The honest run passes.
  const ok = publisher().publish({ [`D${day}.json`]: honest, ...rest, "board.json": boardOf([honest]), "index.json": ix });
  assert.equal(ok.status, 0, ok.out);
});

linux("N-1: hour-0 picks are the Picks contract's (read on both nodes), and a new field is its race card's", () => {
  const day = "2026-11-10", X = "1" + "X".repeat(33);
  // A stranger planted on the winner in hour 0's picks.
  const planted = dayFile(day, [...PICKS, [X, WINNER]], { hours: 1 });
  const r = publisher().publish({ [`D${day}.json`]: planted, "index.json": { ...idx, days: [day] } });
  assert.notEqual(r.status, 0); assert.match(r.out, /its picks aren't the Picks contract's/);
  // A field with one node's handicap raised (the formula at its c gives 1).
  const f = dayFile(day, PICKS, { hours: 0 }); f.picks = {}; f.players = [];
  f.field = { ...f.field, nodes: f.field.nodes.map((n, i) => (i === 4 ? { ...n, h: 1.2 } : n)) };
  const r2 = publisher().publish({ [`D${day}.json`]: f, "index.json": { ...idx, days: [day] } });
  assert.notEqual(r2.status, 0); assert.match(r2.out, /handicap isn't the formula's/);
  // A field from a later card than the event's (chosen after seeing more of the day).
  const g = dayFile(day, PICKS, { hours: 0 }); g.picks = {}; g.players = []; g.field = { ...g.field, at: g.field.at + 3600000 };
  const r3 = publisher().publish({ [`D${day}.json`]: g, "index.json": { ...idx, days: [day] } });
  assert.notEqual(r3.status, 0); assert.match(r3.out, /field isn't from the event's race card|names a race card that isn't on race-data/);
  // The honest field alone (picks not read yet) is accepted.
  const h0 = dayFile(day, PICKS, { hours: 0 }); h0.picks = {}; h0.players = [];
  const ok = publisher().publish({ [`D${day}.json`]: h0, "index.json": { ...idx, days: [day] } }, { KG_TEST_NOW: String(Date.parse("2026-11-09T14:00:00Z")) });
  assert.equal(ok.status, 0, ok.out);
});

// M-H-n3: the publish job refuses a final board / vault file while a day of that week isn't done or void.
linux("M-H-n3: last week can't be marked final, nor a vault file filed, before every day is done or void", () => {
  const pub = publisher();
  const sun = dayFile("2026-11-15", PICKS, { hours: 1 });                      // not done
  const brd = boardOf([sun], true);
  const v = { game: 13, week: 3, final: true, rows: brd.lastWeek.rows.filter((r) => r.pts >= 1).map((r) => ({ player: r.a, points: r.pts })), first: [], second: [] };
  const r = pub.publish({ "D2026-11-15.json": sun, "board.json": brd, "index.json": { ...idx, days: ["2026-11-15"] }, ...(v.rows.length ? { "vault/W3.json": v } : {}) }, { KG_TEST_NOW: String(Date.parse("2026-11-16T12:30:00Z")) });
  assert.notEqual(r.status, 0); assert.equal(pub.show("vault/W3.json"), null);                // fails today
  // and the honest run that finishes Sunday afterwards is still accepted
  const done = dayFile("2026-11-15", PICKS, { hours: 10 });
  const r2 = pub.publish({ "D2026-11-15.json": done, "board.json": boardOf([done], true), "index.json": { ...idx, days: ["2026-11-15"] } }, { KG_TEST_NOW: String(Date.parse("2026-11-16T12:35:00Z")) });
  assert.equal(r2.status, 0, r2.out);
});

// M-H-n4: hours already published are not re-judged against race cards that appeared later.
// (Adapted to the N-4 rule: a window names the first card taken at or after its end; here c1, 20 minutes after hour 0.
// The late card is one taken between the window's end and c1 that reaches race-data only after the hour was published.)
linux("M-H-n4: a race card published after an hour was recorded doesn't refuse every later run", () => {
  const day = "2026-11-10", S = Date.parse(`${day}T14:00:00Z`);
  const c1 = card(S + 3600000 + 20 * 60000), late = card(S + 3600000 + 10 * 60000);
  const d0 = dayFile(day, PICKS, { hours: 1, raceCard: c1 });
  const pub = publisher();
  const files = { "D2026-11-10.json": d0, "index.json": { ...idx, days: [day] } };
  const r0 = pub.publish(files, { FAKE_RACE: raceFiles([c1]), KG_TEST_NOW: String(S + 3600000 + 25 * 60000) });
  assert.equal(r0.status, 0, r0.out);
  const r = pub.publish(files, { FAKE_RACE: raceFiles([c1, late]), KG_TEST_NOW: String(S + 3600000 + 30 * 60000) });
  assert.equal(r.status, 0, r.out);                                                              // fails today
});

// M-H-n5: a field histcheck and lastnode-math.js replay differently is refused at its first publish.
linux("M-H-n5: h whose x10000 rounds differently in Python and JavaScript, or vhp >= 2^53, is refused", () => {
  for (const tweak of [(n, i) => (i === 2 ? { ...n, h: 4.9999999999999996e-5 } : n), (n, i) => (i < 2 ? { ...n, vhp: 9007199254740992 + i } : n)]) {
    const d = dayFile("2026-11-10", PICKS, { hours: 0 });
    d.field = { ...d.field, nodes: d.field.nodes.map(tweak) };
    const r = publisher().publish({ "D2026-11-10.json": d, "index.json": { ...idx, days: ["2026-11-10"] } }, { KG_TEST_NOW: String(Date.parse("2026-11-10T13:30:00Z")) });
    assert.notEqual(r.status, 0, "planted field accepted");                                     // fails today
  }
});

// M-H-n6: watch-and-hold is enforced by the publish job, not only by the recorder.
linux("M-H-n6: a vault file for a week watchWeek flags is not published unless the week is released", () => {
  // Week 3's winner signs 160 blocks an hour against 100 expected (it wins; watchWeek flags it, z about 6), the board is
  // final and published. A run files W3 without a HOLD file and without LASTNODE_RELEASE_WEEKS: not on games-data.
  const pub = publisher(); pub.chain(gamed.chain()); pub.seed(gamed.history());
  const r = pub.publish({ ...gamed.history(), "vault/W3.json": vgood });
  assert.notEqual(r.status, 0, r.out); assert.equal(pub.show("vault/W3.json"), null);
  const rel = pub.publish({ ...gamed.history(), "vault/W3.json": vgood }, { LASTNODE_RELEASE_WEEKS: "3" });
  assert.equal(rel.status, 0, rel.out); assert.ok(pub.show("vault/W3.json"), "released by the owner: filed");
});

// N-2 end to end (the report's "add a publish-twice test"): the REAL recorder and the REAL publish job, run after run,
// with hours, picks and race cards, everything checked against the (fake) chain. Every honest run must publish.
linux("N-2: recorder → publish → recorder → publish, through a field, picks and recorded hours, never refused", async () => {
  const { fieldCard, chainFor } = await import("./lastnode-vault.helpers.mjs");
  const day = "2026-11-10", start = Date.parse(`${day}T14:00:00Z`), L = globalThis.KLastNode, ev = L.eventOf(day);
  const honest = dayFile(day, PICKS, { hours: 10 });
  const hourly = Array.from({ length: 12 }, (_, k) => ({ ...fieldCard(day), at: start + (k + 1) * 3600000 + 5 * 60000 }));
  const race = raceFiles([fieldCard(day), ...hourly]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2-"));
  const windowOf = async (_n, t0) => { const h = honest.hours[(t0 - start) / 3600000]; if (!h) throw new Error("not this event"); return { from: h.from, to: h.to, counts: { ...h.blocks, ["1" + "z".repeat(33)]: 200 } }; };
  const picksOf = async (_n, round) => (round === ev.round ? PICKS.map(([w, s0, b]) => (b ? [w, s0, start - 3600000, b] : [w, s0, start - 3600000])) : []);
  const go = (t) => run({ p: "m", check: "c", prev: dir, out: dir, raceDir: race, picksContract: "1" + "K".repeat(33), windowOf, picksOf, hoursOf: async (_n, _a, n) => Array.from({ length: n }, () => ({})),
    rankedOf: async (w) => new Set(w), stakedOf: async () => null, trials: 200, allowNoForm: true, now: { time: t, libTime: t } });
  const files = () => Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))]));
  const pub = publisher(); pub.chain(chainFor([day]));
  const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };
  for (const t of [ev.opens + 60000, ev.opens + 6 * 60000, start + 3 * 3600000 + 10 * 60000, start + 3 * 3600000 + 15 * 60000, start + 10 * 3600000 + 10 * 60000, start + 10 * 3600000 + 15 * 60000]) {
    await quiet(() => go(t));
    const r = pub.publish(files(), { KG_TEST_NOW: String(t + 60000), FAKE_RACE: race });
    assert.equal(r.status, 0, `run at ${new Date(t).toISOString()}: ${r.out}`);
  }
  const d = JSON.parse(pub.show(`D${day}.json`));
  assert.equal(d.hours.length, 10); assert.equal(d.done, true); assert.equal(d.winner, WINNER);
  assert.ok(d.hours.every((h, i) => h.card === hourly[i].at), "each window names the first card after it");
  assert.equal(d.players.find((p) => p.a === PICKS[0][0]).points, 15);
});
