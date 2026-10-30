// Reviewer D-R failing tests (node:test). NOT RUN HERE (static review) against the repository. Drop into tests/audit/
// with D-R.fixtures.mjs and run with APP=. : they import the REAL bot/games/combo.ts (+ blockx.ts) and drive it with
// fake koilib providers (the stub koilib Contract in the fixtures maps functions.X(args) to provider.fn(id, X, args);
// in the repo, give the fake nodes koilib's Contract shape instead, as combo-recorder.test.mjs does for cardsOf).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
import { run, M, X, C, BXM, H1, H2, H3, H4, ALICE, BOB, W3, heightAt, raceDir, blockxDir, node, quiet, read, tmp, VAULT, PICKS } from "./D-R.fixtures.mjs";
const D3 = C.utcDay(W3), S0 = C.slotRound(D3, 0), dn = (d) => `D${String(d).padStart(5, "0")}.json`;
const APP = process.env.APP || ".";
function publishCheck() {
  const y = fs.readFileSync(path.resolve(APP, ".github/workflows/combo.yml"), "utf8");
  const py = y.split("<<'PY'\n")[1].split("\n          PY\n")[0].split("\n").map((l) => (l.startsWith("          ") ? l.slice(10) : l)).join("\n");
  const f = path.join(tmp(), "check.py"); fs.writeFileSync(f, py); return f;
}
const twoCards = (round) => {
  const sent = D3 * M.DAY + 2 * 3600000, r6 = D3 * 4 + 1;
  const c = (p, l2) => ({ player: p, legs: [{ code: C.WIN, round: r6, producer: H1 }, l2], time: sent, height: heightAt(sent), changes: 0 });
  return round === S0 ? [c(ALICE, { code: C.SHOW, round: r6, producer: H2 }), c(BOB, { code: C.SHOW, round: r6, producer: H3 })] : [];
};

test("D-R-1 (RL-4): one node's week_stake 0 for a staked winner is a disagreement: no Vault file, an error (as Block X)", async () => {
  const now = M.weekStart(4) + 13 * 3600000, out = tmp();
  const r = await quiet(() => run({ p: node({ t: now, cards: twoCards }), check: node({ t: now, cards: twoCards, stake: (p) => (p === ALICE ? 0n : 200000000n) }), out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: PICKS, knodeGame: VAULT, now }));
  const vf = path.join(out, "vault", "W3.json");
  assert.ok(!fs.existsSync(vf) || read(out, "vault/W3.json").rows.some((x) => x.player === ALICE), "a write-once Vault file must not drop a player one node calls unstaked");
  assert.ok(r.errors.some((e) => /stake/.test(e)));
});

test("D-R-2 (RL-9): a leg its source never resolved (a later race is final) can't turn a miss card into a hit", async () => {
  const sun = D3 + 6, sent = sun * M.DAY + 2 * 3600000, S = C.slotRound(sun, 0), ra = sun * 4 + 1, rb = sun * 4 + 3;
  const legs = [{ code: C.WIN, round: ra, producer: H1 }, { code: C.SHOW, round: ra, producer: H2 }, { code: C.WIN, round: rb, producer: H4 }];
  const cards = (r) => (r === S ? [{ player: ALICE, legs, time: sent, height: heightAt(sent), changes: 0 }] : []);
  const t = M.weekStart(4) + 2 * M.DAY + 3600000, out = tmp();
  await quiet(() => run({ p: node({ t, cards }), check: node({ t, cards }), out, raceDir: raceDir({ noResult: new Set([rb]) }), blockxDir: blockxDir(), picksContract: PICKS, knodeGame: VAULT, now: t, vhpMovesOf: async () => 0n }));
  const c = read(out, dn(sun)).slots.find((s) => s.round === S).cards[0];
  assert.notEqual(c.outcome, "hit", "the unresolved third leg must not be dropped from a 3-leg card (void the card, or wait)");
});

test("D-R-3 (BX-100 inherited): one node alone reporting a non-canonical transfer must not void a Block X leg that hit", async () => {
  const sent = D3 * M.DAY + 13 * 3600000, rf = D3 * 4 + 3, R = Math.ceil(heightAt(D3 * M.DAY + 20 * 3600000) / X.ROUND), signer = R % 2 === 0 ? H1 : H2;
  const race = signer === H1 ? { code: C.SHOW, round: rf, producer: H2 } : { code: C.WIN, round: rf, producer: H1 };
  const cards = (r) => (r === S0 ? [{ player: ALICE, legs: [race, { code: C.SHOW, round: rf, producer: H3 }, { code: C.BLOCK, round: R, producer: signer }], time: sent, height: heightAt(sent), changes: 0 }] : []);
  const t = M.weekStart(4) + 13 * 3600000, p = node({ t, cards }), q = node({ t, cards }), out = tmp();
  await quiet(() => run({ p, check: q, out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: PICKS, knodeGame: VAULT, now: t,
    vhpMovesOf: async (n) => { if (n === q) throw new BXM.NonCanonicalTransfer("a VHP transfer isn't in the standard encoding"); return 0n; } }));
  const c = read(out, dn(D3)).slots.find((s) => s.round === S0).cards[0];
  assert.notEqual(c.legs[2][4], "void", "one node's report is a disagreement: hold (and void only at Block X's 3-day edge, as BX-100)");
});

test("D-R-4 (RL-7): one failed read (or a check node that is down) doesn't make the publish job hold the whole run", async () => {
  const tA = M.weekStart(4) + 12 * 3600000 + 52 * 60000, tB = tA + 3600000, A = tmp(), race = raceDir(), bx = blockxDir();
  await quiet(() => run({ p: node({ t: tA, cards: twoCards }), check: node({ t: tA, cards: twoCards }), out: A, raceDir: race, blockxDir: bx, picksContract: PICKS, knodeGame: VAULT, now: tA }));
  const PUB = tmp(); fs.mkdirSync(path.join(PUB, "combo/vault"), { recursive: true });
  for (const f of fs.readdirSync(A)) if (/^(board|D\d{5})\.json$/.test(f)) fs.copyFileSync(path.join(A, f), path.join(PUB, "combo", f));
  for (const check of [{ fail: { slot: (r) => r === S0 } }, { fail: { head: true } }]) {
    const out = tmp();
    await quiet(() => run({ p: node({ t: tB, cards: twoCards }), check: node({ t: tB, cards: twoCards, ...check }), prev: A, out, raceDir: race, blockxDir: bx, picksContract: PICKS, knodeGame: VAULT, now: tB }));
    const IN = tmp(); fs.cpSync(out, path.join(IN, "combo"), { recursive: true });
    const held = path.join(tmp(), "held");
    // (Combo fix round: the publish Python is cut from combo.yml itself, as the README asks, not a copy.)
    try { execFileSync("python3", ["-I", publishCheck(), path.join(IN, "combo"), path.join(PUB, "combo"), held], { env: { ...process.env, CHECK_NOW_MS: String(tB + 60000) }, stdio: "pipe" }); } catch {}
    const h = fs.readFileSync(held, "utf8").split("\n").filter((x) => x && x !== "!alert");
    assert.ok(!h.includes("combo/board.json"), `${JSON.stringify(check.fail && Object.keys(check.fail))}: the board is held because the recorder un-fixed a published slot`);
  }
});

test("D-R-5 (RL-7 cost): a card already final on a published fixed slot is not re-priced (no receipt reads every hour)", async () => {
  const sent = D3 * M.DAY + 13 * 3600000, rf = D3 * 4 + 3, R = Math.ceil(heightAt(D3 * M.DAY + 20 * 3600000) / X.ROUND), signer = R % 2 === 0 ? H1 : H2;
  const race = signer === H1 ? { code: C.SHOW, round: rf, producer: H2 } : { code: C.WIN, round: rf, producer: H1 };
  const cards = (r) => (r === S0 ? [{ player: ALICE, legs: [race, { code: C.BLOCK, round: R, producer: signer }], time: sent, height: heightAt(sent), changes: 0 }] : []);
  const t1 = M.weekStart(3) + 3 * M.DAY, A = tmp(), B = tmp(); let reads = 0;
  const mv = async () => { reads++; return 0n; };
  await quiet(() => run({ p: node({ t: t1, cards }), check: node({ t: t1, cards }), out: A, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: PICKS, knodeGame: VAULT, now: t1, vhpMovesOf: mv }));
  assert.equal(read(A, dn(D3)).slots.find((s) => s.round === S0).cards[0].state, "final");
  reads = 0;
  await quiet(() => run({ p: node({ t: t1 + 3600000, cards }), check: node({ t: t1 + 3600000, cards }), prev: A, out: B, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: PICKS, knodeGame: VAULT, now: t1 + 3600000, vhpMovesOf: mv }));
  assert.equal(reads, 0, "the published final card's moved VHP was read again (2 nodes x every Block X hit x every run)");
});
