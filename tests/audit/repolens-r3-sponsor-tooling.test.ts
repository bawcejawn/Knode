// F4-S2 failing tests for the sponsor tooling @ 1c66ddc. NOT RUN HERE (static review).
// Place in tests/audit/ and run with the repo's test:audit runner (node:test + tsx).
// Each test should FAIL on 1c66ddc and pass once fixed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = () => fs.readFileSync("bot/sponsor.ts", "utf8");
const setConfigBody = () => { const s = src(); return s.slice(s.indexOf("async function setConfig("), s.indexOf("/** Copies the per-action limits")); };

// S2-1 (Medium): enable / disable must not reset the caps to DEFAULT_CAPS. With no cap flag they must keep the
// caps that are on chain (enable/disable change only the switch), or refuse and ask for the caps explicitly.
test("S2-1: enable/disable keep the caps already on chain (only the switch changes)", () => {
  const body = setConfigBody();
  // Today every cap is flag(a, "--x", DEFAULT_CAPS.x) for config, enable and disable alike (sponsor.ts:318-325).
  // A fix keeps cur.* when enabledArg !== undefined and no flag is given (or the CLI rejects enable/disable without caps).
  assert.match(body, /enabledArg\s*!==\s*undefined[\s\S]{0,400}cur\.max_mana_per_day/,
    "enable/disable must take the on-chain caps (both nodes already agree on cur), not the defaults");
});

// S2-2 (Low): the emergency stop must not depend on a second node agreeing or on local files.
test("S2-2: disable --send skips the two-node equality check and the Picks/limits file checks", () => {
  const body = setConfigBody();
  const twoNode = body.indexOf("show different sponsor settings");
  const guard = body.slice(Math.max(0, twoNode - 400), twoNode);
  assert.match(guard, /enabledArg\s*!==\s*false|!stopping/, "the two-node check must not apply when switching off");
  assert.match(src(), /RPC_CHECK\s*===\s*"off"[^\n]*\?\s*null|RPC_CHECK !== "off" \? E\.RPC_CHECK : null/,
    "RPC_CHECK=off should really turn the second node off (today 'off' falls back to api.koinosblocks.com)");
});

// S2-4 (Low): a --testnet run must never fall back to the mainnet files when the chain id can't be read.
test("S2-4: --testnet uses the testnet state and limits files even when the chain id read fails", () => {
  const s = src();
  const main = s.slice(s.indexOf("async function main()"));
  // Today STATE/LIMITS_FILE switch only when MAINNET === false; MAINNET === null (read failed) keeps the mainnet paths,
  // so mana-report --testnet --save / mana-limit --testnet --save write sponsor-data/mana-limits.json.
  assert.match(main, /if \(TESTNET(\s*\|\|\s*MAINNET === false)?\)\s*\{\s*STATE = path\.join\("sponsor-data", "testnet"/,
    "testnet paths must be chosen by --testnet, not only by a successful chain id read");
});

// S2-3 (Low): watch should alert somewhere a person sees (fail the step or email), and cover the sponsor's own Mana.
test("S2-3: the hourly watch makes a visible alert and checks the sponsor wallet's Mana", () => {
  const yml = fs.readFileSync(".github/workflows/bot.yml", "utf8");
  const step = yml.slice(yml.indexOf("name: Mana sponsor watch"), yml.indexOf("name: Mana sponsor watch") + 400);
  assert.ok(!/continue-on-error:\s*true/.test(step) || /if:\s*always\(\)/.test(step), "a ::warning:: in a continue-on-error step emails nobody");
  assert.match(src().slice(src().indexOf("async function watch()")), /getAccountRc/, "watch should warn when the sponsor wallet's own Mana is below today's remaining cap");
});
