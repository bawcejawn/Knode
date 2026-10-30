// Who Signs Block X recorder (bot/games/blockx.ts): targets recorded only once irreversible and matching on two nodes,
// picks agreeing on both nodes, points from the race card in force at the lock, void when no card ever comes, the
// leaderboards and the week's prizes after the 12-hour correction window. Offline: fake nodes and fake race files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP || ".";
const { run, vaultFile } = await import(path.resolve(APP, "bot/games/blockx.ts"));
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
    // Each hourly card stamped with the time the race recorder took it (37 minutes into its hour), as on mainnet.
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) { const i = M.raceIndex(t); races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards: Array.from({ length: 6 }, (_, l) => (withCards ? { ...CARD, samples: 36, at: t + l * 3600000 + 37 * 60000 } : null)), result: null }); }
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

const head0 = (lib) => T(lib);
test("no race card: waits, and a target older than 3 days is recorded void with no points", async () => {
  const lib = H0 + 3 * X.ROUND + 50;
  const r = await quiet(() => run({ p: "main", check: null, out: tmp(), raceDir: raceDir({ withCards: false }), picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(), rankedOf, head: { height: lib, time: T(lib), lib } }));
  assert.ok(r.problems.some((p) => p.includes("no handicap card yet")));
  // Audit BX-48: a lock more than 3 hours ago can never get a card (cards are only made going forward): void now.
  const recorded = r.weeks.get(3)?.targets || [];
  assert.ok(recorded.every((t) => t.void && head0(lib) - t.lockTime > 3 * 3600000), "only old locks are voided; recent ones wait");
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
  // Player rule (owner, 2026-10-28): Bob is staked in Block X (the Staked board, the game's bucket), so only the
  // free players play for the prize: the guest, right every time, takes 1st (2 VHP); nobody free is 2nd.
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
test("testnet: the recorder takes its own hourly card (no Producer Race there); only locks after a card are scored with it", async () => {
  const FAST = { id: 92, round: 300, offset: 0, lead: 100, ahead: 3700, picksPerDay: 50, maxChanges: 5 };
  const lib = H0 + 10 * 300 + 50;
  const signersOf = async () => ({ signers: [BIG, MID, SMALL], first: T(lib - 7199), last: T(lib), n: 7200 });
  const vhpOf = async () => ({ [BIG]: "200000000000", [MID]: "100000000000", [SMALL]: "1000000000" });
  const fastPicks = async (node, r) => [{ player: ALICE, producer: MID, time: T(r * 300) - 600000 }];
  // First run: the first card is taken now; every target recorded so far locked before it, so none can be scored.
  const out = tmp();
  const r1 = await quiet(() => run({ p: "main", check: null, out, game: FAST, cards: "self", picksContract: "1P", blockOf: blockOf(), picksOf: fastPicks, rankedOf, signersOf, vhpOf,
    head: { height: lib + 60, time: T(lib + 60), lib } }));
  assert.equal(r1.cards.length, 1, "one card taken this hour");
  const cards = JSON.parse(fs.readFileSync(path.join(out, "cards.json"), "utf8"));
  assert.equal(cards.v, 1); assert.equal(cards.cards.length, 1);
  assert.equal(cards.startHeight, lib + 60, "it remembers where it started");
  const w1 = JSON.parse(fs.readFileSync(path.join(out, "W003.json"), "utf8"));
  assert.equal(w1.game, 92);
  assert.ok(w1.targets.every((t) => t.height % 300 === 0 && t.lockTime === T(t.height - 100)));
  assert.ok(w1.targets.every((t) => t.void && !t.card), "audit BX-3: a lock before the first card is never scored with a later card");
  // A second run 90 minutes later: targets whose lock came after the first card are scored with that card.
  const lib2 = lib + 1800;
  const out2 = tmp();
  await quiet(() => run({ p: "main", check: null, prev: out, out: out2, game: FAST, cards: "self", picksContract: "1P", blockOf: blockOf(), picksOf: fastPicks, rankedOf, signersOf, vhpOf,
    head: { height: lib2 + 60, time: T(lib2 + 60), lib: lib2 } }));
  const w2 = JSON.parse(fs.readFileSync(path.join(out2, "W003.json"), "utf8"));
  const scored = w2.targets.filter((t) => !t.void);
  assert.ok(scored.length >= 1, "targets locked after the first card are scored");
  assert.ok(scored.every((t) => t.card && t.card.at <= t.lockTime), "every card used was taken at or before its lock");
  const t = scored.find((x) => x.signer === MID);
  if (t) assert.equal(t.picks[0][3], 200, "MID has half the top's VHP: ×2");
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
  const bad = tmp(); fs.cpSync(out, bad, { recursive: true });
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

// ── audit fixes (Repo Lens, 2026-10-28) ──
test("BX-4: Staked status is read on both nodes, and a disagreement holds the target", async () => {
  const lib = H0 + 2 * X.ROUND + 50, asked = [];
  const lying = async (who, node) => { asked.push(node); return node === "main" ? new Set() : new Set(who.filter((a) => a !== GUEST)); };
  const r = await quiet(() => run({ p: "main", check: "check", out: tmp(), raceDir: raceDir(), picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(), rankedOf: lying,
    head: { height: lib, time: T(lib), lib } }));
  assert.ok(asked.includes("main") && asked.includes("check"), "both nodes asked");
  assert.ok(r.problems.some((p) => /disagree about which players are Staked/.test(p)));
  const ts = [...r.weeks.values()].flatMap((w) => w.targets);
  assert.ok(ts.every((t) => t.void && !t.picks.length), "nothing scored while they disagree (targets past the 3-day window are voided, BX-16)");
  assert.ok(ts.every((t) => /disagreed about Staked/.test(t.void)));
});
test("BX-3: a card taken after the lock is never used for it; a signer missing from the card scores ×1", async () => {
  const lib = H0 + 4 * X.ROUND + 50;
  const r = await quiet(() => run({ p: "main", check: null, out: tmp(), raceDir: raceDir(), picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(), rankedOf,
    head: { height: lib, time: T(lib), lib } }));
  const ts = [...r.weeks.values()].flatMap((w) => w.targets).filter((t) => t.card);
  assert.ok(ts.length > 0);
  for (const t of ts) assert.ok(t.card.at <= t.lockTime, `card at ${t.card.at} after lock ${t.lockTime}`);
  const FRESH = "1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
  const r2 = await quiet(() => run({ p: "main", check: null, out: tmp(), raceDir: raceDir(), picksContract: "1P",
    blockOf: async (_n, h) => ({ signer: FRESH, time: T(h) }), picksOf: async () => [{ player: ALICE, producer: FRESH, time: T(H0) }], rankedOf,
    head: { height: lib, time: T(lib), lib } }));
  const pts = [...r2.weeks.values()].flatMap((w) => w.targets).flatMap((t) => t.picks).map((p) => p[3]);
  assert.ok(pts.length && pts.every((x) => x <= 100), `fresh signer scored ${pts}`);
});
test("BX-5: last week is not final while its last target is unrecorded; it is once that target is in", async () => {
  const startH = H0 - Math.floor(3600000 / 3000), endH = startH + 7 * 28800;
  const lastTarget = Math.floor((endH - 1) / X.ROUND) * X.ROUND;
  const down = async (node, h) => { if (h === lastTarget || h === lastTarget - X.ROUND / 24) throw new Error("node down"); return { signer: signerOf(h), time: T(h) }; };
  const missing = await weekThenLook(picksGuest, 13, { blockOf: down, prizesFromWeek: 0 });
  assert.equal(missing.board.lastWeek.final, false, "final with its last target missing");
  assert.deepEqual(missing.board.lastWeek.prizes, []);
  const ok = await weekThenLook(picksGuest, 13, { prizesFromWeek: 0 });
  assert.equal(ok.board.lastWeek.final, true);
});
test("BX-5: the week-final check catches a missing last target in the phase the old 3-hour rule missed", async () => {
  const { targetsCover } = await import(path.resolve(APP, "bot/games/blockx.ts"));
  const H = 3600000, from = M.weekStart(3), to = M.weekStart(4);
  // targets every 2 h, the last one of the week 30 min before its end (round 84), the next one 1.5 h into next week
  const tgt = (round, time) => ({ round, height: round * 2400, final: true, checked: 2, signer: BIG, time, lockTime: time - 300000, card: null, picks: [] });
  const week = (rounds) => ({ v: 1, week: 3, start: from, end: to, targets: rounds.map((r) => tgt(r, from + (r - 1) * 2 * H + 1.5 * H)) });
  const all = (w, next) => new Map([[3, w], [4, { v: 1, week: 4, start: to, end: to + 7 * 24 * H, targets: next }]]);
  const rounds = Array.from({ length: 84 }, (_, i) => i + 1);           // round 84 at to − 0.5 h
  const full = week(rounds), nextFirst = [tgt(85, to + 1.5 * H)];
  assert.equal(targetsCover(full, from, to, all(full, nextFirst)), true);
  const lastMissing = week(rounds.slice(0, -1));                           // round 83 at to − 2.5 h: the old rule said "complete"
  assert.equal(targetsCover(lastMissing, from, to, all(lastMissing, nextFirst)), false, "a missing last target");
  assert.equal(targetsCover(full, from, to, all(full, [])), false, "the next week's first target not recorded yet");
  const gap = week(rounds.filter((r) => r !== 40));
  assert.equal(targetsCover(gap, from, to, all(gap, nextFirst)), false, "a gap");
});

test("BX-16: a target that keeps failing is voided with its reason at the edge of the 3-day window", async () => {
  const lib = H0 + 2 * X.ROUND + 50;
  const r = await quiet(() => run({ p: "main", check: null, out: tmp(), raceDir: raceDir(), picksContract: "1P", blockOf: async () => { throw new Error("node keeps failing"); },
    picksOf: picksOf(), rankedOf, head: { height: lib, time: T(lib), lib } }));
  const ts = [...r.weeks.values()].flatMap((w) => w.targets);
  assert.ok(ts.length > 0 && ts.every((t) => /could not be recorded within 3 days: node keeps failing/.test(t.void)));
  assert.ok(ts.every((t) => t.height < lib - 3 * 28800 + X.ROUND), "only targets at the edge of the window, not recent ones");
});
test("BX-15: a wallet's board is fixed by its first pick of the period (a later 1 VHP can't push it onto Staked)", async () => {
  // Alice picks Free play at first; later targets record her as Staked (someone sent her 1 VHP).
  const lib = H0 + 4 * X.ROUND + 50;
  let current = 0;
  const lastTwo = Math.floor(lib / X.ROUND) - 1;
  const flip = async (who) => (current >= lastTwo ? new Set(who) : new Set());   // only the newest targets see her as Staked
  const r = await quiet(() => run({ p: "main", check: null, out: tmp(), raceDir: raceDir(), picksContract: "1P", blockOf: blockOf(),
    picksOf: async (node, rd) => { current = rd; return [{ player: ALICE, producer: MID, time: T(rd * X.ROUND) - 3600000 }]; }, rankedOf: flip, head: { height: lib, time: T(lib), lib } }));
  const ts = [...r.weeks.values()].flatMap((w) => w.targets).filter((t) => !t.void);
  assert.ok(ts.some((t) => t.picks[0][4] === 1) && ts.some((t) => t.picks[0][4] === 0), "both kinds of rows were recorded");
  const all = r.board.allTime.rows.find((x) => x.a === ALICE);
  assert.equal(all.ranked, false, "still on the Free play board");
});
test("BX-18 / BX-17 / BX-33: picks are read until an empty page; final needs both nodes; pick days outside the week don't count", () => {
  const src = fs.readFileSync(path.resolve(APP, "bot/games/blockx.ts"), "utf8");
  assert.match(src, /if \(!rows\.length\) break;/);
  assert.ok(!/rows\.length < 100\) break/.test(src));
  assert.match(src, /if \(ch\.lib < head\.lib\) head\.lib = ch\.lib;/);
  assert.match(src, /pickTime >= from && pickTime < to \? pickTime : NaN/);
  assert.match(src, /on chain has round/);
});
test("BX-5 / BX-23: a final week's prizes are frozen once (P###.json); the mainnet publish check takes the real output, exact shapes only", async () => {
  const runs = JSON.parse(execFileSync("python3", ["-c", "import yaml,json,sys; w=yaml.safe_load(open(sys.argv[1])); print(json.dumps([s.get('run','') for j in w['jobs'].values() for s in j['steps']]))", path.resolve(APP, ".github/workflows/games.yml")], { encoding: "utf8" }));
  const sh = runs.find((r) => r.includes("<<'PY'"));
  const py = sh.slice(sh.indexOf("<<'PY'\n") + 7, sh.indexOf("\nPY\n") + 1);
  // Round 4 (audit BX-79/80): prize and vault files are judged against the PUBLISHED branch and the job's clock. Here the
  // published copy is the honest run's own board and prize file (as after the run before), and the clock is its head time.
  let pubDir = "", nowMs = 0;
  const check = (dir) => spawnSync("python3", ["-I", "-", dir, "2", pubDir], { input: py, encoding: "utf8", env: { ...process.env, CHECK_NOW_MS: String(nowMs) } });
  const VALID = "1" + "P".repeat(33);
  const rd = raceDir();
  const startH = H0 - Math.floor(3600000 / 3000), endH = startH + 7 * 28800;
  let prev;
  for (let lib = startH + 12 * X.ROUND; lib <= endH + 4 * X.ROUND; lib += 12 * X.ROUND) {
    const o = tmp();
    await quiet(() => run({ p: "main", check: null, prev, out: o, raceDir: rd, picksContract: VALID, blockOf: blockOf(), picksOf: picksGuest, rankedOf, prizesFromWeek: 0, head: { height: lib, time: T(lib), lib } }));
    prev = o;
  }
  const at = endH + 13 * 1200, out = tmp();
  const r = await quiet(() => run({ p: "main", check: null, prev, out, raceDir: rd, picksContract: VALID, blockOf: blockOf(), picksOf: picksGuest, rankedOf, prizesFromWeek: 0, head: { height: at, time: T(at), lib: at - 60 } }));
  assert.equal(r.board.lastWeek.final, true);
  assert.ok(fs.existsSync(path.join(out, "P003.json")), "the final week's prizes are frozen");
  const frozen = JSON.parse(fs.readFileSync(path.join(out, "P003.json"), "utf8"));
  assert.deepEqual(frozen.prizes, r.board.lastWeek.prizes);
  pubDir = tmp(); fs.copyFileSync(path.join(out, "board.json"), path.join(pubDir, "board.json")); fs.copyFileSync(path.join(out, "P003.json"), path.join(pubDir, "P003.json"));
  nowMs = T(at);
  const ok = check(out);
  assert.equal(ok.status, 0, ok.stderr);
  // The Vault (v6) results file for the week, from the frozen prize list (handoff 2026-10-28): vault/W3.json.
  const vf = JSON.parse(fs.readFileSync(path.join(out, "vault", "W3.json"), "utf8"));
  assert.deepEqual({ ...vf, rows: undefined }, { game: 2, week: 3, final: true, rows: undefined, first: frozen.prizes.filter((x) => x.place === 1).map((x) => x.player).sort(), second: frozen.prizes.filter((x) => x.place === 2).map((x) => x.player).sort() });
  assert.ok(vf.first.length === 1, "one winner in 1st");
  assert.deepEqual(vf.rows, [{ player: BOB, points: 255 }], "Bob, staked in Block X, is the bucket's only row");
  for (const broken of [{ ...vf, rows: [{ player: GUEST, points: 3 }] }, { ...vf, rows: [{ player: BOB, points: 0 }] }, { ...vf, week: 4 }, { ...vf, second: [vf.first[0]] }, { ...vf, first: Array(11).fill(0).map((_, i) => "1" + String.fromCharCode(65 + i).repeat(33)) }]) {
    const d = tmp(); fs.cpSync(out, d, { recursive: true }); fs.writeFileSync(path.join(d, "vault", "W3.json"), JSON.stringify(broken));
    assert.notEqual(check(d).status, 0, JSON.stringify(broken).slice(0, 80));
  }
  // A later run uses the frozen list and doesn't write it again.
  const out2 = tmp();
  fs.copyFileSync(path.join(out, "P003.json"), path.join(out2, "P003.json"));
  fs.cpSync(out, out2, { recursive: true });
  const changed = { ...frozen, prizes: frozen.prizes.slice(0, 1) };
  fs.writeFileSync(path.join(out2, "P003.json"), JSON.stringify(changed));
  const out3 = tmp();
  const r3 = await quiet(() => run({ p: "main", check: null, prev: out2, out: out3, raceDir: rd, picksContract: VALID, blockOf: blockOf(), picksOf: picksGuest, rankedOf, prizesFromWeek: 0, head: { height: at + 200, time: T(at + 200), lib: at + 140 } }));
  assert.deepEqual(r3.board.lastWeek.prizes, changed.prizes, "later runs use the frozen list");
  assert.ok(!fs.existsSync(path.join(out3, "P003.json")), "and never write it again");
  // Exact shapes: an extra key anywhere is refused.
  const bad = tmp(); fs.cpSync(out, bad, { recursive: true });
  const b = JSON.parse(fs.readFileSync(path.join(bad, "board.json"), "utf8")); b.today.extra = "x".repeat(1000); fs.writeFileSync(path.join(bad, "board.json"), JSON.stringify(b));
  assert.notEqual(check(bad).status, 0);
  const bad2 = tmp(); fs.cpSync(out, bad2, { recursive: true });
  const i = JSON.parse(fs.readFileSync(path.join(bad2, "index.json"), "utf8")); i.updated = "<script>"; fs.writeFileSync(path.join(bad2, "index.json"), JSON.stringify(i));
  assert.notEqual(check(bad2).status, 0);
  const wf = fs.readFileSync(path.resolve(APP, ".github/workflows/games.yml"), "utf8");
  assert.match(wf, /\(\/P\[0-9\]\{3\}\|\/vault\/W\[0-9\]\+\)\\\.json\$ \]\] && git cat-file -e/, "the publish step never replaces a published prize file or Vault file");
  assert.match(wf, /if grep -qxF "\$name" "\$HELD"; then continue; fi/, "a held file is skipped, the rest published (BX-81)");
});

test("Vault results file (handoff 2026-10-28): ties share a place, 2+ tied for 1st leave 2nd empty, more than 10 tied leave that place empty, nobody qualifying gives empty lists", () => {
  const a = (c) => "1" + c.repeat(33);
  const f = (prizes) => vaultFile(2, 57, prizes);
  assert.deepEqual(f([]).file, { game: 2, week: 57, final: true, rows: [], first: [], second: [] }, "nobody qualifies");
  assert.deepEqual(f([{ player: a("A"), place: 1, vhp: 2 }, { player: a("B"), place: 2, vhp: 1 }]).file.second, [a("B")]);
  const tied1 = f([{ player: a("B"), place: 1, vhp: 1.5 }, { player: a("A"), place: 1, vhp: 1.5 }]).file;
  assert.deepEqual([tied1.first, tied1.second], [[a("A"), a("B")], []], "two tied for 1st share all 3 VHP; no 2nd");
  const tied2 = f([{ player: a("A"), place: 1, vhp: 2 }, { player: a("B"), place: 2, vhp: 0.5 }, { player: a("C"), place: 2, vhp: 0.5 }]).file;
  assert.deepEqual([tied2.first, tied2.second], [[a("A")], [a("B"), a("C")]], "1st untied, two tied for 2nd share 1 VHP");
  const many = "ABCDEFGHJKLM".split("").map((c) => ({ player: a(c), place: 1, vhp: 0.25 }));
  const r = f(many);
  assert.deepEqual([r.file.first, r.file.second], [[], []], "12 tied for 1st: more than the Vault's 10, so the place goes back to the pool");
  assert.ok(r.problems.some((x) => /12 wallets tied for 1st/.test(x)));
  const ten = f(many.slice(0, 10)).file;
  assert.equal(ten.first.length, 10, "exactly 10 is fine");
});

// ── Block X takes stakes (owner, 2026-10-28; handoff claude/handoff-stake-in-every-game.md) ──
test("stakes: staked in Block X (≥ the vault's minimum that week) vs free; staked elsewhere is free here; a mid-week withdrawal stays staked at its lowest; before v6 nobody is staked", async () => {
  const { vaultView, stakedSet, minStakeFor, vaultPoints } = await import(path.resolve(APP, "bot/games/blockx.ts"));
  const V = 100000000n, cfg = { v6_rule_week_plus_one: "4", min_stake: String(V), min_stake_next: String(2n * V), min_stake_next_week: "9" };
  assert.equal(minStakeFor(cfg, 8), V); assert.equal(minStakeFor(cfg, 9), 2n * V, "a new minimum from its own week");
  const A = "1" + "A".repeat(33), B = "1" + "B".repeat(33), C = "1" + "C".repeat(33), D = "1" + "D".repeat(33);
  const res = new Map([
    [A, { active_stake: String(5n * V), week_stake: String(5n * V), entry: null }],                       // staked here
    [B, { active_stake: "0", week_stake: "0", entry: null }],                                            // staked only in ANOTHER game: game 2 shows nothing
    [C, { active_stake: String(V), week_stake: String(V), entry: { stake: String(V), peak_stake: String(4n * V), voided: false } }],  // withdrew 3 of 4 mid-week
    [D, { active_stake: "0", week_stake: "0", entry: { stake: "0", peak_stake: String(3n * V), voided: true } }],                     // withdrew everything
  ]);
  const v = vaultView(cfg, res, 8);
  assert.deepEqual([...stakedSet(v)].sort(), [A, C, D].sort(), "the Staked board: everyone who held the minimum here that week");
  assert.equal(v.players.get(C).week, V, "C counts at its lowest stake that week");
  assert.equal(v.players.get(D).week, 0n, "D withdrew everything: on the Staked board, but no bucket row and no free prize");
  assert.ok(!stakedSet(v).has(B), "B is staked in another game only: a free player in Block X");
  assert.equal(stakedSet(vaultView({ v6_rule_week_plus_one: "0", min_stake: String(V) }, res, 8)).size, 0, "vault not live: everyone is free");
  // Points 1-255 keep the board's order and ties.
  assert.deepEqual(vaultPoints([{ player: A, place: 1 }, { player: C, place: 2 }, { player: D, place: 2 }, { player: B, place: 4 }]).map((x) => x.points), [255, 254, 254, 253]);
  const many = Array.from({ length: 300 }, (_, i) => ({ player: A, place: i + 1 }));
  assert.ok(vaultPoints(many).every((x) => x.points >= 1 && x.points <= 255), "never below 1 or above 255");
});

test("stakes: the vault file lists only players the vault counts as staked for the week (bucket rows) and only free players as prize winners; nobody staked gives empty rows", async () => {
  const startH = H0 - Math.floor(3600000 / 3000), endH = startH + 7 * 28800;
  const rd = raceDir(); let prev;
  const weekRun = async (stakeOf, rankedOfX) => {
    prev = undefined;
    for (let lib = startH + 12 * X.ROUND; lib <= endH + 4 * X.ROUND; lib += 12 * X.ROUND) {
      const o = tmp();
      await quiet(() => run({ p: "main", check: "check", prev, out: o, raceDir: rd, picksContract: "1P", blockOf: blockOf(), picksOf: picksGuest, rankedOf: rankedOfX, stakeOf, prizesFromWeek: 0, head: { height: lib, time: T(lib), lib } }));
      prev = o;
    }
    const at = endH + 13 * 1200, out = tmp();
    await quiet(() => run({ p: "main", check: "check", prev, out, raceDir: rd, picksContract: "1P", blockOf: blockOf(), picksOf: picksGuest, rankedOf: rankedOfX, stakeOf, prizesFromWeek: 0, head: { height: at, time: T(at), lib: at - 60 } }));
    return JSON.parse(fs.readFileSync(path.join(out, "vault", "W3.json"), "utf8"));
  };
  // Bob is on the Staked board; the vault counts him (week stake ≥ min): one bucket row; the guest wins 1st.
  const staked = await weekRun(async (who) => ({ min: 100000000n, week: new Map(who.map((a) => [a, a === BOB ? 300000000n : 0n])) }), rankedOf);
  assert.deepEqual(staked.rows, [{ player: BOB, points: 255 }]); assert.deepEqual(staked.first, [GUEST]);
  // Bob withdrew everything before the week ended (week stake 0): no bucket row (and he can't win the free prize).
  const voided = await weekRun(async (who) => ({ min: 100000000n, week: new Map(who.map((a) => [a, 0n])) }), rankedOf);
  assert.deepEqual(voided.rows, []); assert.ok(!voided.first.includes(BOB) && !voided.second.includes(BOB));
  // Nobody staked: empty rows; the free players are ranked for the prize.
  const none = await weekRun(async () => null, async () => new Set());
  assert.deepEqual(none.rows, []); assert.ok(none.first.length >= 1);
});

test("audit BX-35 / BX-38: a target scores the LOWER multiplier of the lock's card and the first card after the block; flagged cards (too few samples) are never used", async () => {
  const lib = H0 + 10 * X.ROUND + 50;
  // A race dir where every card after 00:00 of week 3's day 0 shows MID twice as big (so ×1 instead of ×2).
  const rd = raceDir();
  for (const f of fs.readdirSync(rd)) {
    const wf = JSON.parse(fs.readFileSync(path.join(rd, f), "utf8"));
    for (const r of wf.races) r.cards = r.cards.map((c, i) => (c && i % 2 === 1 ? { ...c, field: c.field.map((x) => (x.a === MID ? { ...x, vhp: x.vhp * 2 } : x)) } : c));
    fs.writeFileSync(path.join(rd, f), JSON.stringify(wf));
  }
  const out = tmp();
  await quiet(() => run({ p: "main", check: "check", out, raceDir: rd, picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(), rankedOf, head: { height: lib + 60, time: T(lib + 60), lib } }));
  const wf = JSON.parse(fs.readFileSync(path.join(out, "W003.json"), "utf8"));
  const mid = wf.targets.filter((t) => t.signer === MID && !t.void);
  assert.ok(mid.length > 0);
  for (const t of mid) { const alice = t.picks.find((p) => p[0] === ALICE); assert.ok(alice[3] <= 200); assert.ok(t.card.afterAt > t.card.at); }
  assert.ok(mid.some((t) => t.picks.find((p) => p[0] === ALICE)[3] < 200), "where the next card shows MID bigger, the lower multiplier counts");
  // Flagged cards (samples under 12) only: nothing is scored; the targets wait.
  const flagged = raceDir();
  for (const f of fs.readdirSync(flagged)) {
    const wf2 = JSON.parse(fs.readFileSync(path.join(flagged, f), "utf8"));
    for (const r of wf2.races) r.cards = r.cards.map((c) => (c ? { ...c, samples: 3 } : c));
    fs.writeFileSync(path.join(flagged, f), JSON.stringify(wf2));
  }
  const r2 = await quiet(() => run({ p: "main", check: "check", out: tmp(), raceDir: flagged, picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(), rankedOf, head: { height: lib + 60, time: T(lib + 60), lib } }));
  assert.ok([...r2.weeks.values()].flatMap((w) => w.targets).every((t) => t.void || t.picks.every((p) => p[3] === 0)));
});
