# Knode Games names (players and producers)

Any player or producer can swap their long address for a name; it shows on Knode Games pages (leaderboards,
results, Pulse, Producer lookup; not yet the race and games pages), always next to the short address (`Blue Harbor · 1JrsQX…sohh`), so a name can never
pass for another wallet. The Knode Games name is free: a signed message, no contract, no transaction. Wallets without a Knode Games name show their on-chain
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
"ranked" on the leaderboards, so throwaway wallets can't flood names. Every node that answers must agree (one lying
node can't make a wallet eligible); a node that doesn't answer within 8 seconds is left out. A name stays after the
VHP leaves. names.json is kept under 900 kB: past that, new claims wait ("the names list is full") until the owner
removes unused names (`npm run names -- remove`).

## Rules (names.js, `KNames.rules`; the same code on the page, in the workflow and in the CLI)
- 3–24 characters: letters A–Z, digits, spaces and `. - _ '`; no leading, trailing or double spaces; at least 2
  letters or digits.
- Unique ignoring case, spaces, `. - _ '` and lookalikes (0/O, 1/l/I, 2/Z, 5/S, 8/B, rn/m, nn/m, cl/d, ri/n, ii/u,
  vv/w …), including other wallets' Koinos nicknames (your own nickname is fine; the claim is also checked against the
  live Nicknames contract, so a nickname Knode Games never looked up counts too).
- Reserved: equal to Koinos, admin, support, Knode; containing Knode Games, Knode pool, Knode Swap, official, or
  Koinos + Foundation / Group / Team / Support / Admin / Official / Network / Labs; or starting with Knode, as a whole
  or a word ("K.node Swap", "KnodeX", "My Knode"; "Blocknode" is fine). Lookalikes included. The two Knode Games
  nodes keep their names. Reserved nicknames are not shown.
- Never shaped like an address: no "1" followed by 5 or more address characters, and no `...` / `…`
  ("1Mpmf2...T1sr" is refused; "1st Place" is fine). The same for nicknames.
- The claim's date is at most 7 days old, not in the future, newer than the wallet's last claim; one change every
  7 days. The newest valid claim wins. The signature must recover the address (koilib `Signer.recoverAddress`).
- Nicknames: refreshed hourly for producers, leaderboard players, question-game players and named wallets (named
  wallets and producers first, 20 at a time, within 4 minutes; at most 3,000); a nickname counts only when both
  nodes return the same one. A wallet whose read fails keeps its last nickname. A nickname that looks like another
  wallet's Knode Games name is not shown.
- The live nickname check uses the name's exact spellings (lower case; spaces as nothing, - or .). First come wins:
  if a wallet whose @nickname looks like an existing Knode Games name joins the list later, its @nickname isn't shown.
- If no node answers, a claim stays open and is checked again on the next run. Every run ends within about 7
  minutes; claims it didn't reach stay open.
- A signed claim anyone has seen can be submitted again by anyone while it is at most 7 days old (it still only names
  the wallet that signed it).

## Get a Koinos @name (names.html, bottom card)
A Koinos nickname is not a Knode Games name: it is an NFT on the Koinos Nicknames contract
(`1KD9Es7LBBjA1FY3ViCgQJ7e6WH1ipKbhz`), shown in other Koinos apps too. The card **mints** it: one transaction from
the player's own Kondor wallet (`mint { to: the connected wallet, token_id: hex of the name }`), paid with the
player's own Mana (at most 10 KOIN of Mana, or 90% of what the wallet has). It reads `verify_valid_name` first. The
contract, the recipient and the Mana limit are fixed in the page's code. Knode Games shows the new @name after the
next hourly nickname refresh.

## Owner commands (PC, repo folder; dry run unless `--send`; uses your own git login, changes only names-data)
```
npm run names -- list                                  names, nicknames, hidden addresses
npm run names -- check "<claim>"
npm run names -- add "<claim>" --send
npm run names -- hide <address> "<reason>" --send      hides its name and nickname; new claims refused
npm run names -- unhide <address> --send
npm run names -- remove <address> --send                deletes its name for good (it may claim again later)
npm run names -- nicknames --send                       refresh nicknames now (the workflow does it hourly)
```
A claim is two lines; in PowerShell paste them inside double quotes as they are (the line break is fine).

## How it runs (.github/workflows/names.yml)
- **Not triggered by issues** (the CI guard bans issue triggers). Every 15 minutes (minute 4: also the nickname
  refresh), while the repository variable `NAMES_ENABLED` is `true`:
  - **check** (read-only token: contents + issues read, no secrets) lists open issues containing a claim (at most 30,
    oldest first; only issues with the `knode-name` label, every page) through the API, as data, and runs
    `bot/names.ts run`. The issue numbers it found are the job's output, made before any repository code runs. It reads the chain (VHP, stakes, players,
    nicknames) through two nodes (`vars.RPC`, `vars.RPC_CHECK`). Issue text never runs and is never pasted into the
    workflow.
  - **publish** (contents: write, runs no repository code) checks names.json's shape and pushes it as the only file on
    the `names-data` branch. Refused if names-data moved since the check read it; claims are re-checked next run.
  - **reply** (issues: write, runs no repository code) comments the outcome (fixed texts only) and closes each issue,
    only issues the check job's find step listed; an accepted claim is closed only once published (a claim already
    published exactly as claimed is answered as accepted).
- Pages read `https://raw.githubusercontent.com/bawcejawn/Knode/names-data/names.json` through `names.js`
  (`KNames.of(address)`, `KNames.node(address)`), check every entry's shape and rules again (not the signature: the
checker verified it), ignore a file over 2 MB, and only ever use `textContent`.
- The owner CLI pushes to whatever `origin` is in the folder you run it from, and runs the code checked out there.

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
