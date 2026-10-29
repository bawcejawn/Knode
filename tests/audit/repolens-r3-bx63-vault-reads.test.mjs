// F4-K-3 failing test. NOT RUN HERE (static review). Counts get_game_player calls for a 36-target catch-up with 200
// players per round through the exported run() and a stakeOf-free path is not injectable, so this asserts on a
// recorder option the fix should add (a per-(week, player) cache / batch reader).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
const APP = process.env.APP || process.cwd();
test("F4-K-3: the recorder reads each player's stake once per week and node, not once per target", async () => {
  const src = (await import("node:fs")).readFileSync(path.join(APP, "bot/games/blockx.ts"), "utf8");
  assert.match(src, /vaultCache|stakeCache|readVaultCached/, "readVault (blockx.ts:162-177) re-reads get_state and every player sequentially for every target on both nodes");
});
