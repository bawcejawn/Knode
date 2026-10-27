// =====================================================================
// Knode Producer Race picks: contract tests, run inside the Koinos mock VM (no network, no KOIN).
// The lock (no pick once a race has started), the 24-hour window, one pick per wallet per race, the daily limit,
// signatures, settings, and reading the picks back.
// =====================================================================

import { Arrays, Base58, MockVM, Protobuf, authority, chain } from "@koinos/sdk-as";
import { Race, RACE_MS, DAY_MS, CLOSED, LOCKED, TOO_EARLY, USED_UP, SAME, NOT_SIGNED } from "../Race";
import { race } from "../proto/race";

const SELF = Base58.decode("1EDaCKVmBjUxLxgWCmDbRA8gWKkSQ6ByzY");      // the race contract
const OWNER = Base58.decode("1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717");     // the Knode owner
const P1 = Base58.decode("1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv");
const P2 = Base58.decode("16ixK5DgvcojcZLvxyYWhHFcRXfhfrHbpL");
const P3 = Base58.decode("1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8");
const H1 = Base58.decode("15NZhQoewzsbVUcSVsZ8BEBEKgaBNPLLgZ");
const H2 = Base58.decode("1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW");
const BAD = Base58.decode("1MbsVfNw6yzQqA8499d8KQj8qdLyRs8Czz");      // checksum wrong

// 2026-10-27 06:00 UTC: the start of race 83013.
const R: u64 = 83013;
const T: u64 = R * RACE_MS;
const HOUR: u64 = 3600000;

function setTime(ms: u64): void { MockVM.setHeadInfo(new chain.head_info(null, ms, 0)); }
/** A call straight from a transaction: the chain reports an empty caller. */
function direct(): void { MockVM.setCaller(new chain.caller_data(new Uint8Array(0), chain.privilege.user_mode)); }
function signedBy(a: Uint8Array): void { MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, a, true)]); }
function errorIs(message: string): void { expect(MockVM.getErrorMessage()).toBe(message); MockVM.rollbackTransaction(); }

let ARGS: race.pick_arguments = new race.pick_arguments();
function doPick(): void { new Race().pick(ARGS); }
function pick(player: Uint8Array, r: u64, horse: Uint8Array): void {
  signedBy(player);
  ARGS = new race.pick_arguments(player, r, horse);
  doPick();
  MockVM.commitTransaction();
}
function refused(player: Uint8Array, r: u64, horse: Uint8Array, message: string): void {
  signedBy(player);
  ARGS = new race.pick_arguments(player, r, horse);
  expect(() => { doPick(); }).toThrow();
  errorIs(message);
}
function pickOf(player: Uint8Array, r: u64): race.pick_object | null {
  return new Race().get_pick(new race.get_pick_arguments(player, r)).pick;
}

let CFG: race.config = new race.config();
function setConfig(): void { new Race().set_config(new race.set_config_arguments(CFG)); }

function start(): void {
  MockVM.reset();
  MockVM.setContractId(SELF);
  direct();
  setTime(T + HOUR);                         // 07:00 UTC, during race R
  MockVM.commitTransaction();
  signedBy(SELF);                            // the first setup: the contract's own key
  CFG = new race.config(OWNER, true, 5);
  setConfig();
  MockVM.commitTransaction();
}

describe("settings", () => {
  beforeEach(() => { MockVM.reset(); MockVM.setContractId(SELF); direct(); setTime(T); MockVM.commitTransaction(); });

  it("the first setup needs the contract's own key; after that only the owner's", () => {
    CFG = new race.config(OWNER, true, 5);
    signedBy(OWNER);                         // the owner isn't set yet: the owner's key is not enough
    expect(() => { setConfig(); }).toThrow();
    errorIs("RACE: needs the owner's key");
    signedBy(SELF);
    setConfig();
    MockVM.commitTransaction();
    expect(Arrays.equal(new Race().get_config(new race.get_config_arguments()).owner, OWNER)).toBe(true);
    signedBy(SELF);                          // from now on the contract's key alone can't change anything
    CFG = new race.config(OWNER, false, 5);
    expect(() => { setConfig(); }).toThrow();
    errorIs("RACE: needs the owner's key");
    signedBy(P1);
    expect(() => { setConfig(); }).toThrow();
    errorIs("RACE: needs the owner's key");
    signedBy(OWNER);
    setConfig();
    MockVM.commitTransaction();
    expect(new Race().get_config(new race.get_config_arguments()).enabled).toBe(false);
  });

  it("refuses a bad owner or daily limit", () => {
    signedBy(SELF);
    CFG = new race.config(BAD, true, 5);
    expect(() => { setConfig(); }).toThrow(); errorIs("RACE: invalid owner");
    signedBy(SELF);
    CFG = new race.config(SELF, true, 5);
    expect(() => { setConfig(); }).toThrow(); errorIs("RACE: the owner must be a wallet, not this contract");
    signedBy(SELF);
    CFG = new race.config(OWNER, true, 0);
    expect(() => { setConfig(); }).toThrow(); errorIs("RACE: picks per day must be 1 to 20");
    signedBy(SELF);
    CFG = new race.config(OWNER, true, 21);
    expect(() => { setConfig(); }).toThrow(); errorIs("RACE: picks per day must be 1 to 20");
  });

  it("picks are closed before setup and when switched off", () => {
    refused(P1, R + 1, H1, CLOSED);
    signedBy(SELF); CFG = new race.config(OWNER, false, 5); setConfig(); MockVM.commitTransaction();
    refused(P1, R + 1, H1, CLOSED);
  });
});

describe("picking", () => {
  beforeEach(() => { start(); });

  it("a pick for the next race is kept, with the time, and announced", () => {
    pick(P1, R + 1, H1);
    const p = pickOf(P1, R + 1)!;
    expect(Arrays.equal(p.horse, H1)).toBe(true);
    expect(p.at).toBe(T + HOUR);
    expect(p.changes).toBe(0);
    const events = MockVM.getEvents();
    const last = events[events.length - 1];
    expect(last.name).toBe("race.pick_event");
    expect(Arrays.equal(last.impacted[0], P1)).toBe(true);
    const ev = Protobuf.decode<race.pick_event>(last.data!, race.pick_event.decode);
    expect(Arrays.equal(ev.player, P1)).toBe(true);
    expect(ev.race).toBe(R + 1);
    expect(ev.change).toBe(false);
    expect(pickOf(P2, R + 1)).toBeNull();
  });

  it("LOCK: no pick once the race has started, to the millisecond; the running race and past races are locked", () => {
    setTime((R + 1) * RACE_MS - 1);          // 1 ms before race R+1 starts: still open
    pick(P1, R + 1, H1);
    setTime((R + 1) * RACE_MS);              // the moment it starts: locked
    refused(P2, R + 1, H1, LOCKED);
    refused(P1, R + 1, H2, LOCKED);          // a change is locked too
    expect(Arrays.equal(pickOf(P1, R + 1)!.horse, H1)).toBe(true);
    refused(P1, R, H1, LOCKED);              // an earlier race
    refused(P1, 0, H1, LOCKED);
  });

  it("picks open for the next 4 races only (the coming 24 hours)", () => {
    pick(P1, R + 4, H1);
    refused(P1, R + 5, H1, TOO_EARLY);
    refused(P1, 0xffffffffffffffff, H1, TOO_EARLY);
  });

  it("one pick per wallet per race: a change replaces it and is counted; the same horse again is refused", () => {
    pick(P1, R + 1, H1);
    pick(P1, R + 1, H2);
    const p = pickOf(P1, R + 1)!;
    expect(Arrays.equal(p.horse, H2)).toBe(true);
    expect(p.changes).toBe(1);
    refused(P1, R + 1, H2, SAME);
    expect(new Race().get_usage(new race.get_usage_arguments(P1)).picks_today).toBe(2, "the refused repeat isn't counted");
    const rows = new Race().list_picks(new race.list_picks_arguments(R + 1, null, 0)).rows;
    expect(rows.length).toBe(1);
  });

  it("at most 5 picks (new and changes) per wallet per UTC day; the next UTC day starts again", () => {
    pick(P1, R + 1, H1); pick(P1, R + 1, H2); pick(P1, R + 2, H1); pick(P1, R + 3, H1); pick(P1, R + 4, H1);
    refused(P1, R + 4, H2, USED_UP);
    pick(P2, R + 1, H1);                     // other wallets are not affected
    const u = new Race().get_usage(new race.get_usage_arguments(P1));
    expect(u.picks_today).toBe(5); expect(u.max_picks_per_day).toBe(5);
    const nextDay = (T / DAY_MS + 1) * DAY_MS;
    setTime(nextDay);
    const r = nextDay / RACE_MS;             // 18 hours later: race R+3 is running, so R+4 is still open
    pick(P1, r + 1, H2);                     // a change of yesterday's pick for R+4, on the new day's count
    expect(new Race().get_usage(new race.get_usage_arguments(P1)).picks_today).toBe(1);
  });

  it("only the wallet itself can pick, for itself", () => {
    MockVM.setAuthorities([]);
    ARGS = new race.pick_arguments(P1, R + 1, H1);
    expect(() => { doPick(); }).toThrow(); errorIs(NOT_SIGNED);
    signedBy(P2);                            // P2 signs a pick for P1
    ARGS = new race.pick_arguments(P1, R + 1, H1);
    expect(() => { doPick(); }).toThrow(); errorIs(NOT_SIGNED);
    signedBy(OWNER);                         // not even the owner
    expect(() => { doPick(); }).toThrow(); errorIs(NOT_SIGNED);
    expect(pickOf(P1, R + 1)).toBeNull();
  });

  it("refuses an invalid player or horse address", () => {
    refused(P1, R + 1, BAD, "RACE: invalid horse");
    refused(P1, R + 1, new Uint8Array(0), "RACE: invalid horse");
    signedBy(BAD);
    ARGS = new race.pick_arguments(BAD, R + 1, H1);
    expect(() => { doPick(); }).toThrow(); errorIs("RACE: invalid player");
  });
});

describe("reading the picks", () => {
  beforeEach(() => { start(); });

  it("list_picks returns exactly one race's picks, in pages", () => {
    pick(P1, R + 1, H1); pick(P2, R + 1, H2); pick(P3, R + 1, H1);
    pick(P1, R + 2, H2);                     // another race: never mixed in
    let rows = new Race().list_picks(new race.list_picks_arguments(R + 1, null, 0)).rows;
    expect(rows.length).toBe(3);
    rows = new Race().list_picks(new race.list_picks_arguments(R + 1, null, 2)).rows;
    expect(rows.length).toBe(2);
    const more = new Race().list_picks(new race.list_picks_arguments(R + 1, rows[1].player, 2)).rows;
    expect(more.length).toBe(1);
    expect(Arrays.equal(more[0].player, rows[0].player) || Arrays.equal(more[0].player, rows[1].player)).toBe(false);
    expect(new Race().list_picks(new race.list_picks_arguments(R + 2, null, 0)).rows.length).toBe(1);
    expect(new Race().list_picks(new race.list_picks_arguments(R + 3, null, 0)).rows.length).toBe(0);
    expect(new Race().list_picks(new race.list_picks_arguments(R, null, 0)).rows.length).toBe(0);
  });
});
