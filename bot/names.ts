/**
 * Producer names: check a claim and keep names.json (published on the names-data branch). See docs/NAMES.md.
 * The rules are names.js (KNames.rules), the same code the claim page runs.
 *
 * Owner (on your PC, in the repo folder). Every command that changes names.json is a dry run unless you add --send;
 * with --send it pushes the new names.json to the names-data branch with your own git login (nothing else changes):
 *   npm run names -- list                              every name, and the hidden addresses
 *   npm run names -- check "<claim>"                   check a claim without changing anything
 *   npm run names -- add "<claim>" [--send]            add a claim a producer sent you (no GitHub needed for them)
 *   npm run names -- hide <address> "<reason>" [--send]   hide that address's name (pages show its short address)
 *   npm run names -- unhide <address> [--send]         show it again
 * A claim is the two lines the claim page makes:
 *   Knode Games producer name: <name> | <address> | <YYYY-MM-DD>
 *   Signature: <…>
 *
 * Workflow (.github/workflows/names.yml, job "check", read-only token, no secrets):
 *   npm run names -- verify-issues
 *   Env: ISSUES_FILE (the open claim issues as [{ number, body }]: data only, never run), NAMES_PREV (the current
 *   names.json, if any), NAMES_BASE_FILE (its names-data commit, or empty), PRODUCERS_DIR (race-data W*.json and
 *   recent-blocks.json), NAMES_OUT (folder: gets names.json only if a claim passed), NAMES_RESULT (results.json).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Signer, utils } from "koilib";
await import("../names.js");
const K: any = (globalThis as any).KNames;
const R = K.rules;
const LIB = { Signer, utils };
const DAY = 86400000;
const ADDR = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const log = (...a: unknown[]) => console.log(...a);

// ═══════════════ who counts as a producer ═══════════════
/** Producers seen in the last 30 days: every address on a race card taken in that time (field and paddock), and every
 *  signer in the recent-blocks snapshot. `files` maps a file name to its text: W###.json (race-data) and
 *  recent-blocks.json (blocks-data). Anything that doesn't parse is skipped. */
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

function readDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!dir || !fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) if (/^(W\d{3}|recent-blocks)\.json$/.test(f)) out[f] = fs.readFileSync(path.join(dir, f), "utf8");
  return out;
}
const readJson = (file: string) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

/** names.json as published: stable key order, so a change is a small, readable diff. */
export function serialize(db: any): string {
  const sortObj = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  return JSON.stringify({ v: 1, updated: db.updated, names: sortObj(db.names), hidden: sortObj(db.hidden) }, null, 1) + "\n";
}

/** Check one claim text against names.json. */
export async function check(dbIn: any, text: string, now: number, producers: Set<string>) {
  const claim = R.parseClaim(text);
  const r = await R.applyClaim(dbIn, claim, { now, lib: LIB, isProducer: (a: string) => producers.has(a) });
  return { ...r, claim };
}

// ═══════════════ the workflow's check job ═══════════════
/** Check every claim issue in order (oldest first), each against names.json as the earlier ones left it. Returns the
 *  new names.json (null if none passed) and one outcome per issue. Issue text is only ever data here. */
export async function verifyIssues(prev: any, issues: Array<{ number: number; body: string }>, now: number, producers: Set<string>) {
  let db = R.cleanDb(prev);
  let changed = false;
  const results: Array<Record<string, unknown>> = [];
  for (const it of issues.slice(0, 30)) {
    if (!it || !Number.isInteger(it.number) || it.number <= 0) continue;
    const r = await check(db, typeof it.body === "string" ? it.body : "", now, producers);
    if (r.ok) { db = r.db; changed = true; results.push({ issue: it.number, accepted: true, name: r.claim.name, address: r.claim.address }); }
    else results.push({ issue: it.number, accepted: false, reason: r.reason });
  }
  return { db: changed ? db : null, results };
}

async function verifyIssuesCmd() {
  const E = process.env;
  const out = E.NAMES_OUT || "", resultFile = E.NAMES_RESULT || "";
  if (!out || !resultFile) throw new Error("NAMES_OUT and NAMES_RESULT are required.");
  const now = Date.now();
  const prev = E.NAMES_PREV && fs.existsSync(E.NAMES_PREV) ? readJson(E.NAMES_PREV) : null;
  const base = E.NAMES_BASE_FILE && fs.existsSync(E.NAMES_BASE_FILE) ? fs.readFileSync(E.NAMES_BASE_FILE, "utf8").trim() : "";
  const issues = readJson(E.ISSUES_FILE || "");
  const producers = producersFrom(readDir(E.PRODUCERS_DIR || ""), now);
  const r = await verifyIssues(prev, Array.isArray(issues) ? issues : [], now, producers);
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  if (r.db) fs.writeFileSync(path.join(out, "names.json"), serialize(r.db));
  fs.writeFileSync(resultFile, JSON.stringify({ base: /^[0-9a-f]{40}$/.test(base) ? base : "", results: r.results }) + "\n");
  for (const x of r.results) log(`#${x.issue}: ${x.accepted ? `accepted, ${x.name} for ${x.address}` : `not accepted: ${x.reason}`}`);
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
function producersFromGit(now: number): Set<string> {
  const files: Record<string, string> = {};
  for (const b of ["race-data", "blocks-data"]) {
    if (gitTry(["fetch", "-q", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`]) == null) continue;
    for (const f of git(["ls-tree", "--name-only", `refs/remotes/origin/${b}`]).split("\n")) {
      if (/^(W\d{3}|recent-blocks)\.json$/.test(f)) files[f] = git(["show", `refs/remotes/origin/${b}:${f}`]);
    }
  }
  return producersFrom(files, now);
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
  if (cmd === "verify-issues") return verifyIssuesCmd();
  if (cmd === "list") {
    const { db } = current(), c = R.cleanDb(db);
    const rows = Object.entries(c.names) as Array<[string, any]>;
    log(rows.length ? rows.map(([addr, e]) => `${addr}  ${e.name}  (claimed ${e.date})${c.hidden[addr] ? "  HIDDEN" : ""}`).join("\n") : "No names yet.");
    for (const [addr, h] of Object.entries(c.hidden) as Array<[string, any]>) if (!c.names[addr]) log(`${addr}  HIDDEN (${h.date}): ${h.reason}`);
    return;
  }
  if (cmd === "check" || cmd === "add") {
    if (!a[1]) throw new Error(`Usage: npm run names -- ${cmd} "<claim>"   (the two lines from the claim page, in quotes)`);
    const { db, base } = current();
    const r = await check(db, a[1], now, producersFromGit(now));
    if (!r.ok) { log(`Not accepted: ${r.reason}`); process.exitCode = 1; return; }
    log(`OK: "${r.claim.name}" for ${r.claim.address} (signed ${r.claim.date}).`);
    if (cmd === "check") return;
    if (!send) { log("Dry run only. Run again with --send to publish it."); return; }
    return publish(r.db, base, `${r.claim.address} = ${r.claim.name}`);
  }
  if (cmd === "hide" || cmd === "unhide") {
    const addr = a[1] || "";
    if (!ADDR.test(addr)) throw new Error(`Usage: npm run names -- ${cmd} <address>${cmd === "hide" ? ' "<reason>"' : ""}`);
    const { db, base } = current();
    const next = cmd === "hide" ? R.hide(db, addr, a[2] || "", now) : R.unhide(db, addr, now);
    const nm = R.cleanDb(db).names[addr];
    log(cmd === "hide" ? `Hide ${addr}${nm ? ` ("${nm.name}")` : ""}: pages show its short address; new claims from it are refused.`
      : `Unhide ${addr}${nm ? `: "${nm.name}" shows again` : ""}.`);
    if (!send) { log("Dry run only. Run again with --send to publish it."); return; }
    return publish(next, base, `${cmd} ${addr}`);
  }
  log(`Commands: list · check "<claim>" · add "<claim>" [--send] · hide <address> "<reason>" [--send] · unhide <address> [--send]`);
  process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main(process.argv.slice(2)).catch((e) => { console.error(`Error: ${e.message}`); process.exitCode = 1; });
