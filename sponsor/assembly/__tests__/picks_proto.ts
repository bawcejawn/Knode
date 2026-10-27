// A copy of picks/assembly/proto/picks.ts (generated) so the sponsor tests can decode picks exactly as the Picks contract does. npm run check confirms it is current.
import { Writer, Reader } from "as-proto";

export namespace picks {
  export class config {
    static encode(message: config, writer: Writer): void {
      const unique_name_owner = message.owner;
      if (unique_name_owner !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_owner);
      }

      const unique_name_pending_owner = message.pending_owner;
      if (unique_name_pending_owner !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_pending_owner);
      }

      if (message.pending_owner_eta != 0) {
        writer.uint32(24);
        writer.uint64(message.pending_owner_eta);
      }

      const unique_name_upgrade_hash = message.upgrade_hash;
      if (unique_name_upgrade_hash !== null) {
        writer.uint32(34);
        writer.bytes(unique_name_upgrade_hash);
      }

      if (message.upgrade_eta != 0) {
        writer.uint32(40);
        writer.uint64(message.upgrade_eta);
      }

      if (message.generation != 0) {
        writer.uint32(48);
        writer.uint64(message.generation);
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
            message.pending_owner = reader.bytes();
            break;

          case 3:
            message.pending_owner_eta = reader.uint64();
            break;

          case 4:
            message.upgrade_hash = reader.bytes();
            break;

          case 5:
            message.upgrade_eta = reader.uint64();
            break;

          case 6:
            message.generation = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    owner: Uint8Array | null;
    pending_owner: Uint8Array | null;
    pending_owner_eta: u64;
    upgrade_hash: Uint8Array | null;
    upgrade_eta: u64;
    generation: u64;

    constructor(
      owner: Uint8Array | null = null,
      pending_owner: Uint8Array | null = null,
      pending_owner_eta: u64 = 0,
      upgrade_hash: Uint8Array | null = null,
      upgrade_eta: u64 = 0,
      generation: u64 = 0
    ) {
      this.owner = owner;
      this.pending_owner = pending_owner;
      this.pending_owner_eta = pending_owner_eta;
      this.upgrade_hash = upgrade_hash;
      this.upgrade_eta = upgrade_eta;
      this.generation = generation;
    }
  }

  export class game_config {
    static encode(message: game_config, writer: Writer): void {
      if (message.id != 0) {
        writer.uint32(8);
        writer.uint32(message.id);
      }

      const unique_name_name = message.name;
      if (unique_name_name !== null) {
        writer.uint32(18);
        writer.string(unique_name_name);
      }

      if (message.kind != 0) {
        writer.uint32(24);
        writer.uint32(message.kind);
      }

      if (message.list_size != 0) {
        writer.uint32(32);
        writer.uint32(message.list_size);
      }

      if (message.number_min != 0) {
        writer.uint32(40);
        writer.uint64(message.number_min);
      }

      if (message.number_max != 0) {
        writer.uint32(48);
        writer.uint64(message.number_max);
      }

      if (message.lock_mode != 0) {
        writer.uint32(56);
        writer.uint32(message.lock_mode);
      }

      if (message.round_size != 0) {
        writer.uint32(64);
        writer.uint64(message.round_size);
      }

      if (message.round_offset != 0) {
        writer.uint32(72);
        writer.uint64(message.round_offset);
      }

      if (message.lead != 0) {
        writer.uint32(80);
        writer.uint64(message.lead);
      }

      if (message.ahead != 0) {
        writer.uint32(88);
        writer.uint64(message.ahead);
      }

      if (message.max_picks_per_day != 0) {
        writer.uint32(96);
        writer.uint32(message.max_picks_per_day);
      }

      if (message.max_changes != 0) {
        writer.uint32(104);
        writer.uint32(message.max_changes);
      }

      if (message.enabled != false) {
        writer.uint32(112);
        writer.bool(message.enabled);
      }
    }

    static decode(reader: Reader, length: i32): game_config {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new game_config();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.id = reader.uint32();
            break;

          case 2:
            message.name = reader.string();
            break;

          case 3:
            message.kind = reader.uint32();
            break;

          case 4:
            message.list_size = reader.uint32();
            break;

          case 5:
            message.number_min = reader.uint64();
            break;

          case 6:
            message.number_max = reader.uint64();
            break;

          case 7:
            message.lock_mode = reader.uint32();
            break;

          case 8:
            message.round_size = reader.uint64();
            break;

          case 9:
            message.round_offset = reader.uint64();
            break;

          case 10:
            message.lead = reader.uint64();
            break;

          case 11:
            message.ahead = reader.uint64();
            break;

          case 12:
            message.max_picks_per_day = reader.uint32();
            break;

          case 13:
            message.max_changes = reader.uint32();
            break;

          case 14:
            message.enabled = reader.bool();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    id: u32;
    name: string | null;
    kind: u32;
    list_size: u32;
    number_min: u64;
    number_max: u64;
    lock_mode: u32;
    round_size: u64;
    round_offset: u64;
    lead: u64;
    ahead: u64;
    max_picks_per_day: u32;
    max_changes: u32;
    enabled: bool;

    constructor(
      id: u32 = 0,
      name: string | null = null,
      kind: u32 = 0,
      list_size: u32 = 0,
      number_min: u64 = 0,
      number_max: u64 = 0,
      lock_mode: u32 = 0,
      round_size: u64 = 0,
      round_offset: u64 = 0,
      lead: u64 = 0,
      ahead: u64 = 0,
      max_picks_per_day: u32 = 0,
      max_changes: u32 = 0,
      enabled: bool = false
    ) {
      this.id = id;
      this.name = name;
      this.kind = kind;
      this.list_size = list_size;
      this.number_min = number_min;
      this.number_max = number_max;
      this.lock_mode = lock_mode;
      this.round_size = round_size;
      this.round_offset = round_offset;
      this.lead = lead;
      this.ahead = ahead;
      this.max_picks_per_day = max_picks_per_day;
      this.max_changes = max_changes;
      this.enabled = enabled;
    }
  }

  export class pending_game {
    static encode(message: pending_game, writer: Writer): void {
      const unique_name_game = message.game;
      if (unique_name_game !== null) {
        writer.uint32(10);
        writer.fork();
        game_config.encode(unique_name_game, writer);
        writer.ldelim();
      }

      if (message.eta != 0) {
        writer.uint32(16);
        writer.uint64(message.eta);
      }

      if (message.generation != 0) {
        writer.uint32(24);
        writer.uint64(message.generation);
      }
    }

    static decode(reader: Reader, length: i32): pending_game {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new pending_game();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.game = game_config.decode(reader, reader.uint32());
            break;

          case 2:
            message.eta = reader.uint64();
            break;

          case 3:
            message.generation = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    game: game_config | null;
    eta: u64;
    generation: u64;

    constructor(
      game: game_config | null = null,
      eta: u64 = 0,
      generation: u64 = 0
    ) {
      this.game = game;
      this.eta = eta;
      this.generation = generation;
    }
  }

  export class pick_object {
    static encode(message: pick_object, writer: Writer): void {
      const unique_name_producers = message.producers;
      if (unique_name_producers.length !== 0) {
        for (let i = 0; i < unique_name_producers.length; ++i) {
          writer.uint32(10);
          writer.bytes(unique_name_producers[i]);
        }
      }

      if (message.number != 0) {
        writer.uint32(16);
        writer.uint64(message.number);
      }

      if (message.height != 0) {
        writer.uint32(24);
        writer.uint64(message.height);
      }

      if (message.time != 0) {
        writer.uint32(32);
        writer.uint64(message.time);
      }

      if (message.changes != 0) {
        writer.uint32(40);
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
            message.producers.push(reader.bytes());
            break;

          case 2:
            message.number = reader.uint64();
            break;

          case 3:
            message.height = reader.uint64();
            break;

          case 4:
            message.time = reader.uint64();
            break;

          case 5:
            message.changes = reader.uint32();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    producers: Array<Uint8Array>;
    number: u64;
    height: u64;
    time: u64;
    changes: u32;

    constructor(
      producers: Array<Uint8Array> = [],
      number: u64 = 0,
      height: u64 = 0,
      time: u64 = 0,
      changes: u32 = 0
    ) {
      this.producers = producers;
      this.number = number;
      this.height = height;
      this.time = time;
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

  @unmanaged
  export class eta_result {
    static encode(message: eta_result, writer: Writer): void {
      if (message.eta != 0) {
        writer.uint32(8);
        writer.uint64(message.eta);
      }
    }

    static decode(reader: Reader, length: i32): eta_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new eta_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.eta = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    eta: u64;

    constructor(eta: u64 = 0) {
      this.eta = eta;
    }
  }

  export class pick_arguments {
    static encode(message: pick_arguments, writer: Writer): void {
      const unique_name_player = message.player;
      if (unique_name_player !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_player);
      }

      if (message.game != 0) {
        writer.uint32(16);
        writer.uint32(message.game);
      }

      if (message.round != 0) {
        writer.uint32(24);
        writer.uint64(message.round);
      }

      const unique_name_producers = message.producers;
      if (unique_name_producers.length !== 0) {
        for (let i = 0; i < unique_name_producers.length; ++i) {
          writer.uint32(34);
          writer.bytes(unique_name_producers[i]);
        }
      }

      if (message.number != 0) {
        writer.uint32(40);
        writer.uint64(message.number);
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
            message.game = reader.uint32();
            break;

          case 3:
            message.round = reader.uint64();
            break;

          case 4:
            message.producers.push(reader.bytes());
            break;

          case 5:
            message.number = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    player: Uint8Array | null;
    game: u32;
    round: u64;
    producers: Array<Uint8Array>;
    number: u64;

    constructor(
      player: Uint8Array | null = null,
      game: u32 = 0,
      round: u64 = 0,
      producers: Array<Uint8Array> = [],
      number: u64 = 0
    ) {
      this.player = player;
      this.game = game;
      this.round = round;
      this.producers = producers;
      this.number = number;
    }
  }

  export class pick_event {
    static encode(message: pick_event, writer: Writer): void {
      const unique_name_player = message.player;
      if (unique_name_player !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_player);
      }

      if (message.game != 0) {
        writer.uint32(16);
        writer.uint32(message.game);
      }

      if (message.round != 0) {
        writer.uint32(24);
        writer.uint64(message.round);
      }

      const unique_name_producers = message.producers;
      if (unique_name_producers.length !== 0) {
        for (let i = 0; i < unique_name_producers.length; ++i) {
          writer.uint32(34);
          writer.bytes(unique_name_producers[i]);
        }
      }

      if (message.number != 0) {
        writer.uint32(40);
        writer.uint64(message.number);
      }

      if (message.height != 0) {
        writer.uint32(48);
        writer.uint64(message.height);
      }

      if (message.time != 0) {
        writer.uint32(56);
        writer.uint64(message.time);
      }

      if (message.change != false) {
        writer.uint32(64);
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
            message.game = reader.uint32();
            break;

          case 3:
            message.round = reader.uint64();
            break;

          case 4:
            message.producers.push(reader.bytes());
            break;

          case 5:
            message.number = reader.uint64();
            break;

          case 6:
            message.height = reader.uint64();
            break;

          case 7:
            message.time = reader.uint64();
            break;

          case 8:
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
    game: u32;
    round: u64;
    producers: Array<Uint8Array>;
    number: u64;
    height: u64;
    time: u64;
    change: bool;

    constructor(
      player: Uint8Array | null = null,
      game: u32 = 0,
      round: u64 = 0,
      producers: Array<Uint8Array> = [],
      number: u64 = 0,
      height: u64 = 0,
      time: u64 = 0,
      change: bool = false
    ) {
      this.player = player;
      this.game = game;
      this.round = round;
      this.producers = producers;
      this.number = number;
      this.height = height;
      this.time = time;
      this.change = change;
    }
  }

  export class get_pick_arguments {
    static encode(message: get_pick_arguments, writer: Writer): void {
      if (message.game != 0) {
        writer.uint32(8);
        writer.uint32(message.game);
      }

      if (message.round != 0) {
        writer.uint32(16);
        writer.uint64(message.round);
      }

      const unique_name_player = message.player;
      if (unique_name_player !== null) {
        writer.uint32(26);
        writer.bytes(unique_name_player);
      }
    }

    static decode(reader: Reader, length: i32): get_pick_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new get_pick_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.game = reader.uint32();
            break;

          case 2:
            message.round = reader.uint64();
            break;

          case 3:
            message.player = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    game: u32;
    round: u64;
    player: Uint8Array | null;

    constructor(
      game: u32 = 0,
      round: u64 = 0,
      player: Uint8Array | null = null
    ) {
      this.game = game;
      this.round = round;
      this.player = player;
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
      if (message.game != 0) {
        writer.uint32(8);
        writer.uint32(message.game);
      }

      if (message.round != 0) {
        writer.uint32(16);
        writer.uint64(message.round);
      }

      const unique_name_start_after = message.start_after;
      if (unique_name_start_after !== null) {
        writer.uint32(26);
        writer.bytes(unique_name_start_after);
      }

      if (message.limit != 0) {
        writer.uint32(32);
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
            message.game = reader.uint32();
            break;

          case 2:
            message.round = reader.uint64();
            break;

          case 3:
            message.start_after = reader.bytes();
            break;

          case 4:
            message.limit = reader.uint32();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    game: u32;
    round: u64;
    start_after: Uint8Array | null;
    limit: u32;

    constructor(
      game: u32 = 0,
      round: u64 = 0,
      start_after: Uint8Array | null = null,
      limit: u32 = 0
    ) {
      this.game = game;
      this.round = round;
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
      if (message.game != 0) {
        writer.uint32(8);
        writer.uint32(message.game);
      }

      const unique_name_player = message.player;
      if (unique_name_player !== null) {
        writer.uint32(18);
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
            message.game = reader.uint32();
            break;

          case 2:
            message.player = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    game: u32;
    player: Uint8Array | null;

    constructor(game: u32 = 0, player: Uint8Array | null = null) {
      this.game = game;
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

  @unmanaged
  export class get_game_arguments {
    static encode(message: get_game_arguments, writer: Writer): void {
      if (message.game != 0) {
        writer.uint32(8);
        writer.uint32(message.game);
      }
    }

    static decode(reader: Reader, length: i32): get_game_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new get_game_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.game = reader.uint32();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    game: u32;

    constructor(game: u32 = 0) {
      this.game = game;
    }
  }

  export class get_game_result {
    static encode(message: get_game_result, writer: Writer): void {
      const unique_name_game = message.game;
      if (unique_name_game !== null) {
        writer.uint32(10);
        writer.fork();
        game_config.encode(unique_name_game, writer);
        writer.ldelim();
      }

      const unique_name_pending = message.pending;
      if (unique_name_pending !== null) {
        writer.uint32(18);
        writer.fork();
        pending_game.encode(unique_name_pending, writer);
        writer.ldelim();
      }
    }

    static decode(reader: Reader, length: i32): get_game_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new get_game_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.game = game_config.decode(reader, reader.uint32());
            break;

          case 2:
            message.pending = pending_game.decode(reader, reader.uint32());
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    game: game_config | null;
    pending: pending_game | null;

    constructor(
      game: game_config | null = null,
      pending: pending_game | null = null
    ) {
      this.game = game;
      this.pending = pending;
    }
  }

  @unmanaged
  export class list_games_arguments {
    static encode(message: list_games_arguments, writer: Writer): void {}

    static decode(reader: Reader, length: i32): list_games_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new list_games_arguments();

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

  export class list_games_result {
    static encode(message: list_games_result, writer: Writer): void {
      const unique_name_games = message.games;
      for (let i = 0; i < unique_name_games.length; ++i) {
        writer.uint32(10);
        writer.fork();
        game_config.encode(unique_name_games[i], writer);
        writer.ldelim();
      }
    }

    static decode(reader: Reader, length: i32): list_games_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new list_games_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.games.push(game_config.decode(reader, reader.uint32()));
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    games: Array<game_config>;

    constructor(games: Array<game_config> = []) {
      this.games = games;
    }
  }

  @unmanaged
  export class list_pending_arguments {
    static encode(message: list_pending_arguments, writer: Writer): void {
      if (message.start_after != 0) {
        writer.uint32(8);
        writer.uint32(message.start_after);
      }

      if (message.limit != 0) {
        writer.uint32(16);
        writer.uint32(message.limit);
      }
    }

    static decode(reader: Reader, length: i32): list_pending_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new list_pending_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.start_after = reader.uint32();
            break;

          case 2:
            message.limit = reader.uint32();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    start_after: u32;
    limit: u32;

    constructor(start_after: u32 = 0, limit: u32 = 0) {
      this.start_after = start_after;
      this.limit = limit;
    }
  }

  export class list_pending_result {
    static encode(message: list_pending_result, writer: Writer): void {
      const unique_name_pending = message.pending;
      for (let i = 0; i < unique_name_pending.length; ++i) {
        writer.uint32(10);
        writer.fork();
        pending_game.encode(unique_name_pending[i], writer);
        writer.ldelim();
      }
    }

    static decode(reader: Reader, length: i32): list_pending_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new list_pending_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.pending.push(pending_game.decode(reader, reader.uint32()));
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    pending: Array<pending_game>;

    constructor(pending: Array<pending_game> = []) {
      this.pending = pending;
    }
  }

  export class announce_game_arguments {
    static encode(message: announce_game_arguments, writer: Writer): void {
      const unique_name_game = message.game;
      if (unique_name_game !== null) {
        writer.uint32(10);
        writer.fork();
        game_config.encode(unique_name_game, writer);
        writer.ldelim();
      }
    }

    static decode(reader: Reader, length: i32): announce_game_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new announce_game_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.game = game_config.decode(reader, reader.uint32());
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    game: game_config | null;

    constructor(game: game_config | null = null) {
      this.game = game;
    }
  }

  @unmanaged
  export class apply_game_arguments {
    static encode(message: apply_game_arguments, writer: Writer): void {
      if (message.game != 0) {
        writer.uint32(8);
        writer.uint32(message.game);
      }
    }

    static decode(reader: Reader, length: i32): apply_game_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new apply_game_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.game = reader.uint32();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    game: u32;

    constructor(game: u32 = 0) {
      this.game = game;
    }
  }

  export class tighten_game_arguments {
    static encode(message: tighten_game_arguments, writer: Writer): void {
      const unique_name_game = message.game;
      if (unique_name_game !== null) {
        writer.uint32(10);
        writer.fork();
        game_config.encode(unique_name_game, writer);
        writer.ldelim();
      }
    }

    static decode(reader: Reader, length: i32): tighten_game_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new tighten_game_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.game = game_config.decode(reader, reader.uint32());
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    game: game_config | null;

    constructor(game: game_config | null = null) {
      this.game = game;
    }
  }

  @unmanaged
  export class cancel_game_change_arguments {
    static encode(message: cancel_game_change_arguments, writer: Writer): void {
      if (message.game != 0) {
        writer.uint32(8);
        writer.uint32(message.game);
      }
    }

    static decode(reader: Reader, length: i32): cancel_game_change_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new cancel_game_change_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.game = reader.uint32();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    game: u32;

    constructor(game: u32 = 0) {
      this.game = game;
    }
  }

  export class propose_owner_arguments {
    static encode(message: propose_owner_arguments, writer: Writer): void {
      const unique_name_owner = message.owner;
      if (unique_name_owner !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_owner);
      }
    }

    static decode(reader: Reader, length: i32): propose_owner_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new propose_owner_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.owner = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    owner: Uint8Array | null;

    constructor(owner: Uint8Array | null = null) {
      this.owner = owner;
    }
  }

  @unmanaged
  export class accept_owner_arguments {
    static encode(message: accept_owner_arguments, writer: Writer): void {}

    static decode(reader: Reader, length: i32): accept_owner_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new accept_owner_arguments();

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

  export class schedule_upgrade_arguments {
    static encode(message: schedule_upgrade_arguments, writer: Writer): void {
      const unique_name_hash = message.hash;
      if (unique_name_hash !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_hash);
      }
    }

    static decode(reader: Reader, length: i32): schedule_upgrade_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new schedule_upgrade_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.hash = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    hash: Uint8Array | null;

    constructor(hash: Uint8Array | null = null) {
      this.hash = hash;
    }
  }

  export class game_event {
    static encode(message: game_event, writer: Writer): void {
      const unique_name_action = message.action;
      if (unique_name_action !== null) {
        writer.uint32(10);
        writer.string(unique_name_action);
      }

      const unique_name_game = message.game;
      if (unique_name_game !== null) {
        writer.uint32(18);
        writer.fork();
        game_config.encode(unique_name_game, writer);
        writer.ldelim();
      }

      if (message.eta != 0) {
        writer.uint32(24);
        writer.uint64(message.eta);
      }
    }

    static decode(reader: Reader, length: i32): game_event {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new game_event();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.action = reader.string();
            break;

          case 2:
            message.game = game_config.decode(reader, reader.uint32());
            break;

          case 3:
            message.eta = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    action: string | null;
    game: game_config | null;
    eta: u64;

    constructor(
      action: string | null = null,
      game: game_config | null = null,
      eta: u64 = 0
    ) {
      this.action = action;
      this.game = game;
      this.eta = eta;
    }
  }

  export class owner_event {
    static encode(message: owner_event, writer: Writer): void {
      const unique_name_action = message.action;
      if (unique_name_action !== null) {
        writer.uint32(10);
        writer.string(unique_name_action);
      }

      const unique_name_owner = message.owner;
      if (unique_name_owner !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_owner);
      }

      if (message.eta != 0) {
        writer.uint32(24);
        writer.uint64(message.eta);
      }
    }

    static decode(reader: Reader, length: i32): owner_event {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new owner_event();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.action = reader.string();
            break;

          case 2:
            message.owner = reader.bytes();
            break;

          case 3:
            message.eta = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    action: string | null;
    owner: Uint8Array | null;
    eta: u64;

    constructor(
      action: string | null = null,
      owner: Uint8Array | null = null,
      eta: u64 = 0
    ) {
      this.action = action;
      this.owner = owner;
      this.eta = eta;
    }
  }

  export class upgrade_event {
    static encode(message: upgrade_event, writer: Writer): void {
      const unique_name_hash = message.hash;
      if (unique_name_hash !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_hash);
      }

      if (message.eta != 0) {
        writer.uint32(16);
        writer.uint64(message.eta);
      }
    }

    static decode(reader: Reader, length: i32): upgrade_event {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new upgrade_event();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.hash = reader.bytes();
            break;

          case 2:
            message.eta = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    hash: Uint8Array | null;
    eta: u64;

    constructor(hash: Uint8Array | null = null, eta: u64 = 0) {
      this.hash = hash;
      this.eta = eta;
    }
  }
}
