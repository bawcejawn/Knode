# Last Node Standing simulations (2026-10-27)

Scratch simulations behind the Build 13 rules (see `claude/builds/13-last-node-standing-plan.md` in the project).
Not used by the site or the recorder; the rules live in `lastnode-math.js`.

- `lns.cjs`: fairness of the cut on the live race card (so far vs this hour only, c grid, field thresholds).
- `backtest.cjs`: daily events replayed on `data/blocks-compact.csv.gz` (123 days of real blocks).
- `points.cjs`: expected points per node, and the effect of real reliability (needs `recent-blocks.json` from the
  `blocks-data` branch).

- `replay.mjs`: the recorder on real blocks from the `blocks-data` snapshot (run from the repo root: `node --import tsx tools/sim/lastnode/replay.mjs <recent-blocks.json> <race-data folder> <day>`).

Run from this folder, with `RACE_W` pointing at a `race-data` week file:
`node lns.cjs`, `node backtest.cjs ../../../data/blocks-compact.csv.gz`, `node points.cjs`.
