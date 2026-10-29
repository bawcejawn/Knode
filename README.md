# games-data

Data branch for the KnodeGames recorders. Never merged into `main`; the hourly bot reads it with
`git fetch origin games-data` and `git show origin/games-data:<folder>/vault/W<week>.json`.

Each game writes only its own folder:

| Folder | Game | Vault id |
|---|---|---|
| `blockx/` | Who Signs Block X | 2 |
| `survivor/` | Survivor | 3 |
| `fantasy/` | Fantasy Producers | 4 |
| `combo/` | Combo Card | 8 |
| `golf/` | Block Golf | 6 |
| `bracket/` | Producer Bracket | 9 |
| `lastnode/` | Last Node Standing | 13 |

`<folder>/vault/W<week>.json` is the game's weekly results file for the Vault (format: `claude/handoff-vault-results.md`
in the project, and the "KnodeGames Vault" section of `bot/README.md`). The Producer Race publishes to `race-data:vault`
instead. File names are unpadded: `W57.json`, not `W057.json`.

Rules for writers: append or replace your own files only, never rewrite history (no force-push), and write a week's file
only once it is final.
