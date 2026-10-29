// The one parser for game/assembly/Mode.ts, used by build:safe, the offline check and the bot's upgrade guard
// (RepoLens fix-check 4, C4-1). It reads only the live declaration: comments, line or block, never count.
"use strict";
const NORMAL = "export const SAFE_MODE: bool = false;";
const SAFE = "export const SAFE_MODE: bool = true;";

/** The file with comments blanked out (same lines, so line numbers still match). */
function uncommented(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, ""));
}

/** The live lines that mention SAFE_MODE, as [line index, trimmed text]. */
function liveDecl(text) {
  return uncommented(text).map((l, i) => [i, l.trim()]).filter(([, l]) => /\bSAFE_MODE\b/.test(l));
}

const isNormal = (text) => { const d = liveDecl(text); return d.length === 1 && d[0][1] === NORMAL; };
const isSafe = (text) => { const d = liveDecl(text); return d.length === 1 && d[0][1] === SAFE; };

/** The same file with the live declaration switched to the safe build. Throws unless the result is exactly that. */
function toSafe(text) {
  if (!isNormal(text)) throw new Error("Mode.ts must have exactly one live declaration, SAFE_MODE = false");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/), [i] = liveDecl(text)[0];
  lines[i] = lines[i].replace(NORMAL, SAFE);
  const out = lines.join(eol);
  if (!isSafe(out) || out.split(/\r?\n/).filter((l, j) => j !== i && l !== text.split(/\r?\n/)[j]).length !== 0)
    throw new Error("Mode.ts: the switch changed something other than the live declaration");
  return out;
}

module.exports = { liveDecl, isNormal, isSafe, toSafe, NORMAL, SAFE };
