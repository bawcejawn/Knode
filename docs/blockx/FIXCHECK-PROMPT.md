# Fix-check prompt, round 11 (very short): Block X prize-free go / no-go after the main merge

Copy everything below the line into Repo Lens. Give it the package `knode-fixcheck-12.zip` (the repository
`bawcejawn/Knode` at the commit in `00-COMMIT.txt`, branch `picks`, with this prompt as `00-FIXCHECK-PROMPT.md`).

---

You are an independent security auditor. Your report "Block X Prize-Free: Round-10 Go/No-Go (Knode picks @ a55390f)"
said **GO at a55390f**, with one condition (BX-138): `picks` has since merged `main` (c52a649, b301bfa), which changes
`race.yml` and `bot/race.ts` (the Race Vault results file `vault/W<week>.json`, game 7, and a stricter race-data
fetch). Get that diff fix-checked before launching from it.

**Since a55390f:**
- The merge itself. Conflicts were resolved by keeping both sides. Every round 8–9 publish check now also covers
  `vault/`, `vault_ok` uses `[0-9]`, and the old "holds 1 VHP" plain-balance read is gone (ranking is the vault stake).
- A blind review of the merged race code (record: "Blind review of the merge (BX-138)" in
  `docs/history/AUDIT-2026-10-28-repolens-blockx.md`) found nothing must-fix. Fixed anyway:
  - **V1:** a vault file that fails its check is held on its own, with a warning; the race files still publish, and a
    final vault file still never changes;
  - **V2:** the record job lists race-data with `ls-tree -z` into a file;
  - **V3:** `ls-remote` uses `refs/heads/race-data` exactly.
  - V4 (a pre-v6 chain read as "not staked") is marked before prizes.
- **BX-136:** the `\d` guard also checks `python3 -c` / `python3 -I -c` one-liners.
- Docs only: the round-10 record, and a runbook section for the later Picks v2 upgrade (Combo Card, FC2-13).

**Scope: `git diff a55390f HEAD -- .github/workflows bot/race.ts tests/audit` only.** Block X scores with the cards
`race.ts` writes. Send no transaction to any chain.

```
npm ci --ignore-scripts
npm run test:audit:serial
```

## The one question

**Block X live prize-free from this commit: go / no-go.** If no-go, name only what must be fixed for that verdict.
Put everything else in one Low/Info table, marked "before prizes" where it belongs.
