/**
 * Knode Games names: players and producers name their wallet; names.json (on the names-data branch) also carries the
 * wallets' on-chain Koinos nicknames (the Nicknames contract), shown with an @ when a wallet has no Knode Games name.
 * The rules are names.js (KNames.rules), the same code the claim page runs. See docs/NAMES.md.
 *
 * Who may take a name: a block producer (on a Producer Race card, or a signer in the recent-blocks snapshot, in the
 * last 30 days), or a wallet with at least 1 VHP in it or staked in Knode Games (read from the chain).
 *
 * Owner (on your PC, in the repo folder). Every command that changes names.json is a dry run unless you add --send;
 * with --send it pushes the new names.json to the names-data branch with your own git login (nothing else changes):
 *   npm run names -- list                                 every name and nickname, and the hidden addresses
 *   npm run names -- check "<claim>"                      check a claim without changing anything
 *   npm run names -- add "<claim>" [--send]               add a claim someone sent you (no GitHub needed for them)
 *   npm run names -- hide <address> "<reason>" [--send]   hide that address's name and nickname
 *   npm run names -- unhide <address> [--send]            show them again
 *   npm run names -- remove <address> [--send]            delete that address's name for good (it may claim again)
 *   npm run names -- nicknames [--send]                   refresh the on-chain nicknames now (the workflow does it hourly)
 * A claim is the two lines the claim page makes:
 *   Knode Games name: <name> | <address> | <YYYY-MM-DD>
 *   Signature: <…>
 *
 * Workflow (.github/workflows/names.yml, job "check", read-only token, no secrets):
 *   npm run names -- run
 *   Env: ISSUES_FILE (open claim issues as [{ number, body }]: data only, never run; may be absent), NAMES_REFRESH
 *   ("true" = refresh the nicknames too), NAMES_PREV (current names.json), NAMES_BASE_FILE (its names-data commit),
 *   PRODUCERS_DIR (race-data W*.json + board.json, recent-blocks.json), RPC, RPC_CHECK, NAMES_OUT (gets names.json
 *   only if it changed), NAMES_RESULT (results.json).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Contract, Provider, Signer, utils } from "koilib";
await import("../names.js");
const K: any = (globalThis as any).KNames;
const R = K.rules;
const LIB = { Signer, utils };
const DAY = 86400000;
const UNIT = 100000000n;
const ADDR = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const NICKNAMES = "1KD9Es7LBBjA1FY3ViCgQJ7e6WH1ipKbhz";   // the Koinos Nicknames contract (koilib's own docs)
const VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq";
const GAME = "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr";       // the Knode Games game contract (the vault from v6)
const log = (...a: unknown[]) => console.log(...a);
/** Text from a node or a claim, made safe for the Actions log: no "::" workflow commands (audit PN-28). */
const plain = (t: unknown) => String(t ?? "").replace(/::/g, ": :").replace(/[\r\n]+/g, " ").slice(0, 300);
const CALL_MS = 8000;                  // one chain read; a node that hangs falls through to the other (audit PN-3)
/** Rejects after `ms` if the promise hasn't settled. */
export function within<T>(p: Promise<T>, ms = CALL_MS): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, no) => { t = setTimeout(() => no(new Error(`no answer in ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t));
}
/** names.json may not pass this (the publish job refuses 1 MB; new claims stop below it, audit PN-2). */
export const MAX_BYTES = 900_000;

// ═══════════════ evidence from the published files ═══════════════
/** Producers seen in the last 30 days: every address on a race card taken in that time (field and paddock), and every
 *  signer in the recent-blocks snapshot. `files` maps a file name to its text. Anything that doesn't parse is skipped. */
export function producersFrom(files: Record<string, string>, now: number): Set<string> {
  const out = new Set<string>();
  const add = (a: unknown) => { if (typeof a === "string" && ADDR.test(a)) out.add(a); };
  for (const [f, text] of Object.entries(files)) {
    let j: any;
    try { j = JSON.parse(text); } catch { continue; }
    if (/^W\d{3}\.json$/.test(f) && Array.isArray(j?.races)) {
      for (const r of j.races) for (const c of Array.isArray(r?.cards) ? r.cards : []) {
        if (!c || typeof c.at !== "number" || c.at < now - 30 * DAY || c.at > now + DAY) continue;
        for (const x of [...(Array.isArray(c.field) ? c.field : []), ...(Array.isArray(c.paddock) ? c.paddock : [])]) add(x?.a);
      }
    } else if (f === "recent-blocks.json" && Array.isArray(j?.signers)) {
      for (const a of j.signers) add(a);
    }
  }
  return out;
}
/** Players on the published leaderboards (race-data board.json): their nicknames are looked up too. */
export function boardPlayers(files: Record<string, string>): Set<string> {
  const out = new Set<string>();
  try {
    const j = JSON.parse(files["board.json"] || "null");
    for (const k of ["today", "week", "lastWeek", "allTime"]) for (const r of (j && j[k] && Array.isArray(j[k].rows) ? j[k].rows : [])) if (typeof r?.a === "string" && ADDR.test(r.a)) out.add(r.a);
  } catch { /* none */ }
  return out;
}

function readDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!dir || !fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) if (/^(W\d{3}|recent-blocks|board)\.json$/.test(f)) out[f] = fs.readFileSync(path.join(dir, f), "utf8");
  return out;
}
const readJson = (file: string) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// ═══════════════ the chain (read-only) ═══════════════
const addr = (id: number) => ({ type: "bytes", id, options: { "(koinos.btype)": "ADDRESS" } });
const u64 = (id: number) => ({ type: "uint64", id, options: { jstype: "JS_STRING" } });
const READ_ABI = {
  methods: {
    balance_of: { entry_point: 0x5c721497, argument: "r.balance_of_arguments", return: "r.balance_of_result", read_only: true },
    get_player: { entry_point: 0x37ce3085, argument: "r.get_player_arguments", return: "r.get_player_result", read_only: true },
    list_players: { entry_point: 0x44d79744, argument: "r.list_players_arguments", return: "r.list_players_result", read_only: true },
  },
  koilib_types: { nested: { r: { nested: {
    balance_of_arguments: { fields: { owner: addr(1) } },
    balance_of_result: { fields: { value: u64(1) } },
    player_object: { fields: { stake: u64(1), pending: u64(2), stake_other: u64(6) } },   // stake_other: v6 (0 before)
    get_player_arguments: { fields: { player: addr(1), week: u64(2) } },
    get_player_result: { fields: { player: { type: "player_object", id: 1 } } },
    player_row: { fields: { address: addr(1) } },
    list_players_arguments: { fields: { start: addr(1), limit: { type: "uint32", id: 2 }, week: u64(3) } },
    list_players_result: { fields: { rows: { rule: "repeated", type: "player_row", id: 1 } } },
  } } } },
};
export type Chain = {
  vhp(a: string): Promise<bigint>;
  stake(a: string): Promise<bigint>;
  players(): Promise<string[]>;
  nickname(a: string): Promise<string | null>;
  /** The wallet a nickname belongs to (null: nobody). Optional: fakes in the tests may leave it out. */
  nicknameOwner?(n: string): Promise<string | null>;
};
/** One node, read-only. */
export function chainAt(rpc: string): Chain {
  const provider = new Provider([rpc]);
  const vhp = new Contract({ id: VHP, provider, abi: READ_ABI as any }).functions;
  const game = new Contract({ id: GAME, provider, abi: READ_ABI as any }).functions;
  const nick = new Contract({ id: NICKNAMES, provider, abi: utils.nicknamesAbi }).functions;
  return {
    async vhp(a) { return BigInt((await within(vhp.balance_of({ owner: a }))).result?.value || 0); },
    async stake(a) {
      const p: any = (await within(game.get_player({ player: a, week: "0" }))).result?.player || {};
      return BigInt(p.stake || 0) + BigInt(p.pending || 0) + BigInt(p.stake_other || 0);
    },
    async players() {
      const out: string[] = [];
      let start: string | undefined;
      for (let page = 0; page < 40; page++) {
        const rows: any[] = (await within(game.list_players({ ...(start ? { start } : {}), limit: 50, week: "0" }))).result?.rows || [];
        for (const r of rows) if (typeof r.address === "string") out.push(r.address);
        if (rows.length < 50) break;
        start = rows[rows.length - 1].address;
      }
      return out;
    },
    async nickname(a) {
      const t: any = (await within(nick.get_main_token({ value: a }))).result;
      if (!t || !t.token_id) return null;
      const n = new TextDecoder().decode(utils.toUint8Array(String(t.token_id).replace(/^0x/, "")));
      return R.okNick(n) ? n : null;
    },
    async nicknameOwner(n) {
      const r: any = (await within(nick.get_address({ value: n }))).result;
      return r && typeof r.value === "string" && ADDR.test(r.value) ? r.value : null;
    },
  };
}

/** May this wallet take a name? A producer, or 1 VHP in the wallet or staked in Knode Games. Both nodes are asked at
 *  once; every node that answers must agree (one lying node can't make a wallet eligible, audit PN-12), and a node
 *  that errors or hangs is left out (audit PN-3). No answer at all: not eligible this run (the claim stays open). */
export function eligibility(producers: Set<string>, chains: Chain[]) {
  return async (a: string) => {
    if (producers.has(a)) return true;
    const one = async (c: Chain) => (await within(c.vhp(a))) >= UNIT || (await within(c.stake(a))) >= UNIT;
    const got = await Promise.allSettled(chains.map(one));
    const yes = got.filter((g) => g.status === "fulfilled").map((g) => (g as PromiseFulfilledResult<boolean>).value);
    return yes.length > 0 && yes.every(Boolean);
  };
}

/** The nicknames of every wallet Knode Games shows: producers, leaderboard players, question-game players, named
 *  wallets. Returns address → nickname, or "" when both nodes agree it has none. A nickname counts only when every
 *  node returns the same one (one lying node can't plant a name); an address whose nodes failed or disagreed is left
 *  out, so withNicknames keeps what it had (audit PN-4). Reads run 20 at a time within a time budget (audit PN-10):
 *  whatever isn't reached keeps its old value too. `first` (named wallets, producers) is read before the rest. */
export async function nicknames(addresses: Set<string>, chains: Chain[], opts: { budgetMs?: number; first?: Set<string> } = {}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const first = opts.first ?? new Set<string>();
  const list = [...addresses].filter((a) => ADDR.test(a)).sort((x, y) => Number(first.has(y)) - Number(first.has(x)) || (x < y ? -1 : x > y ? 1 : 0)).slice(0, 3000);
  const stop = Date.now() + (opts.budgetMs ?? 240_000);
  const one = async (a: string) => {
    const got = await Promise.allSettled(chains.map((c) => within(c.nickname(a))));
    if (!got.length || got.some((g) => g.status !== "fulfilled")) return;
    const v = got.map((g) => (g as PromiseFulfilledResult<string | null>).value ?? "");
    if (v.every((n) => n === v[0])) out[a] = v[0];
  };
  for (let i = 0; i < list.length && Date.now() < stop; i += 20) await Promise.all(list.slice(i, i + 20).map(one));
  return out;
}

/** names.json as published: stable key order, so a change is a small, readable diff. */
export function serialize(db: any): string {
  const sortObj = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
  return JSON.stringify({ v: 1, updated: db.updated, names: sortObj(db.names), hidden: sortObj(db.hidden), nicknames: sortObj(db.nicknames) }, null, 1) + "\n";
}

/** Check one claim text against names.json. */
export async function check(dbIn: any, text: string, now: number, isEligible: (a: string) => Promise<boolean> | boolean) {
  const claim = R.parseClaim(text);
  const r = await R.applyClaim(dbIn, claim, { now, lib: LIB, isEligible });
  return { ...r, claim };
}

/** Check every claim issue in order (oldest first), each against names.json as the earlier ones left it. Returns the
 *  new names.json (null if none passed) and one outcome per issue. Issue text is only ever data here. */
export async function verifyIssues(prev: any, issues: Array<{ number: number; body: string }>, now: number, isEligible: (a: string) => Promise<boolean> | boolean,
  nicknameOwner?: (n: string) => Promise<string | null>) {
  let db = R.cleanDb(prev);
  let changed = false;
  const results: Array<Record<string, unknown>> = [];
  for (const it of issues.slice(0, 30)) {
    if (!it || !Number.isInteger(it.number) || it.number <= 0) continue;
    const body = typeof it.body === "string" ? it.body : "";
    // Already published exactly as claimed (the reply failed last time): answer it as accepted (audit PN-17).
    const c = R.parseClaim(body), pub = c && db.names[c.address];
    if (c && pub && !db.hidden[c.address] && pub.name === c.name && pub.date === c.date && pub.signature === c.signature) {
      results.push({ issue: it.number, accepted: true, name: c.name, address: c.address }); continue;
    }
    // A name that is another wallet's live Koinos nickname, also one Knode Games never looked up (audit PN-4).
    if (c && nicknameOwner && !R.checkName(c.name)) {
      const taken = await nickTaken(c.name, c.address, nicknameOwner);
      if (taken) { results.push({ issue: it.number, accepted: false, reason: "That name is another wallet's Koinos nickname." }); continue; }
    }
    const r = await check(db, body, now, isEligible);
    if (r.ok && Buffer.byteLength(serialize(r.db)) > MAX_BYTES) {
      results.push({ issue: it.number, accepted: false, reason: "The names list is full for now. Try again later." }); continue;
    }
    if (r.ok) { db = r.db; changed = true; results.push({ issue: it.number, accepted: true, name: r.claim.name, address: r.claim.address }); }
    else results.push({ issue: it.number, accepted: false, reason: r.reason });
  }
  return { db: changed ? db : null, results };
}

/** Is this name (as a nickname would spell it: lower case, spaces as nothing, - or .) another wallet's nickname?
 *  A node that fails here doesn't block the claim (the hourly list still checks the wallets Knode Games shows). */
async function nickTaken(name: string, address: string, owner: (n: string) => Promise<string | null>) {
  const base = name.toLowerCase();
  const tries = [...new Set([base.replace(/ /g, ""), base.replace(/ /g, "-"), base.replace(/ /g, ".")])].filter((n) => /^[a-z0-9][a-z0-9.-]{0,31}$/.test(n));
  for (const n of tries) {
    try { const o = await owner(n); if (o && o !== address) return true; } catch { /* unknown */ }
  }
  return false;
}
/** The live owner of a nickname, from the first node that answers (one lying node can only block a claim). */
export function nicknameOwnerOf(chains: Chain[]) {
  return async (n: string) => {
    for (const c of chains) {
      if (!c.nicknameOwner) continue;
      try { return await within(c.nicknameOwner(n)); } catch { /* the next node */ }
    }
    return null;
  };
}

/** Update the nicknames in names.json from a nicknames() read; returns the new db, or null if nothing changed.
 *  An address the read left out keeps its old nickname (a failed node never wipes them, audit PN-4); "" removes one.
 *  `keep` (optional): the wallets still looked up; old nicknames of other wallets are dropped. A nickname that looks
 *  like another wallet's Knode Games name is never shown (audit PN-5). The file stays under the publish limit. */
export function withNicknames(dbIn: any, nicks: Record<string, string>, now: number, keep?: Set<string>) {
  const db = R.cleanDb(dbIn);
  const merged: Record<string, string> = {};
  for (const [a, n] of Object.entries(db.nicknames as Record<string, string>)) if (!keep || keep.has(a)) merged[a] = n;
  for (const [a, n] of Object.entries(nicks)) { if (n) merged[a] = n; else delete merged[a]; }
  const names = new Map<string, string>();
  for (const [a, e] of Object.entries(db.names as Record<string, any>)) names.set(R.fold(e.name), a);
  for (const [a, n] of Object.entries(merged)) { const owner = names.get(R.fold(n)); if (owner && owner !== a) delete merged[a]; }
  const next = R.cleanDb({ ...db, nicknames: merged }).nicknames;
  if (Buffer.byteLength(serialize({ ...db, nicknames: next })) > 1_000_000) return null;   // never past the publish limit
  if (JSON.stringify(Object.entries(next).sort()) === JSON.stringify(Object.entries(db.nicknames).sort())) return null;
  db.nicknames = next;
  db.updated = new Date(now).toISOString();
  return db;
}

function chainsFromEnv(): Chain[] {
  const E = process.env;
  const a = E.RPC || "https://koinos.armana.io";
  const b = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== a ? E.RPC_CHECK : "https://api.koinosblocks.com";
  return [chainAt(a), chainAt(b)];
}

// ═══════════════ the workflow's check job ═══════════════
async function runCmd() {
  const E = process.env;
  const out = E.NAMES_OUT || "", resultFile = E.NAMES_RESULT || "";
  if (!out || !resultFile) throw new Error("NAMES_OUT and NAMES_RESULT are required.");
  const now = Date.now();
  let db = R.cleanDb(E.NAMES_PREV && fs.existsSync(E.NAMES_PREV) ? readJson(E.NAMES_PREV) : null);
  const base = E.NAMES_BASE_FILE && fs.existsSync(E.NAMES_BASE_FILE) ? fs.readFileSync(E.NAMES_BASE_FILE, "utf8").trim() : "";
  const files = readDir(E.PRODUCERS_DIR || "");
  const producers = producersFrom(files, now);
  const chains = chainsFromEnv();
  let changed = false;
  if (E.NAMES_REFRESH === "true") {
    const who = new Set<string>([...producers, ...boardPlayers(files), ...Object.keys(db.names)]);
    try { for (const a of await chains[0].players()) who.add(a); } catch (e: any) { log(`Couldn't list the question-game players: ${plain(e.message)}`); }
    const nicks = await nicknames(who, chains, { first: new Set([...producers, ...Object.keys(db.names)]) });
    const next = withNicknames(db, nicks, now, who);
    if (next) { db = next; changed = true; }
    log(`Nicknames: read ${Object.keys(nicks).length} of ${who.size} wallets${next ? " (changed)" : ""}.`);
  }
  const issues = readJson(E.ISSUES_FILE || "");
  const r = await verifyIssues(db, Array.isArray(issues) ? issues : [], now, eligibility(producers, chains), nicknameOwnerOf(chains));
  if (r.db) { db = r.db; changed = true; }
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  if (changed) fs.writeFileSync(path.join(out, "names.json"), serialize(db));
  fs.writeFileSync(resultFile, JSON.stringify({ base: /^[0-9a-f]{40}$/.test(base) ? base : "", changed, results: r.results }) + "\n");
  for (const x of r.results) log(`#${x.issue}: ${x.accepted ? `accepted, ${plain(x.name)} for ${x.address}` : `not accepted: ${plain(x.reason)}`}`);
}

// ═══════════════ the owner's commands (git on the owner's PC) ═══════════════
function git(args: string[], input?: string): string {
  const p = spawnSync("git", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (p.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(p.stderr || "").trim()}`);
  return p.stdout;
}
const gitTry = (args: string[]) => { try { return git(args); } catch { return null; } };

/** The current names.json and its commit on origin's names-data branch (none yet: empty). */
function current(): { db: any; base: string } {
  if (gitTry(["fetch", "-q", "origin", "+refs/heads/names-data:refs/remotes/origin/names-data"]) == null) return { db: R.emptyDb(), base: "" };
  const base = git(["rev-parse", "refs/remotes/origin/names-data"]).trim();
  const text = gitTry(["show", `${base}:names.json`]);
  return { db: text ? JSON.parse(text) : R.emptyDb(), base };
}
function filesFromGit(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const b of ["race-data", "blocks-data"]) {
    if (gitTry(["fetch", "-q", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`]) == null) continue;
    for (const f of git(["ls-tree", "--name-only", `refs/remotes/origin/${b}`]).split("\n")) {
      if (/^(W\d{3}|recent-blocks|board)\.json$/.test(f)) files[f] = git(["show", `refs/remotes/origin/${b}:${f}`]);
    }
  }
  return files;
}
/** Push a new names.json as the only file on names-data, on top of `base` (refused if someone pushed in between). */
function publish(db: any, base: string, what: string) {
  const blob = git(["hash-object", "-w", "--stdin"], serialize(db)).trim();
  const tree = git(["mktree"], `100644 blob ${blob}\tnames.json\n`).trim();
  const env = { GIT_AUTHOR_NAME: "knode-names", GIT_AUTHOR_EMAIL: "knode-names@users.noreply.github.com", GIT_COMMITTER_NAME: "knode-names", GIT_COMMITTER_EMAIL: "knode-names@users.noreply.github.com" };
  const p = spawnSync("git", ["commit-tree", tree, ...(base ? ["-p", base] : []), "-m", `names: ${what}`], { encoding: "utf8", input: "", env: { ...process.env, ...env } });
  if (p.status !== 0) throw new Error(`git commit-tree failed: ${p.stderr}`);
  const commit = p.stdout.trim();
  // A plain push: if someone published in between, it isn't a fast-forward and git refuses it (run the command again).
  git(["push", "-q", "origin", `${commit}:refs/heads/names-data`]);
  log(`Published to names-data (${commit.slice(0, 8)}). Pages show it within a few minutes.`);
}

async function main(argv: string[]) {
  const send = argv.includes("--send");
  const a = argv.filter((x) => x !== "--send");
  const cmd = a[0];
  const now = Date.now();
  if (cmd === "run") return runCmd();
  if (cmd === "list") {
    const { db } = current(), c = R.cleanDb(db);
    const rows = Object.entries(c.names) as Array<[string, any]>;
    log(rows.length ? rows.map(([x, e]) => `${x}  ${e.name}  (claimed ${e.date})${c.hidden[x] ? "  HIDDEN" : ""}`).join("\n") : "No Knode Games names yet.");
    const nicks = Object.entries(c.nicknames) as Array<[string, string]>;
    if (nicks.length) log(`\nOn-chain nicknames (${nicks.length}):\n${nicks.map(([x, n]) => `${x}  @${n}${c.hidden[x] ? "  HIDDEN" : ""}`).join("\n")}`);
    for (const [x, h] of Object.entries(c.hidden) as Array<[string, any]>) if (!c.names[x] && !c.nicknames[x]) log(`${x}  HIDDEN (${h.date}): ${h.reason}`);
    return;
  }
  if (cmd === "check" || cmd === "add") {
    if (!a[1]) throw new Error(`Usage: npm run names -- ${cmd} "<claim>"   (the two lines from the claim page, in quotes)`);
    const { db, base } = current();
    const chains = chainsFromEnv();
    const r = await check(db, a[1], now, eligibility(producersFrom(filesFromGit(), now), chains));
    if (!r.ok) { log(`Not accepted: ${r.reason}`); process.exitCode = 1; return; }
    if (await nickTaken(r.claim.name, r.claim.address, nicknameOwnerOf(chains))) { log("Not accepted: that name is another wallet's Koinos nickname."); process.exitCode = 1; return; }
    if (Buffer.byteLength(serialize(r.db)) > MAX_BYTES) { log("Not accepted: names.json would pass 900 kB. Remove unused names first (npm run names -- remove <address>)."); process.exitCode = 1; return; }
    log(`OK: "${r.claim.name}" for ${r.claim.address} (signed ${r.claim.date}).`);
    if (cmd === "check") return;
    if (!send) { log("Dry run only. Run again with --send to publish it."); return; }
    return publish(r.db, base, `${r.claim.address} = ${r.claim.name}`);
  }
  if (cmd === "nicknames") {
    const { db, base } = current();
    const files = filesFromGit(), chains = chainsFromEnv();
    const who = new Set<string>([...producersFrom(files, now), ...boardPlayers(files), ...Object.keys(R.cleanDb(db).names)]);
    for (const x of await chains[0].players()) who.add(x);
    const nicks = await nicknames(who, chains, { first: new Set([...producersFrom(files, now), ...Object.keys(R.cleanDb(db).names)]) });
    for (const [x, n] of Object.entries(nicks)) if (n) log(`${x}  @${n}`);
    const next = withNicknames(db, nicks, now, who);
    log(`${Object.values(nicks).filter(Boolean).length} of ${who.size} wallets have a nickname (${Object.keys(nicks).length} read).${next ? "" : " Nothing changed."}`);
    if (!next) return;
    if (!send) { log("Dry run only. Run again with --send to publish it."); return; }
    return publish(next, base, "nicknames");
  }
  if (cmd === "remove") {
    const x = a[1] || "";
    if (!ADDR.test(x)) throw new Error("Usage: npm run names -- remove <address>");
    const { db, base } = current();
    const next = R.remove(db, x, now);
    log(`Remove "${R.cleanDb(db).names[x].name}" from ${x}. It may claim a name again later.`);
    if (!send) { log("Dry run only. Run again with --send to publish it."); return; }
    return publish(next, base, `remove ${x}`);
  }
  if (cmd === "hide" || cmd === "unhide") {
    const x = a[1] || "";
    if (!ADDR.test(x)) throw new Error(`Usage: npm run names -- ${cmd} <address>${cmd === "hide" ? ' "<reason>"' : ""}`);
    const { db, base } = current();
    const next = cmd === "hide" ? R.hide(db, x, a[2] || "", now) : R.unhide(db, x, now);
    const c = R.cleanDb(db), shown = c.names[x] ? `"${c.names[x].name}"` : c.nicknames[x] ? `@${c.nicknames[x]}` : "";
    log(cmd === "hide" ? `Hide ${x}${shown ? ` (${shown})` : ""}: pages show its short address; new claims from it are refused.`
      : `Unhide ${x}${shown ? `: ${shown} shows again` : ""}.`);
    if (!send) { log("Dry run only. Run again with --send to publish it."); return; }
    return publish(next, base, `${cmd} ${x}`);
  }
  log(`Commands: list · check "<claim>" · add "<claim>" [--send] · hide <address> "<reason>" [--send] · unhide <address> [--send] · remove <address> [--send] · nicknames [--send]`);
  process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main(process.argv.slice(2)).catch((e) => { console.error(`Error: ${e.message}`); process.exitCode = 1; });
