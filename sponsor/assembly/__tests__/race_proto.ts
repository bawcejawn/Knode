// A copy of race/assembly/proto/race.ts (generated) so the sponsor tests can decode picks exactly as the race contract does. npm run check confirms it is current.
import { Writer, Reader } from "as-proto";

export namespace race {
  export class config {
    static encode(message: config, writer: Writer): void {
      const unique_name_owner = message.owner;
      if (unique_name_owner !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_owner);
      }

      if (message.enabled != false) {
        writer.uint32(16);
        writer.bool(message.enabled);
      }

      if (message.max_picks_per_day != 0) {
        writer.uint32(24);
        writer.uint32(message.max_picks_per_day);
      }
    }

    static decode(reader: Reader, length: i32): config {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new config();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.owner = reader.bytes();
            break;

          case 2:
            message.enabled = reader.bool();
            break;

          case 3:
            message.max_picks_per_day = reader.uint32();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    owner: Uint8Array | null;
    enabled: bool;
    max_picks_per_day: u32;

    constructor(
      owner: Uint8Array | null = null,
      enabled: bool = false,
      max_picks_per_day: u32 = 0
    ) {
      this.owner = owner;
      this.enabled = enabled;
      this.max_picks_per_day = max_picks_per_day;
    }
  }

  export class pick_object {
    static encode(message: pick_object, writer: Writer): void {
      const unique_name_horse = message.horse;
      if (unique_name_horse !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_horse);
      }

      if (message.at != 0) {
        writer.uint32(16);
        writer.uint64(message.at);
      }

      if (message.changes != 0) {
        writer.uint32(24);
        writer.uint32(message.changes);
      }
    }

    static decode(reader: Reader, length: i32): pick_object {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new pick_object();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.horse = reader.bytes();
            break;

          case 2:
            message.at = reader.uint64();
            break;

          case 3:
            message.changes = reader.uint32();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    horse: Uint8Array | null;
    at: u64;
    changes: u32;

    constructor(
      horse: Uint8Array | null = null,
      at: u64 = 0,
      changes: u32 = 0
    ) {
      this.horse = horse;
      this.at = at;
      this.changes = changes;
    }
  }

  @unmanaged
  export class day_count {
    static encode(message: day_count, writer: Writer): void {
      if (message.day != 0) {
        writer.uint32(8);
        writer.uint64(message.day);
      }

      if (message.count != 0) {
        writer.uint32(16);
        writer.uint32(message.count);
      }
    }

    static decode(reader: Reader, length: i32): day_count {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new day_count();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.day = reader.uint64();
            break;

          case 2:
            message.count = reader.uint32();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    day: u64;
    count: u32;

    constructor(day: u64 = 0, count: u32 = 0) {
      this.day = day;
      this.count = count;
    }
  }

  @unmanaged
  export class empty_object {
    static encode(message: empty_object, writer: Writer): void {}

    static decode(reader: Reader, length: i32): empty_object {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new empty_object();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    constructor() {}
  }

  export class pick_arguments {
    static encode(message: pick_arguments, writer: Writer): void {
      const unique_name_player = message.player;
      if (unique_name_player !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_player);
      }

      if (message.race != 0) {
        writer.uint32(16);
        writer.uint64(message.race);
      }

      const unique_name_horse = message.horse;
      if (unique_name_horse !== null) {
        writer.uint32(26);
        writer.bytes(unique_name_horse);
      }
    }

    static decode(reader: Reader, length: i32): pick_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new pick_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.player = reader.bytes();
            break;

          case 2:
            message.race = reader.uint64();
            break;

          case 3:
            message.horse = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    player: Uint8Array | null;
    race: u64;
    horse: Uint8Array | null;

    constructor(
      player: Uint8Array | null = null,
      race: u64 = 0,
      horse: Uint8Array | null = null
    ) {
      this.player = player;
      this.race = race;
      this.horse = horse;
    }
  }

  export class pick_event {
    static encode(message: pick_event, writer: Writer): void {
      const unique_name_player = message.player;
      if (unique_name_player !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_player);
      }

      if (message.race != 0) {
        writer.uint32(16);
        writer.uint64(message.race);
      }

      const unique_name_horse = message.horse;
      if (unique_name_horse !== null) {
        writer.uint32(26);
        writer.bytes(unique_name_horse);
      }

      if (message.at != 0) {
        writer.uint32(32);
        writer.uint64(message.at);
      }

      if (message.change != false) {
        writer.uint32(40);
        writer.bool(message.change);
      }
    }

    static decode(reader: Reader, length: i32): pick_event {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new pick_event();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.player = reader.bytes();
            break;

          case 2:
            message.race = reader.uint64();
            break;

          case 3:
            message.horse = reader.bytes();
            break;

          case 4:
            message.at = reader.uint64();
            break;

          case 5:
            message.change = reader.bool();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    player: Uint8Array | null;
    race: u64;
    horse: Uint8Array | null;
    at: u64;
    change: bool;

    constructor(
      player: Uint8Array | null = null,
      race: u64 = 0,
      horse: Uint8Array | null = null,
      at: u64 = 0,
      change: bool = false
    ) {
      this.player = player;
      this.race = race;
      this.horse = horse;
      this.at = at;
      this.change = change;
    }
  }

  export class get_pick_arguments {
    static encode(message: get_pick_arguments, writer: Writer): void {
      const unique_name_player = message.player;
      if (unique_name_player !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_player);
      }

      if (message.race != 0) {
        writer.uint32(16);
        writer.uint64(message.race);
      }
    }

    static decode(reader: Reader, length: i32): get_pick_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new get_pick_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.player = reader.bytes();
            break;

          case 2:
            message.race = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    player: Uint8Array | null;
    race: u64;

    constructor(player: Uint8Array | null = null, race: u64 = 0) {
      this.player = player;
      this.race = race;
    }
  }

  export class get_pick_result {
    static encode(message: get_pick_result, writer: Writer): void {
      const unique_name_pick = message.pick;
      if (unique_name_pick !== null) {
        writer.uint32(10);
        writer.fork();
        pick_object.encode(unique_name_pick, writer);
        writer.ldelim();
      }
    }

    static decode(reader: Reader, length: i32): get_pick_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new get_pick_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.pick = pick_object.decode(reader, reader.uint32());
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    pick: pick_object | null;

    constructor(pick: pick_object | null = null) {
      this.pick = pick;
    }
  }

  export class list_picks_arguments {
    static encode(message: list_picks_arguments, writer: Writer): void {
      if (message.race != 0) {
        writer.uint32(8);
        writer.uint64(message.race);
      }

      const unique_name_start_after = message.start_after;
      if (unique_name_start_after !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_start_after);
      }

      if (message.limit != 0) {
        writer.uint32(24);
        writer.uint32(message.limit);
      }
    }

    static decode(reader: Reader, length: i32): list_picks_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new list_picks_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.race = reader.uint64();
            break;

          case 2:
            message.start_after = reader.bytes();
            break;

          case 3:
            message.limit = reader.uint32();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    race: u64;
    start_after: Uint8Array | null;
    limit: u32;

    constructor(
      race: u64 = 0,
      start_after: Uint8Array | null = null,
      limit: u32 = 0
    ) {
      this.race = race;
      this.start_after = start_after;
      this.limit = limit;
    }
  }

  export class pick_row {
    static encode(message: pick_row, writer: Writer): void {
      const unique_name_player = message.player;
      if (unique_name_player !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_player);
      }

      const unique_name_pick = message.pick;
      if (unique_name_pick !== null) {
        writer.uint32(18);
        writer.fork();
        pick_object.encode(unique_name_pick, writer);
        writer.ldelim();
      }
    }

    static decode(reader: Reader, length: i32): pick_row {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new pick_row();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.player = reader.bytes();
            break;

          case 2:
            message.pick = pick_object.decode(reader, reader.uint32());
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    player: Uint8Array | null;
    pick: pick_object | null;

    constructor(
      player: Uint8Array | null = null,
      pick: pick_object | null = null
    ) {
      this.player = player;
      this.pick = pick;
    }
  }

  export class list_picks_result {
    static encode(message: list_picks_result, writer: Writer): void {
      const unique_name_rows = message.rows;
      for (let i = 0; i < unique_name_rows.length; ++i) {
        writer.uint32(10);
        writer.fork();
        pick_row.encode(unique_name_rows[i], writer);
        writer.ldelim();
      }
    }

    static decode(reader: Reader, length: i32): list_picks_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new list_picks_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.rows.push(pick_row.decode(reader, reader.uint32()));
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    rows: Array<pick_row>;

    constructor(rows: Array<pick_row> = []) {
      this.rows = rows;
    }
  }

  export class get_usage_arguments {
    static encode(message: get_usage_arguments, writer: Writer): void {
      const unique_name_player = message.player;
      if (unique_name_player !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_player);
      }
    }

    static decode(reader: Reader, length: i32): get_usage_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new get_usage_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.player = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    player: Uint8Array | null;

    constructor(player: Uint8Array | null = null) {
      this.player = player;
    }
  }

  @unmanaged
  export class get_usage_result {
    static encode(message: get_usage_result, writer: Writer): void {
      if (message.day != 0) {
        writer.uint32(8);
        writer.uint64(message.day);
      }

      if (message.picks_today != 0) {
        writer.uint32(16);
        writer.uint32(message.picks_today);
      }

      if (message.max_picks_per_day != 0) {
        writer.uint32(24);
        writer.uint32(message.max_picks_per_day);
      }
    }

    static decode(reader: Reader, length: i32): get_usage_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new get_usage_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.day = reader.uint64();
            break;

          case 2:
            message.picks_today = reader.uint32();
            break;

          case 3:
            message.max_picks_per_day = reader.uint32();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    day: u64;
    picks_today: u32;
    max_picks_per_day: u32;

    constructor(
      day: u64 = 0,
      picks_today: u32 = 0,
      max_picks_per_day: u32 = 0
    ) {
      this.day = day;
      this.picks_today = picks_today;
      this.max_picks_per_day = max_picks_per_day;
    }
  }

  @unmanaged
  export class get_config_arguments {
    static encode(message: get_config_arguments, writer: Writer): void {}

    static decode(reader: Reader, length: i32): get_config_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new get_config_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    constructor() {}
  }

  export class set_config_arguments {
    static encode(message: set_config_arguments, writer: Writer): void {
      const unique_name_config = message.config;
      if (unique_name_config !== null) {
        writer.uint32(10);
        writer.fork();
        config.encode(unique_name_config, writer);
        writer.ldelim();
      }
    }

    static decode(reader: Reader, length: i32): set_config_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new set_config_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.config = config.decode(reader, reader.uint32());
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    config: config | null;

    constructor(config: config | null = null) {
      this.config = config;
    }
  }

  export class config_event {
    static encode(message: config_event, writer: Writer): void {
      const unique_name_config = message.config;
      if (unique_name_config !== null) {
        writer.uint32(10);
        writer.fork();
        config.encode(unique_name_config, writer);
        writer.ldelim();
      }
    }

    static decode(reader: Reader, length: i32): config_event {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new config_event();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.config = config.decode(reader, reader.uint32());
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    config: config | null;

    constructor(config: config | null = null) {
      this.config = config;
    }
  }
}
