// Repo Lens round 3, behaviour tests written with the fixes (they fail on 1c66ddc): BX-53 (VHP flashed into the signer
// between its card and block X is counted), BX-55 (a card on which the nodes disagreed about the signer is never
// scored), and BX-62/BX-65 (the publish check still accepts the honest vault file, and refuses a reordered one).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { utils, Signer } from "koilib";

const APP = process.env.APP || ".";
const BX = await import(path.resolve(APP, "bot/games/blockx.ts"));
const M = globalThis.KRaceMath, X = globalThis.KBlockX;
const addr = (seed) => Signer.fromSeed(seed).getAddress();
const BIG = addr("b-big"), MID = addr("b-mid"), ALICE = addr("b-alice"), VHP = addr("b-vhp");
const W3 = M.weekStart(3), H0 = 48_000_000;
const T = (h) => W3 + 3600000 + (h - H0) * 3000;

function raceDir({ flagged } = {}) {
  const rd = fs.mkdtempSync(path.join(os.tmpdir(), "r3b-race-"));
  const CARD = { at: 0, c: 1, blocksPerRace: 7200, fairness: null, field: [{ a: BIG, vhp: 2000, k: 600, h: 1 }, { a: MID, vhp: 1000, k: 300, h: 2 }], paddock: [], ...(flagged ? { flagged } : {}) };
  for (const w of [2, 3, 4]) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) { const i = M.raceIndex(t); races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards: Array.from({ length: 6 }, (_, l) => ({ ...CARD, samples: 36, at: t + l * 3600000 + 37 * 60000 })), result: null }); }
    fs.writeFileSync(path.join(rd, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  return rd;
}
async function go({ moved = 0n, flagged, lateBy = 0 } = {}) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "r3b-bx-")), lib = H0 + 2 * X.ROUND + 50;
  const log = console.log; console.log = () => {};
  try {
    return await BX.run({ p: {}, check: null, out, raceDir: raceDir({ flagged }), picksContract: addr("b-picks"), knodeGame: null, vhpContract: VHP,
      blockOf: async (_n, h) => ({ signer: MID, time: T(h) }),
      picksOf: async (_n, rr) => [{ player: ALICE, producer: MID, time: T(rr * X.ROUND) - 3600000 }],
      vhpMovesOf: async () => moved,
      head: { height: lib + 60, time: T(lib + 60) + lateBy, lib } });
  } finally { console.log = log; }
}
const scored = (r) => [...r.weeks.values()].flatMap((w) => w.targets).filter((t) => !t.void).map((t) => t.picks.find((p) => p[0] === ALICE)[3]);

test("BX-53: VHP moved into the signer between its card and block X counts on the card (no x2 for a flash stake)", async () => {
  const honest = scored(await go());
  assert.ok(honest.length > 0 && honest.every((p) => p === 200), `MID has half the top's VHP: x2 (${honest})`);
  const flashed = scored(await go({ moved: 3000n * 100000000n }));
  assert.ok(flashed.length > 0 && flashed.every((p) => p === 100), `3,000 VHP moved in: MID is the biggest, x1 (${flashed})`);
});

test("BX-53: vhpInflows reads the VHP contract's transfer and mint events to the signer from a receipt", () => {
  const vint = (n) => { n = BigInt(n); const o = []; do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; o.push(b); } while (n); return o; };
  const bytesF = (f, b) => [(f << 3) | 2, b.length, ...b], numF = (f, v) => [(f << 3), ...vint(v)];
  const to = [...utils.decodeBase58(MID)], other = [...utils.decodeBase58(BIG)];
  const ev = (name, data, source = VHP) => ({ source, name, data: Buffer.from(Uint8Array.from(data)).toString("base64"), impacted: [MID] });
  const receipt = { events: [ev("vhp.mint", [...bytesF(1, to), ...numF(2, 5)])], transaction_receipts: [{ events: [
    ev("vhp.transfer", [...bytesF(1, other), ...bytesF(2, to), ...numF(3, 7)]),
    ev("vhp.transfer", [...bytesF(1, to), ...bytesF(2, other), ...numF(3, 100)]),           // out of MID: ignored
    ev("vhp.transfer", [...bytesF(1, other), ...bytesF(2, to), ...numF(3, 1000)], BIG),     // another contract: ignored
  ] }] };
  assert.equal(BX.vhpInflows(receipt, VHP, MID), 12n);
});

test("BX-55: a lock card on which the two nodes disagreed about the signer is never scored (voided after the wait)", async () => {
  const r = await go({ flagged: [MID], lateBy: 4 * 3600000 });
  const ts = [...r.weeks.values()].flatMap((w) => w.targets);
  assert.ok(ts.length > 0 && ts.every((t) => t.void && /disagreed about the signer/.test(t.void)), ts.map((t) => t.void).join("; "));
  const waiting = await go({ flagged: [MID] });
  assert.ok(waiting.problems.some((p) => /disagreed about .*VHP on its lock card; held|waiting for the first handicap card after/.test(p)), "held, not scored");
  assert.equal(scored(waiting).length, 0);
  const other = scored(await go({ flagged: [BIG] }));
  assert.ok(other.length > 0 && other.every((p) => p === 200), "a flag on another producer changes nothing for MID's targets");
});

// The publish job's check, run as it is in the workflow.
function py(yml) { const y = fs.readFileSync(path.join(APP, yml), "utf8"); const s = y.indexOf("<<'PY'\n") + 7, e = y.indexOf("\n          PY\n", s); return y.slice(s, e).split("\n").map((l) => l.slice(10)).join("\n"); }
test("BX-62 / BX-65 / BX-79 (round 4): judged against the PUBLISHED final board and prize file and the job's clock", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "r3b-py-")), "check.py"); fs.writeFileSync(f, py(".github/workflows/games.yml"));
  const S1 = addr("s1"), S2 = addr("s2"), F1 = addr("f1");
  const row = (a, place, ranked) => ({ a, place, boardPlace: place, pts: 100, correct: 1, picks: 1, days: 3, lastCorrect: 0, ranked });
  const W = 7 * 86400000, GEN = 1792368000000, wk = 40, start = GEN + wk * W, end = start + W;
  const prizes = [{ player: F1, place: 1, vhp: 2 }];
  const board = (w = wk, final = true) => ({ v: 1, updated: new Date(end + 13 * 3600000).toISOString(), today: { day: "2026-12-01", rows: [] }, week: { week: w + 1, start: end, rows: [] },
    lastWeek: { week: w, start: GEN + w * W, final, rows: [row(S1, 1, true), row(S2, 2, true), row(F1, 1, false)], prizes }, allTime: { rows: [] } });
  const make = (vault, { now = end + 13 * 3600000, pubBoard = board(), pubP = true } = {}) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "r3b-")), b = path.join(d, "blockx"), pub = path.join(d, "pub");
    fs.mkdirSync(path.join(b, "vault"), { recursive: true }); fs.mkdirSync(pub);
    fs.writeFileSync(path.join(b, "board.json"), JSON.stringify(board()));   // this run's own board (not trusted)
    fs.writeFileSync(path.join(b, "vault", `W${vault.week}.json`), JSON.stringify(vault));
    if (pubBoard) fs.writeFileSync(path.join(pub, "board.json"), JSON.stringify(pubBoard));
    if (pubP) fs.writeFileSync(path.join(pub, `P${String(wk).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: wk, game: 2, at: new Date(end).toISOString(), prizes }));
    return spawnSync("python3", ["-I", f, b, "2", pub], { encoding: "utf8", env: { ...process.env, CHECK_NOW_MS: String(now) } }).status;
  };
  const good = { game: 2, week: wk, final: true, rows: [{ player: S1, points: 255 }, { player: S2, points: 254 }], first: [F1], second: [] };
  assert.equal(make(good), 0, "the honest file");
  assert.notEqual(make({ ...good, rows: [{ player: S2, points: 255 }, { player: S1, points: 254 }] }), 0, "rows out of board order");
  assert.notEqual(make({ ...good, rows: [{ player: S1, points: 255 }, { player: S2, points: 1 }] }), 0, "points not recomputed from the places");
  assert.notEqual(make({ ...good, rows: [{ player: addr("x"), points: 255 }] }), 0, "a wallet not on the published Staked board");
  assert.notEqual(make({ ...good, first: [S1], rows: [{ player: S2, points: 255 }] }), 0, "a staked player as a free winner");
  assert.notEqual(make({ ...good, week: 39 }), 0, "another week");
  assert.notEqual(make(good, { now: end + 4 * 86400000 }), 0, "more than 3 days after the week (the vault's window)");
  assert.notEqual(make(good, { pubBoard: board(wk, false) }), 0, "the published board isn't final yet");
  assert.notEqual(make(good, { pubBoard: null }), 0, "nothing published to check against");
  assert.notEqual(make(good, { pubP: false }), 0, "the prize file isn't published yet");
});
