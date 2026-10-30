# Review 2026-10-28: Block X testnet tooling (independent reviewer agent)

Scope: picks/scripts/build-testnet.cjs, bot/picks.ts, bot/games/blockx.ts (--testnet), testnet/blockx.json,
site/testnet-wallet.js, site/blockx-testnet.html, site/blockx.js, .github/workflows/games-testnet.yml and games.yml,
then tools/testnet-site.mjs. The Picks contract itself was out of scope (audited 2026-10-27, sha256 700c296a…).

Verdict: no High findings; no path found by which the testnet tools, page or workflows could sign, send or publish
for mainnet, or leak a key.

| # | Severity | Finding | Status (fix-check, same day) |
|---|---|---|---|
| 1 | Medium | games-testnet.yml publish check: the inline Python kept 2 extra spaces inside the loop → IndentationError, nothing ever published (the test sliced the indentation itself) | Fixed; tests now take the Python from the parsed YAML and compile every `<<'PY'` block in every workflow |
| 2 | Medium | `CONFIRM_MAINNET=yes` is already in .env (npm run bot -- keys), so a forgotten `--testnet` reached mainnet | Fixed: a mainnet send needs `--mainnet` on the command line too |
| 3 | Medium | lock-test reused a nonce after a reverted pick | Fixed (nonce used whenever a transaction id came back) |
| 4 | Low | testnet recorder fell back to the mainnet VHP address; findVhp could pick KOIN | Fixed: refuses without a testnet VHP; findVhp skips KOIN and checks symbol() = VHP |
| 5 | Low | publish check hardcoded round sizes 2400/300 | Fixed (any whole height ≥ round) |
| 6 | Low | picksKey didn't refuse the mainnet Picks wallet on testnet | Fixed |
| 7 | Info | Kondor's signed transaction: rc_limit and operations not re-checked | Fixed (rc_limit ≤ cap; same count, all to the testnet Picks contract) |
| 8 | Info | the testnet page shares the github.io origin with mainnet pages; isolation by storage names only | Open: owner decision (a custom domain, like S2) |
| 9 | Info | node text in ::warning:: lines could inject workflow commands | Fixed (CR/LF and :: stripped) |
| 10 | Info | .env.testnet briefly default permissions | Fixed (mode 0o600) |

Fix-check notes: tools/testnet-site.mjs (127.0.0.1 only, GET/HEAD, allowlist, never .env.testnet) and the localhost
data path: no issues.
