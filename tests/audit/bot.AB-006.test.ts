// Audit Bot attack test for AB-006 (Knode, commit 6b37c46).
// Attack: someone with write access to main (a maintainer's mistake, a merged pull request, or
// code running with the bot's own push token) edits a posted question's thresholds in
// game-data/questions/*.json but leaves its paramsHash. The bot links the file to the on-chain
// question by that stored paramsHash and resolves with the EDITED thresholds. It never recomputes
// the hash of the parameters it actually uses, so the on-chain params_hash no longer describes
// the rule the answer came from, and nothing notices.
// Asserts the SAFE behaviour (the bot does not resolve from parameters that don't hash to the
// on-chain params_hash): FAILS before the fix (proof), PASSES after.
// Runs the real bot tick against an in-memory fake chain (no network, no key is used for signing).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Signer } from "koilib";
import { tick, paths } from "../../bot/bot.ts";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
function canonicalHash(q: any) {
  const { paramsHash, result, text, title, options, chainId, chainOutcome, postSkipped, ...canonical } = q;
  return sha(JSON.stringify(canonical));
}

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const original = day.questions.find((q: any) => q.template === "M7");

test("(context) the published paramsHash is reproducible from the file, so a check is possible", () => {
  assert.equal(canonicalHash(original), original.paramsHash);
});

test("AB-006: the bot must not resolve a question whose file no longer matches the on-chain params_hash", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab006-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  const tampered = { ...original, thresholds: [0, 1, 2] };           // edited after posting
  delete (tampered as any).chainId;
  fs.writeFileSync(path.join(P.questions, "W000-D3.json"), JSON.stringify({ ...day, questions: [tampered] }));
  // Block history for the window: 50 transactions in total -> option B under the real thresholds.
  const lines: string[] = [];
  for (let h = original.windowStart; h <= original.windowEnd; h++) {
    const i = h - original.windowStart;
    lines.push(`${h},${1792627200000 + i * 3000},1Producer,${i % 100 === 0 ? 1 : 0},0`);
  }
  fs.writeFileSync(path.join(dir, "blocks.csv"), lines.join("\n") + "\n");
  const sent: any[] = [];
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height: original.windowEnd + 500, lib: original.windowEnd + 400 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: String(original.windowEnd + 500), time: "1700000000000",
        config: { owner: "1Owner", operator: "1Op", genesis_time: "1800000000000", week_length: String(7 * 86400000), close_delay: "43200000", min_stake: "100000000" },
        totals: { weeks_closed: "0", weeks_finalized: "0", next_question_id: 1 }, koin_balance: "0" };
      if (method === "get_week") return { week: { questions: 1, resolved: 0 } };
      if (method === "get_question") return { question: { week: "0", k: 4, window_end: String(original.windowEnd), outcome: 0, params_hash: "0x" + original.paramsHash } };
      if (method === "list_players") return { rows: [] };
      return {};
    },
    async send(calls: any[]) { sent.push(...calls); return { ok: true }; },
  };
  const ctx: any = { chain, operator: Signer.fromSeed("audit-test-only"), P, dryRun: false, problems: [],
    generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true };
  await tick(ctx);
  const res = sent.filter((c) => c.method === "resolve_question");
  const honestOption = 1;                                             // 50 tx with thresholds 40/54/73
  assert.ok(res.every((c) => c.args.outcome === honestOption),
    `AB-006: the bot resolved on-chain question ${res[0]?.args.id} as option ${res[0]?.args.outcome} from edited thresholds; the on-chain params_hash says the rule gives option ${honestOption}`);
});
