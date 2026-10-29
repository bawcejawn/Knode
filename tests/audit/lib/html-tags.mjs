// Shared by site.csp.test.mjs and lastnode-fixes.test.mjs (audit LN-10).
/** Audit LN-10. Tags parsed after removing HTML comments; attributes in any order and with any quotes. */
const tagsOf = (html, name) => [...html.replace(/<!--[\s\S]*?-->/g, "").matchAll(new RegExp(`<${name}\\b([^>]*)>`, "gi"))].map((m) => {
  const a = {};
  for (const x of m[1].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) a[x[1].toLowerCase()] = x[2] ?? x[3] ?? x[4] ?? "";
  return a;
});
export const readsMainnetBlocks = (html) => tagsOf(html, "meta").some((a) => a.name === "kg-reads" && a.content === "mainnet-blocks");
export const READS_MAINNET_SCRIPTS = new Set(["testnet-wallet.js", "chain-blocks.js", "race-math.js", "lastnode-math.js", "board.js", "lastnode.js"]);
/** Scripts a reads-mainnet testnet page must not load: anything local that isn't on the list (after resolving ./, ../,
 *  ?query and #hash), and the mainnet wallets by any name or path. CDN scripts are checked by script-src and SRI. */
export function mainnetPageScripts(html) {
  const bad = [];
  for (const a of tagsOf(html, "script")) {
    if (!("src" in a)) continue;
    const src = a.src.trim();
    if (/^https:\/\/cdn\.jsdelivr\.net\/npm\//.test(src) && !/wallet/i.test(src.replace(/kondor-js@/, ""))) continue;
    let file;
    try { const u = new URL(src, "https://site.invalid/x/"); file = u.origin === "https://site.invalid" ? u.pathname.split("/").pop() : null; } catch { file = null; }
    if (!file || !READS_MAINNET_SCRIPTS.has(file) || new URL(src, "https://site.invalid/x/").pathname !== `/x/${file}`) bad.push(src);
  }
  return bad;
}

