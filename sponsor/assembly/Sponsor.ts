import { System, Storage, Protobuf, Crypto, Arrays, authority, value, protocol, error } from "@koinos/sdk-as";
import { sponsor } from "./proto/sponsor";

/**
 * Knode mana sponsor. See assembly/proto/sponsor.proto for the rules.
 * Ported from the SwarmTales sponsor; adds a per-player weekly cap, a read-only would_pay, refuses any signature
 * other than the player's (the owner's own transactions excepted), and pays only for real Knode players (audit M-1),
 * except that free play (game answers, and Producer Race picks since v2) is paid for anyone within a daily
 * free-player sub-cap (owner's decisions 2026-10-26 and 2026-10-27).
 *
 * Uploaded onto a fresh wallet with ONLY the transaction-application override on. Settings and moving KOIN out use
 * the wallet's own key, as for any wallet.
 */

const CONFIG_SPACE = 0;
const ACCOUNT_USAGE_SPACE = 1;
const TOTAL_USAGE_SPACE = 2;
const FREE_USAGE_SPACE = 3;

const ADDRESS_LENGTH = 25;
const SIGNATURE_LENGTH = 65;
const MAX_TOKENS = 4;
const MAX_OPERATIONS = 10;
/** v3: at most 8 allowlisted player actions, each with at most 16 argument fields. */
export const MAX_ALLOWED = 8;
export const MAX_ARG_FIELDS = 16;
/** Most argument bytes in an allowlisted call (or a free claim). */
export const MAX_ARGS_BYTES = 400;
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
/** Producer Race `pick` (race/abi/race.koilib.json). */
export const RACE_PICK: u32 = 0x8ce33c6c;
/** Read-only entry points used by the player check. */
export const TOKEN_BALANCE_OF: u32 = 0x5c721497;
export const GAME_GET_PLAYER: u32 = 0x37ce3085;
export const NOT_A_PLAYER = "SPONSOR: only players who hold VHP or have a Knode stake are sponsored";
export const FREE_USED_UP = "SPONSOR: today's free-player answers and picks are used up";

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

  /** Everyone's Mana today for answers by free (non-player) wallets: day and used_day only. */
  freeUsage: Storage.Obj<sponsor.usage> = new Storage.Obj(
    this.contractId,
    FREE_USAGE_SPACE,
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
    let answerOnly = true;    // free play only: game answers and race picks
    for (let i = 0; i < ops.length; i++) {
      checkOperation(ops[i], cfg, payee);
      if (!isFreePlay(ops[i], cfg, payee)) answerOnly = false;
    }

    const now = System.getHeadInfo().head_block_time;
    const day = dayOf(now), week = weekOf(now);

    // The caps that don't depend on who the player is come first, so a transaction they refuse costs no reads.
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

    // Last, the player rule (the only check that reads other contracts). Anything but answers: real players only,
    // and a failed read fails closed. Answers: anyone, but a wallet that isn't a real player (or can't be read)
    // also counts against everyone's free sub-cap.
    const player = isPlayer(cfg, payee);
    if (!answerOnly) System.require(player, NOT_A_PLAYER);
    if (!player) {
      const fr = this.freeUsage.get()!;
      const freeDay: u64 = fr.day == day ? fr.used_day : 0;
      System.require(
        freeDay <= cfg.max_mana_free_day && rcLimit <= cfg.max_mana_free_day - freeDay,
        FREE_USED_UP
      );
      this.freeUsage.put(new sponsor.usage(day, freeDay + rcLimit, 0, 0));
    }

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

  /** Everyone's Mana today for answers by free (non-player) wallets. */
  get_free_usage(args: sponsor.get_free_usage_arguments): sponsor.usage {
    const u = this.freeUsage.get()!;
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
    else {
      const player = isPlayer(cfg, args.account!);
      out.free = !player;
      const f = this.get_free_usage(new sponsor.get_free_usage_arguments());
      out.left_free_today = cfg.max_mana_free_day > f.used_day ? cfg.max_mana_free_day - f.used_day : 0;
      if (player) out.ok = true;
      else if (!args.answer_only) out.reason = "only players who hold VHP or have a Knode stake are sponsored";
      else if (rc > out.left_free_today) out.reason = "today's free-player answers and picks are used up";
      else out.ok = true;
    }
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
    // The race contract is optional; when set it must be a real address and not any other Knode contract or the sponsor.
    const hasRace = cfg.race != null && cfg.race!.length > 0;
    if (hasRace) {
      System.require(isAddress(cfg.race), "SPONSOR: invalid race contract address");
      System.require(
        !Arrays.equal(cfg.race!, cfg.game!) && !Arrays.equal(cfg.race!, cfg.desk!) && !Arrays.equal(cfg.race!, this.contractId),
        "SPONSOR: the race contract must differ from the game, Knode Swap and the sponsor"
      );
    }
    System.require(cfg.tokens.length <= MAX_TOKENS, "SPONSOR: at most 4 tokens");
    for (let i = 0; i < cfg.tokens.length; i++) {
      const t = cfg.tokens[i];
      System.require(isAddress(t), "SPONSOR: invalid token address");
      System.require(
        !Arrays.equal(t, cfg.game!) && !Arrays.equal(t, cfg.desk!) && !Arrays.equal(t, this.contractId) && !(hasRace && Arrays.equal(t, cfg.race!)),
        "SPONSOR: a token can't be a Knode contract or the sponsor"
      );
      for (let j = 0; j < i; j++) System.require(!Arrays.equal(t, cfg.tokens[j]), "SPONSOR: duplicate token");
    }
    // v3: the allowlist. Each row: a real contract that is none of the built-in ones, a token or the sponsor; a
    // well-formed argument shape with the player first; no row twice.
    System.require(cfg.allowed.length <= MAX_ALLOWED, "SPONSOR: at most 8 allowlisted calls");
    for (let i = 0; i < cfg.allowed.length; i++) {
      const r = cfg.allowed[i];
      System.require(isAddress(r.contract), "SPONSOR: invalid allowlisted contract address");
      const c = r.contract!;
      System.require(
        !Arrays.equal(c, cfg.game!) && !Arrays.equal(c, cfg.desk!) && !Arrays.equal(c, this.contractId) &&
          !(hasRace && Arrays.equal(c, cfg.race!)) && !contains(cfg.tokens, c) && !(cfg.vhp != null && Arrays.equal(c, cfg.vhp!)),
        "SPONSOR: an allowlisted contract can't be the game, Knode Swap, the race, a token or the sponsor"
      );
      const t = r.arg_types != null ? r.arg_types! : new Uint8Array(0);
      System.require(t.length >= 1 && t.length <= MAX_ARG_FIELDS && t[0] == 3, "SPONSOR: arg_types must be 1 to 16 bytes, field 1 the player (3)");
      for (let j = 0; j < t.length; j++) System.require(t[j] == 0 || t[j] == 1 || t[j] == 2 || t[j] == 3 || t[j] == 6, "SPONSOR: arg_types bytes must be 0, 1, 2, 3 or 6");
      for (let j = 0; j < i; j++) {
        const o = cfg.allowed[j];
        System.require(!(Arrays.equal(o.contract!, c) && o.entry_point == r.entry_point), "SPONSOR: duplicate allowlisted call");
      }
    }
    System.require(
      cfg.max_mana_per_tx <= cfg.max_mana_per_account_day &&
        cfg.max_mana_per_account_day <= cfg.max_mana_per_account_week &&
        cfg.max_mana_per_account_day <= cfg.max_mana_per_day,
      "SPONSOR: caps must be per transaction <= per player per day <= per player per week, and per player per day <= per day"
    );
    System.require(cfg.max_mana_per_day <= CAP_LIMIT, "SPONSOR: daily cap above 1,000 mana");
    System.require(cfg.max_mana_free_day <= cfg.max_mana_per_day, "SPONSOR: the free-player cap can't be above the daily cap");
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
  // Fixcheck L-3 (v3): a stake counts like held VHP, from min_vhp up (active and pending together).
  if (p.player == null) return false;
  const st = p.player!.stake, pe = p.player!.pending;
  return st >= cfg.min_vhp || pe >= cfg.min_vhp || st + pe >= cfg.min_vhp;
}

function isGameAction(entry: u32): bool {
  return entry == GAME_DEPOSIT_VHP || entry == GAME_DEPOSIT_KOIN || entry == GAME_WITHDRAW || entry == GAME_ANSWER ||
    entry == GAME_SETTLE || entry == GAME_CLAIM || entry == GAME_CLOSE_WEEK || entry == GAME_FINALIZE_WEEK;
}

function hasRace(cfg: sponsor.config): bool {
  return cfg.race != null && cfg.race!.length == ADDRESS_LENGTH;
}

/** Free play (checkOperation has already accepted the operation): a game `answer`; the payee's own game `claim` (v3:
 *  so a free player, a guest included, can collect a free-game prize); a race `pick`; an allowlisted call marked free play. */
function isFreePlay(op: protocol.operation, cfg: sponsor.config, payee: Uint8Array): bool {
  const call = op.call_contract;
  if (call == null || call.contract_id == null) return false;
  if (Arrays.equal(call.contract_id!, cfg.game!)) {
    if (call.entry_point == GAME_ANSWER) return true;
    if (call.entry_point != GAME_CLAIM) return false;
    // Only the payee's own claim, with canonical arguments (claim_arguments: player = 1, week = 2).
    const raw = call.args ? call.args! : new Uint8Array(0);
    const who = argsPlayer(raw, CLAIM_ARG_TYPES);
    return who != null && Arrays.equal(who!, payee);
  }
  if (hasRace(cfg) && Arrays.equal(call.contract_id!, cfg.race!)) return call.entry_point == RACE_PICK;
  const row = allowedRow(cfg, call.contract_id!, call.entry_point);
  return row != null && row!.free_play;
}

/** The game's claim_arguments: player (bytes), week (varint). */
const CLAIM_ARG_TYPES: Uint8Array = bytesOf([3, 1]);

function bytesOf(a: u8[]): Uint8Array {
  const b = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) b[i] = a[i];
  return b;
}

/** The allowlisted row for a call, or null. */
function allowedRow(cfg: sponsor.config, contract: Uint8Array, entry: u32): sponsor.allowed_call | null {
  for (let i = 0; i < cfg.allowed.length; i++) {
    const r = cfg.allowed[i];
    if (r.contract != null && Arrays.equal(r.contract!, contract) && r.entry_point == entry) return r;
  }
  return null;
}

/**
 * v3, audit S-1 for any contract: the player in a call's arguments, read exactly as the target contract will read it,
 * or null when the arguments could be read two ways. Field 1 must come first, once, as 25 bytes (the player). Every
 * later field must have the wire type that arg_types lists for its number, in field-number order (a repeated field's
 * entries side by side), with nothing left over. A contract's decoder reads each field by its declared type, so a field
 * sent with another wire type could swallow or expose bytes the sponsor reads differently; that is refused here.
 */
export function argsPlayer(raw: Uint8Array, types: Uint8Array): Uint8Array | null {
  if (types.length < 1 || types.length > MAX_ARG_FIELDS || types[0] != 3) return null;
  // Picks audit P-3: player actions are small (the largest Picks pick is 317 bytes); anything longer is refused.
  if (raw.length > MAX_ARGS_BYTES) return null;
  if (raw.length < 2 + ADDRESS_LENGTH || raw[0] != 0x0a || raw[1] != <u8>ADDRESS_LENGTH) return null;
  let pos: i32 = 2 + ADDRESS_LENGTH;
  let last: u32 = 1;
  const n = raw.length;
  while (pos < n) {
    // The tag: a varint of at most 5 bytes.
    let tag: u64 = 0;
    let shift: u64 = 0;
    let k = 0;
    while (true) {
      if (pos >= n || k >= 5) return null;
      const b = raw[pos++];
      tag |= (<u64>(b & 0x7f)) << shift;
      shift += 7; k++;
      if ((b & 0x80) == 0) break;
    }
    const field = <u32>(tag >> 3), wt = <u32>(tag & 7);
    if (field < 2 || field < last || field > <u32>types.length) return null;
    if (<u32>types[field - 1] != wt + 1) return null;
    last = field;
    if (wt == 0) {
      let m = 0;
      while (true) {
        if (pos >= n || m >= 10) return null;
        const b = raw[pos++]; m++;
        if ((b & 0x80) == 0) break;
      }
    } else if (wt == 1) {
      pos += 8;
    } else if (wt == 5) {
      pos += 4;
    } else if (wt == 2) {
      let len: u64 = 0;
      let sh: u64 = 0;
      let m = 0;
      while (true) {
        if (pos >= n || m >= 5) return null;
        const b = raw[pos++];
        len |= (<u64>(b & 0x7f)) << sh;
        sh += 7; m++;
        if ((b & 0x80) == 0) break;
      }
      if (len > <u64>(n - pos)) return null;
      pos += <i32>len;
    } else {
      return null;
    }
    if (pos > n) return null;
  }
  return raw.slice(2, 2 + ADDRESS_LENGTH);
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
  if (hasRace(cfg) && Arrays.equal(target, cfg.race!)) {
    System.require(call.entry_point == RACE_PICK, "SPONSOR: only picks on the Producer Race are sponsored");
    // Only the payee's own pick (the race contract also requires the player's signature). Audit S-1: the arguments must
    // be the canonical encoding of what they decode to, so the sponsor and the race contract can't read different
    // players from the same bytes (a skipped field with an unexpected wire type would otherwise shift the reading).
    const raw = call.args ? call.args! : new Uint8Array(0);
    const p = Protobuf.decode<sponsor.race_pick_args>(raw, sponsor.race_pick_args.decode);
    System.require(Arrays.equal(Protobuf.encode(p, sponsor.race_pick_args.encode), raw), "SPONSOR: a pick's arguments must be canonical");
    System.require(p.player != null && Arrays.equal(p.player!, payee), "SPONSOR: a pick must be the payee's own");
    return;
  }
  const row = allowedRow(cfg, target, call.entry_point);
  if (row != null) {
    const raw = call.args ? call.args! : new Uint8Array(0);
    const who = argsPlayer(raw, row!.arg_types != null ? row!.arg_types! : new Uint8Array(0));
    System.require(who != null && Arrays.equal(who!, payee), "SPONSOR: an allowlisted call must be the payee's own, with arguments in the listed shape");
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
