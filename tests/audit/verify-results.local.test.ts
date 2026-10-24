// verify-results must only ever talk to a node on this computer: no remote --rpc, no remote NODE_RPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--import", "tsx", "bot/bot.ts", "verify-results", ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });

test("a remote --rpc is refused before anything is read", () => {
  const r = run(["--rpc", "https://api.koinos.io"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /must be a node on this computer/);
});

test("with no local node it says so (and never falls back to a remote node)", () => {
  const r = run([], { NODE_RPC: "https://evil.example" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /No mainnet node answered on this computer/);
});
