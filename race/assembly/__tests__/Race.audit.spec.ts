// =====================================================================
// Independent audit 2026-10-27: attack tests for the Producer Race picks contract, kept as regression tests after the
// fixes (R-1: a bad list cursor is refused; R-3: a pick can't come from another contract). Report: docs/history/.
// =====================================================================

import { Arrays, Base58, MockVM, Protobuf, authority, chain } from "@koinos/sdk-as";
import { Race, RACE_MS, DAY_MS, LOCKED, TOO_EARLY, USED_UP, NOT_SIGNED, pickKey } from "../Race";
import { race } from "../proto/race";

const SELF = Base58.decode("1EDaCKVmBjUxLxgWCmDbRA8gWKkSQ6ByzY");
const OWNER = Base58.decode("1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717");
const P1 = Base58.decode("1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv");
const P2 = Base58.decode("16ixK5DgvcojcZLvxyYWhHFcRXfhfrHbpL");
const P3 = Base58.decode("1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8");
const H1 = Base58.decode("15NZhQoewzsbVUcSVsZ8BEBEKgaBNPLLgZ");
const H2 = Base58.decode("1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW");
const SPONSOR_LIKE = Base58.decode("15CM9Qr4GKREDgqnyXJ8tckPj2biERTM1T");   // any other contract

const R: u64 = 83013;
const T: u64 = R * RACE_MS;

function setTime(ms: u64): void { MockVM.setHeadInfo(new chain.head_info(null, ms, 0)); }
/** A call straight from a transaction: the chain reports an empty caller. */
function direct(): void { MockVM.setCaller(new chain.caller_data(new Uint8Array(0), chain.privilege.user_mode)); }
function signedBy(a: Uint8Array): void { MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, a, true)]); }
function errorIs(message: string): void { expect(MockVM.getErrorMessage()).toBe(message); MockVM.rollbackTransaction(); }

let ARGS: race.pick_arguments = new race.pick_arguments();
function doPick(): void { new Race().pick(ARGS); }
function pick(player: Uint8Array, r: u64, horse: Uint8Array): void {
  signedBy(player); ARGS = new race.pick_arguments(player, r, horse); doPick(); MockVM.commitTransaction();
}
function refused(player: Uint8Array, r: u64, horse: Uint8Array, message: string): void {
  signedBy(player); ARGS = new race.pick_arguments(player, r, horse);
  expect(() => { doPick(); }).toThrow(); errorIs(message);
}
let CFG: race.config = new race.config();
let CURSOR: Uint8Array = new Uint8Array(0);   // closures aren't supported: tests set this, then call
function setConfig(): void { new Race().set_config(new race.set_config_arguments(CFG)); }
function start(at: u64): void {
  MockVM.reset(); MockVM.setContractId(SELF); direct(); setTime(at); MockVM.commitTransaction();
  signedBy(SELF); CFG = new race.config(OWNER, true, 20); setConfig(); MockVM.commitTransaction();
}

/** The sponsor/race decoder-divergence payload (see REPORT S-1): race sees player = `raceSees`, the sponsor sees `sponsorSees`. */
export function smuggled(raceSees: Uint8Array, sponsorSees: Uint8Array, r: u64, horse: Uint8Array): Uint8Array {
  const out: u8[] = [];
  out.push(0x0a); out.push(25); for (let i = 0; i < 25; i++) out.push(raceSees[i]);
  out.push(0x18); out.push(27);                       // field 3 with WIRE TYPE 0 (varint 27)
  out.push(0x0a); out.push(25); for (let i = 0; i < 25; i++) out.push(sponsorSees[i]);
  out.push(0x10); let v = r; while (v >= 0x80) { out.push(<u8>((v & 0x7f) | 0x80)); v >>= 7; } out.push(<u8>v);
  out.push(0x1a); out.push(25); for (let i = 0; i < 25; i++) out.push(horse[i]);
  const b = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) b[i] = out[i];
  return b;
}

describe("AUDIT race: lock and window boundaries", () => {
  it("at the exact start of race c, race c+4 (starts in exactly 24 h) is open, c+5 is not", () => {
    start(T);
    pick(P1, R + 4, H1);
    refused(P1, R + 5, H1, TOO_EARLY);
    refused(P1, R, H1, LOCKED);
  });
  it("1 ms before the next race starts: c+1 open (starts in 1 ms), c+4 open (18 h + 1 ms), c+5 (24 h + 1 ms) refused", () => {
    start(T + RACE_MS - 1);
    pick(P1, R + 1, H1);
    pick(P1, R + 4, H1);
    refused(P1, R + 5, H1, TOO_EARLY);
  });
  it("u64 edges: race 2^64-1, 2^64-2, and the far past are refused without overflow", () => {
    start(T);
    refused(P1, 0xffffffffffffffff, H1, TOO_EARLY);
    refused(P1, 0xfffffffffffffffe, H1, TOO_EARLY);
    refused(P1, 0, H1, LOCKED);
  });
});

describe("AUDIT race: daily limit", () => {
  it("the limit is per UTC day, by head block time; the last ms of a day and the first of the next count separately", () => {
    const dayEnd = (T / DAY_MS + 1) * DAY_MS - 1;
    start(dayEnd);
    CFG = new race.config(OWNER, true, 1); signedBy(OWNER); setConfig(); MockVM.commitTransaction();
    const c = dayEnd / RACE_MS;
    pick(P1, c + 1, H1);
    refused(P1, c + 2, H1, USED_UP);
    setTime(dayEnd + 1);
    pick(P1, c + 2, H1);
    refused(P1, c + 3, H1, USED_UP);
  });
});

describe("AUDIT race: picking for someone else", () => {
  it("the crafted pick args that slip past the sponsor's decoder decode here as a pick for P2; without P2's authority it is refused", () => {
    start(T);
    const bytes = smuggled(P2, P1, R + 1, H1);
    const a = Protobuf.decode<race.pick_arguments>(bytes, race.pick_arguments.decode);
    expect(Arrays.equal(a.player, P2)).toBe(true, "the race contract decodes player = P2");
    expect(a.race).toBe(R + 1);
    expect(Arrays.equal(a.horse, H1)).toBe(true, "horse: last field 3 wins");
    signedBy(P1);                                    // only P1 (the sponsor's payee) signed
    ARGS = a;
    expect(() => { doPick(); }).toThrow(); errorIs(NOT_SIGNED);
    // ...but if P2's authority is granted by something other than a P2 signature (a smart wallet whose authorize
    // accepts P1, or any account whose contract_call override says yes), the pick for P2 goes through:
    signedBy(P2);
    ARGS = a; doPick(); MockVM.commitTransaction();
    expect(new Race().get_pick(new race.get_pick_arguments(P2, R + 1)).pick).not.toBeNull();
  });
});

describe("AUDIT race: list_picks", () => {
  it("R-1 (fixed): start_after of the wrong length is refused, never a silent restart", () => {
    start(T);
    pick(P1, R + 1, H1); pick(P2, R + 1, H1); pick(P3, R + 1, H2);
    const all = new Race().list_picks(new race.list_picks_arguments(R + 1, null, 0)).rows;
    expect(all.length).toBe(3);
    CURSOR = new Uint8Array(24); CURSOR.set(all[2].player!.subarray(0, 24));
    expect(() => { new Race().list_picks(new race.list_picks_arguments(R + 1, CURSOR, 0)); }).toThrow();
    errorIs("RACE: bad start_after");
    expect(new Race().list_picks(new race.list_picks_arguments(R + 1, new Uint8Array(0), 0)).rows.length).toBe(3, "empty = from the start");
  });
  it("start_after = 25 x 0xff ends the listing; a cursor from another race never leaks that race's rows", () => {
    start(T);
    pick(P1, R + 1, H1); pick(P2, R + 2, H1);
    const ff = new Uint8Array(25); ff.fill(0xff);
    expect(new Race().list_picks(new race.list_picks_arguments(R + 1, ff, 0)).rows.length).toBe(0);
    const rows = new Race().list_picks(new race.list_picks_arguments(R + 1, P2, 0)).rows;
    for (let i = 0; i < rows.length; i++) expect(Arrays.equal(rows[i].player, P2)).toBe(false);
  });
  it("keys are fixed-length 33 bytes: race (8 BE) || player", () => {
    const k = pickKey(0x0102030405060708, P1);
    expect(k.length).toBe(33);
    expect(k[0]).toBe(1); expect(k[7]).toBe(8);
    expect(Arrays.equal(k.subarray(8), P1)).toBe(true);
  });
});

describe("AUDIT race: settings", () => {
  it("before setup nobody but the contract key can set the owner (no front-running)", () => {
    MockVM.reset(); MockVM.setContractId(SELF); direct(); setTime(T); MockVM.commitTransaction();
    CFG = new race.config(P1, true, 5);
    signedBy(P1);
    expect(() => { setConfig(); }).toThrow(); errorIs("RACE: needs the owner's key");
    MockVM.setAuthorities([]);
    expect(() => { setConfig(); }).toThrow(); errorIs("RACE: needs the owner's key");
  });
  it("the owner may be set to another CONTRACT's address (e.g. the sponsor), which can never authorize: settings bricked", () => {
    start(T);
    CFG = new race.config(SPONSOR_LIKE, true, 5);
    signedBy(OWNER); setConfig(); MockVM.commitTransaction();
    expect(Arrays.equal(new Race().get_config(new race.get_config_arguments()).owner, SPONSOR_LIKE)).toBe(true);
    // From here only SPONSOR_LIKE's contract_call authority can change settings; the sponsor's authorize returns false
    // for contract_call, so on chain nobody can (recovery: upload new code with the race contract's own key).
    CFG = new race.config(OWNER, true, 5);
    signedBy(OWNER);
    expect(() => { setConfig(); }).toThrow(); errorIs("RACE: needs the owner's key");
  });
});

describe("AUDIT race R-3 (fixed): picks only from the player's own transaction", () => {
  it("a pick passed through another contract is refused, even with the player's signature", () => {
    start(T);
    MockVM.setCaller(new chain.caller_data(SPONSOR_LIKE, chain.privilege.user_mode));
    refused(P1, R + 1, H1, NOT_SIGNED);
    MockVM.setCaller(new chain.caller_data(P1, chain.privilege.user_mode));   // the player's own contract account
    pick(P1, R + 1, H1);
    MockVM.setCaller(new chain.caller_data(new Uint8Array(0), chain.privilege.user_mode));   // straight from the transaction
    pick(P2, R + 1, H1);
    expect(new Race().list_picks(new race.list_picks_arguments(R + 1, null, 0)).rows.length).toBe(2);
  });
});
