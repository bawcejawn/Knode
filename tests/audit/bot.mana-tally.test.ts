// The bot records the Mana its own wallet spends per UTC day (bot-state.json manaByDay), for the platform's daily Mana
// budget (owner, 2026-10-28). Transactions the contract paid for are not counted. In-memory chain; nothing is signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { tick, paths } from "../../bot/bot.ts";

const players = ["1PlayerA", "1PlayerB", "1PlayerC"];

async function run(sponsorPays: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-tally-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  const time = 1_700_000_000_000;
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height: 41_000_000, lib: 40_999_900 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: "41000000", time: String(time),
        config: { owner: "1Owner", operator: "1Op", genesis_time: "1800000000000", week_length: String(7 * 86400000), close_delay: "43200000", min_stake: "100000000" },
        totals: { weeks_closed: "1", weeks_finalized: "0", next_question_id: 0 }, koin_balance: "0" };
      if (method === "get_week") return { week: { questions: 0, resolved: 0, closed: true, settle_start: String(time - 1000), settle_end: String(time + 86_400_000) } };
      if (method === "list_players") return { rows: args.start ? [] : players.map((a) => ({ address: a, entry: { settled: false, stake: "100000000" } })) };
      return {};
    },
    async send(calls: any[], _s: any[], opts: any = {}) {
      if (opts.sponsored && !sponsorPays) return { ok: false, error: "the contract declined to pay" };
      return { ok: true, rcUsed: "2500000" };
    },
  };
  const ctx: any = { chain, operator: Signer.fromSeed("mana-tally-test-only"), P, dryRun: false, problems: [],
    generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true };
  await tick(ctx);
  return JSON.parse(fs.readFileSync(P.botState, "utf8")).manaByDay ?? {};
}

test("bot-paid settles are added to today's Mana use", async () => {
  const m = await run(false);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(m[day], String(3 * 2_500_000), JSON.stringify(m));
});

test("transactions the contract paid for are not counted as the bot's", async () => {
  const m = await run(true);
  assert.deepEqual(m, {});
});
