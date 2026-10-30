# Producer names

Producers name their own node; the name shows on every Knode Games page, always next to the short address
(`Blue Harbor · 1JrsQX…sohh`), so a name can never pass for another node. Free, no contract, no transaction.

## How a producer does it
1. Open **https://knodegames.com/names.html**, connect the producer wallet in Kondor (or enter the address and sign
   with another tool), type a name.
2. Sign the message `Knode Games producer name: <name> | <address> | <YYYY-MM-DD>` (Kondor `signMessage`: no
   transaction, no Mana). The page checks the rules and the signature first.
3. **Submit on GitHub** opens a prefilled "Producer name" issue. No GitHub? They send the two lines to the owner, who
   runs `npm run names -- add "<claim>" --send`.
4. Within about 15 minutes the workflow checks it, publishes it and replies on the issue (closing it).

## Rules (names.js, `KNames.rules`; the same code on the page, in the workflow and in the CLI)
- 3–24 characters: letters A–Z, digits, spaces and `. - _ '`; no leading, trailing or double spaces; at least 2
  letters or digits.
- Unique ignoring case, spaces, `. - _ '` and lookalikes (0/O, 1/l/I, 2/Z, 5/S, 8/B, rn/m, vv/w …).
- Reserved: a name equal to Koinos, admin, support, Knode, Knode Games, or containing Knode, official or Koinos
  Foundation (lookalikes included). The two Knode Games nodes keep their names and can't be claimed.
- The address must be a producer: on a Producer Race card (race-data) or a signer in the recent-blocks snapshot
  (blocks-data) in the last 30 days. The signature must recover that address (koilib `Signer.recoverAddress` on
  sha256 of the message).
- The claim's date is at most 7 days old, not in the future, and newer than the address's last claim; one change
  every 7 days. The newest valid claim wins.

## Owner commands (PC, repo folder; dry run unless `--send`; uses your own git login, changes only names-data)
```
npm run names -- list
npm run names -- check "<claim>"
npm run names -- add "<claim>" --send
npm run names -- hide <address> "<reason>" --send     the page shows its short address again; new claims refused
npm run names -- unhide <address> --send
```
A claim is two lines; in PowerShell paste them inside double quotes as they are (the line break is fine).

## How it runs (.github/workflows/names.yml)
- **Not triggered by issues** (the CI guard bans issue triggers). Every 15 minutes, while the repository variable
  `NAMES_ENABLED` is `true`:
  - **check** (read-only token: contents + issues read, no secrets) lists open issues containing a claim (at most 30,
    oldest first) through the API, as data, and runs `bot/names.ts verify-issues`. Issue text never runs and is never
    pasted into the workflow.
  - **publish** (contents: write, runs no repository code) checks names.json's shape and pushes it as the only file on
    the `names-data` branch. Refused if names-data moved since the check read it; those claims are re-checked next run.
  - **reply** (issues: write, runs no repository code) comments the outcome (fixed texts only) and closes each issue;
    an accepted claim is closed only once published.
- Pages read `https://raw.githubusercontent.com/bawcejawn/Knode/names-data/names.json` through `names.js`
  (`KNames.of(address)`, `KNames.node(address)`), check every entry again, and only ever use `textContent`.

## Using it on a page
Load `<script src="names.js"></script>` before the page script, add
`https://raw.githubusercontent.com/bawcejawn/Knode/names-data/` to the page's CSP `connect-src`, show producers with
`KNames.of(a)` (text) or `KNames.node(a)` (element), and redraw on `KNames.onChange(fn)`. Never show `KNames.name(a)`
without the short address next to it.

## Turning it on
1. Merge, then run the Repo Lens audit (`claude/audit-names-prompt.md` in the KnodeGames project) and fix-check.
2. Optional: create the label `producer-name` (Issues → Labels) so claim issues are tagged.
3. Settings → Secrets and variables → Actions → Variables: `NAMES_ENABLED = true`. Run "Producer names" once from
   the Actions tab to check it.
