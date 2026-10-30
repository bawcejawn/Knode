// Reviewer D-R scratch fixtures (own code). Loads a verbatim COPY of bot/games/combo.ts + blockx.ts from $APP.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
export const APP = path.resolve(process.env.APP || ".");
export const { run, expectedLegTypes } = await import(path.join(APP, "bot/games/combo.ts"));
export const BXM = await import(path.join(APP, "bot/games/blockx.ts"));
export const { CALLS } = await import(path.join(APP, "common.ts"));
export const M = globalThis.KRaceMath, X = globalThis.KBlockX, C = globalThis.KCombo;
// (Combo fix round: real addresses with valid checksums, which koilib's encoder requires.)
export const H1 = "15NZhQoewzsbVUcSVsZ8BEBEKgaBNPLLgZ", H2 = "1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW", H3 = "1UG4UUn7Da9JqE4PKbYUWgjbNwE5F9531", H4 = "1GGxRhLN7Ek54xycG5XaZBE4bCgwV2xtvk";
export const ALICE = "1G2QjRtNwEfqGwX7SMD8LNjWgJdWA7XtSU", BOB = "18UYKhWVCbTpFs8oYC54xoiCQQthhEkX7m";
export const W3 = M.weekStart(3), H0 = 48_000_000;
export const heightAt = (t) => H0 + Math.floor((t - W3) / 3000);
export const timeAt = (h) => W3 + (h - H0) * 3000;
export const CARD = (at) => ({ at, c: 0, blocksPerRace: 7200, fairness: null, samples: 12, height: heightAt(at),
  field: [{ a: H1, vhp: 4000, k: 600, h: 1 }, { a: H2, vhp: 2000, k: 300, h: 2 }, { a: H3, vhp: 1300, k: 200, h: 3 }, { a: H4, vhp: 700, k: 100, h: 6 }], paddock: [] });
export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dr-"));
const W = (w) => `W${String(w).padStart(3, "0")}.json`;
/** Race files, a card every hour (6 per race), every race finishes H1,H2,H3,H4; noResult: races left without a result. */
export function raceDir({ noResult = new Set(), from = 2, to = 5, resultsUntil = Infinity } = {}) {
  const d = tmp();
  for (let w = from; w <= to; w++) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) {
      const i = M.raceIndex(t);
      const result = noResult.has(i) || t + M.RACE > resultsUntil ? null : { final: true, checked: 2, standings: [H1, H2, H3, H4].map((a, k) => ({ a, steps: 100 - k * 10, blocks: 10 })) };
      races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards: [0, 1, 2, 3, 4, 5].map((k) => CARD(t + k * 3600000 + 60000)), result });
    }
    fs.writeFileSync(path.join(d, W(w)), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  return d;
}
/** Block X files: even rounds signed by H1, odd by H2; skip: rounds left out (not recorded yet). */
export function blockxDir({ from = 2, to = 5, skip = new Set(), until = Infinity } = {}) {
  const d = tmp();
  for (let w = from; w <= to; w++) {
    const targets = [];
    for (let r = Math.ceil(heightAt(M.weekStart(w)) / X.ROUND); X.target(r) < heightAt(M.weekStart(w + 1)); r++) {
      if (skip.has(r) || timeAt(X.target(r)) > until) continue;
      targets.push({ round: r, height: X.target(r), final: true, checked: 2, signer: r % 2 === 0 ? H1 : H2, time: timeAt(X.target(r)), lockTime: 0, card: null, picks: [] });
    }
    fs.writeFileSync(path.join(d, W(w)), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), targets }));
  }
  return d;
}
// (Combo fix round: real addresses, since the koilib adapter below encodes them; the reviewer's stub koilib took any text.)
export const VAULT = "1EDaCKVmBjUxLxgWCmDbRA8gWKkSQ6ByzY", PICKS = "1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv";
const OWNER = "16ixK5DgvcojcZLvxyYWhHFcRXfhfrHbpL";
// (Combo fix round: the reviewer's fake node answered fn(id, name, args) through a stub koilib Contract. The recorder
// uses the real koilib (and Block X's own vaultReader), so the fake node also speaks koilib's provider interface:
// readContract decodes the arguments with the real ABI, asks fn(), and encodes its answer with the real ABI.)
const { Serializer, utils } = await import("koilib");
const ABIS = [JSON.parse(fs.readFileSync(path.join(APP, "picks/abi/picks.koilib.json"), "utf8")), JSON.parse(fs.readFileSync(path.join(APP, "game/abi/kpred-v6.koilib.json"), "utf8"))]
  .map((a) => ({ ser: new Serializer(a.koilib_types), byEntry: new Map(Object.entries(a.methods).map(([n, m]) => [m.entry_point >>> 0, { name: n, ...m }])) }));
async function readVia(node, { contract_id, entry_point, args }) {
  const A = contract_id === VAULT ? ABIS[1] : ABIS[0], m = A.byEntry.get(entry_point >>> 0);
  if (!m) throw new Error("unexpected entry point " + entry_point);
  const decoded = await A.ser.deserialize(args, m.argument);
  const r = await node.fn(contract_id, m.name, decoded);
  return { result: r && r.result ? utils.encodeBase64url(await A.ser.serialize(r.result, m.return)) : undefined };
}
/** A fake koilib Provider: head at trueT (headTime can lie/lag), Picks list_picks from `cards(round)` (paged by player),
 *  Vault get_state/get_game_player from `stake`. stats counts calls. */
export function node({ t, headTime = t, cards = () => [], stake = () => 200000000n, live = true, fail = {}, stats = { list: 0, vault: 0 } } = {}) {
  const lib = heightAt(headTime) - 60, libTime = headTime - 180000;
  return { stats,
    async getHeadInfo() { if (fail.head) throw new Error("head: no answer"); return { last_irreversible_block: String(lib), head_block_time: String(headTime), head_topology: { id: "0x00", height: String(heightAt(headTime)) } }; },
    async call(_m, a) { return { block_items: [{ block_height: a.ancestor_start_height, block: { header: { timestamp: String(libTime) } } }] }; },
    async readContract(op) { return readVia(this, op); },
    async fn(id, name, args) {
      if (name === "get_game") return { result: { game: { kind: 4, round_size: 3, round_offset: 0, leg_types: expectedLegTypes() } } };
      if (name === "list_picks") {
        stats.list++;
        const rnd = Number(args.round);
        if (fail.slot && fail.slot(rnd)) throw new Error(`list_picks ${rnd}: no answer`);
        const all = [...cards(rnd)].sort((u, v) => (u.player < v.player ? -1 : 1));
        const rows = all.filter((x) => !args.start_after || x.player > args.start_after).slice(0, args.limit);
        return { result: { rows: rows.map((x) => ({ player: x.player, pick: { legs: x.legs.map((l) => ({ code: l.code, round: String(l.round), producer: l.producer })), time: String(x.time), height: String(x.height), changes: x.changes } })) } };
      }
      if (name === "get_state") { stats.vault++; return { result: { config: { owner: OWNER, min_stake: "100000000", v6_rule_week_plus_one: live ? "1" : "0" } } }; }
      if (name === "get_game_player") { stats.vault++; if (fail.vault) throw new Error("vault: no answer"); return { result: { week_stake: String(stake(args.player, Number(args.week))) } }; }
      throw new Error("unexpected " + name);
    } };
}
export const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };
export const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
