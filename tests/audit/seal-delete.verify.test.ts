// Independent verify (AB-040 bypass): seals authenticate each VHP reading but not the SET of readings. Deleting only the
// sealed reading that shows the swing (keeping an earlier, non-swinging sealed reading) turns an honest VOID into a paid
// option with no "skipped" email and no seal warning. Asserts SAFE behaviour; a failure means AB-040 is not fully fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { tick, paths, sealOf, sealReadings } from "../../bot/bot.ts";
import { paramsHashOf } from "../../resolver.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const HOUR = 3_600_000, DAY = 24 * HOUR, WEEK = 7 * DAY, GENESIS = 1_792_368_000_000;
const OP = Signer.fromSeed("verify-seal-delete-test-only");

function M9vhp() {
  const q = structuredClone(day.questions.find((x: any) => x.template === "M9"));
  for (const k of ["chainId", "chainOutcome", "result", "vhpEnd", "vhpReadings", "corrections", "postSkipped"]) delete q[k];
  const [who] = q.subjects;
  q.model.vhp = { [who]: "100000000000000" };
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.10;
  q.paramsHash = paramsHashOf(q);
  q.chainId = 0;
  return q;
}
function csvFor(q: any) {
  const width = q.windowEnd - q.windowStart + 1, [who] = q.subjects, n = Math.round(width * q.model.rates[who]);
  const sig = new Array(width).fill("1Filler");
  for (let j = 0; j < n; j++) sig[Math.floor(((j + 0.5) * width) / n)] = who;
  return sig.map((s, i) => `${q.windowStart + i},${1_792_627_200_000 + i * 3000},${s},0,0`).join("\n") + "\n";
}
function sealed(q: any, height: number, v: string) {
  const r = { height, readAt: new Date(GENESIS + height).toISOString(), values: { [q.subjects[0]]: v } };
  return { ...r, seal: sealOf(OP, `vhp:${String(q.paramsHash).toLowerCase()}`, r) };
}
async function run(q: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-seal-del-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  fs.writeFileSync(path.join(P.questions, "W000-D3.json"), JSON.stringify({ ...day, questions: [q] }));
  fs.writeFileSync(path.join(dir, "blocks.csv"), csvFor(q));
  fs.writeFileSync(P.deployment, JSON.stringify({ owner: "1Owner", operator: "1Op" }));
  const onchain = [{ week: "0", k: 4, window_end: String(q.windowEnd), outcome: 0, params_hash: "0x" + q.paramsHash, data_hash: "0x" + "ab".repeat(32) }];
  const height = q.windowEnd + 500, sent: any[] = [];
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height, lib: height - 100 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: String(height), time: String(GENESIS + 3 * DAY),
        config: { owner: "1Owner", operator: "1Op", genesis_time: String(GENESIS), week_length: String(WEEK), close_delay: String(12 * HOUR), min_stake: "100000000", max_sponsor_rc: "200000000" },
        totals: { weeks_closed: "0", weeks_finalized: "0", next_question_id: 1 }, upgrade: {}, seed_withdrawal: {}, koin_balance: "0", mana: "0" };
      if (method === "get_week") return { week: { questions: 1, resolved: onchain.filter((x) => x.outcome).length } };
      if (method === "get_question") return { question: onchain[Number(args.id)] };
      if (method === "list_players") return { rows: [] };
      return {};
    },
    async send(calls: any[]) { for (const c of calls) { sent.push(c); if (c.method === "resolve_question") onchain[0].outcome = c.args.outcome === 1000 ? 1000 : c.args.outcome + 1; } return { ok: true }; },
  };
  const ctx: any = { chain, operator: OP, P, dryRun: false, problems: [] as string[], generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true };
  await tick(ctx);
  return { outcome: sent.find((c) => c.method === "resolve_question")?.args.outcome, problems: ctx.problems as string[] };
}

test("VERIFY-040: deleting only the swinging sealed reading must not silently change the posted outcome", async () => {
  const honestQ = M9vhp();
  const a = sealed(honestQ, honestQ.windowStart + 100, "100000000000000");   // unchanged
  const b = sealed(honestQ, honestQ.windowStart + 200, "150000000000000");   // +50%: honest result VOID
  honestQ.vhpReadings = [a, b];
  sealReadings(OP, honestQ);   // as the bot writes them: each reading and the whole list
  const editedQ = structuredClone(honestQ); editedQ.vhpReadings = [a];       // the push deletes b only
  const honest = await run(honestQ);
  assert.equal(honest.outcome, 1000, `setup: honest run should void (${JSON.stringify(honest)})`);
  const edited = await run(editedQ);
  const flagged = edited.problems.filter((p) => /VHP|reading|seal/i.test(p));
  assert.ok(edited.outcome === honest.outcome || flagged.length > 0,
    `VERIFY-040: deleting one sealed reading changed the posted outcome ${honest.outcome} -> ${edited.outcome} with no VHP/seal warning (problems: ${JSON.stringify(edited.problems)})`);
});
