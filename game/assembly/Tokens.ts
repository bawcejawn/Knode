/**
 * Every token movement the game makes goes through this file.
 *
 * Production build (BUILD_FOR_TESTING = 0): real calls to the KOIN, VHP and Proof-of-Burn system contracts,
 * using exactly the patterns proven on mainnet by the probe contract:
 *   - pull a user's tokens: the user approves this contract in the same transaction, we call transfer(from → us)
 *   - burn our own KOIN into our own VHP: approve PoB for the amount, then pob.burn
 *
 * Test build (BUILD_FOR_TESTING = 1): an in-contract ledger stands in for the token contracts, so the game logic
 * can be tested end to end on a simulated chain. The offline check refuses a production build containing it.
 */
import { System, Storage, Protobuf, Token, Arrays, pob, error } from "@koinos/sdk-as";
import { kpred } from "./proto/kpred";

const POB_BURN: u32 = 0x859facc5;
const POB_REGISTER_PUBLIC_KEY: u32 = 0x53192be1;
const TEST_LEDGER_SPACE: u32 = 90;

export namespace Tokens {
  // ───────────── test ledger (BUILD_FOR_TESTING only) ─────────────
  function ledger(): Storage.Map<Uint8Array, kpred.bucket_object> {
    return new Storage.Map(System.getContractId(), TEST_LEDGER_SPACE, kpred.bucket_object.decode, kpred.bucket_object.encode, () => new kpred.bucket_object());
  }
  function lkey(tag: u8, who: Uint8Array): Uint8Array {
    const k = new Uint8Array(who.length + 1);
    k[0] = tag;
    k.set(who, 1);
    return k;
  }
  /** Test helper: set a balance (tag 1 = KOIN, 2 = VHP, 3 = Mana). */
  export function testSet(tag: u8, who: Uint8Array, amount: u64): void {
    const o = new kpred.bucket_object();
    o.stake = amount;
    ledger().put(lkey(tag, who), o);
  }
  export function testGet(tag: u8, who: Uint8Array): u64 {
    return ledger().get(lkey(tag, who))!.stake;
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
    if (BUILD_FOR_TESTING) { testMove(2, from, self, amount); return; }
    System.require(vhp().transfer(from, self, amount), "VHP transfer failed: approve this contract for the amount in the same transaction");
  }

  /** Move `amount` KOIN from a user to this contract (the user approved us in the same transaction). */
  export function pullKoin(from: Uint8Array, amount: u64): void {
    const self = System.getContractId();
    if (BUILD_FOR_TESTING) { testMove(1, from, self, amount); testMove(3, from, self, amount); return; }
    System.require(koin().transfer(from, self, amount), "KOIN transfer failed: approve this contract first and keep Mana at least equal to the amount");
  }

  export function sendVhp(to: Uint8Array, amount: u64): void {
    if (amount == 0) return;
    const self = System.getContractId();
    if (BUILD_FOR_TESTING) { testMove(2, self, to, amount); return; }
    System.require(vhp().transfer(self, to, amount), "VHP payout failed");
  }

  /** KOIN moves need Mana ≥ amount; callers cap the amount with mana() first. */
  export function sendKoin(to: Uint8Array, amount: u64): void {
    if (amount == 0) return;
    const self = System.getContractId();
    if (BUILD_FOR_TESTING) { testMove(1, self, to, amount); testMove(3, self, to, amount); return; }
    System.require(koin().transfer(self, to, amount), "KOIN payout failed");
  }

  /** Burn this contract's own KOIN into its own VHP, 1:1 (approve PoB, then pob.burn — proven on mainnet). */
  export function burnOwnKoin(amount: u64): void {
    if (amount == 0) return;
    const self = System.getContractId();
    if (BUILD_FOR_TESTING) {
      testSet(1, self, testGet(1, self) - amount);
      testSet(3, self, testGet(3, self) - amount);
      testSet(2, self, testGet(2, self) + amount);
      return;
    }
    const pobId = System.getContractAddress("pob");
    System.require(koin().approve(self, pobId, amount), "approve for Proof-of-Burn failed");
    const args = new pob.burn_arguments();
    args.token_amount = amount;
    args.burn_address = self;
    args.vhp_address = self;
    const res = System.call(pobId, POB_BURN, Protobuf.encode(args, pob.burn_arguments.encode));
    System.require(res.code == error.error_code.success, "Proof-of-Burn burn failed");
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

  /** Marker so the offline check can tell which ledger a build contains. */
  export function same(a: Uint8Array, b: Uint8Array): bool { return Arrays.equal(a, b); }
}
