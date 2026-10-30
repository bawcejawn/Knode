# Knode Games names (players and producers)

Any player or producer can swap their long address for a name; it shows on every Knode Games page (leaderboards,
races, Pulse, Producer lookup), always next to the short address (`Blue Harbor · 1JrsQX…sohh`), so a name can never
pass for another wallet. Free, no contract, no transaction. Wallets without a Knode Games name show their on-chain
Koinos nickname instead (`@jga · 1Abc12…wxyz`), from the Koinos Nicknames contract `1KD9Es7LBBjA1FY3ViCgQJ7e6WH1ipKbhz`.
Your own wallet button in the header shows your name.

## How someone takes a name
1. Open **https://knodegames.com/names.html**, connect the wallet in Kondor (or enter the address and sign with
   another tool), type a name. The page checks the rules and whether the wallet can take a name.
2. Sign `Knode Games name: <name> | <address> | <YYYY-MM-DD>` (Kondor `signMessage`: no transaction, no Mana). The
   page checks the signature.
3. **Submit on GitHub** opens a prefilled "Knode Games name" issue. No GitHub? They send the two lines to the owner,
   who runs `npm run names -- add "<claim>" --send`.
4. Within about 15 minutes the workflow checks it, publishes it and replies on the issue (closing it).

## Who can take a name
A wallet with **at least 1 VHP in it or staked in Knode Games** (any game; read from the chain), or a **block
producer** (on a Producer Race card or a signer in the recent-blocks snapshot in the last 30 days). The same rule as
"ranked" on the leaderboards, so throwaway wallets can't flood names.

## Rules (names.js, `KNames.rules`; the same code on the page, in the workflow and in the CLI)
- 3–24 characters: letters A–Z, digits, spaces and `. - _ '`; no leading, trailing or double spaces; at least 2
  letters or digits.
- Unique ignoring case, spaces, `. - _ '` and lookalikes (0/O, 1/l/I, 2/Z, 5/S, 8/B, rn/m, vv/w …), including other
  wallets' Koinos nicknames (your own nickname is fine).
- Reserved: equal to Koinos, admin, support, Knode; containing Knode Games, official or Koinos Foundation; or a word
  starting with Knode ("KnodeX", "My Knode"; "Blocknode" is fine). Lookalikes included. The two Knode Games nodes keep
  their names. Reserved nicknames are not shown.
- The claim's date is at most 7 days old, not in the future, newer than the wallet's last claim; one change every
  7 days. The newest valid claim wins. The signature must recover the address (koilib `Signer.recoverAddress`).
- Nicknames: refreshed hourly for producers, leaderboard players, question-game players and named wallets; a
  nickname counts only when two nodes return the same one.

## Owner commands (PC, repo folder; dry run unless `--send`; uses your own git login, changes only names-data)
```
npm run names -- list                                  names, nicknames, hidden addresses
npm run names -- check "<claim>"
npm run names -- add "<claim>" --send
npm run names -- hide <address> "<reason>" --send      hides its name and nickname; new claims refused
npm run names -- unhide <address> --send
npm run names -- nicknames --send                       refresh nicknames now (the workflow does it hourly)
```
A claim is two lines; in PowerShell paste them inside double quotes as they are (the line break is fine).

## How it runs (.github/workflows/names.yml)
- **Not triggered by issues** (the CI guard bans issue triggers). Every 15 minutes (minute 4: also the nickname
  refresh), while the repository variable `NAMES_ENABLED` is `true`:
  - **check** (read-only token: contents + issues read, no secrets) lists open issues containing a claim (at most 30,
    oldest first) through the API, as data, and runs `bot/names.ts run`. It reads the chain (VHP, stakes, players,
    nicknames) through two nodes (`vars.RPC`, `vars.RPC_CHECK`). Issue text never runs and is never pasted into the
    workflow.
  - **publish** (contents: write, runs no repository code) checks names.json's shape and pushes it as the only file on
    the `names-data` branch. Refused if names-data moved since the check read it; claims are re-checked next run.
  - **reply** (issues: write, runs no repository code) comments the outcome (fixed texts only) and closes each issue;
    an accepted claim is closed only once published.
- Pages read `https://raw.githubusercontent.com/bawcejawn/Knode/names-data/names.json` through `names.js`
  (`KNames.of(address)`, `KNames.node(address)`), check every entry again, and only ever use `textContent`.

## Using it on a page
Load `<script src="names.js"></script>` before the page script, add
`https://raw.githubusercontent.com/bawcejawn/Knode/names-data/` to the page's CSP `connect-src`, show wallets with
`KNames.of(a)` (text) or `KNames.node(a)` (element), and redraw on `KNames.onChange(fn)`. Never show `KNames.name(a)`
for someone else's wallet without the short address next to it. The shared leaderboard (`board.js`) does this by
itself on any page that loads `names.js`.

## Turning it on
1. Run the Repo Lens audit (`claude/audit-names-prompt.md` in the KnodeGames project), fix-check, then merge.
2. Optional: create the label `knode-name` (Issues → Labels) so claim issues are tagged.
3. Settings → Secrets and variables → Actions → Variables: `NAMES_ENABLED = true`.
4. Actions → "Knode Games names" → Run workflow: the first run publishes the nicknames (no claims needed).
