/**
 * Every token movement the swap desk makes goes through this file.
 *
 * Production build (BUILD_FOR_TESTING = 0): real calls to the KOIN, VHP and Proof-of-Burn system contracts, using
 * exactly the patterns the probe contract proved on mainnet:
 *   - pull a user's VHP: the user approves this contract in the same transaction, we call transfer(user → us)
 *   - send our KOIN: needs our Mana ≥ the amount, so callers cap the amount with mana() first
 *   - register the block-producer key with Proof-of-Burn
 *
 * Test build (BUILD_FOR_TESTING = 1): an in-contract ledger stands in for the token contracts, so the desk can be
 * tested on a simulated chain. The offline check refuses a production build containing it.
 */
import { System, Storage, Protobuf, Token, pob, error } from "@koinos/sdk-as";
import { desk } from "./proto/desk";

const POB_REGISTER_PUBLIC_KEY: u32 = 0x53192be1;
const TEST_LEDGER_SPACE: u32 = 90;

export namespace Tokens {
  // ───────────── test ledger (BUILD_FOR_TESTING only) ─────────────
  function ledger(): Storage.Map<Uint8Array, desk.ledger_object> {
    return new Storage.Map(System.getContractId(), TEST_LEDGER_SPACE, desk.ledger_object.decode, desk.ledger_object.encode, () => new desk.ledger_object());
  }
  function lkey(tag: u8, who: Uint8Array): Uint8Array {
    const k = new Uint8Array(who.length + 1);
    k[0] = tag;
    k.set(who, 1);
    return k;
  }
  /** Test helper: set a balance (tag 1 = KOIN, 2 = VHP, 3 = Mana, 4 = VHP allowance given to the desk). */
  export function testSet(tag: u8, who: Uint8Array, amount: u64): void {
    const o = new desk.ledger_object();
    o.amount = amount;
    ledger().put(lkey(tag, who), o);
  }
  export function testGet(tag: u8, who: Uint8Array): u64 {
    return ledger().get(lkey(tag, who))!.amount;
  }
  function testMove(tag: u8, from: Uint8Array, to: Uint8Array, amount: u64): void {
    const f = testGet(tag, from);
    System.require(f >= amount, "TEST LEDGER: insufficient balance");
    testSet(tag, from, f - amount);
    testSet(tag, to, testGet(tag, to) + amount);
  }

  // ───────────── real tokens ─────────────
  function koin(): Token { return new Token(System.getContractAddress("koin")); }
  function vhp(): Token { return new Token(System.getContractAddress("vhp")); }

  export function koinBalance(who: Uint8Array): u64 {
    if (BUILD_FOR_TESTING) return testGet(1, who);
    return koin().balanceOf(who);
  }

  export function vhpBalance(who: Uint8Array): u64 {
    if (BUILD_FOR_TESTING) return testGet(2, who);
    return vhp().balanceOf(who);
  }

  /** Mana (resource credits) of an account. */
  export function mana(who: Uint8Array): u64 {
    if (BUILD_FOR_TESTING) return testGet(3, who);
    return System.getAccountRC(who);
  }

  /** Move `amount` VHP from a user to this contract (the user approved us in the same transaction). */
  export function pullVhp(from: Uint8Array, amount: u64): void {
    const self = System.getContractId();
    if (BUILD_FOR_TESTING) {
      // Simulate the real token's allowance check: without an approval the transfer fails.
      const allowed = testGet(4, from);
      System.require(allowed >= amount, "TEST LEDGER: VHP transfer failed: no approval");
      testSet(4, from, allowed - amount);
      testMove(2, from, self, amount);
      return;
    }
    System.require(vhp().transfer(from, self, amount), "VHP transfer failed: approve this contract for the amount in the same transaction");
  }

  export function sendVhp(to: Uint8Array, amount: u64): void {
    if (amount == 0) return;
    const self = System.getContractId();
    if (BUILD_FOR_TESTING) { testMove(2, self, to, amount); return; }
    System.require(vhp().transfer(self, to, amount), "VHP transfer failed");
  }

  /** KOIN moves need Mana ≥ amount; callers cap the amount with mana() first. */
  export function sendKoin(to: Uint8Array, amount: u64): void {
    if (amount == 0) return;
    const self = System.getContractId();
    if (BUILD_FOR_TESTING) { testMove(1, self, to, amount); testMove(3, self, to, amount); return; }
    System.require(koin().transfer(self, to, amount), "KOIN transfer failed");
  }

  /** Register this contract's block-producer key with Proof-of-Burn. */
  export function registerProducerKey(publicKey: Uint8Array): void {
    if (BUILD_FOR_TESTING) return;
    const a = new pob.register_public_key_arguments();
    a.producer = System.getContractId();
    a.public_key = publicKey;
    const res = System.call(System.getContractAddress("pob"), POB_REGISTER_PUBLIC_KEY, Protobuf.encode(a, pob.register_public_key_arguments.encode));
    System.require(res.code == error.error_code.success, "register_public_key failed");
  }
}
