import { System, Storage, Protobuf, Crypto, Arrays, Base58, authority, protocol, value } from "@koinos/sdk-as";
import { picks } from "./proto/picks";

/**
 * KnodeGames Picks. See assembly/proto/picks.proto for the rules.
 * It holds no tokens, takes no fee, never pays Mana and never calls another contract. It only keeps one pick per
 * wallet per round of each game and lets the chain enforce the lock, the opening window, the choice and the caps.
 *
 * Uploaded with all three authority overrides ON, so this contract decides for its own account:
 *  - contract_call (moving anything out of this account): always refused;
 *  - transaction_application (paying Mana for others): always refused;
 *  - contract_upload (new code): only the owner, only the announced sha256, only 48 hours after the announcement.
 * So once uploaded, the wallet key it was uploaded with has no power over it.
 */

const CONFIG_SPACE = 0;
const GAMES_SPACE = 1;     // key: game (4 bytes, big-endian) → game_config
const PENDING_SPACE = 2;   // key: game (4 bytes) → pending_game
const PICKS_SPACE = 3;     // key: game (4) + round (8) + player (25) = 37 bytes → pick_object
const DAYS_SPACE = 4;      // key: game (4) + player (25) = 29 bytes → day_count

const ADDRESS_LENGTH = 25;
const PICK_KEY_LENGTH = 4 + 8 + ADDRESS_LENGTH;
export const DAY_MS: u64 = 86400000;
export const TIMELOCK_MS: u64 = 2 * DAY_MS;                // 48 hours
export const EXPIRY_MS: u64 = 7 * DAY_MS;                  // an announcement can be carried out for 7 days

export const KIND_PRODUCER: u32 = 1;
export const KIND_LIST: u32 = 2;
export const KIND_NUMBER: u32 = 3;
export const LOCK_HEIGHT: u32 = 1;
export const LOCK_TIME: u32 = 2;

/** Every pick locks at least ~5 minutes before its target: 100 blocks, or 5 minutes for time games. */
export const MIN_LEAD_BLOCKS: u64 = 100;
export const MIN_LEAD_MS: u64 = 300000;
/** Picks open at most 35 days ahead (a 4-week season plus a week). Koinos makes a block about every 3 s. */
export const MAX_AHEAD_BLOCKS: u64 = 1008000;
export const MAX_AHEAD_MS: u64 = 35 * DAY_MS;
export const MAX_LIST_SIZE: u32 = 10;
export const MAX_PICKS_LIMIT: u32 = 50;
export const MAX_CHANGES_LIMIT: u32 = 50;
export const MAX_GAMES: u32 = 32;
export const MAX_GAME_ID: u32 = 1000000;
export const MAX_NAME_BYTES: i32 = 40;
export const MAX_LIST: u32 = 100;

/** The owner before the first handover: the KnodeGames owner and treasury (CLAUDE.md "Fixed facts"). */
export const INITIAL_OWNER: Uint8Array = Base58.decode("1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717");

export const CLOSED = "PICKS: this game is closed";
export const NO_GAME = "PICKS: no such game";
export const LOCKED = "PICKS: this round is locked";
export const TOO_EARLY = "PICKS: this round is not open yet";
export const USED_UP = "PICKS: today's picks for this game are used up";
export const NO_CHANGES = "PICKS: this pick can't be changed again";
export const SAME = "PICKS: that is already your pick";
export const NOT_SIGNED = "PICKS: the player must sign";
export const BAD_CHOICE = "PICKS: the choice doesn't fit this game";
export const OWNER_ONLY = "PICKS: owner only";
export const SHAPE_FIXED = "PICKS: a game's shape can't change";
export const NOT_TIGHTER = "PICKS: tighten_game only makes a game stricter";
export const NOT_YET = "PICKS: the 48-hour notice has not passed";
export const EXPIRED = "PICKS: the announcement expired; announce it again";

export class Picks {
  contractId: Uint8Array = System.getContractId();

  config: Storage.Obj<picks.config> = new Storage.Obj(this.contractId, CONFIG_SPACE, picks.config.decode, picks.config.encode, () => new picks.config());
  games: Storage.Map<Uint8Array, picks.game_config> = new Storage.Map(this.contractId, GAMES_SPACE, picks.game_config.decode, picks.game_config.encode, null);
  pending: Storage.Map<Uint8Array, picks.pending_game> = new Storage.Map(this.contractId, PENDING_SPACE, picks.pending_game.decode, picks.pending_game.encode, null);
  entries: Storage.Map<Uint8Array, picks.pick_object> = new Storage.Map(this.contractId, PICKS_SPACE, picks.pick_object.decode, picks.pick_object.encode, null);
  days: Storage.Map<Uint8Array, picks.day_count> = new Storage.Map(this.contractId, DAYS_SPACE, picks.day_count.decode, picks.day_count.encode, () => new picks.day_count());

  // ═══════════════════════ authorize: who may act as this contract's account ═══════════════════════

  authorize(args: authority.authorize_arguments): authority.authorize_result {
    if (args.type == authority.authorization_type.contract_upload) return new authority.authorize_result(this.upgradeOk());
    // contract_call: nothing may ever move anything out of this account. transaction_application: it never pays Mana.
    return new authority.authorize_result(false);
  }

  /** New code only with the owner's signature, only the announced bytecode, only between 48 hours and 9 days after
   *  the announcement, and only if the new code keeps all three overrides on (so it stays in charge of its account). */
  upgradeOk(): bool {
    const cfg = this.config.get()!;
    const hash = cfg.upgrade_hash;
    if (hash == null || hash.length != 32 || cfg.upgrade_eta == 0) return false;
    const now = this.now();
    if (now < cfg.upgrade_eta || now >= cfg.upgrade_eta + EXPIRY_MS) return false;
    // The upload carries the whole new bytecode, far more than the default buffer for reading transaction fields.
    System.setSystemBufferSize(1024 * 1024);
    const ops = txOps();
    let found = false;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.upload_contract == null) continue;
      const up = op.upload_contract!;
      if (!Arrays.equal(up.contract_id, this.contractId)) continue;
      if (!up.authorizes_call_contract || !up.authorizes_transaction_application || !up.authorizes_upload_contract) return false;
      const mh = new Crypto.Multihash();
      mh.deserialize(System.hash(Crypto.multicodec.sha2_256, up.bytecode)!);
      if (!Arrays.equal(mh.digest, hash)) return false;
      found = true;
    }
    if (!found) return false;
    return System.checkAuthority(authority.authorization_type.contract_call, this.ownerOf(cfg));
  }

  // ═══════════════════════ player ═══════════════════════

  pick(args: picks.pick_arguments): picks.empty_object {
    const g = this.games.get(u32Bytes(args.game));
    System.require(g != null, NO_GAME);
    const game = g!;
    System.require(game.enabled, CLOSED);
    System.require(isAddress(args.player), "PICKS: invalid player");
    const player = args.player!;
    System.require(System.checkAuthority(authority.authorization_type.contract_call, player), NOT_SIGNED);
    // Only the player's own transaction (or the player's own contract), never another contract the player happened
    // to sign a transaction for (race audit R-3).
    const caller = System.getCaller().caller;
    System.require(caller == null || caller!.length == 0 || Arrays.equal(caller!, player), NOT_SIGNED);

    // The lock and the opening window, in the game's own clock (block heights or ms).
    const head = System.getHeadInfo();
    const now = head.head_block_time;
    const height: u64 = head.head_topology != null ? head.head_topology!.height : 0;
    const pos: u64 = game.lock_mode == LOCK_HEIGHT ? height : now;
    System.require(args.round <= (u64.MAX_VALUE - game.round_offset) / game.round_size, LOCKED);
    const target = args.round * game.round_size + game.round_offset;
    // Picks are accepted only while pos < target - lead (a target closer than lead to 0 is always locked).
    System.require(target > game.lead && pos < target - game.lead, LOCKED);
    System.require(target - pos <= game.ahead, TOO_EARLY);

    checkChoice(game, args.producers, args.number);

    const key = pickKey(args.game, args.round, player);
    const old = this.entries.get(key);
    const had = old != null;
    if (had) {
      System.require(!sameChoice(old!, args.producers, args.number), SAME);
      System.require(old!.changes < game.max_changes, NO_CHANGES);
    }

    const day = now / DAY_MS;
    const dkey = dayKey(args.game, player);
    const dc = this.days.get(dkey)!;
    const count: u32 = dc.day == day ? dc.count : 0;
    System.require(count < game.max_picks_per_day, USED_UP);
    this.days.put(dkey, new picks.day_count(day, count + 1));

    const stored = new picks.pick_object(copyList(args.producers), args.number, height, now, had ? old!.changes + 1 : 0);
    this.entries.put(key, stored);
    const ev = new picks.pick_event(player, args.game, args.round, copyList(args.producers), args.number, height, now, had);
    System.event("picks.pick_event", Protobuf.encode(ev, picks.pick_event.encode), [player]);
    return new picks.empty_object();
  }

  // ═══════════════════════ read-only ═══════════════════════

  get_pick(args: picks.get_pick_arguments): picks.get_pick_result {
    const out = new picks.get_pick_result();
    if (!isAddress(args.player)) return out;
    const p = this.entries.get(pickKey(args.game, args.round, args.player!));
    if (p != null) out.pick = p;
    return out;
  }

  list_picks(args: picks.list_picks_arguments): picks.list_picks_result {
    const out = new picks.list_picks_result();
    const limit: u32 = args.limit == 0 || args.limit > MAX_LIST ? MAX_LIST : args.limit;
    const prefix = concat(u32Bytes(args.game), u64Bytes(args.round));
    // Start just before the first wallet (an all-zero address, which can't be a real one), or after start_after.
    // A cursor that isn't empty and isn't 25 bytes is an error, never a silent restart (race audit R-1).
    const given = args.start_after != null && args.start_after!.length > 0;
    System.require(!given || args.start_after!.length == ADDRESS_LENGTH, "PICKS: bad start_after");
    let key = concat(prefix, given ? args.start_after! : new Uint8Array(ADDRESS_LENGTH));
    while (<u32>out.rows.length < limit) {
      const obj = this.entries.getNext(key);
      if (obj == null || obj.key == null) break;
      const k = obj.key!;
      if (k.length != PICK_KEY_LENGTH || !Arrays.equal(k.subarray(0, 12), prefix)) break;   // past this round
      out.rows.push(new picks.pick_row(k.slice(12), obj.value));
      key = k;
    }
    return out;
  }

  get_usage(args: picks.get_usage_arguments): picks.get_usage_result {
    const day = System.getHeadInfo().head_block_time / DAY_MS;
    const g = this.games.get(u32Bytes(args.game));
    let n: u32 = 0;
    if (g != null && isAddress(args.player)) { const dc = this.days.get(dayKey(args.game, args.player!))!; if (dc.day == day) n = dc.count; }
    return new picks.get_usage_result(day, n, g != null ? g!.max_picks_per_day : 0);
  }

  get_config(args: picks.get_config_arguments): picks.config {
    const cfg = this.config.get()!;
    cfg.owner = this.ownerOf(cfg);
    return cfg;
  }

  get_game(args: picks.get_game_arguments): picks.get_game_result {
    const key = u32Bytes(args.game);
    const p = this.pending.get(key);
    const live = p != null && p.generation == this.config.get()!.generation;
    return new picks.get_game_result(this.games.get(key), live ? p : null);
  }

  /** Announced changes that can still be applied (current owner generation), by game id (audit P-7). */
  list_pending(args: picks.list_pending_arguments): picks.list_pending_result {
    const out = new picks.list_pending_result();
    const limit: u32 = args.limit == 0 || args.limit > 50 ? 50 : args.limit;
    const gen = this.config.get()!.generation;
    let key = u32Bytes(args.start_after);
    // Stale entries are skipped; at most 200 are looked at per call, so a page can be short (read-only, any caller).
    for (let i = 0; i < 200 && <u32>out.pending.length < limit; i++) {
      const obj = this.pending.getNext(key);
      if (obj == null || obj.key == null || obj.key!.length != 4) break;
      if (obj.value.generation == gen) out.pending.push(obj.value);
      key = obj.key!;
    }
    return out;
  }

  list_games(args: picks.list_games_arguments): picks.list_games_result {
    const out = new picks.list_games_result();
    let key = new Uint8Array(4);
    for (let i: u32 = 0; i <= MAX_GAMES; i++) {
      const obj = this.games.getNext(key);
      if (obj == null || obj.key == null || obj.key!.length != 4) break;
      out.games.push(obj.value);
      key = obj.key!;
    }
    return out;
  }

  // ═══════════════════════ owner ═══════════════════════

  announce_game(args: picks.announce_game_arguments): picks.eta_result {
    this.requireOwner();
    System.require(args.game != null, "PICKS: game missing");
    const n = args.game!;
    checkGame(n);
    const key = u32Bytes(n.id);
    const cur = this.games.get(key);
    if (cur != null) System.require(sameShape(cur!, n), SHAPE_FIXED);
    else System.require(this.gameCount() < MAX_GAMES, "PICKS: at most 32 games");
    const eta = this.now() + TIMELOCK_MS;
    this.pending.put(key, new picks.pending_game(n, eta, this.config.get()!.generation));
    this.gameEvent("announced", n, eta);
    return new picks.eta_result(eta);
  }

  apply_game(args: picks.apply_game_arguments): picks.empty_object {
    const key = u32Bytes(args.game);
    const p = this.pending.get(key);
    System.require(p != null && p!.game != null, "PICKS: nothing announced for this game");
    // Audit P-1: an announcement from before an owner handover is dead.
    System.require(p!.generation == this.config.get()!.generation, "PICKS: announced by a previous owner; the owner must announce it again");
    const now = this.now();
    System.require(now >= p!.eta, NOT_YET);
    System.require(now < p!.eta + EXPIRY_MS, EXPIRED);
    const n = p!.game!;
    checkGame(n);
    const cur = this.games.get(key);
    if (cur != null) System.require(sameShape(cur!, n), SHAPE_FIXED);
    else System.require(this.gameCount() < MAX_GAMES, "PICKS: at most 32 games");
    this.games.put(key, n);
    this.pending.remove(key);
    this.gameEvent("applied", n, 0);
    return new picks.empty_object();
  }

  tighten_game(args: picks.tighten_game_arguments): picks.empty_object {
    this.requireOwner();
    System.require(args.game != null, "PICKS: game missing");
    const n = args.game!;
    const key = u32Bytes(n.id);
    const cur = this.games.get(key);
    System.require(cur != null, NO_GAME);
    const g = cur!;
    System.require(sameShape(g, n) && n.name == g.name, SHAPE_FIXED);
    System.require(
      n.lead >= g.lead && n.ahead <= g.ahead && n.ahead > n.lead &&
        n.max_picks_per_day >= 1 && n.max_picks_per_day <= g.max_picks_per_day &&
        n.max_changes <= g.max_changes && (g.enabled || !n.enabled),
      NOT_TIGHTER
    );
    checkGame(n);
    this.games.put(key, n);
    // Audit P-2: a change announced before the tightening must not undo it later.
    if (this.pending.get(key) != null) { this.pending.remove(key); this.gameEvent("cancelled", n, 0); }
    this.gameEvent("tightened", n, 0);
    return new picks.empty_object();
  }

  cancel_game_change(args: picks.cancel_game_change_arguments): picks.empty_object {
    this.requireOwner();
    const key = u32Bytes(args.game);
    const p = this.pending.get(key);
    System.require(p != null, "PICKS: nothing announced for this game");
    this.pending.remove(key);
    this.gameEvent("cancelled", p!.game, 0);
    return new picks.empty_object();
  }

  propose_owner(args: picks.propose_owner_arguments): picks.eta_result {
    this.requireOwner();
    const cfg = this.config.get()!;
    cfg.owner = this.ownerOf(cfg);
    if (args.owner == null || args.owner!.length == 0) {
      cfg.pending_owner = null;
      cfg.pending_owner_eta = 0;
      this.config.put(cfg);
      this.ownerEvent("cancelled", null, 0);
      return new picks.eta_result(0);
    }
    System.require(isAddress(args.owner), "PICKS: invalid owner");
    System.require(!Arrays.equal(args.owner, this.contractId), "PICKS: the owner must be a wallet, not this contract");
    const eta = this.now() + TIMELOCK_MS;
    cfg.pending_owner = args.owner;
    cfg.pending_owner_eta = eta;
    this.config.put(cfg);
    this.ownerEvent("proposed", args.owner, eta);
    return new picks.eta_result(eta);
  }

  accept_owner(args: picks.accept_owner_arguments): picks.empty_object {
    const cfg = this.config.get()!;
    System.require(isAddress(cfg.pending_owner), "PICKS: no owner proposed");
    const now = this.now();
    System.require(now >= cfg.pending_owner_eta, NOT_YET);
    System.require(now < cfg.pending_owner_eta + EXPIRY_MS, EXPIRED);
    const next = cfg.pending_owner!;
    System.require(System.checkAuthority(authority.authorization_type.contract_call, next), "PICKS: the new owner must sign");
    // The new owner starts clean: a new generation makes every earlier announcement unusable (audit P-1: however many
    // there are, without a loop), and the announced upgrade is cleared.
    this.config.put(new picks.config(next, null, 0, null, 0, cfg.generation + 1));
    this.ownerEvent("accepted", next, 0);
    return new picks.empty_object();
  }

  schedule_upgrade(args: picks.schedule_upgrade_arguments): picks.eta_result {
    this.requireOwner();
    const cfg = this.config.get()!;
    cfg.owner = this.ownerOf(cfg);
    const h = args.hash;
    if (h == null || h.length == 0 || allZero(h)) {
      cfg.upgrade_hash = null;
      cfg.upgrade_eta = 0;
      this.config.put(cfg);
      System.event("picks.upgrade_event", Protobuf.encode(new picks.upgrade_event(null, 0), picks.upgrade_event.encode), [this.contractId]);
      return new picks.eta_result(0);
    }
    System.require(h.length == 32, "PICKS: the sha256 of the new code (32 bytes) is required");
    const eta = this.now() + TIMELOCK_MS;
    cfg.upgrade_hash = h;
    cfg.upgrade_eta = eta;
    this.config.put(cfg);
    System.event("picks.upgrade_event", Protobuf.encode(new picks.upgrade_event(h, eta), picks.upgrade_event.encode), [this.contractId]);
    return new picks.eta_result(eta);
  }

  // ═══════════════════════ helpers ═══════════════════════

  now(): u64 {
    return System.getHeadInfo().head_block_time;
  }

  ownerOf(cfg: picks.config): Uint8Array {
    return isAddress(cfg.owner) ? cfg.owner! : INITIAL_OWNER;
  }

  requireOwner(): void {
    System.require(System.checkAuthority(authority.authorization_type.contract_call, this.ownerOf(this.config.get()!)), OWNER_ONLY);
  }

  gameCount(): u32 {
    let n: u32 = 0;
    let key = new Uint8Array(4);
    while (n <= MAX_GAMES) {
      const obj = this.games.getNext(key);
      if (obj == null || obj.key == null || obj.key!.length != 4) break;
      n++;
      key = obj.key!;
    }
    return n;
  }

  gameEvent(action: string, g: picks.game_config | null, eta: u64): void {
    System.event("picks.game_event", Protobuf.encode(new picks.game_event(action, g, eta), picks.game_event.encode), [this.contractId]);
  }

  ownerEvent(action: string, owner: Uint8Array | null, eta: u64): void {
    System.event("picks.owner_event", Protobuf.encode(new picks.owner_event(action, owner, eta), picks.owner_event.encode), [this.contractId]);
  }
}

// ═══════════════════════ game rules ═══════════════════════

/** A game's settings are within the hard limits. */
function checkGame(g: picks.game_config): void {
  System.require(g.id >= 1 && g.id <= MAX_GAME_ID, "PICKS: game id must be 1 to 1,000,000");
  System.require(nameBytes(g) >= 1 && nameBytes(g) <= MAX_NAME_BYTES, "PICKS: name must be 1 to 40 bytes");
  if (g.kind == KIND_PRODUCER) {
    System.require(g.list_size == 1 && g.number_min == 0 && g.number_max == 0, "PICKS: a one-producer game has list_size 1 and no number range");
  } else if (g.kind == KIND_LIST) {
    System.require(g.list_size >= 2 && g.list_size <= MAX_LIST_SIZE && g.number_min == 0 && g.number_max == 0, "PICKS: a list game has list_size 2 to 10 and no number range");
  } else if (g.kind == KIND_NUMBER) {
    System.require(g.list_size == 0 && g.number_min <= g.number_max, "PICKS: a number game has list_size 0 and number_min <= number_max");
  } else {
    System.require(false, "PICKS: kind must be 1, 2 or 3");
  }
  System.require(g.lock_mode == LOCK_HEIGHT || g.lock_mode == LOCK_TIME, "PICKS: lock_mode must be 1 or 2");
  System.require(g.round_size >= 1 && g.round_offset < g.round_size, "PICKS: round_size must be at least 1 and above round_offset");
  const minLead = g.lock_mode == LOCK_HEIGHT ? MIN_LEAD_BLOCKS : MIN_LEAD_MS;
  const maxAhead = g.lock_mode == LOCK_HEIGHT ? MAX_AHEAD_BLOCKS : MAX_AHEAD_MS;
  System.require(g.lead >= minLead, "PICKS: lead must be at least 100 blocks (or 5 minutes)");
  System.require(g.ahead > g.lead && g.ahead <= maxAhead, "PICKS: ahead must be above lead and at most 35 days");
  System.require(g.max_picks_per_day >= 1 && g.max_picks_per_day <= MAX_PICKS_LIMIT, "PICKS: picks per day must be 1 to 50");
  System.require(g.max_changes <= MAX_CHANGES_LIMIT, "PICKS: changes must be 0 to 50");
}

/** The parts of a game that define what a round and a choice mean. They never change once registered. */
function sameShape(a: picks.game_config, b: picks.game_config): bool {
  return a.id == b.id && a.kind == b.kind && a.list_size == b.list_size && a.number_min == b.number_min &&
    a.number_max == b.number_max && a.lock_mode == b.lock_mode && a.round_size == b.round_size && a.round_offset == b.round_offset;
}

/** The choice fits the game: one valid producer, a list of distinct valid producers, or a number in range. */
function checkChoice(g: picks.game_config, producers: Uint8Array[], n: u64): void {
  if (g.kind == KIND_NUMBER) {
    System.require(producers.length == 0 && n >= g.number_min && n <= g.number_max, BAD_CHOICE);
    return;
  }
  System.require(n == 0 && producers.length >= 1 && <u32>producers.length <= g.list_size, BAD_CHOICE);
  for (let i = 0; i < producers.length; i++) {
    System.require(isAddress(producers[i]), BAD_CHOICE);
    for (let j = 0; j < i; j++) System.require(!Arrays.equal(producers[i], producers[j]), BAD_CHOICE);
  }
}

function sameChoice(old: picks.pick_object, producers: Uint8Array[], n: u64): bool {
  if (old.number != n || old.producers.length != producers.length) return false;
  for (let i = 0; i < producers.length; i++) if (!Arrays.equal(old.producers[i], producers[i])) return false;
  return true;
}

// ═══════════════════════ bytes ═══════════════════════

function u32Bytes(v: u32): Uint8Array {
  const b = new Uint8Array(4);
  for (let i = 3; i >= 0; i--) { b[i] = <u8>(v & 0xff); v >>= 8; }
  return b;
}
function u64Bytes(v: u64): Uint8Array {
  const b = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) { b[i] = <u8>(v & 0xff); v >>= 8; }
  return b;
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
export function pickKey(game: u32, round: u64, player: Uint8Array): Uint8Array {
  return concat(concat(u32Bytes(game), u64Bytes(round)), player);
}
export function dayKey(game: u32, player: Uint8Array): Uint8Array {
  return concat(u32Bytes(game), player);
}
function copyList(list: Uint8Array[]): Uint8Array[] {
  const out = new Array<Uint8Array>();
  for (let i = 0; i < list.length; i++) out.push(list[i].slice(0));
  return out;
}
function allZero(b: Uint8Array): bool {
  for (let i = 0; i < b.length; i++) if (b[i] != 0) return false;
  return true;
}

/** The transaction's operations (the mock VM serves the transaction directly; the chain serves it field by field). */
function txOps(): protocol.operation[] {
  if (BUILD_FOR_TESTING) return System.getTransaction().operations;
  const list = Protobuf.decode<value.list_type>(System.getTransactionField("operations")!.message_value!.value!, value.list_type.decode);
  const out = new Array<protocol.operation>();
  for (let i = 0; i < list.values.length; i++) {
    out.push(Protobuf.decode<protocol.operation>(list.values[i].message_value!.value!, protocol.operation.decode));
  }
  return out;
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

function nameBytes(g: picks.game_config): i32 {
  return g.name == null ? 0 : String.UTF8.byteLength(g.name!);
}
