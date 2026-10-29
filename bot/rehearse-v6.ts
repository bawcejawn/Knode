/**
 * The Vault v6 rehearsal on a copy of the REAL game contract.
 *
 *   npm run bot -- vault-snapshot [--out v5-snapshot.json]     on your PC: reads the live contract (read-only, no key)
 *                                                               and saves every stored value to one file
 *   npm run bot -- rehearse-v6 [--snapshot v5-snapshot.json] [--weeks 3] [--reward 90]
 *                                                               runs anywhere (no network, no keys)
 *
 * What the rehearsal does:
 *  1. Rebuilds the contract's storage in the simulator from the snapshot, under the v5 test build (the same source as
 *     the live v5). Proof that the copy is exact: the v5 code on the copy answers every read exactly as mainnet did.
 *  2. Swaps in the v6 build, as the upload does, and checks every read again.
 *  3. Plays on: the weeks already running finish by the v5 rules (open questions are voided by the owner key, closed,
 *     settled, finalized, claimed); games 2 (free), 3 (free, 2-week seasons) and 13 (staked) are announced and applied;
 *     test players stake, move stake and withdraw part mid-week; each week the node earns `reward` VHP; the bot's own
 *     passes post and seal other games' results and finalize them; every winner claims.
 *  4. Ends in a full exit: every real and test player takes out every stake from every game, the seed is withdrawn,
 *     the owner claims every fee. The solvency check runs after every week and at the end.
 *
 * Real players' stakes are moved in the simulator only, with their addresses as authority: no key is used or needed.
 */
import fs from "node:fs";
import { Serializer, utils, Signer } from "koilib";
import { SimChain, loadAbi, showKoin, type Chain } from "./chain.ts";
import { vaultResultsPass, vaultFinalizePass, vaultView, type VaultCtx } from "./vault.ts";

export const V5_BUILD = "game/test-fixtures/kpred-v5-test-build.wasm";
export const V6_BUILD = "game/build/sim/contract.wasm";
const VHP = 100_000_000n;
const HOUR = 3_600_000;

export type Snapshot = {
  takenAt: string;
  contract: string;
  height: number;
  time: number;
  state: any;
  weeks: Record<string, any>;        // week → get_week result (week + buckets)
  questions: Record<string, any>;    // id → question
  players: Record<string, any[]>;    // week → list_players rows (address, player, entry for that week)
};

const num = (x: any) => Number(x ?? 0);
const big = (x: any) => BigInt(x ?? 0);
const u64Key = (v: number | bigint) => { const k = new Uint8Array(8); let x = BigInt(v); for (let i = 7; i >= 0; i--) { k[i] = Number(x & 0xffn); x >>= 8n; } return k; };
const u32Key = (v: number) => { const k = new Uint8Array(4); for (let i = 3; i >= 0; i--) { k[i] = v & 0xff; v >>>= 8; } return k; };
const cat = (a: Uint8Array, b: Uint8Array) => { const k = new Uint8Array(a.length + b.length); k.set(a, 0); k.set(b, a.length); return k; };
const isEmpty = (o: any) => !o || Object.values(o).every((v) => v === undefined || v === null || v === false || v === 0 || v === "0" || v === "" || (Array.isArray(v) && v.length === 0));

/** Every stored value of the game contract, read through its own read-only calls. */
export async function takeSnapshot(chain: Chain): Promise<Snapshot> {
  const state = await chain.read("get_state", {});
  const t = state.totals ?? {};
  const cur = num(state.week);
  const lastWeek = Math.max(cur, num(t.weeks_closed));
  const weeks: Record<string, any> = {}, players: Record<string, any[]> = {}, questions: Record<string, any> = {};
  for (let w = 0; w <= lastWeek; w++) {
    weeks[w] = await chain.read("get_week", { week: String(w) });
    const rows: any[] = [];
    let start = "";
    for (;;) {
      const r = await chain.read("list_players", { limit: 50, week: String(w), ...(start ? { start } : {}) });
      const page = r.rows ?? [];
      rows.push(...page);
      if (page.length < 50) break;
      start = page[page.length - 1].address;
    }
    players[w] = rows;
  }
  for (let id = 0; id < num(t.next_question_id); id++) questions[id] = (await chain.read("get_question", { id })).question ?? null;
  return { takenAt: new Date().toISOString(), contract: chain.contractId, height: num(state.height), time: num(state.time), state, weeks, questions, players };
}

/** Writes the snapshot into the simulator's storage exactly where the contract keeps each value. */
export async function transplant(sim: SimChain, snap: Snapshot) {
  const abi = loadAbi();
  const ser = new Serializer(abi.koilib_types);
  // Empty byte fields come back from a read as "0x" (koilib), which it can't write back: they are left out, as unset.
  const clean = (o: any): any => Array.isArray(o) ? o.map(clean)
    : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "0x").map(([k, v]) => [k, clean(v)])) : o;
  const enc = async (obj: any, type: string) => new Uint8Array(await ser.serialize(clean(obj ?? {}), `kpred.${type}`));
  const EMPTY = new Uint8Array(0);
  const s = snap.state;
  sim.putContractObject(0, EMPTY, await enc(s.config, "config_object"));
  sim.putContractObject(1, EMPTY, await enc(s.totals, "totals_object"));
  if (!isEmpty(s.upgrade)) sim.putContractObject(7, EMPTY, await enc(s.upgrade, "timelock_object"));
  if (!isEmpty(s.seed_withdrawal)) sim.putContractObject(8, EMPTY, await enc(s.seed_withdrawal, "timelock_object"));
  const weeks = Object.keys(snap.weeks).map(Number).sort((a, b) => a - b);
  const seen = new Set<string>();
  for (const w of weeks) {
    for (const row of snap.players[w] ?? []) {
      const a = utils.decodeBase58(row.address);
      if (!seen.has(row.address)) { seen.add(row.address); sim.putContractObject(2, a, await enc(row.player, "player_object")); }
      if (row.entry) sim.putContractObject(3, cat(a, u64Key(w)), await enc(row.entry, "entry_object"));
    }
    const gw = snap.weeks[w] ?? {};
    if (!isEmpty(gw.week)) sim.putContractObject(5, u64Key(w), await enc(gw.week, "week_object"));
    for (let p = 0; p < (gw.buckets ?? []).length; p++) {
      const b = gw.buckets[p];
      if (!isEmpty(b)) sim.putContractObject(6, cat(u64Key(w), u32Key(p)), await enc(b, "bucket_object"));
    }
  }
  for (const [id, q] of Object.entries(snap.questions)) if (q) sim.putContractObject(4, u32Key(Number(id)), await enc(q, "question_object"));
  await sim.ledgerSet(2, snap.contract, big(s.vhp_balance));
  await sim.ledgerSet(1, snap.contract, big(s.koin_balance));
  await sim.ledgerSet(3, snap.contract, big(s.mana));
  sim.setHeight(snap.height, snap.time);
}

/** Differences between two snapshots (the time each was taken aside). */
export function compareSnapshots(a: Snapshot, b: Snapshot, newFieldsOk = false): string[] {
  const out: string[] = [];
  const walk = (x: any, y: any, where: string) => {
    if (out.length > 20) return;
    if (x === null || typeof x !== "object") { if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${where}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`); return; }
    if (y === null || typeof y !== "object") { out.push(`${where}: missing`); return; }
    for (const k of Object.keys(x)) walk(x[k], y[k], `${where}.${k}`);
    for (const k of Object.keys(y)) if (!(k in x) && !(newFieldsOk && isEmpty({ v: y[k] }))) out.push(`${where}.${k}: new value ${JSON.stringify(y[k])}`);
  };
  for (const part of ["state", "weeks", "questions", "players"] as const) walk((a as any)[part], (b as any)[part], part);
  return out;
}

export type RehearsalReport = { ok: boolean; lines: string[] };

/** The whole rehearsal. Throws on the first failed check; returns the report. */
export async function rehearseV6(snap: Snapshot, opts: { weeks?: number; reward?: bigint; v5?: string; v6?: string; print?: (s: string) => void } = {}): Promise<RehearsalReport> {
  const lines: string[] = [];
  const say = (s: string) => { lines.push(s); opts.print?.(s); };
  const check = (cond: boolean, what: string) => { if (!cond) throw new Error(`rehearsal check failed: ${what}`); say(`  ✔ ${what}`); };
  const sim = new SimChain(snap.contract, opts.v5 ?? V5_BUILD);
  await sim.init();

  // ───── 1. the copy ─────
  await transplant(sim, snap);
  const copy = await takeSnapshot(sim);
  const d1 = compareSnapshots(snap, copy);
  const realPlayers = (snap.players[Math.max(...Object.keys(snap.players).map(Number))] ?? []).map((r) => r.address as string);
  say(`Copy of ${snap.contract} taken ${snap.takenAt}: ${realPlayers.length} players, ${Object.keys(snap.weeks).length} weeks, ${Object.keys(snap.questions).length} questions`);
  check(d1.length === 0, `the v5 code on the copy answers every read exactly as mainnet did${d1.length ? `: ${d1.join("; ")}` : ""}`);

  // ───── 2. the upgrade ─────
  await sim.setCode(opts.v6 ?? V6_BUILD);
  const d2 = compareSnapshots(snap, await takeSnapshot(sim), true);
  check(d2.length === 0, `after the swap to v6, every read is unchanged${d2.length ? `: ${d2.join("; ")}` : ""}`);

  const c = snap.state.config;
  const owner = c.owner as string, operator = c.operator as string, seedOwner = c.seed_owner as string;
  const genesis = num(c.genesis_time), weekLen = num(c.week_length), closeDelay = num(c.close_delay), timelock = num(c.timelock_length);
  const weekEnd = (w: number) => genesis + (w + 1) * weekLen;
  const h0 = snap.height, t0 = snap.time;
  const at = (t: number) => sim.setHeight(h0 + Math.floor((t - t0) / 3000), t);
  const send = async (who: string, method: string, args: any, mustWork = true) => {
    const r = await sim.sendAs([{ method, args }], [who], mustWork);
    if (mustWork && !r.ok) throw new Error(`${method} ${JSON.stringify(args)} as ${who}: ${r.error}`);
    return r.ok;
  };
  const read = (m: string, a: any = {}) => sim.read(m, a);
  const solvent = async (when: string) => {
    const s = await read("get_state");
    const t = s.totals ?? {};
    const owed = ["total_stake", "seed_vhp", "seed_koin", "owner_share", "creator_fee", "pots_outstanding", "fee_vhp", "games_rolled", "rolled_over"].reduce((n, k) => n + big(t[k]), 0n);
    const held = big(s.vhp_balance) + big(s.koin_balance);
    check(held >= owed, `${when}: holdings ${showKoin(held)} cover everything owed ${showKoin(owed)}`);
    await books(when);
  };
  // The books behind the counters (review of the audit fixes): unpaid rewards cover what every closed week still owes,
  // and the rolled-over buckets add up to the games' own. If either failed on real data, the new checked subtractions
  // would refuse closes and claims after the upgrade, so it must hold before it.
  const books = async (when: string) => {
    const s = await read("get_state");
    const t = s.totals ?? {};
    let owedWeeks = 0n;
    for (let w = 0; w < num(t.weeks_closed); w++) {
      const wk = (await read("get_week", { week: String(w) })).week ?? {};
      const left = (wk.rolled_over ? big(wk.pot_free) : big(wk.pot)) - big(wk.claimed);
      if (left > 0n) owedWeeks += left;
    }
    for (const g of (await read("list_games", {})).games ?? []) {
      if (num(g.id) === 1) continue;
      for (let w = 0; w < num(t.weeks_closed); w++) {
        const gw = (await read("get_game", { game: num(g.id), week: String(w) })).week ?? {};
        if (!gw.closed) continue;
        const left = (gw.rolled_over ? big(gw.prize_first) * BigInt(num(gw.first_n)) + big(gw.prize_second) * BigInt(num(gw.second_n))
          : gw.finalized ? big(gw.bucket) + big(gw.prize) - (big(gw.prize) - big(gw.prize_first) * BigInt(num(gw.first_n)) - big(gw.prize_second) * BigInt(num(gw.second_n)))
          : big(gw.bucket) + big(gw.prize)) - big(gw.claimed);
        if (left > 0n) owedWeeks += left;
      }
    }
    let heldGames = 0n;
    for (const g of (await read("list_games", {})).games ?? []) heldGames += big(g.prize_held);
    owedWeeks += heldGames;
    // Fix-check VN-12: on correct data the two are equal, so any drift shows.
    check(big(t.pots_outstanding) === owedWeeks, `${when}: unpaid rewards ${showKoin(t.pots_outstanding)} equal what every closed week still owes ${showKoin(owedWeeks)}`);
    const rolled = ((await read("list_games", {})).games ?? []).reduce((n: bigint, g: any) => n + big(g.rolled), 0n);
    check(big(t.games_rolled) === rolled, `${when}: rolled-over buckets ${showKoin(t.games_rolled)} equal the games' own ${showKoin(rolled)}`);
  };
  const cur = num(snap.state.week);
  let now = t0;
  await books("on the copy, right after the upgrade");

  // ───── 3a. the first v6 write: announce the games (this also sets the switch) ─────
  await send(owner, "propose_game", { game: 2, name: "Who Signs Block X", staked: false, free_prize: true, season_weeks: 1 });
  await send(owner, "propose_game", { game: 3, name: "Survivor", staked: false, free_prize: true, season_weeks: 2 });
  await send(owner, "propose_game", { game: 13, name: "Last Node Standing", staked: true, free_prize: false, season_weeks: 1 });
  const v6From = num((await read("get_state")).config.v6_rule_week_plus_one) - 1;
  check(v6From === cur + 1, `the vault rules start with week ${v6From}, the week after the one running at the first v6 write`);

  // ───── 3b. finish the weeks already over, by the v5 rules ─────
  const finishV5Week = async (w: number) => {
    let s = await read("get_state");
    if (num(s.totals.weeks_closed) <= w) {
      for (const [id, q] of Object.entries(snap.questions)) if (q && num(q.week) === w && num(q.outcome) === 0) {
        if (num((await read("get_question", { id: Number(id) })).question?.outcome) === 0) await send(owner, "correct_question", { id: Number(id), outcome: 1000, data_hash: "0x" + "ee".repeat(32) });
      }
      const wk = (await read("get_week", { week: String(w) })).week ?? {};
      now = Math.max(now, weekEnd(w), num(wk.last_resolved_time)) + closeDelay + 1;
      at(now);
      if (num((await read("get_state")).totals.weeks_closed) <= w) await send(operator, "close_week", { week: String(w) });
    }
    for (const row of snap.players[w] ?? []) if (row.entry && !row.entry.settled) await send(operator, "settle", { player: row.address, week: String(w) }, false);
    const wk = (await read("get_week", { week: String(w) })).week ?? {};
    now = Math.max(now, num(wk.settle_end) + 1);
    at(now);
    for (let i = 0; i < 50 && !(await read("get_week", { week: String(w) })).week?.finalized; i++) await send(operator, "finalize_week", { week: String(w) });
    let paid = 0n;
    for (const row of snap.players[w] ?? []) if (row.entry && !row.entry.claimed) {
      if (await send(row.address, "claim", { player: row.address, week: String(w) }, false)) paid += big((await read("get_player", { player: row.address, week: String(w) })).entry?.reward);
    }
    const fw = (await read("get_week", { week: String(w) })).week ?? {};
    say(`  week ${w} (v5 rules): closed, settled, finalized; ${num(fw.winners)} winner(s), ${showKoin(paid)} VHP claimed in the rehearsal${fw.rolled_over ? ", rolled over" : ""}`);
  };
  for (let w = num(snap.state.totals.weeks_finalized); w < cur; w++) await finishV5Week(w);
  await solvent("after the finished weeks");

  // ───── 3c. apply the games; test players join ─────
  now = Math.max(now, t0 + timelock + 60_000);
  at(now);
  for (const g of [2, 3, 13]) await send(owner, "apply_game", { game: g });
  const view = (await vaultView(sim))!;
  say(`  games: ${view.games.map((g: any) => `${num(g.id)} ${g.name} (from week ${num(g.from_week)})`).join(", ")}`);
  const test = ["S1", "S2", "S3", "S4", "S5", "S6"].map((n) => Signer.fromSeed(`vault rehearsal ${n}`).getAddress());
  for (const a of test) { await sim.ledgerSet(2, a, 1000n * VHP); await sim.ledgerSet(1, a, 100n * VHP); await sim.ledgerSet(3, a, 1000n * VHP); }
  const [S1, S2, S3, S4, S5, S6] = test;
  for (const [a, n] of [[S1, 5n], [S2, 20n], [S3, 1n]] as const) await send(a, "deposit_to", { from: a, game: 13, amount: String(n * VHP), koin: false });
  await send(S4, "deposit_vhp", { from: S4, amount: String(10n * VHP) });
  // the biggest real staker moves 1 VHP of their real stake into Last Node Standing
  let mover = "";
  let best = 0n;
  for (const a of realPlayers) {
    const p = (await read("get_player", { player: a, week: "0" })).player ?? {};
    const st = big(p.stake) + big(p.pending);
    if (st >= 2n * VHP && st > best) { best = st; mover = a; }
  }
  if (mover) { await send(mover, "move_stake", { player: mover, from_game: 1, to_game: 13, amount: String(VHP) }); say(`  real player ${mover} moved 1 VHP of their stake from the question game to Last Node Standing`); }
  await finishV5Week(cur);
  await solvent("after the last v5 week");

  // ───── 3d. the vault weeks ─────
  const lastGain = big(snap.weeks[Math.max(0, num(snap.state.totals.weeks_closed) - 1)]?.week?.gain);
  const reward = opts.reward ?? (lastGain > 0n ? lastGain : 90n * VHP);
  const files: Record<string, any> = {};
  const vctx: VaultCtx = {
    chain: sim, operator: Signer.fromSeed("unused"), dryRun: false, problems: [], quiet: true,
    deployment: { vaultGames: { "2": { results: "mem:2" }, "3": { results: "mem:3" }, "13": { results: "mem:13" } } },
    readResults: (src, w) => files[`${src}/W${w}`] ?? null,
  };
  const opSend = async (what: string, calls: any[]) => {
    const r = await sim.sendAs(calls, [operator]);
    if (!r.ok) throw new Error(`${what}: ${r.error}`);
    return true;
  };
  const weeks = opts.weeks ?? 3;
  for (let w = v6From; w < v6From + weeks; w++) {
    // mid-week: S2 takes 5 VHP out of Last Node Standing (that week counts 15 for S2)
    now = Math.max(now, weekEnd(w) - 3 * 24 * HOUR);
    at(now);
    if (w === v6From) await send(S2, "withdraw_from", { to: S2, game: 13, amount: String(5n * VHP) });
    await sim.ledgerAdd(2, snap.contract, reward);
    now = Math.max(now, weekEnd(w) + closeDelay + 1);
    at(now);
    await send(operator, "close_week", { week: String(w) });
    const wk = (await read("get_week", { week: String(w) })).week ?? {};
    const lnRows = [{ player: S1, points: 10 + w % 3 }, { player: S2, points: 7 }, { player: S3, points: 3 }];
    if (mover && w > v6From) lnRows.push({ player: mover, points: 9 });
    files[`mem:13/W${w}`] = { game: 13, week: w, final: true, rows: lnRows };
    files[`mem:2/W${w}`] = { game: 2, week: w, final: true, rows: [], first: [S5], second: [S6] };
    files[`mem:3/W${w}`] = { game: 3, week: w, final: true, rows: [], first: [S6], second: [S5] };
    await vaultResultsPass(vctx, opSend);
    check(vctx.problems.length === 0, `week ${w}: results posted and sealed for every game${vctx.problems.length ? `: ${vctx.problems.join("; ")}` : ""}`);
    now += 2 * closeDelay + 1;                       // a day after the seal: the owner's correction window has closed
    at(now);
    await vaultFinalizePass(vctx, opSend);
    now = Math.max(now, num(wk.settle_end) + 1);
    at(now);
    for (let i = 0; i < 50 && !(await read("get_week", { week: String(w) })).week?.finalized; i++) await send(operator, "finalize_week", { week: String(w) });
    let claimed = 0n;
    for (const a of [...test, ...realPlayers]) for (const g of [2, 3, 13]) {
      if (await send(a, "claim_game", { player: a, game: g, week: String(w) }, false)) claimed += big((await read("get_game_player", { player: a, game: g, week: String(w) })).entry?.reward);
    }
    const s = (await read("get_state")).totals;
    say(`  week ${w} (vault): gain ${showKoin(wk.gain)}, fee ${showKoin(wk.fee_vhp)}, seed's part ${showKoin(wk.seed_part)}, prizes ${showKoin(wk.prizes)}, split ${showKoin(wk.split)}; ${showKoin(claimed)} VHP claimed in other games; rolling over ${showKoin(s.games_rolled)}`);
    await solvent(`after week ${w}`);
  }

  // ───── 4. full exit ─────
  now += HOUR;
  at(now);
  // Claims left open from before the upgrade (v5 weeks) still pay under v6.
  let old = 0n, oldN = 0;
  for (let w = 0; w <= cur; w++) for (const row of snap.players[w] ?? []) {
    if (!row.entry || row.entry.claimed) continue;
    if (await send(row.address, "claim", { player: row.address, week: String(w) }, false)) {
      old += big((await read("get_player", { player: row.address, week: String(w) })).entry?.reward); oldN++;
    }
  }
  say(`  claims left open from before the upgrade: ${oldN} paid, ${showKoin(old)} VHP`);
  let out = 0n;
  for (const a of [...realPlayers, ...test]) {
    const p = (await read("get_player", { player: a, week: "0" })).player ?? {};
    const q = big(p.stake) + big(p.pending);
    if (q > 0n) { await send(a, "withdraw", { to: a, amount: String(q) }); out += q; }
    for (const g of [2, 3, 13]) {
      const gp = (await read("get_game_player", { player: a, game: g, week: "0" })).player ?? {};
      const gq = big(gp.stake) + big(gp.pending);
      if (gq > 0n) { await send(a, "withdraw_from", { to: a, game: g, amount: String(gq) }); out += gq; }
    }
  }
  say(`  every player withdrew: ${showKoin(out)} VHP in total`);
  let t = (await read("get_state")).totals;
  if (big(t.seed_vhp) + big(t.seed_koin) > 0n) {
    await send(seedOwner, "request_seed_withdrawal", { vhp: String(t.seed_vhp ?? "0"), koin: String(t.seed_koin ?? "0") });
    now += timelock + 60_000;
    at(now);
    await sim.ledgerSet(3, snap.contract, big((await read("get_state")).koin_balance) + VHP);   // Mana refills over time on chain
    for (let i = 0; i < 10 && big((await read("get_state")).totals.seed_vhp) + big((await read("get_state")).totals.seed_koin) > 0n; i++) await send(seedOwner, "execute_seed_withdrawal", {});
  }
  t = (await read("get_state")).totals;
  if (big(t.fee_vhp) > 0n) await send(owner, "claim_fee_vhp", { to: owner, amount: String(t.fee_vhp) });
  await sim.ledgerSet(3, snap.contract, big((await read("get_state")).koin_balance) + VHP);
  for (let i = 0; i < 10 && big((await read("get_state")).totals.creator_fee) > 0n; i++) await send(owner, "claim_creator_fee", { to: owner });
  const e = await read("get_state");
  t = e.totals;
  check(big(t.total_stake) === 0n && big(t.stake_other) === 0n, "no stake left in any game");
  check(big(t.seed_vhp) === 0n && big(t.seed_koin) === 0n, "the seed is fully withdrawn");
  check(big(t.fee_vhp) === 0n && big(t.creator_fee) === 0n, "every fee is claimed");
  const owed = big(t.pots_outstanding) + big(t.games_rolled) + big(t.rolled_over);
  const held = big(e.vhp_balance) + big(e.koin_balance);
  check(held >= owed, `what remains (${showKoin(held)}) covers the rewards still owed: unclaimed ${showKoin(t.pots_outstanding)}, rolling over ${showKoin(t.games_rolled)}, returned prizes ${showKoin(t.rolled_over)}`);
  say(`  dust (held − owed): ${showKoin(held - owed)} VHP`);
  check(sim.failures.length === 0, `none of the rehearsal's own transactions failed${sim.failures.length ? `: ${sim.failures.slice(0, 3).map((f) => `${f.method}: ${f.error}`).join("; ")}` : ""}`);
  say("All vault rehearsal checks passed.");
  return { ok: true, lines };
}

/** The commands (bot.ts dispatches to these). */
export async function snapshotCommand(chain: Chain, out: string) {
  const snap = await takeSnapshot(chain);
  fs.writeFileSync(out, JSON.stringify(snap, null, 1) + "\n");
  console.log(`Saved ${out}: ${Object.keys(snap.weeks).length} weeks, ${Object.keys(snap.questions).length} questions, ${snap.players[Object.keys(snap.players).length - 1]?.length ?? 0} players, block ${snap.height}. It holds public data only.`);
}
export async function rehearseCommand(file: string, weeks: number, reward?: string) {
  if (!fs.existsSync(file)) throw new Error(`${file} not found. On your PC: npm run bot -- vault-snapshot --out ${file}`);
  if (!fs.existsSync(V6_BUILD)) throw new Error(`${V6_BUILD} missing: in the game folder run npm run build:sim`);
  const snap = JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
  await rehearseV6(snap, { weeks, reward: reward ? BigInt(Math.round(Number(reward) * 1e8)) : undefined, print: (s) => console.log(s) });
}
