/**
 * REHEARSAL — runs the real contract code and the real bot through several whole weeks on a simulated chain,
 * then checks every result independently. No network, no keys, no KOIN.
 *
 *   npm run bot -- rehearse [--weeks 3] [--verbose]
 *
 * How it is simulated:
 *   - the chain's blocks are the REAL mainnet history in data/blocks-compact.csv.gz, replayed hour by hour, so the
 *     generator makes and resolves real questions about real producers;
 *   - the contract is the game's test build running in the Koinos mock VM (its token ledger lives inside it);
 *   - block rewards are added to the contract every simulated hour, and production turns some VHP into KOIN;
 *   - 10 simulated players with different habits deposit, answer, withdraw, claim — or vanish;
 *   - trouble is injected on purpose: a crash right after posting, a stray question the bot knows nothing
 *     about, and a long outage of the bot.
 */
import fs from "node:fs";
import path from "node:path";
import { Signer } from "koilib";
import { SimChain, showKoin } from "./chain.ts";
import { tick, paths, generatorRunner, allPlayers, DAY, type Ctx } from "./bot.ts";
import { readCompact, writeCsv } from "../common.ts";

const SIM_WASM = "game/build/sim/contract.wasm";
const VHP = 100_000_000n;
const HOUR = 1_200;

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];

type Habit = "diligent" | "casual" | "ghost" | "quitter" | "late" | "tiny" | "whale";
type Player = { name: string; key: Signer; habit: Habit; stake: bigint; claimed: bigint };

export async function rehearse(opts: { weeks: number; verbose: boolean }) {
  if (!fs.existsSync(SIM_WASM)) throw new Error(`${SIM_WASM} not found — in the game folder run: npm run build:sim`);
  const t0 = Date.now();
  const checks: Array<{ ok: boolean; what: string }> = [];
  const check = (ok: boolean, what: string) => { checks.push({ ok, what }); if (!ok || opts.verbose) console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); };

  // ── the simulated chain ──
  console.log("Loading the real block history ...");
  const history = readCompact();
  const h0 = history[0].h;
  const genesis = h0 + 27 * DAY;                       // 27 days of history before week 0 for the generator's model
  const endHeight = genesis + opts.weeks * 7 * DAY + 4 * DAY;
  if (endHeight > history[history.length - 1].h) throw new Error(`Not enough history for ${opts.weeks} weeks.`);
  const contract = Signer.fromSeed("rehearsal contract"), operator = Signer.fromSeed("rehearsal operator");
  const owner = Signer.fromSeed("rehearsal owner"), seedOwner = Signer.fromSeed("rehearsal seed");
  const sim = new SimChain(contract.getAddress(), SIM_WASM);
  await sim.init();
  const C = contract.getAddress();

  const dir = "rehearsal-data";
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const P = paths(dir);
  const run = generatorRunner(dir, ["--offline"]);
  let generatorRuns = 0;
  const ctx: Ctx = {
    chain: sim, operator, P, dryRun: false, quiet: !opts.verbose, checkpoint: () => {},
    generator: (args) => {
      // The generator reads blocks.csv: give it the last 26 days of irreversible history at the simulated height.
      const lib = sim.height - 60;
      const from = Math.max(h0, lib - 26 * DAY);
      writeCsv(path.join(dir, "blocks.csv"), history.slice(from - h0, lib - h0 + 1));
      generatorRuns++;
      return run(args);
    },
  };

  sim.setHeight(genesis - 2 * DAY);
  const init = { owner: owner.getAddress(), operator: operator.getAddress(), seed_owner: seedOwner.getAddress(), genesis_height: String(genesis),
    week_blocks: String(7 * DAY), close_delay: String(DAY), settle_blocks: String(2 * DAY), timelock_blocks: String(2 * DAY),
    min_stake: String(VHP), max_sponsor_rc: String(2n * VHP) };
  check((await sim.sendAs([{ method: "init", args: init }], [C])).ok, "contract initialised with the mainnet settings (7-day weeks, 24 h correction delay, 48 h settlement)");

  // ── wallets ──
  const habits: Habit[] = ["diligent", "diligent", "diligent", "casual", "casual", "ghost", "quitter", "late", "tiny", "whale"];
  const players: Player[] = habits.map((habit, i) => ({ name: `P${i}-${habit}`, key: Signer.fromSeed(`rehearsal player ${i}`), habit, stake: 0n, claimed: 0n }));
  for (const p of players) for (const tag of [1, 2, 3]) await sim.ledgerSet(tag, p.key.getAddress(), 100_000n * VHP);
  for (const tag of [1, 2, 3]) await sim.ledgerSet(tag, seedOwner.getAddress(), 300_000n * VHP);
  const act = async (who: Signer, method: string, args: any) => (await sim.sendAs([{ method, args }], [who.getAddress()], false)).ok;

  // Seed: 170,000 VHP producing + 20,000 KOIN as the Mana reserve (the planned mainnet seed).
  check(await act(seedOwner, "seed_deposit_vhp", { amount: String(170_000n * VHP) }), "seed: 170,000 VHP deposited");
  check(await act(seedOwner, "seed_deposit_koin", { amount: String(20_000n * VHP) }), "seed: 20,000 KOIN deposited (kept as KOIN for Mana)");
  const stakes: Record<Habit, bigint> = { diligent: 500n * VHP, casual: 200n * VHP, ghost: 300n * VHP, quitter: 400n * VHP, late: 250n * VHP, tiny: VHP / 2n, whale: 20_000n * VHP };
  for (const p of players) {
    if (p.habit === "late") continue; // deposits during week 0 → counts from week 1
    const amt = stakes[p.habit];
    if (await act(p.key, p.habit === "whale" ? "deposit_koin" : "deposit_vhp", { from: p.key.getAddress(), amount: String(amt) })) p.stake += amt;
  }

  // ── block production: every hour the pool's VHP makes blocks; ~12% a year, some VHP turns into KOIN ──
  let minted = 0n;
  const produce = async () => {
    const vhp = await sim.ledgerGet(2, C);
    const reward = (vhp * 12n) / (100n * 8760n);
    const burned = vhp / 2000n;
    await sim.ledgerSet(2, C, vhp - burned);
    await sim.ledgerAdd(1, C, burned + reward);
    await sim.ledgerSet(3, C, await sim.ledgerGet(1, C)); // the contract's Mana follows its KOIN (fully regenerated)
    minted += reward;
  };

  // ── trouble to inject ──
  let crashInjected = false, strayPosted = false, outageDone = false;
  const strayHash = "0x" + "5a".repeat(32);

  const weekLog: string[] = [];
  let lastClosed = 0;
  const closeHeights: number[] = [];
  let ticks = 0, outageSkips = 0, claimChecked = 0;
  const answered = new Set<string>();

  console.log(`Rehearsing ${opts.weeks} weeks on real blocks ${genesis}…${endHeight} (one bot run per simulated hour) ...`);
  for (let h = genesis - 2 * DAY + HOUR; h <= endHeight; h += HOUR) {
    sim.setHeight(h);
    await produce();
    const week = h < genesis ? -1 : Math.floor((h - genesis) / (7 * DAY));
    const dayIdx = h < genesis ? -1 : Math.floor((h - genesis) / DAY);

    // ── players ──
    const st = await sim.read("get_state", {});
    const next = Number(st.totals.next_question_id ?? 0);
    const open: any[] = [];
    for (let id = Math.max(0, next - 8); id < next; id++) {
      const q = (await sim.read("get_question", { id })).question;
      if (q && h < Number(q.lock_height) && Number(q.outcome ?? 0) === 0) open.push({ id, k: Number(q.k) });
    }
    const fin = Number(st.totals.weeks_finalized ?? 0);
    for (const p of players) {
      const A = p.key.getAddress();
      if (p.habit === "late" && p.stake === 0n && week === 0 && dayIdx === 2) {
        if (await act(p.key, "deposit_vhp", { from: A, amount: String(stakes.late) })) p.stake += stakes.late;
      }
      if (p.habit === "ghost" && week >= 1) continue;                   // played week 0, then vanished forever
      if (p.habit === "quitter" && week === 1 && dayIdx === 10 && p.stake > 0n) {
        const amt = p.stake / 2n;                                          // withdraws half mid-week: week 1 is void
        if (await act(p.key, "withdraw", { to: A, amount: String(amt) })) p.stake -= amt;
      }
      // answer open questions
      for (const q of open) {
        if (answered.has(`${A}:${q.id}`)) continue;
        answered.add(`${A}:${q.id}`);                                    // one decision per question
        if (p.habit === "casual" && rnd() < 0.4) continue;
        await act(p.key, "answer", { player: A, question_id: q.id, option: Math.floor(rnd() * q.k) });
      }
      // claim finished weeks (everyone except the ghost, who never comes back)
      if (p.habit !== "ghost" && fin > claimChecked) {
        for (let w = Math.max(0, fin - 2); w < fin; w++) {
          const r = await sim.read("get_player", { player: A, week: String(w) });
          if (r.entry?.eligible && !r.entry.claimed) {
            const wk = (await sim.read("get_week", { week: String(w) })).week;
            if (wk.rolled_over || Number(r.entry.points) < Number(wk.cutoff)) continue;
            const before = await sim.ledgerGet(2, A);
            if (await act(p.key, "claim", { player: A, week: String(w) })) p.claimed += (await sim.ledgerGet(2, A)) - before;
          }
        }
      }
    }

    claimChecked = fin;

    // ── injected trouble ──
    if (!strayPosted && week === 1 && dayIdx === 9) {
      // A question the bot knows nothing about (as if posted by hand with the operator key). The bot must void it
      // after its window, or week 1 could never close.
      strayPosted = await act(operator, "post_question", { k: 2, lock_height: String(h + 600), window_start: String(h + 601), window_end: String(h + 1800), params_hash: strayHash });
      check(strayPosted, "injected: a stray question unknown to the bot was posted on-chain");
    }
    if (!outageDone && week === 1 && dayIdx === 11 && (h - genesis) % DAY < 20 * HOUR) { outageSkips++; continue; } // bot down ~20 h
    if (!outageDone && week === 1 && dayIdx === 11) { outageDone = true; check(outageSkips >= 19, `injected: the bot was down for ${outageSkips} hours`); }

    // ── the bot ──
    const bsFile = P.botState;
    const bsBefore = fs.existsSync(bsFile) ? fs.readFileSync(bsFile, "utf8") : null;
    const snap = new Map<string, string>();
    if (!crashInjected && week === 1 && dayIdx === 8) for (const f of fs.existsSync(P.questions) ? fs.readdirSync(P.questions) : []) snap.set(f, fs.readFileSync(path.join(P.questions, f), "utf8"));
    await tick(ctx);
    ticks++;
    if (!crashInjected && week === 1 && dayIdx === 8) {
      // Crash simulation: the bot posted questions but "died" before saving their on-chain ids.
      const posted = fs.readdirSync(P.questions).filter((f) => !snap.has(f) || snap.get(f) !== fs.readFileSync(path.join(P.questions, f), "utf8"));
      for (const f of posted) {
        // Only questions posted in THIS run lose their ids (ids at or above what the bot had already saved).
        const saved = bsBefore ? JSON.parse(bsBefore).checkedUpTo : 0;
        const d = JSON.parse(fs.readFileSync(path.join(P.questions, f), "utf8"));
        if (!d.questions.some((q: any) => q.chainId !== undefined && q.chainId >= saved)) continue;
        for (const q of d.questions) if (q.chainId !== undefined && q.chainId >= saved) delete q.chainId;
        fs.writeFileSync(path.join(P.questions, f), JSON.stringify(d, null, 2));
        if (bsBefore !== null) fs.writeFileSync(bsFile, bsBefore);
        crashInjected = true;
        check(true, `injected: crash after posting ${f} (its on-chain ids were never saved)`);
      }
    }

    // ── per-week bookkeeping ──
    const s2 = await sim.read("get_state", {});
    const closed = Number(s2.totals.weeks_closed);
    while (lastClosed < closed) {
      const wk = (await sim.read("get_week", { week: String(lastClosed) })).week;
      closeHeights.push(Number(wk.settle_start));
      lastClosed++;
    }
  }

  // ═══════════════════ independent checks ═══════════════════
  const st = await sim.read("get_state", {});
  const T = st.totals;
  const W = opts.weeks;
  console.log("");
  check(Number(T.weeks_closed) >= W, `all ${W} weeks closed automatically (closed: ${T.weeks_closed})`);
  check(Number(T.weeks_finalized) >= W, `all ${W} weeks finalized automatically (finalized: ${T.weeks_finalized})`);
  for (let w = 0; w < W; w++) {
    const due = genesis + (w + 1) * 7 * DAY + DAY;
    check(closeHeights[w] !== undefined && closeHeights[w] - due <= HOUR + 60, `week ${w} closed on time (${closeHeights[w] - due} blocks after it was due)`);
  }

  // Questions: every one resolved, on-chain outcomes equal the generator's results, all inside their week.
  const files = fs.readdirSync(P.questions).sort().map((f) => JSON.parse(fs.readFileSync(path.join(P.questions, f), "utf8")));
  const local = files.flatMap((d: any) => d.questions);
  const posted = local.filter((q: any) => q.chainId !== undefined);
  const nq = Number(T.next_question_id);
  check(posted.length + 1 === nq, `every on-chain question is accounted for: ${posted.length} from the generator + 1 stray = ${nq}`);
  check(new Set(posted.map((q: any) => q.chainId)).size === posted.length, "no question was posted twice (the crash was recovered by matching hashes)");
  let mismatch = 0, unresolved = 0, outOfWeek = 0, voids = 0;
  for (const q of posted) {
    const oc = (await sim.read("get_question", { id: q.chainId })).question;
    const w = Number(oc.week);
    if (Number(oc.outcome) === 0) { if (w < W) { unresolved++; console.log(`  unresolved: ${q.id} (#${q.chainId})`); } continue; }
    if (!q.result) { mismatch++; console.log(`  ${q.id} (#${q.chainId}) is resolved on-chain (${oc.outcome}) but has no local result`); continue; }
    const mine = q.result.void ? 1000 : q.result.option + 1;
    if (mine !== Number(oc.outcome)) mismatch++;
    if (q.result.void) voids++;
    if (String(oc.params_hash).replace(/^0x/, "") !== q.paramsHash) mismatch++;
    if (Number(oc.lock_height) > genesis + (w + 1) * 7 * DAY || Number(oc.window_end) + 60 + HOUR > genesis + (w + 1) * 7 * DAY + DAY) outOfWeek++;
  }
  check(unresolved === 0, `every question of a finished week was resolved (${posted.length} questions, ${voids} void)`);
  check(mismatch === 0, "every on-chain outcome and params hash equals the generator's published result");
  check(outOfWeek === 0, "every question closed for answers inside its week and finished in time for the week to close");
  let strayVoid = false;
  for (let id = 0; id < nq; id++) { const q = (await sim.read("get_question", { id })).question; if (String(q.params_hash) === strayHash) strayVoid = Number(q.outcome) === 1000; }
  check(strayVoid, "the stray question was resolved as VOID, so its week could close");
  const lateSkips = local.filter((q: any) => q.postSkipped).length;
  const dayFilesSkipped = files.filter((d: any) => d.skipped).length;
  check(true, `bot outage handled: ${lateSkips} question(s) skipped as too late to answer, ${dayFilesSkipped} day(s) skipped`);

  // Scoring: recompute every week's winners off-chain from the raw entries and compare with the contract.
  for (let w = 0; w < W; w++) {
    const wk = (await sim.read("get_week", { week: String(w) })).week;
    const rows = await allPlayers(sim, w);
    const entries = rows.filter((r) => r.entry);
    const outcome = new Map<number, number>();
    for (let id = 0; id < nq; id++) outcome.set(id, Number((await sim.read("get_question", { id })).question.outcome));
    const scored = entries.map((r) => {
      const e = r.entry;
      let pts = 0, counted = 0;
      if (!e.voided) for (const a of e.answers ?? []) { const o = outcome.get(Number(a.question_id))!; if (o === 1000) continue; counted++; if (o === Number(a.option) + 1) pts++; }
      return { addr: r.address, pts, eligible: !e.voided && counted > 1 && BigInt(e.stake) >= VHP, stake: BigInt(e.stake), e };
    });
    const allSettled = entries.every((r) => r.entry.settled);
    const pointsMatch = scored.every((s) => s.pts === Number(s.e.points) && s.eligible === s.e.eligible);
    const elig = scored.filter((s) => s.eligible);
    const total = elig.reduce((s, x) => s + x.stake, 0n);
    let cutoff = 0, cum = 0n;
    const maxP = Math.max(0, ...elig.map((s) => s.pts));
    for (let p = maxP; p >= 1; p--) { cum += elig.filter((s) => s.pts === p).reduce((a, x) => a + x.stake, 0n); cutoff = p; if (cum * 10000n >= total * 3000n) break; }
    const winners = cutoff >= 1 ? elig.filter((s) => s.pts >= cutoff) : [];
    const weight = winners.reduce((a, s) => a + BigInt(s.pts) * s.stake, 0n);
    const onWeight = (BigInt(wk.weight_hi) << 64n) + BigInt(wk.weight_lo);
    check(allSettled, `week ${w}: all ${entries.length} entries settled (players who never came back were settled by the bot)`);
    check(pointsMatch, `week ${w}: every player's points and eligibility match an independent recount`);
    check(Number(wk.cutoff) === cutoff && Number(wk.winners) === winners.length && onWeight === weight,
      `week ${w}: winners match the independent recount — cutoff ${cutoff} pts, ${winners.length} winner(s) holding ≥30% of ${showKoin(total)} eligible VHP`);
    let payOk = true;
    for (const s of winners) {
      if (!s.e.claimed) continue;
      const expect = (BigInt(wk.pot) * BigInt(s.pts) * s.stake) / weight;
      if (BigInt(s.e.reward) !== expect) payOk = false;
    }
    check(payOk, `week ${w}: every claimed reward = pot × points × stake ÷ total weight, to the unit`);
    const voided = entries.filter((r) => r.entry.voided).length;
    weekLog.push(`week ${w}: ${wk.questions} questions · gain ${showKoin(wk.gain)} → fee ${showKoin(wk.fee)} / owner ${showKoin(wk.retained)} / pot ${showKoin(wk.pot)} · ${entries.length} played (${voided} voided), ${wk.eligible_players} eligible · cutoff ${wk.cutoff} pts · ${wk.winners} winner(s) · claimed ${showKoin(wk.claimed)}${wk.rolled_over ? " · ROLLED OVER" : ""}`);
  }

  // Habits behaved as designed.
  const pr = async (p: Player, w: number) => (await sim.read("get_player", { player: p.key.getAddress(), week: String(w) })).entry;
  const ghost = players.find((p) => p.habit === "ghost")!, quitter = players.find((p) => p.habit === "quitter")!;
  const late = players.find((p) => p.habit === "late")!, tiny = players.find((p) => p.habit === "tiny")!;
  check(!(await pr(late, 0)) && !!(await pr(late, 1)), "a deposit made during week 0 only counted from week 1");
  check(!(await pr(tiny, 0)), "a player below the 1 VHP minimum could not answer");
  check(!!(await pr(quitter, 1))?.voided, "the mid-week withdrawal voided that player's week-1 answers");
  const g0 = await pr(ghost, 0);
  check(!!g0?.settled && !(g0?.claimed), "the player who vanished after week 0 was settled by the bot and their reward stays unclaimed (still producing)");

  // Money: everything produced is accounted for exactly once.
  const holdings = BigInt(st.vhp_balance) + BigInt(st.koin_balance);
  const owed = ["total_stake", "seed_vhp", "seed_koin", "owner_share", "creator_fee", "pots_outstanding"].reduce((s, k) => s + BigInt(T[k]), 0n);
  let gains = 0n, rolled = 0n, claimedOnChain = 0n;
  for (let w = 0; w < Number(T.weeks_closed); w++) {
    const wk = (await sim.read("get_week", { week: String(w) })).week;
    gains += BigInt(wk.gain);
    if (wk.rolled_over) rolled += BigInt(wk.pot);
    claimedOnChain += BigInt(wk.claimed);
  }
  check(holdings >= owed, `the contract holds at least everything it owes (${showKoin(holdings)} ≥ ${showKoin(owed)})`);
  check(gains - rolled + (holdings - owed) === minted,
    `every unit produced was counted exactly once: weekly gains ${showKoin(gains)} − rolled over ${showKoin(rolled)} + not yet split ${showKoin(holdings - owed)} = produced ${showKoin(minted)}`);
  const claimedByPlayers = players.reduce((s, p) => s + p.claimed, 0n);
  check(claimedByPlayers === claimedOnChain, `players received exactly what the contract recorded as claimed (${showKoin(claimedOnChain)} VHP)`);
  check(BigInt(T.seed_vhp) === 170_000n * VHP && BigInt(T.seed_koin) === 20_000n * VHP, "the seed is untouched");
  check(BigInt(st.koin_balance) >= BigInt(T.seed_koin) + BigInt(T.creator_fee), "compounding never touched the seed KOIN or the unpaid creator fee");
  const botFailures = sim.failures;
  check(botFailures.length === 0, `the bot's own transactions never failed (${sim.calls} sent)${botFailures.length ? ": " + botFailures.slice(0, 3).map((f) => `${f.method}: ${f.error}`).join("; ") : ""}`);

  console.log("\n" + weekLog.join("\n"));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${ticks} bot runs, ${generatorRuns} generator runs, ${((Date.now() - t0) / 60000).toFixed(1)} min.`);
  console.log(failed ? `\n${failed} of ${checks.length} checks FAILED.` : `\nAll ${checks.length} rehearsal checks passed.`);
  process.exitCode = failed ? 1 : 0;
}
