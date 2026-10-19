import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPOUND_GRACE_BLOCKS, CONTRACT_MANA_MIN, contractManaVerdict } from "./mana.ts";

const KOIN = 100_000_000n;
const SEED = 50n * KOIN;
const H = 40_000_000;

test("enough Mana is fine, with or without a recent compound", () => {
  assert.equal(contractManaVerdict(CONTRACT_MANA_MIN, SEED, H, 0), "ok");
  assert.equal(contractManaVerdict(127n * KOIN, SEED, H, H - 10), "ok");
});

test("no seed yet: the contract Mana check is off", () => {
  assert.equal(contractManaVerdict(0n, 0n, H, 0), "ok");
});

test("low Mana right after a compound (same tick) is only a warning", () => {
  assert.equal(contractManaVerdict(0n, SEED, H, H), "after-compound");
  assert.equal(contractManaVerdict(CONTRACT_MANA_MIN - 1n, SEED, H, H - 100), "after-compound");
});

test("low Mana up to ~6 hours after a compound is still only a warning", () => {
  assert.equal(COMPOUND_GRACE_BLOCKS, 7_200);
  assert.equal(contractManaVerdict(KOIN, SEED, H, H - COMPOUND_GRACE_BLOCKS), "after-compound");
});

test("low Mana with no recent compound to explain it fails the run", () => {
  assert.equal(contractManaVerdict(KOIN, SEED, H, H - COMPOUND_GRACE_BLOCKS - 1), "low");
  assert.equal(contractManaVerdict(KOIN, SEED, H, 0), "low");               // never compounded
  assert.equal(contractManaVerdict(KOIN, SEED, H, H + 5), "low");           // a bad saved height explains nothing
});
