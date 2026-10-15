/**
 * KPROBE — a TESTNET-ONLY probe contract.
 * Each entry point checks one capability the real prediction contract depends on:
 *   P1 info          the contract can see its own addresses, balances, mana and the block height
 *   P2 deposit_vhp   a user's VHP can be pulled in (approve + transfer in one transaction)
 *   P3 deposit_koin  a user's KOIN can be pulled in and burned into the contract's own VHP 1:1
 *   P4 withdraw_vhp  VHP can be paid back out only to the user who owns the credit
 *   P5 compound      the contract can burn its own KOIN into VHP, limited by its mana
 *   P6 register_key  the contract can register a block-producer key with Proof-of-Burn
 *   P7 ping          the contract can sponsor (pay the Mana for) a user's transaction
 *   P8 stress        Mana cost of storage writes/reads (for sizing the real contract)
 *   authorize        nobody — not even the deploy key — can move the contract's tokens or
 *                    re-upload its code without the owner's signature
 * Not for mainnet: no fees, no game logic, minimal checks.
 */
import { System, Storage, Protobuf, Token, Arrays, Crypto, authority, pob, value, error, protocol } from "@koinos/sdk-as";
import { kprobe } from "./proto/kprobe";

const POB_BURN: u32 = 0x859facc5;
const POB_REGISTER_PUBLIC_KEY: u32 = 0x53192be1;
const POB_GET_PUBLIC_KEY: u32 = 0x96634f68;
const PING_ENTRY: u32 = 0x758d61f2;

const CONFIG_SPACE: u32 = 0;
const CREDIT_SPACE: u32 = 1;
const TOTALS_SPACE: u32 = 2;
const STRESS_SPACE: u32 = 3;

export class Kprobe {
  contractId: Uint8Array;
  config: Storage.Obj<kprobe.config_object>;
  credits: Storage.Map<Uint8Array, kprobe.balance_object>;
  totals: Storage.Map<string, kprobe.balance_object>;
  scratch: Storage.Map<string, kprobe.balance_object>;

  constructor() {
    this.contractId = System.getContractId();
    this.config = new Storage.Obj(this.contractId, CONFIG_SPACE, kprobe.config_object.decode, kprobe.config_object.encode, () => new kprobe.config_object());
    this.credits = new Storage.Map(this.contractId, CREDIT_SPACE, kprobe.balance_object.decode, kprobe.balance_object.encode, () => new kprobe.balance_object());
    this.totals = new Storage.Map(this.contractId, TOTALS_SPACE, kprobe.balance_object.decode, kprobe.balance_object.encode, () => new kprobe.balance_object());
    this.scratch = new Storage.Map(this.contractId, STRESS_SPACE, kprobe.balance_object.decode, kprobe.balance_object.encode, () => new kprobe.balance_object());
  }

  // ───── helpers ─────

  koin(): Token { return new Token(System.getContractAddress("koin")); }
  vhp(): Token { return new Token(System.getContractAddress("vhp")); }

  /** True if the current transaction carries a signature from `addr`. */
  signedBy(addr: Uint8Array): bool {
    const txId = System.getTransactionField("id")!.bytes_value!;
    const sigs = Protobuf.decode<value.list_type>(System.getTransactionField("signatures")!.message_value!.value!, value.list_type.decode);
    for (let i = 0; i < sigs.values.length; i++) {
      const key = System.recoverPublicKey(sigs.values[i].bytes_value!, txId);
      if (key && Arrays.equal(Crypto.addressFromPublicKey(key!), addr)) return true;
    }
    return false;
  }

  addTotal(name: string, delta: u64): u64 {
    const t = this.totals.get(name)!;
    t.value += delta;
    this.totals.put(name, t);
    return t.value;
  }

  /** Burn `amount` of the contract's own KOIN into its own VHP via Proof-of-Burn.
   *  KOIN only lets PoB burn our tokens if we approve it first, inside this same transaction. */
  burnOwnKoin(amount: u64): void {
    const pobId = System.getContractAddress("pob");
    System.require(this.koin().approve(this.contractId, pobId, amount), "approve for PoB failed");
    const args = new pob.burn_arguments();
    args.token_amount = amount;
    args.burn_address = this.contractId;
    args.vhp_address = this.contractId;
    const res = System.call(pobId, POB_BURN, Protobuf.encode(args, pob.burn_arguments.encode));
    System.require(res.code == error.error_code.success, "PoB burn failed: " + (res.res.error ? res.res.error!.message : ""));
  }

  // ───── P1 ─────
  info(args: kprobe.info_arguments): kprobe.info_result {
    const r = new kprobe.info_result();
    r.contract = this.contractId;
    r.owner = this.config.get()!.owner;
    r.koin = System.getContractAddress("koin");
    r.vhp = System.getContractAddress("vhp");
    r.pob = System.getContractAddress("pob");
    r.koin_balance = this.koin().balanceOf(this.contractId);
    r.vhp_balance = this.vhp().balanceOf(this.contractId);
    r.mana = System.getAccountRC(this.contractId);
    r.head_height = System.getBlockField("header.height")!.uint64_value;
    r.credited_total = this.totals.get("credited")!.value;
    r.pings = this.totals.get("pings")!.value;
    const q = new pob.get_public_key_arguments();
    q.producer = this.contractId;
    const res = System.call(r.pob!, POB_GET_PUBLIC_KEY, Protobuf.encode(q, pob.get_public_key_arguments.encode));
    if (res.code == error.error_code.success && res.res.object) {
      r.producer_key = Protobuf.decode<pob.get_public_key_result>(res.res.object!, pob.get_public_key_result.decode).value;
    }
    return r;
  }

  init(args: kprobe.init_arguments): kprobe.init_result {
    const cfg = this.config.get()!;
    System.require(cfg.owner == null || cfg.owner!.length == 0, "owner already set");
    System.require(this.signedBy(this.contractId), "init must be signed by the contract's own key");
    System.require(args.owner != null && args.owner!.length > 0, "owner required");
    cfg.owner = args.owner;
    this.config.put(cfg);
    return new kprobe.init_result();
  }

  // ───── P2 ─────
  deposit_vhp(args: kprobe.deposit_vhp_arguments): kprobe.deposit_vhp_result {
    System.require(args.amount > 0, "amount must be positive");
    System.requireAuthority(authority.authorization_type.contract_call, args.from!);
    System.require(this.vhp().transfer(args.from!, this.contractId, args.amount), "VHP transfer failed — approve this contract for the amount in the same transaction");
    const c = this.credits.get(args.from!)!;
    c.value += args.amount;
    this.credits.put(args.from!, c);
    this.addTotal("credited", args.amount);
    const r = new kprobe.deposit_vhp_result();
    r.credited = c.value;
    return r;
  }

  // ───── P3 ─────
  deposit_koin(args: kprobe.deposit_koin_arguments): kprobe.deposit_koin_result {
    System.require(args.amount > 0, "amount must be positive");
    System.requireAuthority(authority.authorization_type.contract_call, args.from!);
    System.require(this.koin().transfer(args.from!, this.contractId, args.amount), "KOIN transfer failed — approve this contract for the amount in the same transaction (and keep enough mana)");
    this.burnOwnKoin(args.amount);
    const c = this.credits.get(args.from!)!;
    c.value += args.amount;
    this.credits.put(args.from!, c);
    this.addTotal("credited", args.amount);
    const r = new kprobe.deposit_koin_result();
    r.credited = c.value;
    return r;
  }

  // ───── P4 ─────
  withdraw_vhp(args: kprobe.withdraw_vhp_arguments): kprobe.withdraw_vhp_result {
    System.requireAuthority(authority.authorization_type.contract_call, args.to!);
    const c = this.credits.get(args.to!)!;
    System.require(c.value >= args.amount && args.amount > 0, "not enough credited VHP");
    c.value -= args.amount;
    this.credits.put(args.to!, c);
    const t = this.totals.get("credited")!;
    t.value -= args.amount;
    this.totals.put("credited", t);
    System.require(this.vhp().transfer(this.contractId, args.to!, args.amount), "VHP payout failed");
    return new kprobe.withdraw_vhp_result();
  }

  // ───── P5 ─────
  compound(args: kprobe.compound_arguments): kprobe.compound_result {
    const r = new kprobe.compound_result();
    const bal = this.koin().balanceOf(this.contractId);
    const mana = System.getAccountRC(this.contractId);
    r.mana_before = mana;
    if (bal <= args.keep_reserve) return r;
    let amount = bal - args.keep_reserve;
    // Burning needs mana equal to the amount, so never burn more than the mana we have.
    if (amount > mana) amount = mana;
    if (amount == 0) return r;
    this.burnOwnKoin(amount);
    r.burned = amount;
    return r;
  }

  // ───── P6 ─────
  register_key(args: kprobe.register_key_arguments): kprobe.register_key_result {
    const owner = this.config.get()!.owner;
    System.require(owner != null && this.signedBy(owner!), "only the owner can register a producer key");
    const a = new pob.register_public_key_arguments();
    a.producer = this.contractId;
    a.public_key = args.public_key;
    const res = System.call(System.getContractAddress("pob"), POB_REGISTER_PUBLIC_KEY, Protobuf.encode(a, pob.register_public_key_arguments.encode));
    System.require(res.code == error.error_code.success, "register_public_key failed: " + (res.res.error ? res.res.error!.message : ""));
    return new kprobe.register_key_result();
  }

  // ───── P7 ─────
  ping(args: kprobe.ping_arguments): kprobe.ping_result {
    const r = new kprobe.ping_result();
    r.count = this.addTotal("pings", 1);
    r.payer = System.getTransactionField("header.payer")!.bytes_value!;
    return r;
  }

  // ───── P8 ─────
  stress(args: kprobe.stress_arguments): kprobe.stress_result {
    let sum: u64 = 0;
    for (let i: u32 = 0; i < args.writes; i++) {
      const v = new kprobe.balance_object();
      v.value = <u64>i;
      this.scratch.put(i.toString(), v);
    }
    for (let i: u32 = 0; i < args.bins; i++) sum += this.scratch.get(i.toString())!.value;
    const r = new kprobe.stress_result();
    r.sum = sum;
    return r;
  }

  // ───── authorize: who may act for this contract's address ─────
  authorize(args: authority.authorize_arguments): authority.authorize_result {
    // Paying for transactions: only a single operation that calls this contract's ping.
    if (args.type == authority.authorization_type.transaction_application) {
      const ops = Protobuf.decode<value.list_type>(System.getTransactionField("operations")!.message_value!.value!, value.list_type.decode);
      if (ops.values.length != 1) return new authority.authorize_result(false);
      const op = Protobuf.decode<protocol.operation>(ops.values[0].message_value!.value!, protocol.operation.decode);
      const ok = op.call_contract != null
        && Arrays.equal(op.call_contract!.contract_id, this.contractId)
        && op.call_contract!.entry_point == PING_ENTRY;
      return new authority.authorize_result(ok);
    }
    // Re-uploading the code: only with the owner's signature.
    if (args.type == authority.authorization_type.contract_upload) {
      const owner = this.config.get()!.owner;
      return new authority.authorize_result(owner != null && owner!.length > 0 && this.signedBy(owner!));
    }
    // Moving the contract's tokens from outside: never. (Calls the contract makes itself don't come here.)
    return new authority.authorize_result(false);
  }
}
