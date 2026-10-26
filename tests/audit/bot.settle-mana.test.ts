// Red team (SABOTEUR persona) attack tests, Knode commit 6b37c46.
// Attack: starve the operator bot of Mana so it can no longer resolve questions (a week then cannot close
// until the owner voids every open question by hand).
//   settlePass (bot/bot.ts ~455-470) sends one settle per staked, unsettled entry. It asks the pool to pay
//   (sponsored); whenever the pool declines (for example because its Mana was drained, see
//   Kpred.redteam-sponsor-drain.spec.ts and AB-003), sendOp (bot/bot.ts ~133-142) silently re-sends the same
//   transaction paid by the OPERATOR. A saboteur with N minimum-stake accounts (1 VHP each, recoverable)
//   turns that into N operator-paid transactions every week, with no cap and no Mana kept back for
//   resolve_question / post_question.
// Also: the docs say the project "is not paying anyone's Mana right now", but sponsorship is decided by the
// contract, not the website: anyone can name the contract as payer while max_sponsor_rc > 0.
// Asserts the SAFE behaviour: FAILS while the attack works. Runs the real bot tick on an in-memory fake chain
// (no network; the key below is a throwaway test seed, nothing is signed for a real chain).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Signer } from "koilib";
import { tick, paths } from "../../bot/bot.ts";

const N = 120;
const sybils = Array.from({ length: N }, (_, i) => `1Sybil${String(i).padStart(4, "0")}`);

test("SABOTEUR: when the pool declines to sponsor, the bot does not spend its own Mana on every sybil's settle", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-settle-"));
  const P = paths(dir);
  fs.mkdirSync(P.questions, { recursive: true });
  const time = 1_700_000_000_000;
  let botPaid = 0, sponsoredTried = 0;
  const chain: any = {
    kind: "sim", contractId: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr",
    async head() { return { height: 41_000_000, lib: 40_999_900 }; },
    async mana() { return 10n ** 12n; },
    async read(method: string, args: any) {
      if (method === "get_state") return { height: "41000000", time: String(time),
        config: { owner: "1Owner", operator: "1Op", genesis_time: "1800000000000", week_length: String(7 * 86400000), close_delay: "43200000", min_stake: "100000000" },
        totals: { weeks_closed: "1", weeks_finalized: "0", next_question_id: 0 }, koin_balance: "0" };
      if (method === "get_week") return { week: { questions: 0, resolved: 0, closed: true, settle_start: String(time - 1000), settle_end: String(time + 86_400_000) } };
      if (method === "list_players") {
        const from = args.start ? sybils.indexOf(args.start) + 1 : 0;
        return { rows: sybils.slice(from, from + Number(args.limit)).map((a) => ({ address: a, entry: { settled: false, stake: "100000000" } })) };
      }
      return {};
    },
    async send(calls: any[], _signers: any[], opts: any = {}) {
      if (calls.some((c) => c.method !== "settle")) return { ok: true };
      if (opts.sponsored) { sponsoredTried++; return { ok: false, error: "the contract declined to pay (Mana exhausted)" }; }
      botPaid++;
      return { ok: true, rcUsed: "3000000" };
    },
  };
  const ctx: any = { chain, operator: Signer.fromSeed("redteam-test-only"), P, dryRun: false, problems: [],
    generator: () => ({ ok: true, output: "" }), checkpoint: () => {}, quiet: true };
  await tick(ctx);
  assert.equal(sponsoredTried, N, "(context) the bot tried to settle every staked sybil entry");
  assert.ok(botPaid <= 10,
    `SABOTEUR: the bot paid its own Mana for ${botPaid} settle transactions of 1-VHP accounts in one run (no cap, nothing kept for resolve_question)`);
});

test("SABOTEUR: the live pool does not pay Mana for strangers while the docs say nobody's Mana is paid", () => {
  const dep = JSON.parse(fs.readFileSync("game-data/deployment.json", "utf8"));
  const docs = fs.readFileSync("docs/history/security-audit.md", "utf8");
  const claimsOff = /not paying anyone's Mana right now/i.test(docs);
  assert.ok(!claimsOff || BigInt(dep.maxSponsorRc ?? 0) === 0n,
    `SABOTEUR: docs say the project pays nobody's Mana, but max_sponsor_rc is ${dep.maxSponsorRc} (any staked account can name the contract as payer)`);
});
