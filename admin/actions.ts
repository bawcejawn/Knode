/**
 * Everything the admin page can do. Each action runs one of the existing, tested commands (npm run bot / desk / sponsor)
 * with checked arguments: the page adds no new way to sign anything. Actions that send a transaction always run as a
 * dry run first; the page can send only the exact same action and values that were just previewed.
 */
export type Param = { name: string; label: string; pattern: RegExp; hint: string; choices?: string[]; value?: string };
export type Action = {
  id: string; group: string; label: string; help: string;
  tool: "bot" | "desk" | "sponsor" | "picks";
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
// No word may start with "-", so a reason can never pass an option such as --send to the command.
const REASON: Omit<Param, "name" | "label"> = { pattern: /^(?!(.*\s)?-)[A-Za-z0-9 .,'()\-]{0,120}$/, hint: "letters, numbers and basic punctuation (no word starting with -)" };

export const ACTIONS: Action[] = [
  // ── checks (read-only) ──
  { id: "game-status", group: "Checks", label: "Game status", help: "The game right now: week, questions, players, pots, the bot's health.", tool: "bot", args: ["status"], sends: false },
  { id: "desk-status", group: "Checks", label: "Desk status", help: "The Desk right now: KOIN available, VHP producing, swaps, settings.", tool: "desk", args: ["status"], sends: false },
  { id: "chain-check", group: "Checks", label: "Chain check", help: "Both contracts' code fingerprints and safety switches, owners and anything announced, read from the chain.", tool: "bot", args: ["chain-check"], sends: false },
  { id: "verify", group: "Checks", label: "Verify results with my node", help: "Recount recent results from your own node on this computer. Run `git pull` first.", tool: "bot", args: ["verify-results", "--days", "{days}"], params: [{ name: "days", label: "Days back", ...INT }], sends: false },
  { id: "game-upgrade-status", group: "Checks", label: "Game upgrade status", help: "Is an upgrade announced, and does it match the code built on this PC?", tool: "bot", args: ["upgrade", "status"], sends: false },
  { id: "desk-upgrade-status", group: "Checks", label: "Desk upgrade status", help: "Same, for the Desk.", tool: "desk", args: ["upgrade", "status"], sends: false },
  { id: "desk-key-status", group: "Checks", label: "Desk node key status", help: "Which producer key Proof-of-Burn has on record for the Desk.", tool: "desk", args: ["key-status"], sends: false },

  // ── game ──
  { id: "pause", group: "Game", label: "Pause new deposits", help: "Stops NEW deposits only. Withdrawals, answers and claims keep working.", tool: "bot", args: ["pause", "{state}"], params: [{ name: "state", label: "Pause", ...ONOFF }], sends: true },
  { id: "void", group: "Game", label: "Void a question", help: "Cancel a question's result (it counts for nobody). Allowed until the week's correction time ends.", tool: "bot", args: ["void", "{id}", "{reason}"], params: [{ name: "id", label: "Question # (on-chain number)", ...INT }, { name: "reason", label: "Reason (public)", ...REASON }], sends: true },
  { id: "min-stake", group: "Game", label: "Minimum stake", help: "Whole VHP. Applies from next week if at least 48 hours away, otherwise from the week after.", tool: "bot", args: ["min-stake", "{vhp}"], params: [{ name: "vhp", label: "VHP", ...WHOLE }], sends: true },
  { id: "sponsor", group: "Game", label: "Free-Mana limit", help: "Most KOIN of Mana the game pays for one player transaction (0 = players always pay their own).", tool: "bot", args: ["sponsor-limit", "{max}"], params: [{ name: "max", label: "KOIN", ...AMOUNT }], sends: true },
  { id: "claim-fee", group: "Game", label: "Claim the producer fee", help: "Sends the accumulated 5% producer fee (KOIN) to the owner wallet.", tool: "bot", args: ["claim-fee"], sends: true },
  { id: "set-operator", group: "Game", label: "Change the bot wallet (operator)", help: "Only on a Sunday after Saturday's windows end. Then update OPERATOR_WIF on GitHub and in .env.", tool: "bot", args: ["admin", "set_operator", "operator={address}", "--as", "owner"], params: [{ name: "address", label: "New operator address", ...ADDRESS }], sends: true },
  { id: "propose-owner", group: "Game", label: "Hand over the game: propose", help: "Step 1. The new owner accepts about a day later. Any announced upgrade is cleared when they do.", tool: "bot", args: ["admin", "propose_owner", "new_owner={address}", "--as", "owner"], params: [{ name: "address", label: "New owner address", ...ADDRESS }], sends: true },
  { id: "accept-owner", group: "Game", label: "Hand over the game: accept", help: "Step 2, signed by the NEW owner: put its key in .env as NEW_OWNER_WIF for this step only.", tool: "bot", args: ["admin", "accept_owner", "--as", "new"], sends: true },
  { id: "propose-seed", group: "Game", label: "Hand over the seed: propose", help: "Step 1, signed by the seed owner. A pending seed withdrawal is cancelled when the new seed owner accepts.", tool: "bot", args: ["admin", "propose_seed_owner", "new_seed_owner={address}", "--as", "seed"], params: [{ name: "address", label: "New seed owner address", ...ADDRESS }], sends: true },
  { id: "accept-seed", group: "Game", label: "Hand over the seed: accept", help: "Step 2, about a day later, signed by the NEW seed owner (NEW_OWNER_WIF in .env for this step).", tool: "bot", args: ["admin", "accept_seed_owner", "--as", "new"], sends: true },
  { id: "seed-vhp", group: "Game", label: "Add seed VHP", help: "From the seed owner's wallet into the game's pool.", tool: "bot", args: ["seed-vhp", "{amount}"], params: [{ name: "amount", label: "VHP", ...AMOUNT }], sends: true },
  { id: "seed-withdraw", group: "Game", label: "Announce a seed withdrawal", help: "Starts the 48-hour wait; players see it on the Trust page.", tool: "bot", args: ["seed-withdraw", "{vhp}", "{koin}"], params: [{ name: "vhp", label: "VHP", ...AMOUNT }, { name: "koin", label: "KOIN", ...AMOUNT }], sends: true },
  { id: "seed-execute", group: "Game", label: "Carry out the seed withdrawal", help: "After the 48 hours (within 7 days).", tool: "bot", args: ["seed-withdraw", "execute"], sends: true },

  // ── game upgrades ──
  { id: "game-upgrade-schedule", group: "Game upgrade", label: "Announce the upgrade", help: "Announces the code built on this PC (game/build/release). Players get 48 hours' notice.", tool: "bot", args: ["upgrade", "schedule"], sends: true },
  { id: "game-upgrade-apply", group: "Game upgrade", label: "Upload the announced code", help: "After the 48 hours. The owner wallet signs and pays; the chain's new fingerprint is written to deployment.json.", tool: "bot", args: ["upgrade", "apply"], sends: true },
  { id: "game-upgrade-cancel", group: "Game upgrade", label: "Cancel the announcement", help: "Clears an announced upgrade (also run this after a successful upload).", tool: "bot", args: ["admin", "cancel_upgrade", "--as", "owner"], sends: true },

  // ── desk ──
  { id: "desk-pause", group: "Desk", label: "Pause swaps", help: "Stops swaps. Withdrawals to the treasury keep working.", tool: "desk", args: ["pause", "{state}"], params: [{ name: "state", label: "Pause", ...ONOFF }], sends: true },
  { id: "desk-fee", group: "Desk", label: "Fee", help: "Percent, 0 to 10. Raising it applies at once; lowering it waits 48 hours (then: Apply waiting settings).", tool: "desk", args: ["fee", "{percent}"], params: [{ name: "percent", label: "Fee %", ...PERCENT }], sends: true },
  { id: "desk-limits", group: "Desk", label: "Swap size limits", help: "Smallest and largest single swap in VHP (largest 0 = no fixed cap).", tool: "desk", args: ["limits", "{min}", "{max}"], params: [{ name: "min", label: "Smallest VHP", ...AMOUNT }, { name: "max", label: "Largest VHP", ...AMOUNT }], sends: true },
  { id: "desk-cap", group: "Desk", label: "Daily payout cap", help: "Most KOIN swaps may pay out at once; room frees up at this much per 24 hours (0 = no cap). Lowering applies now; raising or removing waits 48 hours.", tool: "desk", args: ["daily-cap", "{koin}"], params: [{ name: "koin", label: "KOIN per 24 h", ...AMOUNT }], sends: true },
  { id: "desk-settings-apply", group: "Desk", label: "Apply waiting settings", help: "After 48 hours: carries out a waiting fee cut, cap raise or node key.", tool: "desk", args: ["settings", "apply"], sends: true },
  { id: "desk-settings-cancel", group: "Desk", label: "Cancel waiting settings", help: "Drops a waiting fee cut, cap raise or node key.", tool: "desk", args: ["settings", "cancel"], sends: true },
  { id: "desk-withdraw", group: "Desk", label: "Withdraw to the treasury", help: "KOIN or VHP from the Desk. It can only ever go to the treasury address.", tool: "desk", args: ["withdraw", "{token}", "{amount}"], params: [{ name: "token", label: "Token", pattern: /^(koin|vhp)$/, hint: "koin or vhp", choices: ["koin", "vhp"] }, { name: "amount", label: "Amount", ...AMOUNT }], sends: true },
  { id: "desk-key", group: "Desk", label: "Announce the node key", help: "The Desk node's PUBLIC key (or: node, to read it from the key file on this PC). Registered by Apply waiting settings after 48 hours.", tool: "desk", args: ["register-key", "{key}"], params: [{ name: "key", label: "Public key", ...KEY }], sends: true },
  { id: "treasury-schedule", group: "Desk", label: "Treasury: announce a new address", help: "Your cold wallet's address. Takes effect with “Treasury: apply” after 48 hours.", tool: "desk", args: ["treasury", "schedule", "{address}"], params: [{ name: "address", label: "New treasury", ...ADDRESS }], sends: true },
  { id: "treasury-apply", group: "Desk", label: "Treasury: apply", help: "After the 48 hours.", tool: "desk", args: ["treasury", "apply"], sends: true },
  { id: "treasury-cancel", group: "Desk", label: "Treasury: cancel", help: "Drops an announced treasury change.", tool: "desk", args: ["treasury", "cancel"], sends: true },
  { id: "desk-owner-propose", group: "Desk", label: "Hand over the Desk: propose", help: "Step 1 (Desk v2). The new owner can accept after 48 hours.", tool: "desk", args: ["owner", "propose", "{address}"], params: [{ name: "address", label: "New owner address", ...ADDRESS }], sends: true },
  { id: "desk-owner-accept", group: "Desk", label: "Hand over the Desk: accept", help: "Step 2, signed by the NEW owner (NEW_OWNER_WIF in .env for this step only).", tool: "desk", args: ["owner", "accept"], sends: true },
  { id: "desk-owner-cancel", group: "Desk", label: "Hand over the Desk: cancel", help: "Drops a proposed owner change.", tool: "desk", args: ["owner", "cancel"], sends: true },

  // ── desk upgrades ──
  { id: "desk-upgrade-schedule", group: "Desk upgrade", label: "Announce the Desk upgrade", help: "Announces the Desk code built on this PC. 48 hours' notice.", tool: "desk", args: ["upgrade", "schedule"], sends: true },
  { id: "desk-upgrade-apply", group: "Desk upgrade", label: "Upload the announced Desk code", help: "After the 48 hours; the owner signs and pays.", tool: "desk", args: ["upgrade", "apply"], sends: true },
  // ── Mana sponsor (sponsor/README.md) ──
  { id: "sponsor-status", group: "Mana sponsor", label: "Sponsor status", help: "On or off, the caps, its KOIN and Mana, today's use, and who the website asks to pay.", tool: "sponsor", args: ["status"], sends: false },
  { id: "sponsor-payer", group: "Mana sponsor", label: "Mana paid by", help: "Who the website asks to pay players' Mana: the sponsor, or players themselves (self). Staked players' answers stay with the game. Edits game-data and desk-data deployment.json on this PC; they reach the live site through a pull request to main (Claude can open it).", tool: "sponsor", args: ["payer", "{who}"], params: [{ name: "who", label: "Paid by", pattern: /^(sponsor|self)$/, hint: "sponsor or self", choices: ["sponsor", "self"] }], sends: true },
  { id: "sponsor-enable", group: "Mana sponsor", label: "Switch the sponsor on", help: "The sponsor pays within its caps. Signed and paid by the sponsor wallet (SPONSOR_WIF).", tool: "sponsor", args: ["enable"], sends: true },
  { id: "sponsor-disable", group: "Mana sponsor", label: "Switch the sponsor off", help: "Instantly stops it paying; players pay their own Mana. Signed by the sponsor wallet.", tool: "sponsor", args: ["disable"], sends: true },
  { id: "sponsor-caps", group: "Mana sponsor", label: "Sponsor limits", help: "In Mana (1 = 1 KOIN of Mana). Filled in with the owner's settings (2026-10-28): 1 per transaction, 50 per player per day, 300 per week, 5,000 for everyone per day, of which free players share 2,000 (released by the hour), and a real player has at least 1 VHP staked in a Knode game. The preview shows old → new for each; it also checks the website as deployed on knodegames.com.", tool: "sponsor", args: ["config", "--per-tx", "{tx}", "--per-player-day", "{day}", "--per-player-week", "{week}", "--per-day", "{all}", "--free-per-day", "{free}", "--min-vhp", "{minvhp}"], params: [{ name: "tx", label: "Per transaction", ...AMOUNT, value: "1" }, { name: "day", label: "Per player per day", ...AMOUNT, value: "50" }, { name: "week", label: "Per player per week", ...AMOUNT, value: "300" }, { name: "all", label: "Everyone per day (at most 5,000)", ...AMOUNT, value: "5000" }, { name: "free", label: "Free players, everyone per day", ...AMOUNT, value: "2000" }, { name: "minvhp", label: "Real player: VHP staked in a Knode game", ...AMOUNT, value: "1" }], sends: true },
  { id: "sponsor-watch", group: "Mana sponsor", label: "Usage alerts", help: "Warns when free play (as released so far today) or everyone's total is past 80% of today's caps. The hourly bot runs the same check.", tool: "sponsor", args: ["watch"], sends: false },
  { id: "sponsor-report", group: "Mana sponsor", label: "Mana report (what each action used)", help: "Reads the last day of sponsored transactions on two nodes and suggests a limit per action (2 × the most used; only with 20+ measurements). Nothing is saved.", tool: "sponsor", args: ["mana-report"], sends: false },
  { id: "sponsor-report-save", group: "Mana sponsor", label: "Mana report: save the suggested limits", help: "Writes sponsor-data/mana-limits.json on this PC (nothing on chain). Then: Website limits, a pull request to main, and Sponsor limits.", tool: "sponsor", args: ["mana-report", "--save"], sends: false },
  { id: "sponsor-site-limits", group: "Mana sponsor", label: "Website limits (step 1 of a limits change)", help: "Writes the per-action limits into game-data and desk-data deployment.json on this PC, safe for the old and the new chain limits. They reach the site through a pull request to main.", tool: "sponsor", args: ["site-limits"], sends: true },

  // ── Who Signs Block X (the Picks contract), mainnet ──
  { id: "picks-status", group: "Block X", label: "Picks contract status", help: "Code fingerprint and the three safety switches, checked on two nodes; owner; games and anything announced.", tool: "picks", args: ["status", "--mainnet"], sends: false },
  { id: "picks-upload", group: "Block X", label: "Upload the Picks contract", help: "Once, onto the new Picks wallet (PICKS_WIF). Send that wallet no KOIN: the Mana is paid by PAYER_WIF (else OPERATOR_WIF). Only the audited build.", tool: "picks", args: ["upload", "--mainnet"], sends: true },
  { id: "picks-announce", group: "Block X", label: "Announce a game", help: "Game 2 = Who Signs Block X. Players get 48 hours' notice; then Apply.", tool: "picks", args: ["announce", "{game}", "--mainnet"], params: [{ name: "game", label: "Game", pattern: /^[1-9]\d{0,2}$/, hint: "the game id (2 = Block X)", value: "2" }], sends: true },
  { id: "picks-apply", group: "Block X", label: "Apply an announced game", help: "After the 48 hours.", tool: "picks", args: ["apply", "{game}", "--mainnet"], params: [{ name: "game", label: "Game", pattern: /^[1-9]\d{0,2}$/, hint: "the game id", value: "2" }], sends: true },
  { id: "picks-pause", group: "Block X", label: "Pause a game now", help: "Switches the game off at once (picks already made stay recorded). Switching it back on needs a new announcement and 48 hours.", tool: "picks", args: ["pause", "{game}", "--mainnet"], params: [{ name: "game", label: "Game", pattern: /^[1-9]\d{0,2}$/, hint: "the game id", value: "2" }], sends: true },

  // ── the sponsor v3 trial on the Koinos Foundation testnet (docs/blockx/SPONSOR-TESTNET.md) ──
  { id: "t-sponsor-keys", group: "Testnet trial", label: "1. New testnet sponsor wallet", help: "Adds SPONSOR_WIF to .env.testnet (once) and shows its address. Then get it test KOIN from the faucet bot, a few times.", tool: "sponsor", args: ["keys", "--testnet"], sends: false },
  { id: "t-sponsor-status", group: "Testnet trial", label: "Testnet sponsor status", help: "On or off, caps, test KOIN and Mana, today's use.", tool: "sponsor", args: ["status", "--testnet"], sends: false },
  { id: "t-sponsor-upload", group: "Testnet trial", label: "2. Upload sponsor v3 to the testnet", help: "The v3 candidate build from sponsor/build/release. Writes its address into testnet/blockx.json so the testnet page asks it to pay.", tool: "sponsor", args: ["upload", "--testnet"], sends: true },
  { id: "t-sponsor-caps", group: "Testnet trial", label: "3. Testnet sponsor limits", help: "The same caps as mainnet. The testnet page's picks are free play.", tool: "sponsor", args: ["config", "--testnet", "--per-tx", "{tx}", "--per-player-day", "{day}", "--per-player-week", "{week}", "--per-day", "{all}", "--free-per-day", "{free}", "--min-vhp", "{minvhp}"], params: [{ name: "tx", label: "Per transaction", ...AMOUNT, value: "1" }, { name: "day", label: "Per player per day", ...AMOUNT, value: "50" }, { name: "week", label: "Per player per week", ...AMOUNT, value: "300" }, { name: "all", label: "Everyone per day", ...AMOUNT, value: "5000" }, { name: "free", label: "Free players per day", ...AMOUNT, value: "2000" }, { name: "minvhp", label: "Real player: VHP staked", ...AMOUNT, value: "1" }], sends: true },
  { id: "t-sponsor-enable", group: "Testnet trial", label: "4. Switch the testnet sponsor on", help: "It starts paying within its caps.", tool: "sponsor", args: ["enable", "--testnet"], sends: true },
  { id: "t-sponsor-disable", group: "Testnet trial", label: "Switch the testnet sponsor off", help: "Players pay their own test Mana again.", tool: "sponsor", args: ["disable", "--testnet"], sends: true },
  { id: "t-sponsor-report", group: "Testnet trial", label: "5. What sponsored picks really used", help: "After some picks on the testnet page: each action's real Mana, from the chain.", tool: "sponsor", args: ["mana-report", "--testnet", "--blocks", "{blocks}"], params: [{ name: "blocks", label: "Blocks back (28,800 = a day)", ...INT, value: "28800" }], sends: false },
  { id: "t-sponsor-watch", group: "Testnet trial", label: "Testnet usage alerts", help: "The 80% warnings, on the testnet sponsor.", tool: "sponsor", args: ["watch", "--testnet"], sends: false },
  { id: "t-picks-status", group: "Testnet trial", label: "Testnet Picks status", help: "The testnet Picks contract and its games.", tool: "picks", args: ["status", "--testnet"], sends: false },
  { id: "sponsor-upload", group: "Mana sponsor", label: "Upload the sponsor contract", help: "Once, onto the new sponsor wallet (SPONSOR_WIF), after sending it KOIN. Uses sponsor/build/release built on this PC.", tool: "sponsor", args: ["upload"], sends: true },

  { id: "desk-upgrade-cancel", group: "Desk upgrade", label: "Cancel the Desk announcement", help: "Also run this after a successful upload.", tool: "desk", args: ["upgrade", "cancel"], sends: true },
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
