// RepoLens fix-check 3 (V3-10, V3-12): the upgrade command's local-build guards, as one tested function.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { upgradeGuard } from "../../bot/bot.ts";

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const normal = Buffer.from("normal build bytes"), safe = Buffer.from("safe build bytes");
const testBuild = Buffer.concat([Buffer.from("x"), Buffer.from("TEST LEDGER", "utf16le")]);
const MODE_OK = "// comment\nexport const SAFE_MODE: bool = false;\n";
const dep = { safeWasmSha256: sha(safe) };

test("a normal upgrade: the normal build passes; the safe build, the pinned hash, the test build and a switched Mode.ts are refused", () => {
  assert.equal(upgradeGuard(normal, false, dep, safe, MODE_OK), "");
  assert.equal(upgradeGuard(normal, false, dep, safe, MODE_OK.replace(/\n/g, "\r\n")), "", "Windows line endings");
  assert.match(upgradeGuard(safe, false, dep, safe, MODE_OK), /withdrawals-only/);
  assert.match(upgradeGuard(safe, false, dep, null, MODE_OK), /withdrawals-only/, "caught by the pinned hash with no local safe file");
  assert.match(upgradeGuard(testBuild, false, dep, null, MODE_OK), /TEST build/);
  assert.match(upgradeGuard(normal, false, dep, null, "export const SAFE_MODE: bool = true;\n"), /Mode\.ts/);
  assert.match(upgradeGuard(normal, false, dep, null, "// export const SAFE_MODE: bool = false;\nexport const SAFE_MODE: bool = true;\n"), /Mode\.ts/, "a commented-out false line doesn't count");
});

test("a safe upgrade: only the pinned fingerprint", () => {
  assert.equal(upgradeGuard(safe, true, dep, safe, MODE_OK), "");
  assert.match(upgradeGuard(normal, true, dep, safe, MODE_OK), /not the pinned/);
  assert.match(upgradeGuard(safe, true, {}, safe, MODE_OK), /no safeWasmSha256/);
});
