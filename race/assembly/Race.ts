import { System, Storage, Protobuf, Crypto, Arrays, authority } from "@koinos/sdk-as";
import { race } from "./proto/race";

/**
 * Knode Producer Race picks. See assembly/proto/race.proto for the rules.
 * Free to play: it holds no funds, takes no fee and never pays Mana. It only keeps one pick per wallet per race and
 * lets the chain enforce the lock (no pick once a race has started), the 24-hour window and the daily limit.
 * Uploaded with no authority overrides: upgrades need this contract's own key; settings need the owner's key.
 */

const CONFIG_SPACE = 0;
const PICKS_SPACE = 1;     // key: race (8 bytes, big-endian) + player (25 bytes) → pick_object
const DAYS_SPACE = 2;      // key: player → day_count

const ADDRESS_LENGTH = 25;
export const RACE_MS: u64 = 21600000;      // 6 hours
export const DAY_MS: u64 = 86400000;
/** Picks are open for the next 4 races: the coming 24 hours. */
export const LOOKAHEAD: u64 = 4;
export const MAX_PICKS_LIMIT: u32 = 20;
export const MAX_LIST: u32 = 100;

export const CLOSED = "RACE: picks are closed";
export const LOCKED = "RACE: this race has started; picks are locked";
export const TOO_EARLY = "RACE: picks open 24 hours before a race";
export const USED_UP = "RACE: today's picks are used up";
export const SAME = "RACE: that is already your pick";
export const NOT_SIGNED = "RACE: the player must sign";

export class Race {
  contractId: Uint8Array = System.getContractId();

  config: Storage.Obj<race.config> = new Storage.Obj(this.contractId, CONFIG_SPACE, race.config.decode, race.config.encode, () => new race.config());
  picks: Storage.Map<Uint8Array, race.pick_object> = new Storage.Map(this.contractId, PICKS_SPACE, race.pick_object.decode, race.pick_object.encode, () => new race.pick_object());
  days: Storage.Map<Uint8Array, race.day_count> = new Storage.Map(this.contractId, DAYS_SPACE, race.day_count.decode, race.day_count.encode, () => new race.day_count());

  pick(args: race.pick_arguments): race.empty_object {
    const cfg = this.config.get()!;
    System.require(cfg.enabled, CLOSED);
    System.require(isAddress(args.player), "RACE: invalid player");
    System.require(isAddress(args.horse), "RACE: invalid horse");
    const player = args.player!;
    System.require(System.checkAuthority(authority.authorization_type.contract_call, player), NOT_SIGNED);

    const now = System.getHeadInfo().head_block_time;
    const current = now / RACE_MS;                  // the race running now; it started at current * RACE_MS <= now
    // A race number above `current` starts after now. Equal or below: started (or over): locked.
    System.require(args.race > current, LOCKED);
    System.require(args.race <= current + LOOKAHEAD, TOO_EARLY);

    const key = pickKey(args.race, player);
    const old = this.picks.get(key);
    const had = old != null && old.horse != null && old.horse!.length > 0;
    System.require(!had || !Arrays.equal(old!.horse, args.horse), SAME);

    const day = now / DAY_MS;
    const dc = this.days.get(player)!;
    const count: u32 = dc.day == day ? dc.count : 0;
    System.require(count < cfg.max_picks_per_day, USED_UP);
    this.days.put(player, new race.day_count(day, count + 1));

    this.picks.put(key, new race.pick_object(args.horse, now, had ? old!.changes + 1 : 0));
    const ev = new race.pick_event(player, args.race, args.horse, now, had);
    System.event("race.pick_event", Protobuf.encode(ev, race.pick_event.encode), [player]);
    return new race.empty_object();
  }

  get_pick(args: race.get_pick_arguments): race.get_pick_result {
    const out = new race.get_pick_result();
    if (!isAddress(args.player)) return out;
    const p = this.picks.get(pickKey(args.race, args.player!));
    if (p != null && p.horse != null && p.horse!.length > 0) out.pick = p;
    return out;
  }

  list_picks(args: race.list_picks_arguments): race.list_picks_result {
    const out = new race.list_picks_result();
    const limit: u32 = args.limit == 0 || args.limit > MAX_LIST ? MAX_LIST : args.limit;
    const prefix = raceBytes(args.race);
    // Start just before the first wallet (an all-zero address, which can't be a real one), or after start_after.
    // Every key has the same length, so the order is the same on the chain and in the test VM.
    const after = args.start_after != null && args.start_after!.length == ADDRESS_LENGTH ? args.start_after! : new Uint8Array(ADDRESS_LENGTH);
    let key = concat(prefix, after);
    while (<u32>out.rows.length < limit) {
      const obj = this.picks.getNext(key);
      if (obj == null || obj.key == null) break;
      const k = obj.key!;
      if (k.length != 8 + ADDRESS_LENGTH || !Arrays.equal(k.subarray(0, 8), prefix)) break;   // past this race
      out.rows.push(new race.pick_row(k.slice(8), obj.value));
      key = k;
    }
    return out;
  }

  get_usage(args: race.get_usage_arguments): race.get_usage_result {
    const cfg = this.config.get()!;
    const day = System.getHeadInfo().head_block_time / DAY_MS;
    let n: u32 = 0;
    if (isAddress(args.player)) { const dc = this.days.get(args.player!)!; if (dc.day == day) n = dc.count; }
    return new race.get_usage_result(day, n, cfg.max_picks_per_day);
  }

  get_config(args: race.get_config_arguments): race.config {
    return this.config.get()!;
  }

  set_config(args: race.set_config_arguments): race.empty_object {
    const cur = this.config.get()!;
    // The first setup: this contract's own key. After that: the owner's key only.
    const who = isAddress(cur.owner) ? cur.owner! : this.contractId;
    System.require(System.checkAuthority(authority.authorization_type.contract_call, who), "RACE: needs the owner's key");
    System.require(args.config != null, "RACE: config missing");
    const cfg = args.config!;
    System.require(isAddress(cfg.owner), "RACE: invalid owner");
    System.require(!Arrays.equal(cfg.owner, this.contractId), "RACE: the owner must be a wallet, not this contract");
    System.require(cfg.max_picks_per_day >= 1 && cfg.max_picks_per_day <= MAX_PICKS_LIMIT, "RACE: picks per day must be 1 to 20");
    this.config.put(cfg);
    System.event("race.config_event", Protobuf.encode(new race.config_event(cfg), race.config_event.encode), [this.contractId]);
    return new race.empty_object();
  }
}

/** The race number as 8 big-endian bytes, so keys sort by race, then by player. */
function raceBytes(r: u64): Uint8Array {
  const b = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) { b[i] = <u8>(r & 0xff); r >>= 8; }
  return b;
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
export function pickKey(r: u64, player: Uint8Array): Uint8Array {
  return concat(raceBytes(r), player);
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
