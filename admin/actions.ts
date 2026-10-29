/**
 * Everything the admin page can do, for the whole Knode Games platform.
 *
 * Each action runs one of the existing, tested commands (npm run bot / desk / sponsor / picks / racepicks) with
 * checked arguments: the page adds no new way to sign anything. Actions that send always run as a dry run first; the
 * page can send only the exact same action and values that were just previewed.
 *
 * HOW TO ADD A GAME'S CONTROLS (for each game's build chat; docs/ADMIN.md):
 *   1. Its area is already in AREAS below (by game id). Set `status` and `tool`, and fill `what` / `docs`.
 *   2. Add its actions with `area: "<its id>"`, the right `kind`, and every text field filled in plainly.
 *   3. `npm run test:audit` checks every action has all its fields and a known area and kind.
 */
export type Param = { name: string; label: string; pattern: RegExp; hint: string; choices?: string[]; value?: string };

/** What kind of control it is. The page shows an area's controls in this order, each under its own heading. */
export const KINDS = {
  check: { title: "Check (read-only)", blurb: "Looks only. Nothing here can change anything." },
  settings: { title: "Adjustable rules and settings", blurb: "The numbers and switches you tune while the game runs." },
  emergency: { title: "Emergency stop", blurb: "Use these if something looks wrong. Stopping is always allowed, at once." },
  money: { title: "Money in and out", blurb: "Fees, seed funds and withdrawals." },
  launch: { title: "Launch steps", blurb: "Done once (or once per new game), in the order shown." },
  upgrade: { title: "Upgrade the contract code", blurb: "New contract code. Game and Swap upgrades give players 48 hours' notice first; each card says what it needs." },
  ownership: { title: "Keys and ownership", blurb: "Hand-overs and changing which wallet does what. Rare; take your time." },
} as const;
export type Kind = keyof typeof KINDS;

/** Where on the platform an action belongs. `section` is the sidebar heading. */
export type Area = {
  id: string; name: string; section: "Start here" | "Platform" | "Games" | "Knode Swap" | "Testnet";
  status: "live" | "launching" | "planned" | "testnet";
  gameId?: number;          // the game id registry (claude/knodegames-plan.md)
  what: string;             // one or two plain sentences: what this part of the platform is
  contract?: string;        // which contract or wallet it runs on
  docs?: string;            // the runbook in the repository
  later?: string;           // planned games: what will appear here and when
};

export const AREAS: Area[] = [
  { id: "overview", name: "Health checks", section: "Start here", status: "live",
    what: "Quick read-only checks across the whole platform. A good first stop: nothing here can change anything." },

  { id: "sponsor", name: "Mana sponsor", section: "Platform", status: "live",
    what: "The wallet that pays players' Mana (transaction fees) for every Knode game, within daily caps. Free players share a pool released by the hour; players with a stake in a game get more.",
    contract: "Mana sponsor contract on the sponsor wallet (SPONSOR_WIF)", docs: "sponsor/README.md" },
  { id: "vault", name: "Knode Vault (v6)", section: "Platform", status: "planned",
    what: "The one vault that holds every staked VHP, produces blocks with it, and pays each week's prizes after the flat 5% fee.",
    later: "Its controls (game registry, minimum stakes, weekly finalize, prizes) arrive here when Vault v6 launches (branch vault-v6)." },

  { id: "question", name: "Question game", section: "Games", status: "live", gameId: 1,
    what: "The weekly block-producer questions. Players answer free or with a stake; correct answers climb the weekly board.",
    contract: "Game contract v5 (owner wallet OWNER_WIF; seed owner SEED_WIF)", docs: "bot/README.md" },
  { id: "blockx", name: "Who Signs Block X", section: "Games", status: "launching", gameId: 2,
    what: "Every 2,400 blocks is a target: players pick the producer they think signs it. Runs on the Picks contract, which later carries other games too.",
    contract: "Picks contract (game 2)", docs: "docs/blockx/MAINNET-LAUNCH.md" },
  { id: "survivor", name: "Survivor", section: "Games", status: "planned", gameId: 3,
    what: "Two-week seasons: one producer pick a day, two lives, each producer only once.",
    later: "Its season settings appear here when it launches (branch survivor, on the Picks contract as game 3)." },
  { id: "fantasy", name: "Fantasy Producers", section: "Games", status: "planned", gameId: 4,
    what: "Pick a team of five producers for the week (game 4), with a weekly rival (game 5).",
    later: "Controls appear here when it is built and launched." },
  { id: "golf", name: "Block Golf", section: "Games", status: "planned", gameId: 6,
    what: "The platform's golf course: scored from every game's weekly board, no picks of its own.",
    later: "Its course settings appear here when it launches (after the vault)." },
  { id: "race", name: "Producer Race", section: "Games", status: "live", gameId: 7,
    what: "Players pick the producers who sign the most blocks in a day (Win and Show). Cards and results are made automatically every few minutes.",
    contract: "Race picks contract (owner wallet OWNER_WIF)" },
  { id: "combo", name: "Combo Card", section: "Games", status: "planned", gameId: 8,
    what: "A card of several picks across games, scored together.",
    later: "Controls appear here after the Picks v2 (CARD) upgrade and its audit." },
  { id: "bracket", name: "Producer Bracket", section: "Games", status: "planned", gameId: 9,
    what: "A knockout bracket of producers.",
    later: "Controls appear here when it launches (branch kg-09-bracket)." },
  { id: "lastnode", name: "Last Node Standing", section: "Games", status: "planned", gameId: 13,
    what: "Hourly rounds: the producers with the fewest blocks are cut until one is left.",
    later: "Controls appear here when it launches (branch lastnode)." },

  { id: "desk", name: "Knode Swap (Desk)", section: "Knode Swap", status: "live",
    what: "The VHP → KOIN swap desk, funded by the node. Players swap VHP for KOIN at the fee you set.",
    contract: "Desk contract v2 (owner wallet OWNER_WIF)", docs: "bot/README.md" },

  { id: "t-sponsor", name: "Sponsor v3 trial", section: "Testnet", status: "testnet",
    what: "Sponsor v3 on the Koinos Foundation testnet with test KOIN only, played from the testnet Block X page. Do the numbered steps in order.",
    contract: "Testnet sponsor wallet (SPONSOR_WIF in .env.testnet)", docs: "docs/blockx/SPONSOR-TESTNET.md" },
];

export type Action = {
  id: string;
  area: string;            // an AREAS id
  kind: Kind;
  label: string;           // a short name: what you're doing
  what: string;            // what it does, in plain words
  when?: string;           // when (or why) you'd use it
  signer: string;          // which wallet signs, or "nobody (read-only)"
  effect: "none" | "chain" | "files";   // read-only / changes the blockchain / changes files on this PC
  timing?: string;         // when the change takes effect
  step?: number;           // for a numbered sequence inside an area
  tool: "bot" | "desk" | "sponsor" | "picks" | "racepicks";
  args: string[];          // {name} is replaced by the parameter's value
  params?: Param[];
  sends: boolean;          // false = read-only, never takes --send
};

const ADDRESS: Omit<Param, "name" | "label"> = { pattern: /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/, hint: "a Koinos address (starts with 1)" };
const AMOUNT: Omit<Param, "name" | "label"> = { pattern: /^\d{1,12}(\.\d{1,8})?$/, hint: "a number, up to 8 decimals" };
const WHOLE: Omit<Param, "name" | "label"> = { pattern: /^[1-9]\d{0,11}$/, hint: "a whole number, at least 1" };
const INT: Omit<Param, "name" | "label"> = { pattern: /^\d{1,10}$/, hint: "a whole number" };
const PERCENT: Omit<Param, "name" | "label"> = { pattern: /^(10(\.0{1,2})?|\d(\.\d{1,2})?)$/, hint: "0 to 10, up to 2 decimals" };
const KEY: Omit<Param, "name" | "label"> = { pattern: /^(node|[A-Za-z0-9_\-+/=]{40,90})$/, hint: "the node's PUBLIC key, or: node" };
const ONOFF: Omit<Param, "name" | "label"> = { pattern: /^(on|off)$/, hint: "on or off", choices: ["on", "off"] };
const GAMEID: Omit<Param, "name" | "label"> = { pattern: /^[1-9]\d{0,2}$/, hint: "the game id (2 = Block X)" };
// No word may start with "-", so a reason can never pass an option such as --send to the command.
const REASON: Omit<Param, "name" | "label"> = { pattern: /^(?!(.*\s)?-)[A-Za-z0-9 .,'()\-]{0,120}$/, hint: "letters, numbers and basic punctuation (no word starting with -)" };

const RO = "Nobody (read-only)";
const FILES = "Nobody: it only edits files on this PC";
const OWNER = "Owner wallet (OWNER_WIF)";
const SPONSOR = "Sponsor wallet (SPONSOR_WIF)";
const TSPONSOR = "Testnet sponsor wallet (SPONSOR_WIF in .env.testnet)";
const NEWOWNER = "The NEW owner (NEW_OWNER_WIF in .env, for this step only)";
const AT_ONCE = "At once";
const NOTICE = "After 48 hours' notice";

/** The owner's sponsor caps (2026-10-28), shared by the mainnet and testnet forms. */
const CAPS_ARGS = ["--per-tx", "{tx}", "--per-player-day", "{day}", "--per-player-week", "{week}", "--per-day", "{all}", "--free-per-day", "{free}", "--min-vhp", "{minvhp}"];
const CAPS_PARAMS: Param[] = [
  { name: "tx", label: "Most Mana for one transaction", ...AMOUNT, value: "1" },
  { name: "day", label: "Most Mana per player per day", ...AMOUNT, value: "50" },
  { name: "week", label: "Most Mana per player per week", ...AMOUNT, value: "300" },
  { name: "all", label: "Most Mana for everyone per day (at most 5,000)", ...AMOUNT, value: "5000" },
  { name: "free", label: "Of that, the free players' pool per day", ...AMOUNT, value: "2000" },
  { name: "minvhp", label: "VHP a wallet must have staked in a game to count as a player", ...AMOUNT, value: "1" },
];

export const ACTIONS: Action[] = [
  // ════════ Start here: health checks ════════
  { id: "chain-check", area: "overview", kind: "check", label: "Contracts check", what: "Reads the question game's and the Desk's code fingerprints, safety switches, owners and anything announced, straight from the chain.", when: "Before and after any upgrade, or whenever something looks off.", signer: RO, effect: "none", tool: "bot", args: ["chain-check"], sends: false },
  { id: "game-status", area: "overview", kind: "check", label: "Question game status", what: "The question game right now: week, questions, players, pots and the bot's health.", signer: RO, effect: "none", tool: "bot", args: ["status"], sends: false },
  { id: "sponsor-status", area: "overview", kind: "check", label: "Mana sponsor status", what: "On or off, its caps, its KOIN and Mana, today's use, and who the website asks to pay.", signer: RO, effect: "none", tool: "sponsor", args: ["status"], sends: false },
  { id: "sponsor-watch", area: "overview", kind: "check", label: "Mana sponsor usage alerts", what: "Warns when free play (as released so far today) or everyone's total is past 80% of today's caps.", when: "The hourly bot runs this too; if it warns often, lower the caps in Mana sponsor.", signer: RO, effect: "none", tool: "sponsor", args: ["watch"], sends: false },
  { id: "picks-status", area: "overview", kind: "check", label: "Picks contract status (Block X)", what: "The Picks contract's code and safety switches, checked on two nodes; its owner; its games and anything announced.", signer: RO, effect: "none", tool: "picks", args: ["status", "--mainnet"], sends: false },
  { id: "race-status", area: "overview", kind: "check", label: "Race picks status", what: "The race contract's code, its settings and today's picks.", signer: RO, effect: "none", tool: "racepicks", args: ["status"], sends: false },
  { id: "desk-status", area: "overview", kind: "check", label: "Knode Swap status", what: "The Desk right now: KOIN available, VHP producing, swaps and settings.", signer: RO, effect: "none", tool: "desk", args: ["status"], sends: false },

  // ════════ Mana sponsor ════════
  { id: "sponsor-status-2", area: "sponsor", kind: "check", label: "Sponsor status", what: "On or off, its caps, its KOIN and Mana, today's use, and who the website asks to pay.", signer: RO, effect: "none", tool: "sponsor", args: ["status"], sends: false },
  { id: "sponsor-watch-2", area: "sponsor", kind: "check", label: "Usage alerts (80%)", what: "Warns when free play (as released so far today) or everyone's total is past 80% of today's caps.", signer: RO, effect: "none", tool: "sponsor", args: ["watch"], sends: false },
  { id: "sponsor-report", area: "sponsor", kind: "check", label: "Mana report: what each action really used", what: "Reads the last day of sponsored transactions on two nodes and suggests a Mana limit per action (2 × the most used; only with 20 or more measurements). Saves nothing.", when: "After a full day of real play.", signer: RO, effect: "none", tool: "sponsor", args: ["mana-report"], sends: false },
  { id: "sponsor-caps", area: "sponsor", kind: "settings", label: "Sponsor limits (caps)", what: "How much Mana the sponsor may pay: per transaction, per player per day and week, for everyone per day, and the free players' pool (released by the hour). 1 Mana = 1 KOIN of Mana. Filled in with your settings of 28 Oct.", when: "If free Mana drains fast, lower the per-player or free-pool numbers.", signer: SPONSOR, effect: "chain", timing: AT_ONCE, tool: "sponsor", args: ["config", ...CAPS_ARGS], params: CAPS_PARAMS, sends: true },
  { id: "sponsor-report-save", area: "sponsor", kind: "settings", label: "Per-action limits, step 1: save the report's suggestions", what: "Writes the suggested per-action limits into sponsor-data/mana-limits.json on this PC. Nothing goes on chain.", when: "After a full day of real play (launch step 10).", signer: FILES, effect: "files", step: 1, tool: "sponsor", args: ["mana-report", "--save"], sends: false },
  { id: "sponsor-site-limits", area: "sponsor", kind: "settings", label: "Per-action limits, step 2: the website's copy", what: "Writes those limits into game-data and desk-data deployment.json on this PC. They reach the live site through a pull request to main (Claude opens it). Then run Sponsor limits again.", signer: FILES, effect: "files", step: 2, tool: "sponsor", args: ["site-limits"], sends: true },
  { id: "sponsor-payer", area: "sponsor", kind: "settings", label: "Who the website asks to pay Mana", what: "sponsor = the website asks the Mana sponsor to pay; self = players pay their own. Edits game-data and desk-data deployment.json on this PC; they reach the live site through a pull request to main.", signer: FILES, effect: "files", tool: "sponsor", args: ["payer", "{who}"], params: [{ name: "who", label: "Paid by", pattern: /^(sponsor|self)$/, hint: "sponsor or self", choices: ["sponsor", "self"] }], sends: true },
  { id: "sponsor-enable", area: "sponsor", kind: "settings", label: "Switch the sponsor on", what: "The sponsor starts paying, within its caps.", signer: SPONSOR, effect: "chain", timing: AT_ONCE, tool: "sponsor", args: ["enable"], sends: true },
  { id: "sponsor-disable", area: "sponsor", kind: "emergency", label: "Switch the sponsor off", what: "Stops the sponsor paying at once; players pay their own Mana. Always allowed, whatever the other checks say.", when: "If Mana drains in a way it shouldn't.", signer: SPONSOR, effect: "chain", timing: AT_ONCE, tool: "sponsor", args: ["disable"], sends: true },
  { id: "sponsor-upload", area: "sponsor", kind: "upgrade", label: "Upload sponsor code (v3 upgrade)", what: "Puts the sponsor contract built on this PC (sponsor/build/release) onto the sponsor wallet. Only the audited build is accepted.", when: "Launch step 4, after the fix-check. The v2 build is the rollback.", signer: SPONSOR, effect: "chain", timing: AT_ONCE, tool: "sponsor", args: ["upload"], sends: true },

  // ════════ Question game (game 1) ════════
  { id: "game-status-2", area: "question", kind: "check", label: "Game status", what: "Week, questions, players, pots and the bot's health.", signer: RO, effect: "none", tool: "bot", args: ["status"], sends: false },
  { id: "verify", area: "question", kind: "check", label: "Recount results with my node", what: "Recounts recent results from your own node on this PC and compares them with what was published.", when: "Run git pull first.", signer: RO, effect: "none", tool: "bot", args: ["verify-results", "--days", "{days}"], params: [{ name: "days", label: "Days back", ...INT, value: "7" }], sends: false },
  { id: "min-stake", area: "question", kind: "settings", label: "Minimum stake", what: "The fewest whole VHP a player can stake.", signer: OWNER, effect: "chain", timing: "From next week if that is at least 48 hours away, otherwise the week after", tool: "bot", args: ["min-stake", "{vhp}"], params: [{ name: "vhp", label: "VHP", ...WHOLE }], sends: true },
  { id: "sponsor", area: "question", kind: "settings", label: "Game's own Mana limit for staked answers", what: "The most KOIN of Mana the game contract itself pays for one staked player's answer (0 = players always pay their own). Separate from the Mana sponsor.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "bot", args: ["sponsor-limit", "{max}"], params: [{ name: "max", label: "KOIN of Mana", ...AMOUNT }], sends: true },
  { id: "void", area: "question", kind: "settings", label: "Void a question", what: "Cancels a question's result, so it counts for nobody. The reason is public.", when: "Only if a question was wrong or unfair. Allowed until the week's correction time ends.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "bot", args: ["void", "{id}", "{reason}"], params: [{ name: "id", label: "Question number (on chain)", ...INT }, { name: "reason", label: "Reason (public)", ...REASON }], sends: true },
  { id: "pause", area: "question", kind: "emergency", label: "Pause new deposits", what: "Stops NEW deposits only. Withdrawals, answers and claims keep working. Choose off to resume.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "bot", args: ["pause", "{state}"], params: [{ name: "state", label: "Pause", ...ONOFF }], sends: true },
  { id: "claim-fee", area: "question", kind: "money", label: "Collect the 5% producer fee", what: "Sends the accumulated producer fee (KOIN) to the owner wallet.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "bot", args: ["claim-fee"], sends: true },
  { id: "seed-vhp", area: "question", kind: "money", label: "Add seed VHP", what: "Moves VHP from the seed owner's wallet into the game's prize pool.", signer: "Seed owner (SEED_WIF, else OWNER_WIF)", effect: "chain", timing: AT_ONCE, tool: "bot", args: ["seed-vhp", "{amount}"], params: [{ name: "amount", label: "VHP", ...AMOUNT }], sends: true },
  { id: "seed-withdraw", area: "question", kind: "money", label: "Seed withdrawal, step 1: announce", what: "Announces taking seed VHP/KOIN back out. Players see it on the Trust page during a 48-hour wait.", signer: "Seed owner (SEED_WIF, else OWNER_WIF)", effect: "chain", timing: "Starts the 48-hour wait", step: 1, tool: "bot", args: ["seed-withdraw", "{vhp}", "{koin}"], params: [{ name: "vhp", label: "VHP", ...AMOUNT }, { name: "koin", label: "KOIN", ...AMOUNT }], sends: true },
  { id: "seed-execute", area: "question", kind: "money", label: "Seed withdrawal, step 2: carry it out", what: "Carries out the announced seed withdrawal.", when: "After the 48 hours, within 7 days.", signer: "Seed owner (SEED_WIF, else OWNER_WIF)", effect: "chain", timing: AT_ONCE, step: 2, tool: "bot", args: ["seed-withdraw", "execute"], sends: true },
  { id: "game-upgrade-status", area: "question", kind: "upgrade", label: "Upgrade status", what: "Is an upgrade announced, and does it match the code built on this PC?", signer: RO, effect: "none", tool: "bot", args: ["upgrade", "status"], sends: false },
  { id: "game-upgrade-schedule", area: "question", kind: "upgrade", label: "Upgrade, step 1: announce", what: "Announces the code built on this PC (game/build/release). Players get 48 hours' notice.", signer: OWNER, effect: "chain", timing: "Starts the 48-hour notice", step: 1, tool: "bot", args: ["upgrade", "schedule"], sends: true },
  { id: "game-upgrade-apply", area: "question", kind: "upgrade", label: "Upgrade, step 2: upload the announced code", what: "Uploads the announced code. The owner wallet signs and pays; the new fingerprint is written to deployment.json.", when: "After the 48 hours.", signer: OWNER, effect: "chain", timing: AT_ONCE, step: 2, tool: "bot", args: ["upgrade", "apply"], sends: true },
  { id: "game-upgrade-cancel", area: "question", kind: "upgrade", label: "Upgrade, step 3: clear the announcement", what: "Clears an announced upgrade: to cancel it, or as the last step after a successful upload.", signer: OWNER, effect: "chain", timing: AT_ONCE, step: 3, tool: "bot", args: ["admin", "cancel_upgrade", "--as", "owner"], sends: true },
  { id: "set-operator", area: "question", kind: "ownership", label: "Change the bot wallet (operator)", what: "Sets the wallet the hourly bot uses to post questions and results.", when: "Only on a Sunday after Saturday's windows end. Then update OPERATOR_WIF on GitHub and in .env.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "bot", args: ["admin", "set_operator", "operator={address}", "--as", "owner"], params: [{ name: "address", label: "New operator address", ...ADDRESS }], sends: true },
  { id: "propose-owner", area: "question", kind: "ownership", label: "Hand over the game, step 1: propose", what: "Proposes a new owner for the game. Any announced upgrade is cleared when they accept.", signer: OWNER, effect: "chain", timing: "The new owner can accept about a day later", step: 1, tool: "bot", args: ["admin", "propose_owner", "new_owner={address}", "--as", "owner"], params: [{ name: "address", label: "New owner address", ...ADDRESS }], sends: true },
  { id: "accept-owner", area: "question", kind: "ownership", label: "Hand over the game, step 2: accept", what: "The new owner accepts and takes over the game.", signer: NEWOWNER, effect: "chain", timing: AT_ONCE, step: 2, tool: "bot", args: ["admin", "accept_owner", "--as", "new"], sends: true },
  { id: "propose-seed", area: "question", kind: "ownership", label: "Hand over the seed, step 1: propose", what: "Proposes a new seed owner. A pending seed withdrawal is cancelled when they accept.", signer: "Seed owner (SEED_WIF, else OWNER_WIF)", effect: "chain", timing: "The new seed owner can accept about a day later", step: 1, tool: "bot", args: ["admin", "propose_seed_owner", "new_seed_owner={address}", "--as", "seed"], params: [{ name: "address", label: "New seed owner address", ...ADDRESS }], sends: true },
  { id: "accept-seed", area: "question", kind: "ownership", label: "Hand over the seed, step 2: accept", what: "The new seed owner accepts.", signer: NEWOWNER, effect: "chain", timing: AT_ONCE, step: 2, tool: "bot", args: ["admin", "accept_seed_owner", "--as", "new"], sends: true },

  // ════════ Who Signs Block X (game 2, Picks contract) ════════
  { id: "picks-status-2", area: "blockx", kind: "check", label: "Picks contract status", what: "Code fingerprint and the three safety switches, checked on two nodes; owner; games and anything announced.", signer: RO, effect: "none", tool: "picks", args: ["status", "--mainnet"], sends: false },
  { id: "picks-pause", area: "blockx", kind: "emergency", label: "Pause a game now", what: "Switches the game off at once. Picks already made stay recorded. Switching it back on needs a new announcement and 48 hours.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "picks", args: ["pause", "{game}", "--mainnet"], params: [{ name: "game", label: "Game id", ...GAMEID, value: "2" }], sends: true },
  { id: "picks-upload", area: "blockx", kind: "launch", label: "Launch, step 1: upload the Picks contract", what: "Puts the audited Picks contract onto the new Picks wallet (PICKS_WIF), once. Send that wallet no KOIN: the Mana is paid by PAYER_WIF (else OPERATOR_WIF).", when: "Launch step 5.", signer: "Picks wallet (PICKS_WIF) + payer (PAYER_WIF or OPERATOR_WIF)", effect: "chain", timing: AT_ONCE, step: 1, tool: "picks", args: ["upload", "--mainnet"], sends: true },
  { id: "picks-announce", area: "blockx", kind: "launch", label: "Launch, step 2: announce a game", what: "Announces a game on the Picks contract with its fixed rules. Players get 48 hours' notice.", when: "Game 2 = Who Signs Block X. Later games (Survivor 3, …) use the same step.", signer: OWNER, effect: "chain", timing: "Starts the 48-hour notice", step: 2, tool: "picks", args: ["announce", "{game}", "--mainnet"], params: [{ name: "game", label: "Game id", ...GAMEID, value: "2" }], sends: true },
  { id: "picks-apply", area: "blockx", kind: "launch", label: "Launch, step 3: switch the announced game on", what: "Puts the announced game in force; picks open.", when: "After the 48 hours.", signer: OWNER, effect: "chain", timing: AT_ONCE, step: 3, tool: "picks", args: ["apply", "{game}", "--mainnet"], params: [{ name: "game", label: "Game id", ...GAMEID, value: "2" }], sends: true },

  // ════════ Producer Race (game 7) ════════
  { id: "race-status-2", area: "race", kind: "check", label: "Race picks status", what: "The race contract's code, its settings and today's picks.", signer: RO, effect: "none", tool: "racepicks", args: ["status"], sends: false },
  { id: "race-limit", area: "race", kind: "settings", label: "Picks per wallet per day", what: "How many race picks one wallet may make a day.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "racepicks", args: ["limit", "{n}"], params: [{ name: "n", label: "Picks a day (1 to 20)", pattern: /^([1-9]|1\d|20)$/, hint: "1 to 20", value: "5" }], sends: true },
  { id: "race-enable", area: "race", kind: "settings", label: "Switch race picks on", what: "Players can make race picks again.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "racepicks", args: ["enable"], sends: true },
  { id: "race-disable", area: "race", kind: "emergency", label: "Switch race picks off", what: "Stops new race picks at once. Picks already made stay recorded.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "racepicks", args: ["disable"], sends: true },

  // ════════ Knode Swap (Desk) ════════
  { id: "desk-status-2", area: "desk", kind: "check", label: "Desk status", what: "KOIN available, VHP producing, swaps and settings.", signer: RO, effect: "none", tool: "desk", args: ["status"], sends: false },
  { id: "desk-key-status", area: "desk", kind: "check", label: "Node key on record", what: "Which block-producer key Proof-of-Burn has on record for the Desk.", signer: RO, effect: "none", tool: "desk", args: ["key-status"], sends: false },
  { id: "desk-fee", area: "desk", kind: "settings", label: "Swap fee", what: "The fee taken on each swap, in percent (0 to 10).", signer: OWNER, effect: "chain", timing: "Raising applies at once; lowering waits 48 hours (then Apply waiting settings)", tool: "desk", args: ["fee", "{percent}"], params: [{ name: "percent", label: "Fee %", ...PERCENT, value: "3" }], sends: true },
  { id: "desk-limits", area: "desk", kind: "settings", label: "Swap size limits", what: "The smallest and largest single swap, in VHP (largest 0 = no fixed cap).", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "desk", args: ["limits", "{min}", "{max}"], params: [{ name: "min", label: "Smallest swap (VHP)", ...AMOUNT }, { name: "max", label: "Largest swap (VHP, 0 = no cap)", ...AMOUNT }], sends: true },
  { id: "desk-cap", area: "desk", kind: "settings", label: "Daily payout cap", what: "The most KOIN swaps may pay out; room frees up at this much per 24 hours (0 = no cap). You chose no cap on 28 Oct.", signer: OWNER, effect: "chain", timing: "Lowering applies at once; raising or removing waits 48 hours", tool: "desk", args: ["daily-cap", "{koin}"], params: [{ name: "koin", label: "KOIN per 24 hours", ...AMOUNT, value: "0" }], sends: true },
  { id: "desk-settings-apply", area: "desk", kind: "settings", label: "Apply waiting settings", what: "Carries out a waiting fee cut, cap raise or node key.", when: "After their 48 hours.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "desk", args: ["settings", "apply"], sends: true },
  { id: "desk-settings-cancel", area: "desk", kind: "settings", label: "Cancel waiting settings", what: "Drops a waiting fee cut, cap raise or node key.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "desk", args: ["settings", "cancel"], sends: true },
  { id: "desk-key", area: "desk", kind: "settings", label: "Announce the node key", what: "The Desk node's PUBLIC key (or: node, to read it from the key file on this PC). Registered by Apply waiting settings after 48 hours.", signer: OWNER, effect: "chain", timing: NOTICE, tool: "desk", args: ["register-key", "{key}"], params: [{ name: "key", label: "Public key", ...KEY }], sends: true },
  { id: "desk-pause", area: "desk", kind: "emergency", label: "Pause swaps", what: "Stops swaps at once. Withdrawals to the treasury keep working. Choose off to resume.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "desk", args: ["pause", "{state}"], params: [{ name: "state", label: "Pause", ...ONOFF }], sends: true },
  { id: "desk-withdraw", area: "desk", kind: "money", label: "Withdraw to the treasury", what: "Takes KOIN or VHP out of the Desk. It can only ever go to the treasury address.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "desk", args: ["withdraw", "{token}", "{amount}"], params: [{ name: "token", label: "Token", pattern: /^(koin|vhp)$/, hint: "koin or vhp", choices: ["koin", "vhp"] }, { name: "amount", label: "Amount", ...AMOUNT }], sends: true },
  { id: "treasury-schedule", area: "desk", kind: "money", label: "Treasury address, step 1: announce", what: "Announces a new treasury address (your cold wallet).", signer: OWNER, effect: "chain", timing: "Starts the 48-hour wait", step: 1, tool: "desk", args: ["treasury", "schedule", "{address}"], params: [{ name: "address", label: "New treasury", ...ADDRESS }], sends: true },
  { id: "treasury-apply", area: "desk", kind: "money", label: "Treasury address, step 2: apply", what: "Makes the announced treasury address the real one.", when: "After the 48 hours.", signer: OWNER, effect: "chain", timing: AT_ONCE, step: 2, tool: "desk", args: ["treasury", "apply"], sends: true },
  { id: "treasury-cancel", area: "desk", kind: "money", label: "Treasury address: cancel", what: "Drops an announced treasury change.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "desk", args: ["treasury", "cancel"], sends: true },
  { id: "desk-upgrade-status", area: "desk", kind: "upgrade", label: "Upgrade status", what: "Is a Desk upgrade announced, and does it match the code built on this PC?", signer: RO, effect: "none", tool: "desk", args: ["upgrade", "status"], sends: false },
  { id: "desk-upgrade-schedule", area: "desk", kind: "upgrade", label: "Upgrade, step 1: announce", what: "Announces the Desk code built on this PC. 48 hours' notice.", signer: OWNER, effect: "chain", timing: "Starts the 48-hour notice", step: 1, tool: "desk", args: ["upgrade", "schedule"], sends: true },
  { id: "desk-upgrade-apply", area: "desk", kind: "upgrade", label: "Upgrade, step 2: upload the announced code", what: "Uploads the announced Desk code; the owner signs and pays.", when: "After the 48 hours.", signer: OWNER, effect: "chain", timing: AT_ONCE, step: 2, tool: "desk", args: ["upgrade", "apply"], sends: true },
  { id: "desk-upgrade-cancel", area: "desk", kind: "upgrade", label: "Upgrade, step 3: clear the announcement", what: "Clears the announcement: to cancel it, or as the last step after a successful upload.", signer: OWNER, effect: "chain", timing: AT_ONCE, step: 3, tool: "desk", args: ["upgrade", "cancel"], sends: true },
  { id: "desk-owner-propose", area: "desk", kind: "ownership", label: "Hand over the Desk, step 1: propose", what: "Proposes a new Desk owner.", signer: OWNER, effect: "chain", timing: "The new owner can accept after 48 hours", step: 1, tool: "desk", args: ["owner", "propose", "{address}"], params: [{ name: "address", label: "New owner address", ...ADDRESS }], sends: true },
  { id: "desk-owner-accept", area: "desk", kind: "ownership", label: "Hand over the Desk, step 2: accept", what: "The new owner accepts and takes over the Desk.", signer: NEWOWNER, effect: "chain", timing: AT_ONCE, step: 2, tool: "desk", args: ["owner", "accept"], sends: true },
  { id: "desk-owner-cancel", area: "desk", kind: "ownership", label: "Hand over the Desk: cancel", what: "Drops a proposed owner change.", signer: OWNER, effect: "chain", timing: AT_ONCE, tool: "desk", args: ["owner", "cancel"], sends: true },

  // ════════ Testnet: sponsor v3 trial (docs/blockx/SPONSOR-TESTNET.md) ════════
  { id: "t-sponsor-status", area: "t-sponsor", kind: "check", label: "Testnet sponsor status", what: "On or off, caps, test KOIN and Mana, today's use.", signer: RO, effect: "none", tool: "sponsor", args: ["status", "--testnet"], sends: false },
  { id: "t-picks-status", area: "t-sponsor", kind: "check", label: "Testnet Picks status", what: "The testnet Picks contract and its games.", signer: RO, effect: "none", tool: "picks", args: ["status", "--testnet"], sends: false },
  { id: "t-sponsor-watch", area: "t-sponsor", kind: "check", label: "Testnet usage alerts (80%)", what: "The 80% warnings, on the testnet sponsor.", signer: RO, effect: "none", tool: "sponsor", args: ["watch", "--testnet"], sends: false },
  { id: "t-sponsor-keys", area: "t-sponsor", kind: "launch", label: "Trial, step 1: new testnet sponsor wallet", what: "Adds SPONSOR_WIF to .env.testnet (once; never shown) and shows its address.", when: "Then send /faucet <address> to @KoinosTestnetFaucetBot in Telegram, a few times: the upload needs about 17 test KOIN.", signer: FILES, effect: "files", step: 1, tool: "sponsor", args: ["keys", "--testnet"], sends: false },
  { id: "t-sponsor-upload", area: "t-sponsor", kind: "launch", label: "Trial, step 2: upload sponsor v3", what: "Uploads the v3 build from sponsor/build/release (built in C:\\knode-build) to the testnet sponsor wallet, and writes its address into testnet/blockx.json so the testnet page asks it to pay.", signer: TSPONSOR, effect: "chain", timing: AT_ONCE, step: 2, tool: "sponsor", args: ["upload", "--testnet"], sends: true },
  { id: "t-sponsor-caps", area: "t-sponsor", kind: "launch", label: "Trial, step 3: testnet sponsor limits", what: "The same caps as mainnet, on the testnet sponsor.", signer: TSPONSOR, effect: "chain", timing: AT_ONCE, step: 3, tool: "sponsor", args: ["config", "--testnet", ...CAPS_ARGS], params: CAPS_PARAMS, sends: true },
  { id: "t-sponsor-enable", area: "t-sponsor", kind: "launch", label: "Trial, step 4: switch the testnet sponsor on", what: "It starts paying for testnet picks within its caps. Then play from a private window: npm run testnet-site -- --record.", signer: TSPONSOR, effect: "chain", timing: AT_ONCE, step: 4, tool: "sponsor", args: ["enable", "--testnet"], sends: true },
  { id: "t-sponsor-report", area: "t-sponsor", kind: "launch", label: "Trial, step 5: what sponsored picks really used", what: "After some picks on the testnet page: each action's real Mana, read from the chain. Send Claude the output.", signer: RO, effect: "none", step: 5, tool: "sponsor", args: ["mana-report", "--testnet", "--blocks", "{blocks}"], params: [{ name: "blocks", label: "Blocks back (28,800 = a day)", ...INT, value: "28800" }], sends: false },
  { id: "t-sponsor-disable", area: "t-sponsor", kind: "emergency", label: "Switch the testnet sponsor off", what: "Players pay their own test Mana again. Also the way to end the trial.", signer: TSPONSOR, effect: "chain", timing: AT_ONCE, tool: "sponsor", args: ["disable", "--testnet"], sends: true },
];

/** The command line for an action, or the reason it can't run. Values must match their pattern exactly. */
export function commandFor(a: Action, values: Record<string, string>): { argv: string[] } | { error: string } {
  const v: Record<string, string> = {};
  for (const p of a.params ?? []) {
    const x = String(values?.[p.name] ?? "").trim();
    if (!p.pattern.test(x)) return { error: `${p.label}: ${p.hint}` };
    v[p.name] = x;
  }
  const argv: string[] = [];
  for (const t of a.args) {
    const filled = t.replace(/\{(\w+)\}/g, (_m, n) => v[n] ?? "");
    if (filled === "" && /^\{\w+\}$/.test(t)) continue;             // an optional, empty value (e.g. no reason)
    argv.push(...(a.id === "void" && t === "{reason}" ? filled.split(" ").filter(Boolean) : [filled]));
  }
  return { argv };
}
