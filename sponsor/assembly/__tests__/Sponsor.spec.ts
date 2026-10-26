// =====================================================================
// Knode mana sponsor: tests
//
// The mock VM recovers real secp256k1 signatures, so these tests use signatures made by
// scripts/make-test-fixtures.cjs over fixed transaction ids, with test-only keys (never funded).
// Ported from the SwarmTales sponsor tests, extended for the weekly cap, would_pay and the one-signer rule.
// =====================================================================

import { Arrays, Base58, MockVM, Protobuf, authority, chain, protocol } from "@koinos/sdk-as";
import {
  Sponsor, APPROVE_ENTRY, dayOf, weekOf,
  GAME_DEPOSIT_VHP, GAME_DEPOSIT_KOIN, GAME_WITHDRAW, GAME_ANSWER, GAME_SETTLE, GAME_CLAIM, GAME_CLOSE_WEEK, GAME_FINALIZE_WEEK, DESK_SWAP,
} from "../Sponsor";
import { sponsor } from "../proto/sponsor";
import { F } from "./fixtures";

const SELF = Base58.decode(F.SELF);
const USER = Base58.decode(F.USER);
const OTHER = Base58.decode(F.OTHER);
const GAME = Base58.decode("1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr");
const DESK = Base58.decode("1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR");
const VHP = Base58.decode("12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq");
const KOIN = Base58.decode("19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK");
const STRANGER_CONTRACT = Base58.decode("1EDaCKVmBjUxLxgWCmDbRA8gWKkSQ6ByzY");
const ATTACKER = Base58.decode("16ixK5DgvcojcZLvxyYWhHFcRXfhfrHbpL");

const MANA: u64 = 100000000;
const DAY_MS: u64 = 86400000;
// 2023-11-14 22:13 UTC, a Tuesday.
const T0: u64 = 1700000000000;
// 2023-11-19 23:00 UTC (Sunday) and 2023-11-20 00:00 UTC (the next Monday).
const SUNDAY_LATE: u64 = 1700434800000;
const NEXT_MONDAY: u64 = 1700438400000;
const TRANSFER_ENTRY: u32 = 0x27f576ca;
// Game and Desk owner-only entry points (never sponsored).
const GAME_SET_OPERATOR: u32 = 0x426e2c17;
const GAME_SCHEDULE_UPGRADE: u32 = 0xa58d30dd;
const GAME_SEED_DEPOSIT_VHP: u32 = 0x71d17431;
const GAME_COMPOUND: u32 = 0xee0df97c;
const DESK_WITHDRAW_KOIN: u32 = 0xc7c42a57;

// Closures aren't supported in AssemblyScript; tests set these, then call.
let OPS: protocol.operation[] = [];
let SIGNERS: string[] = [];
const NONE = new Uint8Array(0);
let PAYEE: Uint8Array = NONE;
let RC: u64 = 0;
let TX: i32 = 1;
let RAW_SIGS: Uint8Array[] = [];

function hex(s: string): Uint8Array {
  return Arrays.fromHexString(s);
}

function sig(name: string, tx: i32): Uint8Array {
  if (tx == 1) {
    if (name == "SELF") return hex(F.SIG_SELF_TX1);
    if (name == "USER") return hex(F.SIG_USER_TX1);
    if (name == "OTHER") return hex(F.SIG_OTHER_TX1);
  } else if (tx == 2) {
    if (name == "SELF") return hex(F.SIG_SELF_TX2);
    if (name == "USER") return hex(F.SIG_USER_TX2);
    if (name == "OTHER") return hex(F.SIG_OTHER_TX2);
  } else {
    if (name == "SELF") return hex(F.SIG_SELF_TX3);
    if (name == "USER") return hex(F.SIG_USER_TX3);
    if (name == "OTHER") return hex(F.SIG_OTHER_TX3);
  }
  throw new Error("no fixture " + name);
}

function txId(tx: i32): Uint8Array {
  return hex(tx == 1 ? F.TX1_ID : tx == 2 ? F.TX2_ID : F.TX3_ID);
}

function call(contract: Uint8Array, entry: u32, args: Uint8Array): protocol.operation {
  return new protocol.operation(null, new protocol.call_contract_operation(contract, entry, args));
}

function approve(token: Uint8Array, owner: Uint8Array, spender: Uint8Array): protocol.operation {
  const a = new sponsor.approve_args(owner, spender, 5000000);
  return call(token, APPROVE_ENTRY, Protobuf.encode(a, sponsor.approve_args.encode));
}

/** Put the transaction built from OPS/SIGNERS/PAYEE/RC/TX (plus any RAW_SIGS) in the mock. */
function apply(): void {
  const t = new protocol.transaction();
  t.id = txId(TX);
  t.header = new protocol.transaction_header(NONE, RC, NONE, NONE, SELF, PAYEE);
  t.operations = OPS;
  const sigs: Uint8Array[] = [];
  for (let i = 0; i < SIGNERS.length; i++) sigs.push(sig(SIGNERS[i], TX));
  for (let i = 0; i < RAW_SIGS.length; i++) sigs.push(RAW_SIGS[i]);
  t.signatures = sigs;
  MockVM.setTransaction(t);
}

function pays(): bool {
  apply();
  return new Sponsor().authorize(new authority.authorize_arguments(authority.authorization_type.transaction_application)).value;
}

/** A normal sponsored stake by USER: approve the game for VHP, then deposit. */
function userStake(tx: i32, rc: u64): void {
  TX = tx;
  RC = rc;
  PAYEE = USER;
  SIGNERS = ["USER"];
  RAW_SIGS = [];
  OPS = [approve(VHP, USER, GAME), call(GAME, GAME_DEPOSIT_VHP, new Uint8Array(0))];
}

function userCall(tx: i32, rc: u64, contract: Uint8Array, entry: u32): void {
  TX = tx;
  RC = rc;
  PAYEE = USER;
  SIGNERS = ["USER"];
  RAW_SIGS = [];
  OPS = [call(contract, entry, new Uint8Array(0))];
}

function setTime(ms: u64): void {
  MockVM.setHeadInfo(new chain.head_info(null, ms, 0));
}

function errorIs(message: string): void {
  expect(MockVM.getErrorMessage()).toBe(message);
  MockVM.rollbackTransaction();
}

function asOwner(): void {
  MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, SELF, true)]);
}

/** per tx 10, per player per day 30, per player per week 50, everyone per day 100 (Mana). */
function goodConfig(): sponsor.config {
  return new sponsor.config(true, GAME, DESK, [VHP, KOIN], 10 * MANA, 30 * MANA, 50 * MANA, 100 * MANA);
}

let CFG: sponsor.config = new sponsor.config();

function setConfig(): void {
  asOwner();
  new Sponsor().set_config(new sponsor.set_config_arguments(CFG));
}

function configure(): void {
  CFG = goodConfig();
  setConfig();
  MockVM.commitTransaction();
}

function start(): void {
  MockVM.reset();
  MockVM.setContractId(SELF);
  setTime(T0);
  MockVM.commitTransaction();
  RAW_SIGS = [];
}

describe("day and week numbers", () => {
  it("weeks start on Monday 00:00 UTC", () => {
    expect(weekOf(SUNDAY_LATE)).toBe(weekOf(T0));
    expect(weekOf(NEXT_MONDAY)).toBe(weekOf(T0) + 1);
    expect(weekOf(NEXT_MONDAY - 1)).toBe(weekOf(T0));
    expect(dayOf(NEXT_MONDAY)).toBe(dayOf(SUNDAY_LATE) + 1);
    // 1970-01-05 was a Monday: day 4 is the first day of week 1.
    expect(weekOf(3 * DAY_MS)).toBe(0);
    expect(weekOf(4 * DAY_MS)).toBe(1);
  });
});

describe("sponsor settings", () => {
  beforeEach(() => { start(); });

  it("starts switched off and pays nothing for players", () => {
    userStake(1, MANA);
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: switched off");
    expect(new Sponsor().get_config(new sponsor.get_config_arguments()).enabled).toBe(false);
  });

  it("saves settings with the sponsor's own key and emits them", () => {
    configure();
    const cfg = new Sponsor().get_config(new sponsor.get_config_arguments());
    expect(cfg.enabled).toBe(true);
    expect(Arrays.equal(cfg.game!, GAME)).toBe(true);
    expect(Arrays.equal(cfg.desk!, DESK)).toBe(true);
    expect(cfg.tokens.length).toBe(2);
    expect(cfg.max_mana_per_tx).toBe(10 * MANA);
    expect(cfg.max_mana_per_account_week).toBe(50 * MANA);
    const events = MockVM.getEvents();
    expect(events[events.length - 1].name).toBe("sponsor.config_event");
  });

  it("refuses settings from anyone else", () => {
    MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, SELF, false)]);
    CFG = goodConfig();
    expect(() => { new Sponsor().set_config(new sponsor.set_config_arguments(CFG)); }).toThrow();
    errorIs("SPONSOR: needs the sponsor wallet's own key");
  });

  it("refuses a per-transaction cap above the per-day cap", () => {
    CFG = goodConfig();
    CFG.max_mana_per_tx = 40 * MANA;
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: caps must be per transaction <= per player per day <= per player per week, and per player per day <= per day");
  });

  it("refuses a per-player day cap above the per-player week cap", () => {
    CFG = goodConfig();
    CFG.max_mana_per_account_week = 20 * MANA;
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: caps must be per transaction <= per player per day <= per player per week, and per player per day <= per day");
  });

  it("refuses a per-player day cap above everyone's day cap", () => {
    CFG = goodConfig();
    CFG.max_mana_per_day = 20 * MANA;
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: caps must be per transaction <= per player per day <= per player per week, and per player per day <= per day");
  });

  it("refuses a daily cap above 1,000 mana", () => {
    CFG = goodConfig();
    CFG.max_mana_per_day = 1001 * MANA;
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: daily cap above 1,000 mana");
  });

  it("refuses a weekly cap above 7,000 mana", () => {
    CFG = goodConfig();
    CFG.max_mana_per_account_week = 7001 * MANA;
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: weekly cap above 7,000 mana");
  });

  it("refuses switching on with a zero cap", () => {
    CFG = new sponsor.config(true, GAME, DESK, [], 0, 0, 0, 0);
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: switched on with a zero cap");
  });

  it("refuses a bad address", () => {
    CFG = goodConfig();
    CFG.game = new Uint8Array(25);
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: invalid contract address");
  });

  it("refuses the same contract twice", () => {
    CFG = goodConfig();
    CFG.desk = GAME;
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: the game and Knode Swap must differ");
  });

  it("refuses itself as a Knode contract", () => {
    CFG = goodConfig();
    CFG.game = SELF;
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: the sponsor can't be a Knode contract");
  });

  it("refuses a token that is a Knode contract", () => {
    CFG = goodConfig();
    CFG.tokens = [VHP, DESK];
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: a token can't be a Knode contract or the sponsor");
  });

  it("refuses itself as a token", () => {
    CFG = goodConfig();
    CFG.tokens = [VHP, SELF];
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: a token can't be a Knode contract or the sponsor");
  });

  it("refuses a duplicate token", () => {
    CFG = goodConfig();
    CFG.tokens = [VHP, VHP];
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: duplicate token");
  });

  it("refuses more than 4 tokens", () => {
    CFG = goodConfig();
    CFG.tokens = [VHP, KOIN, STRANGER_CONTRACT, OTHER, USER];
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: at most 4 tokens");
  });

  it("can be switched off, and then pays nothing", () => {
    configure();
    CFG = goodConfig();
    CFG.enabled = false;
    setConfig();
    MockVM.commitTransaction();
    userStake(1, MANA);
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: switched off");
  });
});

describe("sponsor pays player actions", () => {
  beforeEach(() => { start(); configure(); });

  it("pays a stake (approve + deposit) and counts it for the day and the week", () => {
    userStake(1, 5 * MANA);
    expect(pays()).toBe(true);
    const mine = new Sponsor().get_usage(new sponsor.get_usage_arguments(USER));
    expect(mine.used_day).toBe(5 * MANA);
    expect(mine.used_week).toBe(5 * MANA);
    expect(mine.day).toBe(dayOf(T0));
    expect(mine.week).toBe(weekOf(T0));
    expect(new Sponsor().get_total_usage(new sponsor.get_total_usage_arguments()).used_day).toBe(5 * MANA);
  });

  it("pays a KOIN stake (approve KOIN + deposit_koin)", () => {
    TX = 1; RC = MANA; PAYEE = USER; SIGNERS = ["USER"]; RAW_SIGS = [];
    OPS = [approve(KOIN, USER, GAME), call(GAME, GAME_DEPOSIT_KOIN, new Uint8Array(0))];
    expect(pays()).toBe(true);
  });

  it("pays every player action on the game", () => {
    const entries: u32[] = [GAME_WITHDRAW, GAME_ANSWER, GAME_SETTLE, GAME_CLAIM, GAME_CLOSE_WEEK, GAME_FINALIZE_WEEK];
    TX = 1; RC = MANA; PAYEE = USER; SIGNERS = ["USER"]; RAW_SIGS = [];
    OPS = [];
    for (let i = 0; i < entries.length; i++) OPS.push(call(GAME, entries[i], new Uint8Array(0)));
    expect(pays()).toBe(true);
  });

  it("pays a swap on Knode Swap (approve VHP to the Desk + swap)", () => {
    TX = 1; RC = MANA; PAYEE = USER; SIGNERS = ["USER"]; RAW_SIGS = [];
    OPS = [approve(VHP, USER, DESK), call(DESK, DESK_SWAP, new Uint8Array(0))];
    expect(pays()).toBe(true);
  });

  it("pays the owner's own transactions without counting them", () => {
    TX = 1; RC = 500 * MANA; PAYEE = NONE; SIGNERS = ["SELF"]; RAW_SIGS = [];
    OPS = [call(KOIN, TRANSFER_ENTRY, new Uint8Array(0))];
    expect(pays()).toBe(true);
    expect(new Sponsor().get_total_usage(new sponsor.get_total_usage_arguments()).used_day).toBe(0);
  });

  it("answers no for any other kind of authority", () => {
    userStake(1, MANA);
    apply();
    expect(new Sponsor().authorize(new authority.authorize_arguments(authority.authorization_type.contract_call)).value).toBe(false);
    expect(new Sponsor().authorize(new authority.authorize_arguments(authority.authorization_type.contract_upload)).value).toBe(false);
  });
});

describe("sponsor refuses", () => {
  beforeEach(() => { start(); configure(); });

  it("a transaction that doesn't name the player as payee", () => {
    userStake(1, MANA);
    PAYEE = NONE;
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: the transaction must name the player as payee");
  });

  it("a transaction the payee didn't sign", () => {
    userStake(1, MANA);
    SIGNERS = ["OTHER"];
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: the payee must sign");
  });

  it("a payee signature made for another transaction", () => {
    userStake(1, MANA);
    SIGNERS = [];
    RAW_SIGS = [sig("USER", 2)];
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: the payee must sign");
  });

  it("a second signer next to the payee", () => {
    userStake(1, MANA);
    SIGNERS = ["USER", "OTHER"];
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: only the payee may sign");
  });

  it("an extra signature that isn't valid (recovery fails: the whole check fails)", () => {
    userStake(1, MANA);
    RAW_SIGS = [new Uint8Array(65)];
    expect(() => { pays(); }).toThrow();
    MockVM.rollbackTransaction();
  });

  it("an extra signature of the wrong length", () => {
    userStake(1, MANA);
    RAW_SIGS = [new Uint8Array(10)];
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: only the payee may sign");
  });

  it("the same signature twice counts once (still just the payee)", () => {
    userStake(1, MANA);
    SIGNERS = ["USER", "USER"];
    expect(pays()).toBe(true);
  });

  it("the sponsor as payee", () => {
    userStake(1, MANA);
    PAYEE = SELF;
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: the sponsor can't be the payee");
  });

  it("a call to any other contract", () => {
    userStake(1, MANA);
    OPS = [call(GAME, GAME_ANSWER, new Uint8Array(0)), call(STRANGER_CONTRACT, 1, new Uint8Array(0))];
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: only Knode calls are sponsored");
  });

  it("owner and operator actions on the game", () => {
    userCall(1, MANA, GAME, GAME_SET_OPERATOR);
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: only player actions on the game are sponsored");
    userCall(1, MANA, GAME, GAME_SCHEDULE_UPGRADE);
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: only player actions on the game are sponsored");
    userCall(1, MANA, GAME, GAME_SEED_DEPOSIT_VHP);
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: only player actions on the game are sponsored");
  });

  it("compound (the bot pays for it)", () => {
    userCall(1, MANA, GAME, GAME_COMPOUND);
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: only player actions on the game are sponsored");
  });

  it("anything on Knode Swap but a swap", () => {
    userCall(1, MANA, DESK, DESK_WITHDRAW_KOIN);
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: only swaps on Knode Swap are sponsored");
  });

  it("a token transfer", () => {
    userCall(1, MANA, VHP, TRANSFER_ENTRY);
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: only approve is sponsored on a token");
  });

  it("an approve to an attacker's spender", () => {
    userStake(1, MANA);
    OPS = [approve(VHP, USER, ATTACKER), call(GAME, GAME_DEPOSIT_VHP, new Uint8Array(0))];
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: approve must name the game or Knode Swap as spender");
  });

  it("an approve of someone else's tokens", () => {
    userStake(1, MANA);
    OPS = [approve(VHP, OTHER, GAME)];
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: approve must be for the payee's own tokens");
  });

  it("an approve on a token that isn't listed", () => {
    userStake(1, MANA);
    OPS = [approve(STRANGER_CONTRACT, USER, GAME)];
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: only Knode calls are sponsored");
  });

  it("an upload", () => {
    userStake(1, MANA);
    OPS = [new protocol.operation(new protocol.upload_contract_operation(USER, new Uint8Array(4)))];
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: only contract calls are sponsored");
  });

  it("no operations", () => {
    userStake(1, MANA);
    OPS = [];
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: 1 to 10 operations");
  });

  it("11 operations", () => {
    userStake(1, MANA);
    OPS = [];
    for (let i = 0; i < 11; i++) OPS.push(call(GAME, GAME_ANSWER, new Uint8Array(0)));
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: 1 to 10 operations");
  });

  it("a mana limit above the per-transaction cap", () => {
    userStake(1, 10 * MANA + 1);
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: mana limit above the per-transaction cap");
  });

  it("a zero mana limit", () => {
    userStake(1, 0);
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: mana limit above the per-transaction cap");
  });
});

describe("sponsor caps", () => {
  beforeEach(() => { start(); configure(); });

  it("stops at the per-player daily cap and starts again the next day", () => {
    for (let i = 1; i <= 3; i++) {
      userStake(i, 10 * MANA);
      expect(pays()).toBe(true);
      MockVM.commitTransaction();
    }
    userStake(1, MANA);
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: this player's daily sponsored mana is used up");
    setTime(T0 + DAY_MS);
    MockVM.commitTransaction();
    userStake(1, MANA);
    expect(pays()).toBe(true);
    const u = new Sponsor().get_usage(new sponsor.get_usage_arguments(USER));
    expect(u.used_day).toBe(MANA);
    expect(u.used_week).toBe(31 * MANA);
  });

  it("stops at the per-player weekly cap across days, and starts again on Monday", () => {
    // Tuesday 30, Wednesday 20: the week's 50 is used.
    for (let i = 1; i <= 3; i++) { userStake(i, 10 * MANA); expect(pays()).toBe(true); MockVM.commitTransaction(); }
    setTime(T0 + DAY_MS);
    MockVM.commitTransaction();
    for (let i = 1; i <= 2; i++) { userStake(i, 10 * MANA); expect(pays()).toBe(true); MockVM.commitTransaction(); }
    userStake(3, MANA);
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: this player's weekly sponsored mana is used up");
    // Still the same week late on Sunday.
    setTime(SUNDAY_LATE);
    MockVM.commitTransaction();
    userStake(1, MANA);
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: this player's weekly sponsored mana is used up");
    // Monday 00:00 UTC: a new week.
    setTime(NEXT_MONDAY);
    MockVM.commitTransaction();
    userStake(1, 10 * MANA);
    expect(pays()).toBe(true);
    const u = new Sponsor().get_usage(new sponsor.get_usage_arguments(USER));
    expect(u.used_week).toBe(10 * MANA);
    expect(u.week).toBe(weekOf(NEXT_MONDAY));
  });

  it("counts each player separately", () => {
    for (let i = 1; i <= 3; i++) { userStake(i, 10 * MANA); expect(pays()).toBe(true); MockVM.commitTransaction(); }
    TX = 1; RC = 10 * MANA; PAYEE = OTHER; SIGNERS = ["OTHER"]; RAW_SIGS = [];
    OPS = [call(GAME, GAME_ANSWER, new Uint8Array(0))];
    expect(pays()).toBe(true);
    expect(new Sponsor().get_usage(new sponsor.get_usage_arguments(OTHER)).used_day).toBe(10 * MANA);
  });

  it("stops at the daily cap for everyone", () => {
    CFG = goodConfig();
    CFG.max_mana_per_day = 35 * MANA;
    setConfig();
    MockVM.commitTransaction();
    for (let i = 1; i <= 3; i++) { userStake(i, 10 * MANA); expect(pays()).toBe(true); MockVM.commitTransaction(); }
    TX = 1; RC = 10 * MANA; PAYEE = OTHER; SIGNERS = ["OTHER"]; RAW_SIGS = [];
    OPS = [call(GAME, GAME_ANSWER, new Uint8Array(0))];
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: today's sponsored mana is used up");
    RC = 5 * MANA;
    expect(pays()).toBe(true);
    MockVM.commitTransaction();
    expect(new Sponsor().get_total_usage(new sponsor.get_total_usage_arguments()).used_day).toBe(35 * MANA);
    // The next day everyone starts again.
    setTime(T0 + DAY_MS);
    MockVM.commitTransaction();
    expect(new Sponsor().get_total_usage(new sponsor.get_total_usage_arguments()).used_day).toBe(0);
  });

  it("reads yesterday's and last week's usage as 0", () => {
    userStake(1, 7 * MANA);
    expect(pays()).toBe(true);
    MockVM.commitTransaction();
    setTime(NEXT_MONDAY);
    MockVM.commitTransaction();
    const u = new Sponsor().get_usage(new sponsor.get_usage_arguments(USER));
    expect(u.used_day).toBe(0);
    expect(u.used_week).toBe(0);
  });
});

describe("would_pay", () => {
  beforeEach(() => { start(); });

  it("says no while switched off", () => {
    const r = new Sponsor().would_pay(new sponsor.would_pay_arguments(USER, MANA));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("switched off");
  });

  it("says yes within the caps, and how much is left", () => {
    configure();
    const r = new Sponsor().would_pay(new sponsor.would_pay_arguments(USER, MANA));
    expect(r.ok).toBe(true);
    expect(r.left_today).toBe(30 * MANA);
    expect(r.left_this_week).toBe(50 * MANA);
  });

  it("names the cap that would refuse", () => {
    configure();
    expect(new Sponsor().would_pay(new sponsor.would_pay_arguments(USER, 11 * MANA)).reason).toBe("mana limit above the per-transaction cap");
    for (let i = 1; i <= 3; i++) { userStake(i, 10 * MANA); expect(pays()).toBe(true); MockVM.commitTransaction(); }
    const r = new Sponsor().would_pay(new sponsor.would_pay_arguments(USER, MANA));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("this player's daily sponsored mana is used up");
    expect(r.left_today).toBe(0);
    expect(r.left_this_week).toBe(20 * MANA);
    setTime(T0 + DAY_MS);
    MockVM.commitTransaction();
    for (let i = 1; i <= 2; i++) { userStake(i, 10 * MANA); expect(pays()).toBe(true); MockVM.commitTransaction(); }
    expect(new Sponsor().would_pay(new sponsor.would_pay_arguments(USER, MANA)).reason).toBe("this player's weekly sponsored mana is used up");
  });

  it("names everyone's daily cap", () => {
    CFG = goodConfig();
    CFG.max_mana_per_day = 30 * MANA;
    setConfig();
    MockVM.commitTransaction();
    for (let i = 1; i <= 3; i++) { userStake(i, 10 * MANA); expect(pays()).toBe(true); MockVM.commitTransaction(); }
    const r = new Sponsor().would_pay(new sponsor.would_pay_arguments(OTHER, MANA));
    expect(r.reason).toBe("today's sponsored mana is used up");
    expect(r.left_today).toBe(0);
  });
});
