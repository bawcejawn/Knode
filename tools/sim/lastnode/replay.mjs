// Replays the Last Node Standing recorder on real mainnet blocks from the blocks-data snapshot (recent-blocks.json)
// and the real race cards (a race-data folder), with made-up players. Offline; reads no node.
//   node --import tsx tools/sim/lastnode/replay.mjs <recent-blocks.json> <race-data folder> <yyyy-mm-dd>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const [snap, raceDir, day] = process.argv.slice(2);
const { run } = await import(path.resolve("bot/games/lastnode.ts"));
const L = globalThis.KLastNode;
const B = JSON.parse(fs.readFileSync(snap, "utf8"));
const ts = []; let t = B.t0; for (let i = 0; i < B.sig.length; i++) { t += i ? B.dts[i] : 0; ts.push(t); }
const lastT = ts[ts.length - 1];
const ev = L.eventOf(day);
const windowOf = async (_node, t0, t1) => {
  if (t0 < ts[0]) throw new Error("before the snapshot");
  const counts = {}; let from = -1, to = -1;
  for (let i = 0; i < ts.length; i++) if (ts[i] >= t0 && ts[i] < t1) { if (from < 0) from = B.from + i; to = B.from + i; const a = B.signers[B.sig[i]]; counts[a] = (counts[a] || 0) + 1; }
  return { from, to, counts };
};
// 40 made-up players: each picks a random field node at the start and a random backup for every round.
let field = null;
const picksOf = async (_node, round) => {
  if (!field) return [];
  const off = round - ev.round, rows = [];
  for (let p = 0; p < 40; p++) {
    const who = "1" + String(p).padStart(2, "0").replace(/0/g, "x").replace(/1/g, "y").replace(/2/g, "z").replace(/3/g, "w") + "a".repeat(31);
    const k = (p * 7 + off * 13) % field.length;
    if (off === 0 || p % 2 === 0) rows.push([who, field[k], ev.start - 3600000]);
  }
  return rows;
};
const out = fs.mkdtempSync(path.join(os.tmpdir(), "lnsreplay-"));
const lib = Math.min(lastT, ev.start + 12 * 3600000);
const first = await run({ p: "main", check: "check", out, raceDir, picksContract: null, windowOf, picksOf: async () => [], rankedOf: async () => new Set(), now: { time: ev.start - 3600000, libTime: ev.start - 3600000 } });
const d0 = JSON.parse(fs.readFileSync(path.join(out, `D${day}.json`), "utf8"));
field = d0.field.nodes.map((n) => n.a);
const r = await run({ p: "main", check: "check", prev: out, out, raceDir, picksContract: null, windowOf, picksOf, rankedOf: async () => new Set(), now: { time: lib, libTime: lib } });
const d = JSON.parse(fs.readFileSync(path.join(out, `D${day}.json`), "utf8"));
console.log(`\n${day}: field of ${d.field.nodes.length}, c = ${d.field.c}, fairness ${d.field.fairness}`);
for (const h of d.hours) console.log(`hour ${h.i}: blocks ${h.from}-${h.to} (${h.to - h.from + 1}), cut ${d.cuts[h.i]?.a ?? "-"}`);
console.log(`done: ${d.done}, winner: ${d.winner}, standing: ${d.standing.length}; players ${d.players.length}, top points ${d.players.slice(0, 5).map((p) => p.points).join(" ")}`);
console.log("problems:", r.problems.length ? r.problems : "none");
