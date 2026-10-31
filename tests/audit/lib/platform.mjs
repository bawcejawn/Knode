// What the Last Node tests need from the machine, so a run on Windows skips (with a reason) what only Linux can do,
// instead of failing. The reviewer and GitHub Actions run them all on Linux.
import { spawnSync } from "node:child_process";
import { test } from "node:test";
/** A Python 3 to run the publish job's Python with: python3 (Linux, macOS), else python or py (Windows). */
export const PY = ["python3", "python", "py"].find((c) => {
  const r = spawnSync(c, ["-c", "import sys; assert sys.version_info >= (3, 8); print('ok')"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "ok";
}) || null;
/** The publish job's shell is bash on Linux (GitHub's runner); on Windows those tests are skipped. */
export const BASH = process.platform !== "win32";
/** test() when the machine has what it needs, else a skipped test that says why. */
export const needs = (ok, why) => (ok ? test : (name, ...rest) => test(name, { skip: why }, rest[rest.length - 1]));
export const withPython = needs(!!PY, "needs Python 3 (python3, python or py)");
export const withBash = needs(BASH && !!PY, "the publish job's bash steps run on Linux only (GitHub Actions)");
