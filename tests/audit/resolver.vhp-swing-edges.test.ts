// Proof test (audit fix check, AB-022): VHP-swing edge cases in the resolver.
// SAB-VHP-4/4b: dust sent to a subject whose release VHP was 0 must not void the question.
// SAB-VHP-5: the resolver itself (anyone can re-run it) only uses readings taken during the window.
// Adapted to the owner's rule (only in-window readings count): the dust readings are taken inside the window so the
// test still exercises the dust case, and SAB-VHP-5 now checks the decided boundary (a reading after windowEnd is not
// used) instead of the earlier "end reading must be at or after windowEnd".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scoreQuestion, vhpSubjects } from "../../resolver.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const byT = (t: string) => structuredClone(day.questions.find((q: any) => q.template === t));
const FILLER = "1FillerCoreProducerXXXXXXXXXXXXXXX";

/** Copied from tests/audit/open-network.test.ts: blocks where each producer signs at its published rate. */
function history(q: any) {
  const width = q.windowEnd - q.windowStart + 1;
  const sig: string[] = new Array(width).fill(FILLER);
  for (const [who, r] of Object.entries((q.model.rates ?? {}) as Record<string, number>)) {
    const n = Math.round(width * r);
    for (let j = 0; j < n; j++) {
      let i = Math.floor(((j + 0.5) * width) / n);
      while (i < width && sig[i] !== FILLER) i++;
      if (i < width) sig[i] = who;
    }
  }
  return sig.map((s, i) => ({ h: q.windowStart + i, ts: 1_792_627_200_000 + i * 3000, signer: s, ntx: 0, compute: 0 }));
}

test("SAB-VHP-4: one unit (1e-8 VHP) sent to a subject whose release VHP was 0 must not void the question", () => {
  const q = byT("M9");
  q.model.vhp = Object.fromEntries(vhpSubjects(q).map((w) => [w, "0"]));
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  const r = scoreQuestion(q, history(q), { vhpEnd: { height: q.windowEnd - 300, values: { [q.subjects[0]]: "1" } } });
  assert.ok(!(r.ok && r.result.void),
    `SAB-VHP-4: a 1e-8 VHP dust transfer voided the question (${r.ok ? r.result.reason : r.reason})`);
});

test("SAB-VHP-4b: the same dust on an M10 group member with 0 release VHP must not void the group question", () => {
  const q = byT("M10");
  const members = vhpSubjects(q);
  q.model.vhp = Object.fromEntries(members.map((w, i) => [w, i === members.length - 1 ? "0" : "100000000000000"]));
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  const end = { ...q.model.vhp, [members[members.length - 1]]: "1" };
  const r = scoreQuestion(q, history(q), { vhpEnd: { height: q.windowEnd - 300, values: end } });
  assert.ok(!(r.ok && r.result.void), `SAB-VHP-4b: dust to one zero-VHP member voided the group question (${r.ok ? r.result.reason : r.reason})`);
});

test("SAB-VHP-5: a VHP reading taken after the window's last block is not used to decide", () => {
  const q = byT("M9");
  q.model.vhp = { [q.subjects[0]]: "100000000000000" };
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  // One block after the window the subject was +50%.
  const r = scoreQuestion(q, history(q), { vhpEnd: { height: q.windowEnd + 1, values: { [q.subjects[0]]: "150000000000000" } } });
  assert.ok(r.ok && !r.result.void, `SAB-VHP-5: a reading from height ${q.windowEnd + 1} (> windowEnd ${q.windowEnd}) decided: ${r.ok ? (r.result.void ? "VOID" : "option " + r.result.option) : r.reason}`);
  assert.deepEqual(r.ok && r.result.vhpCheck?.readings, []);
});
