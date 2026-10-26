import { System, Storage, Protobuf, Crypto, Arrays, authority, value, protocol, error } from "@koinos/sdk-as";
import { sponsor } from "./proto/sponsor";

/**
 * Knode mana sponsor. See assembly/proto/sponsor.proto for the rules.
 * Ported from the SwarmTales sponsor; adds a per-player weekly cap, a read-only would_pay, refuses any signature
 * other than the player's (the owner's own transactions excepted), and pays only for real Knode players (audit M-1).
 *
 * Uploaded onto a fresh wallet with ONLY the transaction-application override on. Settings and moving KOIN out use
 * the wallet's own key, as for any wallet.
 */

const CONFIG_SPACE = 0;
const ACCOUNT_USAGE_SPACE = 1;
const TOTAL_USAGE_SPACE = 2;

const ADDRESS_LENGTH = 25;
const SIGNATURE_LENGTH = 65;
const MAX_TOKENS = 4;
const MAX_OPERATIONS = 10;
const MS_PER_DAY: u64 = 86400000;
/** KCS-4 approve entry point. */
export const APPROVE_ENTRY: u32 = 0x74e21680;
/** No cap may be above this (1,000 Mana a day for everyone; 1 Mana = 100000000), so a typo can't open the tap. */
export const CAP_LIMIT: u64 = 100000000000;

// The player actions the sponsor pays for (entry points = the first 4 bytes of sha256 of the method name; the same in
// game v3 and v5, and in the Desk v1 and v2). Owner, operator and seed actions are never sponsored.
export const GAME_DEPOSIT_VHP: u32 = 0x8ed1d782;
export const GAME_DEPOSIT_KOIN: u32 = 0x1fca9c49;
export const GAME_WITHDRAW: u32 = 0xc26f22db;
export const GAME_ANSWER: u32 = 0x0db52f40;
export const GAME_SETTLE: u32 = 0x6868e83d;
export const GAME_CLAIM: u32 = 0xdd1b3c31;
export const GAME_CLOSE_WEEK: u32 = 0x250d08be;
export const GAME_FINALIZE_WEEK: u32 = 0x8c516995;
export const DESK_SWAP: u32 = 0xda47c2f4;
/** Read-only entry points used by the player check. */
export const TOKEN_BALANCE_OF: u32 = 0x5c721497;
export const GAME_GET_PLAYER: u32 = 0x37ce3085;
export const NOT_A_PLAYER = "SPONSOR: only players who hold VHP or have a Knode stake are sponsored";

/** UTC day number of a time in ms. */
export function dayOf(ms: u64): u64 {
  return ms / MS_PER_DAY;
}
/** Week number with weeks starting Monday 00:00 UTC (day 0, 1970-01-01, was a Thursday). */
export function weekOf(ms: u64): u64 {
  return (dayOf(ms) + 3) / 7;
}

export class Sponsor {
  contractId: Uint8Array = System.getContractId();

  config: Storage.Obj<sponsor.config> = new Storage.Obj(
    this.contractId,
    CONFIG_SPACE,
    sponsor.config.decode,
    sponsor.config.encode,
    () => new sponsor.config()
  );

  accountUsage: Storage.Map<Uint8Array, sponsor.usage> = new Storage.Map(
    this.contractId,
    ACCOUNT_USAGE_SPACE,
    sponsor.usage.decode,
    sponsor.usage.encode,
    () => new sponsor.usage()
  );

  totalUsage: Storage.Obj<sponsor.usage> = new Storage.Obj(
    this.contractId,
    TOTAL_USAGE_SPACE,
    sponsor.usage.decode,
    sponsor.usage.encode,
    () => new sponsor.usage()
  );

  /**
   * Called by the chain when a transaction names this wallet as payer. Fails with a "SPONSOR: ..." message (so the
   * site can tell, and fall back to the player's own Mana) instead of returning false.
   */
  authorize(args: authority.authorize_arguments): authority.authorize_result {
    if (args.type != authority.authorization_type.transaction_application) {
      return new authority.authorize_result(false);
    }
    const signed = signatureAddresses();
    // The owner's own transactions (settings, top-ups, moving KOIN out).
    if (contains(signed, this.contractId)) return new authority.authorize_result(true);

    const cfg = this.config.get()!;
    System.require(cfg.enabled, "SPONSOR: switched off");

    const rcField = System.getTransactionField("header.rc_limit");
    const rcLimit: u64 = rcField ? rcField.uint64_value : 0;
    System.require(rcLimit > 0 && rcLimit <= cfg.max_mana_per_tx, "SPONSOR: mana limit above the per-transaction cap");

    const payeeField = System.getTransactionField("header.payee");
    const payee = payeeField && payeeField.bytes_value ? payeeField.bytes_value! : new Uint8Array(0);
    System.require(payee.length == ADDRESS_LENGTH, "SPONSOR: the transaction must name the player as payee");
    System.require(!Arrays.equal(payee, this.contractId), "SPONSOR: the sponsor can't be the payee");
    System.require(contains(signed, payee), "SPONSOR: the payee must sign");
    // Only the player signs a player's transaction. A second signer would let one sponsored transaction act for
    // several wallets while counting against one wallet's caps.
    System.require(signed.length == 1, "SPONSOR: only the payee may sign");

    const tx = System.getTransaction();
    const ops = tx.operations;
    System.require(ops.length > 0 && ops.length <= MAX_OPERATIONS, "SPONSOR: 1 to 10 operations");
    for (let i = 0; i < ops.length; i++) {
      checkOperation(ops[i], cfg, payee);
    }

    // Last of the checks, so a transaction refused for any other reason costs no reads.
    System.require(isPlayer(cfg, payee), NOT_A_PLAYER);

    const now = System.getHeadInfo().head_block_time;
    const day = dayOf(now), week = weekOf(now);

    const mine = this.accountUsage.get(payee)!;
    const mineDay: u64 = mine.day == day ? mine.used_day : 0;
    const mineWeek: u64 = mine.week == week ? mine.used_week : 0;
    System.require(
      mineDay <= cfg.max_mana_per_account_day && rcLimit <= cfg.max_mana_per_account_day - mineDay,
      "SPONSOR: this player's daily sponsored mana is used up"
    );
    System.require(
      mineWeek <= cfg.max_mana_per_account_week && rcLimit <= cfg.max_mana_per_account_week - mineWeek,
      "SPONSOR: this player's weekly sponsored mana is used up"
    );
    const all = this.totalUsage.get()!;
    const allDay: u64 = all.day == day ? all.used_day : 0;
    System.require(
      allDay <= cfg.max_mana_per_day && rcLimit <= cfg.max_mana_per_day - allDay,
      "SPONSOR: today's sponsored mana is used up"
    );
    this.accountUsage.put(payee, new sponsor.usage(day, mineDay + rcLimit, week, mineWeek + rcLimit));
    this.totalUsage.put(new sponsor.usage(day, allDay + rcLimit, 0, 0));
    return new authority.authorize_result(true);
  }

  get_config(args: sponsor.get_config_arguments): sponsor.config {
    return this.config.get()!;
  }

  /** Usage as of the head block: a past day's or week's numbers read as 0. */
  get_usage(args: sponsor.get_usage_arguments): sponsor.usage {
    System.require(args.account != null, "SPONSOR: account missing");
    const u = this.accountUsage.get(args.account!)!;
    const now = System.getHeadInfo().head_block_time;
    const day = dayOf(now), week = weekOf(now);
    return new sponsor.usage(day, u.day == day ? u.used_day : 0, week, u.week == week ? u.used_week : 0);
  }

  get_total_usage(args: sponsor.get_total_usage_arguments): sponsor.usage {
    const u = this.totalUsage.get()!;
    const day = dayOf(System.getHeadInfo().head_block_time);
    return new sponsor.usage(day, u.day == day ? u.used_day : 0, 0, 0);
  }

  /** The caps and the on/off switch only: what the website asks before choosing the sponsor as payer. */
  would_pay(args: sponsor.would_pay_arguments): sponsor.would_pay_result {
    const cfg = this.config.get()!;
    const out = new sponsor.would_pay_result();
    if (args.account == null || args.account!.length != ADDRESS_LENGTH) { out.reason = "account missing"; return out; }
    const u = this.get_usage(new sponsor.get_usage_arguments(args.account));
    const t = this.get_total_usage(new sponsor.get_total_usage_arguments());
    const leftDay = cfg.max_mana_per_account_day > u.used_day ? cfg.max_mana_per_account_day - u.used_day : 0;
    const leftWeek = cfg.max_mana_per_account_week > u.used_week ? cfg.max_mana_per_account_week - u.used_week : 0;
    const leftAll = cfg.max_mana_per_day > t.used_day ? cfg.max_mana_per_day - t.used_day : 0;
    out.left_today = leftDay < leftAll ? leftDay : leftAll;
    out.left_this_week = leftWeek;
    const rc = args.rc_limit;
    if (!cfg.enabled) out.reason = "switched off";
    else if (rc == 0 || rc > cfg.max_mana_per_tx) out.reason = "mana limit above the per-transaction cap";
    else if (rc > leftDay) out.reason = "this player's daily sponsored mana is used up";
    else if (rc > leftWeek) out.reason = "this player's weekly sponsored mana is used up";
    else if (rc > leftAll) out.reason = "today's sponsored mana is used up";
    else if (!isPlayer(cfg, args.account!)) out.reason = "only players who hold VHP or have a Knode stake are sponsored";
    else out.ok = true;
    return out;
  }

  set_config(args: sponsor.set_config_arguments): sponsor.empty_object {
    System.require(
      System.checkAuthority(authority.authorization_type.contract_call, this.contractId),
      "SPONSOR: needs the sponsor wallet's own key"
    );
    System.require(args.config != null, "SPONSOR: config missing");
    const cfg = args.config!;
    System.require(isAddress(cfg.game) && isAddress(cfg.desk), "SPONSOR: invalid contract address");
    System.require(!Arrays.equal(cfg.game, cfg.desk), "SPONSOR: the game and Knode Swap must differ");
    System.require(
      !Arrays.equal(cfg.game!, this.contractId) && !Arrays.equal(cfg.desk!, this.contractId),
      "SPONSOR: the sponsor can't be a Knode contract"
    );
    System.require(cfg.tokens.length <= MAX_TOKENS, "SPONSOR: at most 4 tokens");
    for (let i = 0; i < cfg.tokens.length; i++) {
      const t = cfg.tokens[i];
      System.require(isAddress(t), "SPONSOR: invalid token address");
      System.require(
        !Arrays.equal(t, cfg.game!) && !Arrays.equal(t, cfg.desk!) && !Arrays.equal(t, this.contractId),
        "SPONSOR: a token can't be a Knode contract or the sponsor"
      );
      for (let j = 0; j < i; j++) System.require(!Arrays.equal(t, cfg.tokens[j]), "SPONSOR: duplicate token");
    }
    System.require(
      cfg.max_mana_per_tx <= cfg.max_mana_per_account_day &&
        cfg.max_mana_per_account_day <= cfg.max_mana_per_account_week &&
        cfg.max_mana_per_account_day <= cfg.max_mana_per_day,
      "SPONSOR: caps must be per transaction <= per player per day <= per player per week, and per player per day <= per day"
    );
    System.require(cfg.max_mana_per_day <= CAP_LIMIT, "SPONSOR: daily cap above 1,000 mana");
    System.require(cfg.max_mana_per_account_week <= 7 * CAP_LIMIT, "SPONSOR: weekly cap above 7,000 mana");
    System.require(!cfg.enabled || cfg.max_mana_per_tx > 0, "SPONSOR: switched on with a zero cap");
    System.require(!cfg.enabled || (isAddress(cfg.vhp) && contains(cfg.tokens, cfg.vhp!) && cfg.min_vhp > 0),
      "SPONSOR: switched on without the VHP token (one of the tokens) and a minimum above 0");
    this.config.put(cfg);
    const ev = new sponsor.config_event(cfg);
    System.event("sponsor.config_event", Protobuf.encode(ev, sponsor.config_event.encode), [this.contractId]);
    return new sponsor.empty_object();
  }
}

/**
 * A real Knode player (audit M-1): holds at least min_vhp VHP, or has a stake (active or pending) in the game.
 * Read-only calls to the configured VHP token and game. Any failed or unreadable read counts as "no" (fails closed).
 */
function isPlayer(cfg: sponsor.config, account: Uint8Array): bool {
  if (cfg.vhp == null || cfg.game == null || cfg.min_vhp == 0) return false;
  const b = System.call(cfg.vhp!, TOKEN_BALANCE_OF,
    Protobuf.encode(new sponsor.balance_of_args(account), sponsor.balance_of_args.encode));
  if (b.code == error.error_code.success && b.res.object != null) {
    const r = Protobuf.decode<sponsor.balance_of_result>(b.res.object!, sponsor.balance_of_result.decode);
    if (r.value >= cfg.min_vhp) return true;
  }
  const g = System.call(cfg.game!, GAME_GET_PLAYER,
    Protobuf.encode(new sponsor.game_get_player_args(account, 0), sponsor.game_get_player_args.encode));
  if (g.code != error.error_code.success || g.res.object == null) return false;
  const p = Protobuf.decode<sponsor.game_get_player_result>(g.res.object!, sponsor.game_get_player_result.decode);
  return p.player != null && (p.player!.stake > 0 || p.player!.pending > 0);
}

function isGameAction(entry: u32): bool {
  return entry == GAME_DEPOSIT_VHP || entry == GAME_DEPOSIT_KOIN || entry == GAME_WITHDRAW || entry == GAME_ANSWER ||
    entry == GAME_SETTLE || entry == GAME_CLAIM || entry == GAME_CLOSE_WEEK || entry == GAME_FINALIZE_WEEK;
}

/** One operation is sponsored only if it is a player action on the game or Knode Swap, or approves one of them. */
function checkOperation(op: protocol.operation, cfg: sponsor.config, payee: Uint8Array): void {
  System.require(
    op.upload_contract == null && op.set_system_call == null && op.set_system_contract == null && op.call_contract != null,
    "SPONSOR: only contract calls are sponsored"
  );
  const call = op.call_contract!;
  System.require(call.contract_id != null, "SPONSOR: call without a contract");
  const target = call.contract_id!;
  if (Arrays.equal(target, cfg.game!)) {
    System.require(isGameAction(call.entry_point), "SPONSOR: only player actions on the game are sponsored");
    return;
  }
  if (Arrays.equal(target, cfg.desk!)) {
    System.require(call.entry_point == DESK_SWAP, "SPONSOR: only swaps on Knode Swap are sponsored");
    return;
  }
  System.require(contains(cfg.tokens, target), "SPONSOR: only Knode calls are sponsored");
  System.require(call.entry_point == APPROVE_ENTRY, "SPONSOR: only approve is sponsored on a token");
  const a = Protobuf.decode<sponsor.approve_args>(call.args ? call.args! : new Uint8Array(0), sponsor.approve_args.decode);
  System.require(
    a.spender != null && (Arrays.equal(a.spender!, cfg.game!) || Arrays.equal(a.spender!, cfg.desk!)),
    "SPONSOR: approve must name the game or Knode Swap as spender"
  );
  System.require(a.owner != null && Arrays.equal(a.owner!, payee), "SPONSOR: approve must be for the payee's own tokens");
}

/** A Koinos address: version 0, 20-byte hash, 4-byte double-sha256 checksum. */
function isAddress(a: Uint8Array | null): bool {
  if (a == null) return false;
  const b = a!;
  if (b.length != ADDRESS_LENGTH || b[0] != 0) return false;
  const once = System.hash(Crypto.multicodec.sha2_256, b.subarray(0, 21));
  if (!once) return false;
  const twice = System.hash(Crypto.multicodec.sha2_256, once.subarray(2));
  if (!twice) return false;
  for (let i = 0; i < 4; i++) {
    if (twice[2 + i] != b[21 + i]) return false;
  }
  return true;
}

function contains(list: Uint8Array[], item: Uint8Array): bool {
  for (let i = 0; i < list.length; i++) {
    if (Arrays.equal(list[i], item)) return true;
  }
  return false;
}

/** Distinct addresses recovered from this transaction's signatures. */
function signatureAddresses(): Uint8Array[] {
  const out: Uint8Array[] = [];
  const field = System.getTransactionField("signatures");
  if (!field || !field.message_value) return out;
  const list = Protobuf.decode<value.list_type>(field.message_value!.value!, value.list_type.decode);
  const id = System.getTransactionField("id");
  if (!id || !id.bytes_value) return out;
  const txId = id.bytes_value!;
  for (let i = 0; i < list.values.length; i++) {
    const raw = list.values[i].bytes_value;
    // A signature that isn't 65 bytes or doesn't recover still counts as "someone else signed": fail closed.
    if (!raw || raw.length != SIGNATURE_LENGTH) { out.push(new Uint8Array(0)); continue; }
    const publicKey = System.recoverPublicKey(raw, txId);
    if (!publicKey) { out.push(new Uint8Array(0)); continue; }
    const a = Crypto.addressFromPublicKey(publicKey);
    if (!contains(out, a)) out.push(a);
  }
  return out;
}
