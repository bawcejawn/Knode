# Who wins Last Node Standing on real blocks (2026-10-29)

Scratch analysis behind the form rule. Not used by the site or the recorder.

Data (not in the repo): put in this folder `recent1.json` and `recent2.json` (two `blocks-data` snapshots,
`recent-blocks.json`, covering 25–29 Oct) and `W001.json` (race-data week 1). `long.cjs` reads `data/blocks-compact.csv.gz`.

- `analyze.cjs`: each node's blocks against its VHP share; every possible event replayed under today's rule; Monte Carlo
  at the VHP rate and at the real rate.
- `persist.cjs`: form day by day (is it steady?), and hourly spread against Poisson. Writes `hours.json`.
- `policy.cjs`: today's rule vs + form vs + form + a VHP rebase, replayed on real blocks.
- `long.cjs`: the form rule on 123 days of blocks (June–October).
- `impl.cjs`: the built rule (`formOf`, `makeField(card, trials, form)`) replayed.

Paths at the top of each file point at the repo and this folder.
