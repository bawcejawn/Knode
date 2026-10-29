# Kpred operator bot

The bot keeps the weekly game running. GitHub runs it every hour for free (`.github/workflows/bot.yml`),
or you can run it on your own PC. Every run looks at the chain and does whatever is due. Running it twice
does no harm.

| Every run, if it is due | How |
|---|---|
| Resolve finished questions | reads the irreversible blocks, works out the answer (or VOID), posts it with a hash of the blocks used |
| Post the day's questions | runs the question generator for the on-chain day (`W003-D2` = week 3, day 2), saves the questions to `game-data/questions/`, then posts them |
| Close / finalize the week | sends `close_week` / `finalize_week` if no player action has done it already |
| Settle players | settles everyone who answered last week but hasn't come back. The contract pays for this |
| Compound | once a day, burns the KOIN from block rewards into VHP so it produces too. It never touches the seed KOIN or the unpaid creator fee |

Questions are fitted to their on-chain week. Answers always close before the week ends, and every
observation window ends at least an hour before the week can close. This means a late question can never
hold up a week.

## Safety

- **The bot's key (operator) can't move any funds.** It can only post and resolve questions. A wrong
  resolution can be corrected by the owner before the week closes, and the owner can replace the operator.
- **A posted question is not lost.** In the GitHub run, a day's questions are saved in the runner (a local commit)
  *before* they are posted, and the workflow's publish job pushes `game-data/` at the end of every run, even a failed
  one. If the bot crashes after posting but before saving, the next run finds the questions on chain by their hash.
  - Each run starts from the latest `main`, and the publish job writes the bot's files on top of the latest `main`.
    So you can commit `deployment.json`, `game.json` or anything else while a run is going: your commit is kept, and
    so are the run's files. If a question file was also changed on `main` during the run, the two are merged three ways
    against the run's starting copy, field by field: what only you changed keeps your value, what only the run changed
    (a result, a recorded correction) keeps the run's, and where both changed the same field `main`'s version wins.
    This run's questions and their chain ids are always added.
  - The one way to lose a run's files: the runner itself dies mid-run, so its files never reach the publish job. A
    question it posted is then unknown to the next run, which emails you and resolves it as VOID so its week can still
    close.
- **The bot's own files are sealed.** `bot-state.json` and each question's VHP readings carry a seal made with a key
  derived from `OPERATOR_WIF`.
  - The readings are sealed as a whole list (`vhpSeal`: every reading, how many, and the latest height). If a reading is
    removed, added or changed, the bot emails you and does not resolve that question: restore the file from git
    history, or void the question with the owner key.
  - `bot-state.json` is sealed with the block it was saved at. If it was edited, the bot emails you and starts its state
    afresh (nothing in it is kept, and the pool's last block counts as unknown until it is seen again). If it was
    deleted after the bot had run, the bot emails you (the owner-settings baseline is gone). If it is more than 90
    minutes old (the bot was down, or an older copy was put back), the bot re-checks its alert history, so every live
    owner-only change is emailed again.
  - The first run after this change emails you once about `bot-state.json` (it had no seal yet); that is expected.
- **The bot job holds no push token.** It runs with a read-only GitHub token (not left in `.git/config`) and installs
  exactly `package-lock.json` with install scripts off. A separate `publish` job, which runs no repository code,
  copies only `game-data/questions/*.json`, `bot-state.json`, `state.json` and `index.json` and pushes them.
- **Results are checked before they are posted.** A question file must still hash to the `params_hash` on chain,
  and the window's blocks are read fresh from the chain (the cached `blocks.csv` is only used to build questions,
  and its rows are spot-checked against the chain on every run).
- **Settles the bot pays for are capped** at 10 per run (`MAX_BOT_PAID_SETTLES`) when the contract declines to
  sponsor them, so the bot always keeps Mana for posting and resolving. In the last 3 hours before a week's
  `settle_end` the cap is lifted, but the bot still stops when its own Mana falls below 2 KOIN (`BOT_MANA_FLOOR`).
  It never pays for an entry the player voided by withdrawing everything (it can't be paid anything).
- **Keys:**
  - Only `OPERATOR_WIF` goes into GitHub.
  - `CONTRACT_WIF` is needed once, to deploy.
  - `OWNER_WIF` and `SEED_WIF` stay in `.env` on your PC, and only if you choose to use `admin` from the
    command line.

## Commands

From the repo's root folder (run `npm install` once). **LAUNCH.md** has the full step-by-step launch guide.

```
npm run bot -- status                 the game now: weeks, money, open questions, pool production (no key needed)
npm run bot -- tick --dry-run         what the bot would do, without sending anything
npm run bot -- tick                   do it (GitHub runs this every hour)
npm run bot -- keys                   create the project's keys in .env (never prints a private key)
npm run bot -- deploy [--send]        deploy + initialise the contract
npm run bot -- register-key <public key> [--send]
npm run bot -- seed-vhp <amount> / seed-koin <amount> [--send]
npm run bot -- deposit <amount> / answer <question #> <letter> / claim <week> / withdraw <amount> [--send]   (player)
npm run bot -- void <question #> "reason" / claim-fee / claim-share <amount> / pause on|off [--send]
npm run bot -- sponsor-limit <KOIN> [floor KOIN] [--send]   most (and least) Mana one free transaction may use; 0 = off
npm run bot -- min-stake <VHP> [--send]                     minimum stake for rewards, from next week (never 0)
npm run bot -- admin <method> key=value ... --as owner|seed|operator|player [--send]   (anything else)
npm run bot -- rehearse --weeks 3     whole weeks on a simulated chain (no network, no keys, no KOIN)
```

`rehearse` needs the contract's test build: in the `game` folder, run `npm run build:sim` first.

**Health alarms:**
- the pool has made no block for 1 hour (or longer, if the pool normally goes longer between blocks);
- the bot's or the contract's Mana is low;
- a week is overdue to close;
- a transaction or the question generator failed;
- the game's owner or operator, or the producer key registered for it, differs from `game-data/deployment.json`
  (the key: from `"producerKey"` there, or else the first key the bot saw);
- an ownership transfer, a code upgrade or a seed withdrawal is announced;
- the Desk's owner or treasury differs from `desk-data/deployment.json`, or a Desk upgrade or treasury change is
  announced, or its producer key changes;
- a posted result was changed on chain (a correction), or an on-chain result differs from what the blocks say;
- an orphan question (one that matches no question file) has any outcome other than VOID;
- a question was resolved without the VHP-swing rule (no VHP reading before its answer was decided);
- `bot-state.json` or a VHP reading was not written by the bot (no valid seal);
- a question file no longer matches its on-chain `params_hash`.

Changes that stay true (a new owner, an announcement) email you once, not every hour.

Any of these ends the hourly run as *failed*, and GitHub emails you.

## The KnodeGames Vault (game v6)

These commands work once v6 is live; on v5 they say so and stop. Each one is a dry run until you add `--send`.

```
npm run bot -- games                                  every game: stake, this week's count, last week's bucket and prize
npm run bot -- game-add <id> "<name>" --staked|--free [--season <weeks>] [--send]   announce a game (48 h notice)
npm run bot -- game-apply <id> [--send]               after the 48 h, within 7 days: the game starts next Monday
npm run bot -- game-stop <id> [--send]                no new stakes; it earns through this week (withdrawals stay open)
npm run bot -- game-post <id> <week> [<folder or branch:folder>] [--send]   operator: post a week's results, then seal
npm run bot -- game-seal <id> <week> / game-finalize <id> <week> [--send]  operator (the hourly bot does both itself)
npm run bot -- game-correct <id> <week> <player> <points> [--send]   owner, until 24 h after the seal (0 removes)
npm run bot -- game-unprize <id> <week> <player> [--send]            owner: take a prize place away
npm run bot -- game-void <id> <week> [--send]                        owner: the week rolls over, its prize returns
npm run bot -- claim-fee-vhp [to] [VHP|all] [--send]                 owner: the 5% fee, in VHP
npm run bot -- stake <id> <VHP> / stake-koin <id> <KOIN> / unstake <id> <VHP|all> [--send]   (player, other games)
npm run bot -- move <from id> <to id> <VHP|all> / claim-game <id> <week> [--send]           (player)
```

Example, adding Who Signs Block X (game 2, free prize):
`npm run bot -- game-add 2 "Who Signs Block X" --free`, then again with `--send`; 48 hours later
`npm run bot -- game-apply 2 --send`. Survivor adds `--season 2` (its prize is paid once every 2 weeks).

**Results files.** The hourly bot posts each game's week once that game's recorder has published it as final, then
seals it. The owner then has 24 hours to correct anything, and anyone can finalize once those 24 hours are over and
the last correction has stood for 12 hours. Results are due 3 days after the week ends; a week with none by then rolls over. Each game says
where its files are in `game-data/deployment.json`:

```json
"vaultGames": { "2": { "name": "Who Signs Block X", "results": "games-data:blockx/vault" } }
```

`"<branch>:<folder>"` reads `<folder>/W<week>.json` from that branch; a plain folder reads files on disk. A file:

```json
{ "game": 2, "week": 57, "final": true,
  "rows":   [ { "player": "1Abc…", "points": 12 } ],
  "first":  [ "1Abc…" ], "second": [ "1Def…" ] }
```

- `week` is the vault's week number. Week 0 began at the contract's genesis, Mon 19 Oct 2026 00:00 UTC.
- `rows` (staked games) lists every staked player with 1–255 points; only the order matters.
- `first` and `second` (free-prize games) list the winners, ties included, at most 10 each, posted with the last week of
  the game's prize season.
- The bot checks every row against the chain first. Rows the vault would refuse (a wallet not staked in that game, a
  prize winner who was staked there) are left out and reported.

**More health alarms (v6):** a game is announced; the game list changes; the owner corrects or voids a game's week; a
game's results are still missing 12 hours before their deadline.

## The rehearsal

The rehearsal runs the **real contract code**, the **real bot** and the **real question generator**
together. It replays real mainnet block history hour by hour, so the questions are about real producers
and are resolved from real blocks. It adds:
- 10 simulated players with different habits (diligent, casual, one who vanishes, one who withdraws
  mid-week, a late depositor, one below the minimum, a whale depositing KOIN);
- the planned seed (170,000 VHP and 20,000 KOIN);
- block rewards every hour;
- trouble on purpose: a crash right after posting, a stray question the bot doesn't know about, and a
  20-hour outage of the bot.

Then it checks everything independently:
- every week closed on time;
- every outcome equals the generator's published result;
- every player's points, the cutoff, the winners and each reward match a recount done outside the contract;
- everything produced was counted exactly once;
- the seed was never touched;
- none of the bot's transactions failed.

## Launch checklist

1. `game`: run `npm test`, `npm run check` and `npm run build:sim`. Then at the root, run
   `npm run bot -- rehearse`. Everything must pass. (The rehearsal's own trouble, the stray question, is expected
   to email you: the rehearsal counts that one email as expected.)
2. Make the keys: a new **contract** key (an empty address), an **operator** key (holds ~20–30 KOIN for
   its Mana), and the **owner** and **seed** addresses.
3. `npm run bot -- deploy` (dry run). Check the plan, then `npm run bot -- deploy --send`.
4. The owner registers the block producer key: `admin register_key '{"public_key":"…"}' --as owner`. Then add the
   same key as `"producerKey"` to `game-data/deployment.json` (and the Desk's to `desk-data/deployment.json`) and commit:
   the bot compares the registered key with these files on every run.
5. Add the seed: `admin seed_deposit_vhp '{"amount":"…"}' --as seed`, then `seed_deposit_koin`.
6. In GitHub: Settings → Environments → New environment `bot`; under "Deployment branches and tags" choose
   "Selected branches and tags" and add `main`; add the environment secret `OPERATOR_WIF`. Delete any
   repository-level `OPERATOR_WIF` secret, so a manual run from another branch can't get the key. Then set the
   variable `BOT_ENABLED=true`.

## Rotating the operator key

Rotate it only while no question's counting window is open: the seals on VHP readings are made with the operator
key, so readings taken before a rotation no longer match it. The windows of Saturday's questions end on Sunday (no
questions are released on Sunday); the bot's last run log then has no "read … VHP during its window" line. If you
rotated while a window was open, the bot holds those questions back and emails you. Then, on your PC, put the old key
in `.env` as `PREVIOUS_OPERATOR_WIF` (next to the new `OPERATOR_WIF`) and run `npm run bot -- tick` once their results
are due: seals made with the old key are accepted, re-sealed with the new one, and the questions resolved. Commit and
push `game-data/`, then delete `PREVIOUS_OPERATOR_WIF` from `.env`. (GitHub only ever holds `OPERATOR_WIF`.)

The bot's key must be its own: never a key that was used for anything else (the probes' owner wallet was reused
before; rotate away from it). Nothing in this list has been done for you.

1. On your PC, make a new wallet for the bot only (for example a new Kondor account, or
   `node -e "const {Signer}=require('koilib');const s=Signer.fromSeed(require('crypto').randomBytes(32).toString('hex'));console.log(s.getAddress(), s.getPrivateKey('wif'))"`),
   and keep the private key only in your password manager. Send it a little KOIN for Mana.
2. Point the contract at it (owner key, on your PC):
   `npm run bot -- admin set_operator operator=<new address> --as owner` (dry run), then add `--send`.
3. Right away, in GitHub: Settings → Environments → `bot` → `OPERATOR_WIF` → Update secret, paste the new private
   key. Update `OPERATOR_WIF` in your local `.env` too.
4. Update `"operator"` in `game-data/deployment.json` to the new address and commit it (otherwise the bot will email
   you that the operator changed).
5. Run the workflow once by hand (Actions → Kpred bot → Run workflow) and check it is green.
6. Move any KOIN left in the old wallet elsewhere and stop using that key.

## Limit what the bot can push (GitHub ruleset)

The publish job already refuses anything outside `game-data/`. To have GitHub enforce it too, add a **push ruleset**
(Settings → Rules → Rulesets → New ruleset → *New push ruleset*):

- Name: `bot can only change game-data`; Enforcement: Active; Target: all branches (push rulesets apply to the whole
  repository).
- Rule **Restrict file paths**, with every path except the bot's: `.github/**`, `*.html`, `*.js`, `*.css`, `media/**`, `site/**`, `desk-data/**`, `game/**`,
  `desk/**`, `bot/**`, `node/**`, `docs/**`, `tests/**`, `data/**`, `game-data/deployment.json`,
  `game-data/game.json`, and the files in the repository's root folder by name (`package.json`, `package-lock.json`,
  `common.ts`, `resolver.ts`, `generator.ts`, … as they are listed there). Do not use a bare `*.json`: it could also
  match the bot's own files under `game-data/`.
- This advice has not been tested by the project. Check it before relying on it: from a test branch, a push changing `index.html` must be refused for a non-admin token,
  and the next hourly run must still publish `game-data/`.
- Bypass list: **Repository admin** (you), so your own pushes and pull requests still work. Do not add GitHub Actions.

Push rulesets are offered only on some plans and repository types. If yours doesn't show *New push ruleset*, use a
**branch ruleset** on `main` instead: *Restrict deletions*, *Block force pushes*, and *Require status checks to pass*
(Contract tests, Desk contract tests, Resolver tests, Workflow guard) with Repository admin as the only bypass. That
does not stop a token from pushing other files, which is why the publish job checks every path itself.

