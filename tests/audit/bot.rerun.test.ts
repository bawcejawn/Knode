// Audit Bot check (Knode, commit 6b37c46): bot reruns and crash recovery.
// 1. Running tick again after a resolution landed sends nothing new (no double resolution).
// 2. If a crash made the same question get posted twice, the duplicate is resolved VOID, never
//    scored as a second live question.
// 3. If a resolution was sent but not confirmed in time (crash/timeout), the next run re-reads the
//    chain and resolves it exactly once.
// Asserts the SAFE behaviour; expected to PASS (these attacks are blocked).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { tick, paths } from "../../bot/bot.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const original = day.questions.find((q: any) => q.template === "M7");

function world(nQuestions: number, opts: { dropFirstSend?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abrerun-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  const q = { ...original }; delete (q as any).chainId;
  fs.writeFileSync(path.join(P.questions, "W000-D3.json"), JSON.stringify({ ...day, questions: [q] }));
  const lines: string[] = [];
  for (let h = original.windowStart; h <= original.windowEnd; h++) lines.push(`${h},${1792627200000 + (h - original.windowStart) * 3000},1P,${(h - original.windowStart) % 100 === 0 ? 1 : 0},0`);
  fs.writeFileSync(path.join(dir, "blocks.csv"), lines.join("\n") + "\n");
  const onchain = Array.from({ length: nQuestions }, () => ({ week: "0", k: 4, window_end: String(original.windowEnd), outcome: 0, params_hash: "0x" + original.paramsHash }));
  const sent: any[] = [];
  let drop = !!opts.dropFirstSend;
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height: original.windowEnd + 500, lib: original.windowEnd + 400 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: String(original.windowEnd + 500), time: "1700000000000",
        config: { owner: "1Owner", operator: "1Op", genesis_time: "1800000000000", week_length: String(7 * 86400000), close_delay: "43200000", min_stake: "100000000" },
        totals: { weeks_closed: "0", weeks_finalized: "0", next_question_id: onchain.length }, koin_balance: "0" };
      if (method === "get_week") return { week: { questions: onchain.length, resolved: onchain.filter((x) => x.outcome).length } };
      if (method === "get_question") return { question: onchain[Number(args.id)] };
      if (method === "list_players") return { rows: [] };
      return {};
    },
    async send(calls: any[]) {
      for (const c of calls) {
        if (c.method !== "resolve_question") continue;
        if (drop) { drop = false; sent.push({ ...c, dropped: true }); return { ok: false, error: "sent, but not seen in a block within 3 minutes" }; }
        const x = onchain[Number(c.args.id)];
        if (x.outcome) return { ok: false, error: "reverted: already resolved" };
        x.outcome = c.args.outcome === 1000 ? 1000 : c.args.outcome + 1;
        sent.push(c);
      }
      return { ok: true };
    },
  };
  const ctx = () => ({ chain, operator: Signer.fromSeed("audit-test-only"), P, dryRun: false, problems: [] as string[],
    generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true } as any);
  return { chain, sent, onchain, ctx };
}

test("a second tick after a resolution sends nothing new", async () => {
  const w = world(1);
  await tick(w.ctx()); await tick(w.ctx());
  assert.equal(w.sent.filter((c) => !c.dropped).length, 1, "resolved more than once");
});

test("a question posted twice by a crash: the duplicate is voided, not scored twice", async () => {
  const w = world(2);
  await tick(w.ctx()); await tick(w.ctx());
  assert.equal(w.onchain[0].outcome, 2, "the real question should get option B");
  assert.equal(w.onchain[1].outcome, 1000, "the duplicate must be VOID");
});

test("a resolution lost to a timeout is resolved exactly once on the next run", async () => {
  const w = world(1, { dropFirstSend: true });
  const c1 = w.ctx(); await tick(c1);
  assert.ok(c1.problems.length > 0, "the lost send should be reported");
  await tick(w.ctx());
  assert.equal(w.sent.filter((c) => !c.dropped).length, 1);
  assert.equal(w.onchain[0].outcome, 2);
});
