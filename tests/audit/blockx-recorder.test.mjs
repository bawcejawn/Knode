// Who Signs Block X recorder (bot/games/blockx.ts): targets recorded only once irreversible and matching on two nodes,
// picks agreeing on both nodes, points from the race card in force at the lock, void when no card ever comes, the
// leaderboards and the week's prizes after the 12-hour correction window. Offline: fake nodes and fake race files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP || ".";
const { run } = await import(path.resolve(APP, "bot/games/blockx.ts"));
const M = globalThis.KRaceMath, X = globalThis.KBlockX;
const plain = (x) => JSON.parse(JSON.stringify(x));

const BIG = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", MID = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", SMALL = "1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ALICE = "1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", BOB = "1EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE", GUEST = "1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";

// Week 3 (Mon 2 Nov 2026). A made-up chain: block h at time T(h); every target is signed by BIG except every third (MID).
const W3 = M.weekStart(3);
const H0 = 48_000_000;                          // a height at W3 + 1 h
const T = (h) => W3 + 3600000 + (h - H0) * 3000;
const signerOf = (h) => (h % X.ROUND === 0 && (h / X.ROUND) % 3 === 0 ? MID : BIG);
function blockOf(tamperAt = null) {
  return async (node, h) => ({ signer: node === "check" && tamperAt === h ? SMALL : signerOf(h), time: T(h) });
}
// Picks: Alice always picks MID, Bob always BIG, the guest SMALL. Times spread over 3 days.
function picksOf(tamperRound = null) {
  return async (node, r) => {
    const t = T(r * X.ROUND) - 3600000;
    const rows = [{ player: ALICE, producer: MID, time: t }, { player: BOB, producer: BIG, time: t }, { player: GUEST, producer: SMALL, time: t }];
    if (node === "check" && r === tamperRound) rows[0].producer = BIG;
    return rows;
  };
}
const rankedOf = async (who) => new Set(who.filter((a) => a !== GUEST));
const CARD = { at: 0, c: 1, blocksPerRace: 7200, fairness: null, field: [{ a: BIG, vhp: 2000, k: 600, h: 1 }, { a: MID, vhp: 1000, k: 300, h: 2 }], paddock: [{ a: SMALL, vhp: 10, k: 3 }] };
function raceDir({ withCards = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "race-"));
  for (const w of [2, 3, 4]) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) { const i = M.raceIndex(t); races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards: new Array(6).fill(withCards ? CARD : null), result: null }); }
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  return d;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "blockx-"));
const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };

test("records irreversible targets with picks and capped points from the card at the lock", async () => {
  const out = tmp(), lib = H0 + 10 * X.ROUND + 50;
  const r = await quiet(() => run({ p: "main", check: "check", out, raceDir: raceDir(), picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(), rankedOf,
    head: { height: lib + 60, time: T(lib + 60), lib } }));
  assert.deepEqual(r.problems, []);
  const wf = JSON.parse(fs.readFileSync(path.join(out, "W003.json"), "utf8"));
  const rounds = wf.targets.map((t) => t.round);
  assert.ok(rounds.includes(H0 / X.ROUND + 10) && !rounds.includes(H0 / X.ROUND + 11), "only irreversible targets");
  for (const t of wf.targets) {
    assert.equal(t.height % X.ROUND, 0); assert.equal(t.checked, 2); assert.equal(t.lockTime, T(t.height - 100));
    const byPlayer = Object.fromEntries(t.picks.map((p) => [p[0], p]));
    if (t.signer === MID) { assert.equal(byPlayer[ALICE][3], 200); assert.equal(byPlayer[BOB][3], 0); }
    else { assert.equal(byPlayer[BOB][3], 100); assert.equal(byPlayer[ALICE][3], 0); }
    assert.equal(byPlayer[GUEST][3], 0); assert.equal(byPlayer[GUEST][4], 0, "guest not ranked");
  }
  const board = JSON.parse(fs.readFileSync(path.join(out, "board.json"), "utf8"));
  assert.equal(board.week.week, 3);
  assert.ok(board.week.rows.length === 3 && board.week.rows.every((x) => typeof x.pts === "number"));
});

test("not recorded when the two nodes disagree about the block or the picks", async () => {
  const lib = H0 + 3 * X.ROUND + 50, badH = H0 + 2 * X.ROUND;
  const r1 = await quiet(() => run({ p: "main", check: "check", out: tmp(), raceDir: raceDir(), picksContract: "1P", blockOf: blockOf(badH), picksOf: picksOf(), rankedOf, head: { height: lib, time: T(lib), lib } }));
  assert.ok(r1.problems.some((p) => p.includes(`block ${badH}`) && p.includes("disagree")));
  const r2 = await quiet(() => run({ p: "main", check: "check", out: tmp(), raceDir: raceDir(), picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(badH / X.ROUND), rankedOf, head: { height: lib, time: T(lib), lib } }));
  assert.ok(r2.problems.some((p) => p.includes("picks") && p.includes("disagree")));
  const wf = r2.weeks.get(3);
  assert.ok(!wf.targets.some((t) => t.round === badH / X.ROUND));
});

test("no race card: waits, and a target older than 3 days is recorded void with no points", async () => {
  const lib = H0 + 3 * X.ROUND + 50;
  const r = await quiet(() => run({ p: "main", check: null, out: tmp(), raceDir: raceDir({ withCards: false }), picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(), rankedOf, head: { height: lib, time: T(lib), lib } }));
  assert.ok(r.problems.some((p) => p.includes("no handicap card yet")));
  assert.equal((r.weeks.get(3)?.targets || []).length, 0);
  // 3 days later the old ones are void
  const later = lib + 3 * 28800 - X.ROUND;
  const r2 = await quiet(() => run({ p: "main", check: null, out: tmp(), raceDir: raceDir({ withCards: false }), picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(), rankedOf, head: { height: later, time: T(later), lib: later } }));
  const all = [...r2.weeks.values()].flatMap((w) => w.targets);
  const voided = all.filter((t) => t.void);
  assert.ok(voided.length >= 1 && voided.every((t) => t.picks.every((p) => p[3] === 0)));
});

/** Record the whole of week 3, then one run from Monday of week 4 at `hoursAfter`. */
async function weekThenLook(picks, hoursAfter, extra = {}) {
  const rd = raceDir();
  let prev;
  const startH = H0 - Math.floor(3600000 / 3000), endH = startH + 7 * 28800;   // W3 00:00, W4 00:00
  for (let lib = startH + 12 * X.ROUND; lib <= endH + 4 * X.ROUND; lib += 12 * X.ROUND) {
    const o = tmp();
    await quiet(() => run({ p: "main", check: null, prev, out: o, raceDir: rd, picksContract: "1P", blockOf: blockOf(), picksOf: picks, rankedOf, head: { height: lib, time: T(lib), lib }, ...extra }));
    prev = o;
  }
  const at = endH + hoursAfter * 1200;
  return quiet(() => run({ p: "main", check: null, prev, out: tmp(), raceDir: rd, picksContract: "1P", blockOf: blockOf(), picksOf: picks, rankedOf, head: { height: at, time: T(at), lib: at - 60 }, ...extra }));
}
// Here the guest (Free play) picks the signer every time; Bob (Staked) always picks BIG.
const picksGuest = async (node, r) => { const t = T(r * X.ROUND) - 3600000 * (1 + (r % 3)); return [{ player: GUEST, producer: signerOf(r * X.ROUND), time: t }, { player: BOB, producer: BIG, time: t }]; };

test("no prizes are listed until PRIZES_FROM_WEEK (prizes start with the vault, owner 2026-10-28)", async () => {
  const r = await weekThenLook(picksGuest, 13);
  assert.equal(r.board.lastWeek.final, true);
  assert.deepEqual(r.board.lastWeek.prizes, [], "no prize week set: nothing listed, nothing owed");
  const later = await weekThenLook(picksGuest, 13, { prizesFromWeek: 4 });
  assert.deepEqual(later.board.lastWeek.prizes, [], "week 3 is before the first prize week 4");
});

test("prizes, from the first prize week: only after the 12-hour correction window, and only the Free play board's top 2", async () => {
  const early = await weekThenLook(picksGuest, 6, { prizesFromWeek: 3 });
  assert.equal(early.board.lastWeek.week, 3);
  assert.equal(early.board.lastWeek.final, false, "6 h after the week: still in the correction window");
  assert.deepEqual(early.board.lastWeek.prizes, []);
  const late = await weekThenLook(picksGuest, 13, { prizesFromWeek: 3 });
  assert.equal(late.board.lastWeek.final, true);
  // The guest is Free play and right every time: 1st, the whole 2 + 1 VHP? No: a lone winner takes 1st (2 VHP); Bob is
  // Staked, so the Free play board has nobody else and 2nd stays unpaid.
  assert.deepEqual(plain(late.board.lastWeek.prizes).map((x) => [x.player, x.vhp]), [[GUEST, 2]]);
  const rows = late.board.lastWeek.rows;
  assert.equal(rows.find((x) => x.a === GUEST).ranked, false, "Free play board");
  assert.equal(rows.find((x) => x.a === BOB).ranked, true, "Staked board");
});

test("the Free play prize needs picks on 3 different days and at least one point", async () => {
  // Two free wallets: CAROL is right but picks on one day only; DAVE picks on 3 days.
  const CAROL = "1GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG", DAVE = "1HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH";
  const picks = async (node, r) => {
    const h = r * X.ROUND, t = T(h);
    return [{ player: CAROL, producer: signerOf(h), time: M.weekStart(3) + 1000 }, { player: DAVE, producer: signerOf(h), time: t - 3600000 }];
  };
  const r = await weekThenLook(picks, 13, { prizesFromWeek: 0, rankedOf: async () => new Set() });   // both Free play
  const pz = plain(r.board.lastWeek.prizes).map((x) => x.player);
  assert.ok(pz.includes(DAVE) && !pz.includes(CAROL), "one-day wallet can't win");
});

// ── the testnet way: its own hourly cards, a fast game, its own config ──
test("testnet: the recorder takes its own hourly card (no Producer Race there) and scores a fast game with it", async () => {
  const FAST = { id: 92, round: 300, offset: 0, lead: 100, ahead: 3700, picksPerDay: 50, maxChanges: 5 };
  const lib = H0 + 10 * 300 + 50;
  const signersOf = async () => ({ signers: [BIG, MID, SMALL], first: T(lib - 7199), last: T(lib), n: 7200 });
  const vhpOf = async () => ({ [BIG]: "200000000000", [MID]: "100000000000", [SMALL]: "1000000000" });
  const fastPicks = async (node, r) => [{ player: ALICE, producer: MID, time: T(r * 300) - 600000 }];
  // The lock of each target here comes after the card is taken? No: the card is taken at the run (head time), and a
  // lock before the first card uses the first card taken within the hour after it.
  const out = tmp();
  const r1 = await quiet(() => run({ p: "main", check: null, out, game: FAST, cards: "self", picksContract: "1P", blockOf: blockOf(), picksOf: fastPicks, rankedOf, signersOf, vhpOf,
    head: { height: lib + 60, time: T(lib + 60), lib } }));
  assert.equal(r1.cards.length, 1, "one card taken this hour");
  const cards = JSON.parse(fs.readFileSync(path.join(out, "cards.json"), "utf8"));
  assert.equal(cards.v, 1); assert.equal(cards.cards.length, 1);
  const wf = JSON.parse(fs.readFileSync(path.join(out, "W003.json"), "utf8"));
  assert.equal(wf.game, 92);
  assert.ok(wf.targets.every((t) => t.height % 300 === 0 && t.lockTime === T(t.height - 100)));
  const recent = wf.targets.filter((t) => T(lib + 60) - t.lockTime <= 3600000);
  assert.ok(recent.length >= 1 && recent.every((t) => !t.void && t.card), "targets whose lock is within the hour before the card are scored");
  assert.ok(wf.targets.every((t) => !t.void), "no void rows for the days before the recorder first ran");
  assert.equal(cards.startHeight, lib + 60, "it remembers where it started");
  const t = recent.find((x) => x.signer === MID);
  if (t) assert.equal(t.picks[0][3], 200, "MID has half the top's VHP: ×2");
  // A second run in the same hour doesn't take another card.
  const r2 = await quiet(() => run({ p: "main", check: null, prev: out, out: tmp(), game: FAST, cards: "self", picksContract: "1P", blockOf: blockOf(), picksOf: fastPicks, rankedOf, signersOf, vhpOf,
    head: { height: lib + 70, time: T(lib + 70), lib: lib + 10 } }));
  assert.equal(r2.cards.length, 1);
});

test("testnet: testnet/blockx.json is a valid config the Picks contract would accept", async () => {
  const { readNetConfig } = await import(path.resolve(APP, "bot/games/blockx.ts"));
  const c = readNetConfig(path.resolve(APP, "testnet/blockx.json"));
  assert.equal(c.network, "koinos-foundation-testnet");
  assert.equal(c.rpc, "https://testnet.koinosfoundation.org");
  assert.notEqual(c.chainId, "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==");
  assert.ok(c.games.some((g) => g.id === 2 && g.round === 2400 && g.lead === 100 && g.ahead === 28900), "game 2 with the real mainnet settings");
  for (const g of c.games) { const G = X.forGame(g); assert.equal(G.openRounds(48_000_000).length, 12, `game ${g.id}: 12 targets open`); assert.ok(g.id < 128); }
  assert.match(c.data, /^https:\/\/raw\.githubusercontent\.com\/bawcejawn\/Knode\/testnet-data\/$/, "its own data branch, never games-data");
});

// ── the testnet workflow (.github/workflows/games-testnet.yml): its publish check takes the recorder's real output ──
import { execFileSync, spawnSync } from "node:child_process";
test("testnet workflow: publishes only to testnet-data, off by default, and its shape check takes the real output", async () => {
  const wf = fs.readFileSync(path.resolve(APP, ".github/workflows/games-testnet.yml"), "utf8");
  assert.match(wf, /vars\.TESTNET_GAMES_ENABLED == 'true'/, "off until the owner turns it on");
  assert.ok(!/secrets\./.test(wf), "no secrets");
  const pushes = [...wf.matchAll(/git push[^\n]*/g)].map((m) => m[0]);
  assert.deepEqual(pushes, ['git push -q "$remote" "$commit:refs/heads/testnet-data"'], "it pushes testnet-data and nothing else");
  assert.ok(!/games-data|race-data|refs\/heads\/main"/.test(wf.replace(/never main, never games-data/g, "")), "never names a mainnet branch");
  assert.match(wf, /--testnet --game/);
  // The shape check, exactly as the workflow runs it.
  // The Python exactly as the runner gets it: YAML parsed, then the heredoc body of the publish step (review #1).
  const runs = JSON.parse(execFileSync("python3", ["-c", "import yaml,json,sys; w=yaml.safe_load(open(sys.argv[1])); print(json.dumps([s.get('run','') for j in w['jobs'].values() for s in j['steps']]))", path.resolve(APP, ".github/workflows/games-testnet.yml")], { encoding: "utf8" }));
  const sh = runs.find((r) => r.includes("<<'PY'"));
  const py = sh.slice(sh.indexOf("<<'PY'\n") + 7, sh.indexOf("\nPY\n") + 1);
  assert.ok(py.length > 500 && /^import json/.test(py), "the heredoc body, with the shell's own indentation removed");
  const FAST = { id: 92, round: 300, offset: 0, lead: 100, ahead: 3700, picksPerDay: 50, maxChanges: 5 };
  const lib = H0 + 10 * 300 + 50;
  const signersOf = async () => ({ signers: [BIG, MID, SMALL], first: T(lib - 7199), last: T(lib), n: 7200 });
  const vhpOf = async () => ({ [BIG]: "200000000000", [MID]: "100000000000", [SMALL]: "1000000000" });
  const fastPicks = async (node, r) => [{ player: ALICE, producer: MID, time: T(r * 300) - 600000 }];
  const out = tmp();
  await quiet(() => run({ p: "main", check: null, out, game: FAST, cards: "self", picksContract: "1" + "P".repeat(33), blockOf: blockOf(), picksOf: fastPicks, rankedOf, signersOf, vhpOf,
    head: { height: lib + 60, time: T(lib + 60), lib } }));
  const check = (dir, id) => spawnSync("python3", ["-I", "-", dir, String(id)], { input: py, encoding: "utf8" });
  const ok = check(out, 92);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /testnet games files ok/);
  assert.notEqual(check(out, 2).status, 0, "files for game 92 can't be published as game 2");
  const bad = tmp(); for (const f of fs.readdirSync(out)) fs.copyFileSync(path.join(out, f), path.join(bad, f));
  const c = JSON.parse(fs.readFileSync(path.join(bad, "cards.json"), "utf8")); c.cards[0].field[0].a = "<script>"; fs.writeFileSync(path.join(bad, "cards.json"), JSON.stringify(c));
  assert.notEqual(check(bad, 92).status, 0, "a card with a bad address is refused");
  void execFileSync;
});

test("every workflow's embedded Python compiles exactly as the runner gets it", () => {
  const out = execFileSync("python3", ["-c", `
import yaml, sys, glob, re
n = 0
for f in sorted(glob.glob(sys.argv[1] + "/.github/workflows/*.yml")):
    w = yaml.safe_load(open(f))
    for j in w["jobs"].values():
        for st in j.get("steps", []):
            r = st.get("run", "")
            for m in re.finditer(r"<<'PY'\\n(.*?)\\n[ ]*PY\\n", r, re.S):
                body = m.group(1)
                # inside a loop the shell keeps the heredoc lines as written; python must still compile them
                compile(body + "\\n", f, "exec"); n += 1
print(n)`, path.resolve(APP)], { encoding: "utf8" });
  assert.ok(Number(out) >= 2, `compiled ${out.trim()} blocks`);
});
