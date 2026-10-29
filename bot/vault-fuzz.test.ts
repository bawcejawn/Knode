/**
 * Vault v6 conservation fuzz (audit V6-13): random weeks of play on the simulated chain against the v6 test build,
 * checked against a ghost ledger kept outside the contract.
 *
 * Every step: deposits, withdrawals and moves in the question game and games 2, 3 and 13; block rewards; closes;
 * results (rows, prize winners, seals, owner corrections and voids, weeks left unsealed); finalizing in pages; claims;
 * a game stopped and restarted. After every step:
 *   - holdings cover everything owed (the contract's own solvency rule, recomputed here in BigInt);
 *   - no counter has wrapped (each stays below 2^63);
 *   - the ghost stakes add up to the contract's total_stake and stake_other;
 *   - every game week's claims stay within its bucket plus prize, and every question week's within its pot.
 * A withdrawal of a stake the ghost ledger says a player holds must always succeed; so must finalizing a closed week
 * once it is ready, and every claim a finalized week owes; claiming them all must leave only rounding dust. (Not
 * covered here: the question game's answers, v5 weeks, paged finalizing; the as-pect specs and the rehearsal cover them.) At the end everyone takes
 * everything out (stakes, seed, fee) and what is left equals exactly what is still owed, plus rounding dust.
 *
 * Run (after `npm run build:sim` in game/): node --import tsx --test bot/vault-fuzz.test.ts   (from the repo root)
 * About 6 s per seed. More seeds: FUZZ_SEEDS=50 node --import tsx --test bot/vault-fuzz.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Signer } from "koilib";
import { SimChain } from "./chain.ts";

const NEW = "game/build/sim/contract.wasm";
const V5 = "game/test-fixtures/kpred-v5-test-build.wasm";
const VHP = 100_000_000n;
const HOUR = 3_600_000, DAY = 24 * HOUR, WEEK = 7 * DAY;
const GENESIS = 1_800_000_000_000 - (1_800_000_000_000 % DAY);
const T0 = GENESIS - DAY, H0 = 50_000_000;
const WRAP = 1n << 63n;
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 4);
const WEEKS = Number(process.env.FUZZ_WEEKS ?? 7);

const key = (s: string) => Signer.fromSeed(`vault-fuzz ${s}`);
const [contract, owner, operator, seedOwner] = ["contract", "owner", "operator", "seed"].map(key);
const players = Array.from({ length: 8 }, (_, i) => key(`P${i}`).getAddress());
const addr = (s: Signer) => s.getAddress();
const GAMES = [1, 2, 3, 13];             // 1 question game; 2 staked + free prize; 3 free prize, 2-week seasons; 13 staked
const STAKED = [1, 2, 13];

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)], chance: (p: number) => next() < p };
}

async function run(seed: number) {
  const r = rng(seed);
  const sim = new SimChain(addr(contract), V5);
  await sim.init();
  let now = T0;
  const at = (t: number) => { now = Math.max(now, t); sim.setHeight(H0 + Math.floor((now - T0) / 3000), now); };
  const send = async (who: string, method: string, args: any) => {
    const ok = (await sim.sendAs([{ method, args }], [who])).ok;
    if (process.env.FUZZ_TRACE && ok && /result|winners|seal|void|finalize_game/.test(method)) console.log("TRACE", now, method, JSON.stringify(args));
    return ok;
  };
  const must = async (who: string, method: string, args: any) => {
    const res = await sim.sendAs([{ method, args }], [who]);
    assert.ok(res.ok, `seed ${seed}: ${method} ${JSON.stringify(args)}: ${res.error}`);
  };
  const read = (m: string, a: any = {}) => sim.read(m, a);
  const big = (v: any) => BigInt(v ?? 0);

  for (const p of players) { await sim.ledgerSet(2, p, 2000n * VHP); await sim.ledgerSet(3, p, 1000n * VHP); }
  await sim.ledgerSet(2, addr(seedOwner), 5000n * VHP);
  await sim.ledgerSet(3, addr(contract), 1000n * VHP);
  at(T0);
  await must(addr(contract), "init", { owner: addr(owner), operator: addr(operator), seed_owner: addr(seedOwner), genesis_time: String(GENESIS),
    week_length: String(WEEK), close_delay: String(12 * HOUR), settle_length: String(DAY), timelock_length: String(2 * DAY), min_stake: String(VHP), max_sponsor_rc: "0" });
  await sim.setCode(NEW);
  await must(addr(owner), "propose_game", { game: 2, name: "Fantasy", staked: true, free_prize: true, season_weeks: 1 });
  await must(addr(owner), "propose_game", { game: 3, name: "Survivor", staked: false, free_prize: true, season_weeks: 2 });
  await must(addr(owner), "propose_game", { game: 13, name: "Last Node", staked: true, free_prize: false, season_weeks: 1 });
  at(T0 + 2 * DAY + HOUR);
  for (const g of [2, 3, 13]) await must(addr(owner), "apply_game", { game: g });
  await must(addr(seedOwner), "seed_deposit_vhp", { amount: String(BigInt(300 + r.int(1500)) * VHP) });

  // The ghost ledger: what each player holds in each game.
  const stake = new Map<string, bigint>();
  const sk = (p: string, g: number) => `${p}/${g}`;
  const held = (p: string, g: number) => stake.get(sk(p, g)) ?? 0n;
  const setHeld = (p: string, g: number, v: bigint) => stake.set(sk(p, g), v);
  let steps = 0;

  async function check(where: string) {
    steps++;
    const s = await read("get_state");
    const t = s.totals;
    for (const [k, v] of Object.entries(t)) if (typeof v === "string" && !k.startsWith("acc_")) assert.ok(BigInt(v) < WRAP, `seed ${seed} ${where}: ${k} wrapped (${v})`);
    const owed = big(t.total_stake) + big(t.seed_vhp) + big(t.seed_koin) + big(t.owner_share) + big(t.creator_fee) + big(t.pots_outstanding)
      + big(t.fee_vhp) + big(t.games_rolled) + big(t.rolled_over);
    const holdings = (await sim.ledgerGet(2, addr(contract))) + (await sim.ledgerGet(1, addr(contract)));
    assert.ok(holdings >= owed, `seed ${seed} ${where}: holdings ${holdings} < owed ${owed}`);
    let all = 0n, other = 0n;
    for (const p of players) for (const g of STAKED) { all += held(p, g); if (g !== 1) other += held(p, g); }
    assert.equal(big(t.total_stake), all, `seed ${seed} ${where}: total_stake vs ghost`);
    assert.equal(big(t.stake_other), other, `seed ${seed} ${where}: stake_other vs ghost`);
  }

  async function checkPots(w: number) {
    const wk = (await read("get_week", { week: String(w) })).week ?? {};
    assert.ok(big(wk.claimed) <= big(wk.pot), `seed ${seed}: question week ${w} paid ${wk.claimed} > pot ${wk.pot}`);
    for (const g of [2, 3, 13]) {
      const gw = (await read("get_game", { game: g, week: String(w) })).week ?? {};
      const cap = (gw.rolled_over ? 0n : big(gw.bucket)) + big(gw.prize);
      assert.ok(big(gw.claimed) <= cap, `seed ${seed}: game ${g} week ${w} paid ${gw.claimed} > ${cap}`);
    }
  }

  async function randomMoves(n: number, from: number, to: number) {
    for (let i = 0; i < n; i++) {
      at(from + r.int(Math.max(1, to - from)));
      const p = r.pick(players);
      const what = r.int(10);
      if (what < 4) {                                  // deposit
        const g = r.pick(STAKED), amt = BigInt(1 + r.int(60)) * VHP;
        const ok = g === 1 ? await send(p, "deposit_vhp", { from: p, amount: String(amt) })
          : await send(p, "deposit_to", { from: p, game: g, amount: String(amt), koin: false });
        if (ok) setHeld(p, g, held(p, g) + amt);
      } else if (what < 7) {                           // withdraw (must always work)
        const g = r.pick(STAKED), h = held(p, g);
        if (h === 0n) continue;
        const amt = r.chance(0.3) ? h : BigInt(1 + r.int(Number(h / VHP))) * VHP;
        if (g === 1) await must(p, "withdraw", { to: p, amount: String(amt) });
        else await must(p, "withdraw_from", { to: p, game: g, amount: String(amt) });
        setHeld(p, g, h - amt);
      } else if (what < 9) {                           // move
        const a = r.pick(STAKED), b = r.pick(STAKED.filter((x) => x !== a)), h = held(p, a);
        if (h === 0n) continue;
        const amt = BigInt(1 + r.int(Number(h / VHP))) * VHP;
        if (await send(p, "move_stake", { player: p, from_game: a, to_game: b, amount: String(amt) })) { setHeld(p, a, h - amt); setHeld(p, b, held(p, b) + amt); }
      } else {                                         // block rewards
        await sim.ledgerAdd(2, addr(contract), BigInt(r.int(40)) * VHP + BigInt(r.int(1_000_000)));
      }
      await check(`move ${i}`);
    }
  }

  let stopped = false;
  for (let w = 0; w < WEEKS; w++) {
    const start = GENESIS + w * WEEK, end = start + WEEK;
    await randomMoves(4 + r.int(8), now, end - HOUR);
    // close
    at(end + 12 * HOUR + 1);
    await must(addr(operator), "close_week", { week: String(w) });
    await check(`close ${w}`);
    // results for the game weeks that closed
    const sealed: number[] = [];
    for (const g of [2, 3, 13]) {
      const gw = (await read("get_game", { game: g, week: String(w) })).week ?? {};
      if (!gw.closed) continue;
      if (g !== 3) for (const p of players) if (held(p, g) > 0n && r.chance(0.8)) await send(addr(operator), "post_results", { game: g, week: String(w), rows: [{ player: p, points: 1 + r.int(r.chance(0.5) ? 4 : 255) }] });
      if (g !== 13) for (const place of [1, 2]) {
        const free = players.filter((p) => held(p, g) === 0n);
        const n = r.int(3);
        const who = [...new Set(Array.from({ length: n }, () => r.pick(free)))];
        if (who.length) await send(addr(operator), "post_prize_winners", { game: g, week: String(w), place, players: who });
      }
      if (r.chance(0.85)) { await send(addr(operator), "seal_results", { game: g, week: String(w) }); sealed.push(g); }
      await check(`results ${g}/${w}`);
    }
    // the owner corrects or voids now and then, within the window
    at(now + 6 * HOUR);
    for (const g of [2, 13]) {
      if (r.chance(0.3)) await send(addr(owner), "correct_result", { player: r.pick(players), game: g, week: String(w), points: r.int(20), remove_prize: false });
      if (r.chance(0.1)) await send(addr(owner), "void_game_week", { game: g, week: String(w) });
      await check(`correct ${g}/${w}`);
    }
    if (r.chance(0.15)) await send(addr(owner), "correct_result", { player: r.pick(players), game: 3, week: String(w), points: 0, remove_prize: true });
    // finalize after the owner's day (or the results deadline for unsealed weeks), in pages
    at(end + 3 * DAY + HOUR);
    for (const g of [2, 3, 13]) {
      // Every closed week is ready by now (a day after any seal; past the results deadline otherwise): finalizing
      // must never be refused (fix-check VN-6: an unexpected revert fails the fuzz).
      for (let i = 0; i < 30; i++) {
        const gw = (await read("get_game", { game: g, week: String(w) })).week ?? {};
        if (!gw.closed || gw.finalized) break;
        await must(addr(operator), "finalize_game_week", { game: g, week: String(w) });
      }
      await check(`finalize ${g}/${w}`);
    }
    for (let i = 0; i < 30 && !(await read("get_week", { week: String(w) })).week?.finalized; i++) await send(addr(operator), "finalize_week", { week: String(w) });
    // claims: every reward a finalized week owes must be claimable, and claiming them all must empty the week
    // (a ghost of what each pot owes: fix-check VN-6).
    for (const g of [2, 3, 13]) {
      const gw = (await read("get_game", { game: g, week: String(w) })).week ?? {};
      if (!gw.finalized) continue;
      let winners = 0;
      for (const p of players) {
        const e = (await read("get_game_player", { player: p, game: g, week: String(w) })).entry;
        const place = Number(e?.prize_place ?? 0), pts = Number(e?.points ?? 0), cutoff = Number(gw.cutoff ?? 0);
        const owed = place === 1 ? big(gw.prize_first) > 0n : place === 2 ? big(gw.prize_second) > 0n
          : !gw.rolled_over && cutoff >= 1 && pts >= cutoff;
        if (owed) {
          winners++;
          const res = await sim.sendAs([{ method: "claim_game", args: { player: p, game: g, week: String(w) } }], [p]);
          if (!res.ok) {
            const full = await read("get_game", { game: g, week: String(w) });
            console.log("DUMPCLAIM", JSON.stringify({ gw: full.week, e, buckets: (full.buckets ?? []).map((b: any, i: number) => [i, b]).filter((x: any) => x[1].players) }));
          }
          assert.ok(res.ok, `seed ${seed}: claim_game ${p} game ${g} week ${w}: ${res.error}`);
        }
        else assert.ok(!(await send(p, "claim_game", { player: p, game: g, week: String(w) })), `seed ${seed}: game ${g} week ${w} paid ${p}, who wasn't owed`);
      }
      const after = (await read("get_game", { game: g, week: String(w) })).week ?? {};
      const due = (after.rolled_over ? 0n : big(after.bucket)) + big(after.prize_first) * BigInt(Number(after.first_n ?? 0)) + big(after.prize_second) * BigInt(Number(after.second_n ?? 0));
      const left = due - big(after.claimed);
      if (!(left >= 0n && left <= BigInt(winners + 2))) {
        const rows = [];
        for (const p of players) rows.push((await read("get_game_player", { player: p, game: g, week: String(w) })));
        const bk = ((await read("get_game", { game: g, week: String(w) })).buckets ?? []).map((b: any, i: number) => [i, b]).filter((x: any) => Object.keys(x[1]).length);
        console.log("DUMP", JSON.stringify(bk));
      }
      assert.ok(left >= 0n && left <= BigInt(winners + 2), `seed ${seed}: game ${g} week ${w} left ${left} unpaid after every winner claimed`);
    }
    for (const p of players) await send(p, "claim", { player: p, week: String(w) });
    await checkPots(w);
    await check(`claims ${w}`);
    // stop or restart game 13 now and then
    if (!stopped && r.chance(0.25)) {
      await must(addr(owner), "deactivate_game", { game: 13 });
      await must(addr(owner), "propose_game", { game: 13, name: "Last Node", staked: true, free_prize: false, season_weeks: 1 });
      stopped = true;
    } else if (stopped && r.chance(0.6)) {
      if (await send(addr(owner), "apply_game", { game: 13 })) stopped = false;
    }
    await check(`registry ${w}`);
  }

  // Full exit: every stake, the seed and the fee come out; what's left is exactly what's still owed.
  at(now + DAY);
  for (const p of players) for (const g of STAKED) {
    const h = held(p, g);
    if (h === 0n) continue;
    if (g === 1) await must(p, "withdraw", { to: p, amount: String(h) });
    else await must(p, "withdraw_from", { to: p, game: g, amount: String(h) });
    setHeld(p, g, 0n);
  }
  const t0 = (await read("get_state")).totals;
  await must(addr(seedOwner), "request_seed_withdrawal", { vhp: t0.seed_vhp ?? "0", koin: "0" });
  at(now + 2 * DAY + HOUR);
  await must(addr(seedOwner), "execute_seed_withdrawal", {});
  const fee = (await read("get_state")).totals.fee_vhp;
  if (big(fee) > 0n) await must(addr(owner), "claim_fee_vhp", { to: addr(owner), amount: fee });
  await check("exit");
  const t = (await read("get_state")).totals;
  assert.equal(big(t.total_stake), 0n);
  assert.equal(big(t.seed_vhp), 0n);
  assert.equal(big(t.fee_vhp), 0n);
  const left = await sim.ledgerGet(2, addr(contract));
  const owed = big(t.pots_outstanding) + big(t.games_rolled) + big(t.rolled_over) + big(t.creator_fee);
  assert.ok(left >= owed, `seed ${seed}: ${left} left < ${owed} owed`);
  assert.ok(left - owed < 2000n + BigInt(steps), `seed ${seed}: ${left - owed} units unaccounted for`);
  return steps;
}

test(`vault conservation fuzz: ${SEEDS} seeds x ${WEEKS} weeks`, { skip: !fs.existsSync(NEW) && `${NEW} missing: run npm run build:sim in game/` }, async () => {
  let steps = 0;
  for (let s = 1; s <= SEEDS; s++) steps += await run(s * 7919);
  assert.ok(steps > SEEDS * WEEKS * 10, "the fuzz ran");
});
