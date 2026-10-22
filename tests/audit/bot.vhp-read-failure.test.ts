// Proof test (audit fix check, AB-022): a failing VHP read must only cost that reading; questions that need no VHP
// reading are still resolved in the same run.
// Adapted to the owner's rule (VHP is read only while a window is open): the snapshot question's window is still open
// at the run's height, so the bot does try to read VHP, and the read fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { tick, paths } from "../../bot/bot.ts";
import { paramsHashOf } from "../../resolver.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const M9 = () => { const q = structuredClone(day.questions.find((x: any) => x.template === "M9")); delete q.chainId; return q; };
const WEEK = 7 * 86_400_000, GENESIS = 1_792_368_000_000;

function csvFor(q: any) {                                   // copied from tests/audit/bot.alerts.test.ts
  const width = q.windowEnd - q.windowStart + 1, [who] = q.subjects, n = Math.round(width * q.model.rates[who]);
  const sig = new Array(width).fill("1Filler");
  for (let j = 0; j < n; j++) sig[Math.floor(((j + 0.5) * width) / n)] = who;
  return sig.map((s, i) => `${q.windowStart + i},${1_792_627_200_000 + i * 3000},${s},0,0`).join("\n") + "\n";
}

test("SAB-VHP-6: a failing VHP read does not stop questions that need no VHP reading from being resolved", async () => {
  const old = M9();                                         // released before the rule: no snapshot
  delete old.model.vhp; delete old.model.vhpHeight; delete old.model.voidVhpSwing;
  old.paramsHash = paramsHashOf(old);
  const snap = M9();
  snap.id = "W000-D3-3b";
  snap.model.vhp = { [snap.subjects[0]]: "100000000000000" };
  snap.model.vhpHeight = snap.releaseHeight;
  snap.model.voidVhpSwing = 0.1;
  snap.windowStart += 1000; snap.windowEnd += 1000; // still open when the run below happens
  snap.paramsHash = paramsHashOf(snap);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sab-vhpfail-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  fs.writeFileSync(path.join(P.questions, "W000-D3.json"), JSON.stringify({ ...day, questions: [old, snap] }));
  fs.writeFileSync(path.join(dir, "blocks.csv"), csvFor(old));
  const onchain = [old, snap].map((q) => ({ week: "0", k: 4, window_end: String(q.windowEnd), outcome: 0, params_hash: "0x" + q.paramsHash }));
  const height = old.windowEnd + 500, sent: any[] = [];
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height, lib: height - 100 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: String(height), time: String(GENESIS + 3 * 86_400_000),
        config: { owner: "1Owner", operator: "1Op", genesis_time: String(GENESIS), week_length: String(WEEK), close_delay: "43200000", min_stake: "100000000" },
        totals: { weeks_closed: "0", weeks_finalized: "0", next_question_id: onchain.length }, koin_balance: "0" };
      if (method === "get_week") return { week: { questions: onchain.length, resolved: onchain.filter((x) => x.outcome).length } };
      if (method === "get_question") return { question: onchain[Number(args.id)] };
      if (method === "list_players") return { rows: [] };
      return {};
    },
    async send(calls: any[]) {
      for (const c of calls) {
        sent.push(c);
        if (c.method === "resolve_question") { const x = onchain[Number(c.args.id)]; x.outcome = c.args.outcome === 1000 ? 1000 : c.args.outcome + 1; }
      }
      return { ok: true };
    },
  };
  const ctx: any = { chain, operator: Signer.fromSeed("sab-vhpfail-test-only"), P, dryRun: false, problems: [] as string[],
    generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true,
    vhp: async () => { vhpCalls++; throw new Error("VHP of 1JrsQX…: 429 Too Many Requests"); } };
  let vhpCalls = 0;
  await tick(ctx);
  const resolvedIds = sent.filter((c) => c.method === "resolve_question").map((c) => Number(c.args.id));
  assert.ok(resolvedIds.includes(0),
    `SAB-VHP-6: the question without a VHP snapshot was not resolved because the VHP read failed (problems: ${ctx.problems.join(" | ")})`);
  assert.ok(vhpCalls > 0, "(control) the bot tried to read VHP for the open window");
  assert.ok(!resolvedIds.includes(1), "(control) the snapshot question's window is still open");
  assert.ok(ctx.problems.some((p: string) => /VHP/.test(p)), "(control) the failed read is reported");
});
