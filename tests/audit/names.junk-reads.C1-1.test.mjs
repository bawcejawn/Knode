// tests/audit/names.junk-reads.C1-1.test.mjs   (node --import tsx --test)   Repo Lens #C-1, finding C1-1 (PN-3 residual)
// Unsigned junk claims must cause no chain read at all (the signature is checked first). Written, not run here.
import { test } from "node:test"; import assert from "node:assert/strict"; import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const N = await import(new URL("bot/names.ts", `file://${ROOT}`).href);
test("C1-1: 30 unsigned claims trigger no nickname-owner or eligibility read", async () => {
  let reads = 0;
  const owner = async () => { reads++; return null; };
  const elig = async () => { reads++; return true; };
  const issues = Array.from({ length: 30 }, (_, i) => ({ number: i + 1,
    body: `Knode Games name: Junk Name ${String.fromCharCode(65 + (i % 26))}x | 1AbcdefghijkmnopqrstuvwxyzABC | 2026-10-30\nSignature: ${"A".repeat(87)}` }));
  const r = await N.verifyIssues(null, issues, Date.parse("2026-10-30T12:00:00Z"), elig, owner);
  assert.equal(r.results.length, 30);
  assert.ok(r.results.every((x) => x.accepted === false));
  assert.equal(reads, 0, `unsigned claims caused ${reads} chain reads (a hanging first node costs 8 s each; the job has 600 s)`);
});
