// Audit fix check 3 (written by the auditor in place of the Insider red-team persona, which stopped before writing).
// FC3-REPLAY-1 (bypass): the bot-state seal has no freshness. An OLD bot-state.json from git history carries a valid
//   seal; re-committing it restores alert keys that were live back then, so the same owner-only change made again
//   (with a stolen owner key) is treated as "already emailed".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { paramsHashOf } from "../../resolver.ts";
import { tick, paths, sealOf } from "../../bot/bot.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const RELEASE = 100_000_000_000_000n;
const HOUR = 1_200;
const OP = Signer.fromSeed("fc3-seal-test-only");

function world(opts: { height: number; config?: Record<string, string>; koin?: string; questions?: any[] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc3-seal-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  const onchain: any[] = (opts.questions ?? []).map((q) => ({ week: "0", k: 4, window_end: String(q.windowEnd), outcome: 0, params_hash: "0x" + q.paramsHash }));
  if (opts.questions) fs.writeFileSync(path.join(P.questions, "W000-D3.json"), JSON.stringify({ ...day, questions: opts.questions }));
  const sent: any[] = [];
  const cfg = { owner: "1Owner", operator: "1Op", genesis_time: "1792368000000", week_length: String(7 * 86_400_000), close_delay: "43200000", min_stake: "100000000", min_sponsor_rc: "50000000", ...(opts.config ?? {}) };
  let height = opts.height;
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height, lib: height - 100 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: String(height), time: String(1_792_368_000_000 + 3 * 86_400_000), config: cfg,
        totals: { weeks_closed: "0", weeks_finalized: "0", next_question_id: onchain.length, seed_koin: "0", creator_fee: "0" }, koin_balance: opts.koin ?? "0" };
      if (method === "get_week") return { week: { questions: onchain.length, resolved: onchain.filter((x) => x.outcome).length } };
      if (method === "get_question") return { question: onchain[Number(args.id)] };
      if (method === "list_players") return { rows: [] };
      return {};
    },
    async send(calls: any[]) {
      for (const c of calls) { sent.push(c); if (c.method === "resolve_question") onchain[c.args.id].outcome = c.args.outcome === 1000 ? 1000 : c.args.outcome + 1; }
      return { ok: true };
    },
  };
  const run = async (op = OP) => {
    const ctx: any = { chain, operator: op, P, dryRun: false, problems: [] as string[], generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true };
    await tick(ctx);
    return ctx.problems as string[];
  };
  return { dir, P, cfg, sent, onchain, run, setHeight: (h: number) => { height = h; } };
}
const stateFile = (w: { P: any }) => w.P.botState as string;

test("FC3-REPLAY-1: re-committing an old sealed bot-state.json does not silence a repeated owner-only change", async () => {
  // The bot runs every hour: 1,200 blocks between runs (the chain does not stand still between them).
  const w = world({ height: 40_000_000 });
  let h = 40_000_000;
  const next = () => { h += 1_200; w.setHeight(h); return w.run(); };
  await w.run();
  w.cfg.paused = "true" as any;               // the owner pauses the game once: emailed
  const p1 = await next();
  assert.ok(p1.some((x) => /paused/.test(x)), `setup: the pause is emailed: ${JSON.stringify(p1)}`);
  const old = fs.readFileSync(stateFile(w), "utf8");   // published by the bot, so it is in git history
  delete (w.cfg as any).paused;               // unpaused
  await next();
  await next();
  // Later: a stolen owner key pauses the game again, and the old sealed bot-state.json is pushed back to main.
  w.cfg.paused = "true" as any;
  fs.writeFileSync(stateFile(w), old);
  const p = await next();
  assert.ok(p.some((x) => /paused|bot-state/.test(x)),
    `FC3-REPLAY-1: the game was paused again and an old, validly sealed bot-state.json was replayed: nothing was emailed (${JSON.stringify(p)})`);
});
