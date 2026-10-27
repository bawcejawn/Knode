# Fix-check: KnodeGames Picks, commit b149d7c

**Verdict: ready for testnet.** P-1 and P-2 are fixed, and so are P-4, P-7 and the workflow part of P-10. The fixes
introduce nothing above Low. One new Low (PF-1, a `list_pending` page can come back empty with no way to continue) is
worth fixing before mainnet but does not block testnet.

- Picks `npm test`: **42 / 42 pass** (30 original + 12 in `Picks.audit.spec.ts`). `npm run check` passes and now
  checks the compiled code too (16 entry points).
- Release sha256: **`6a508621028304cd91e1c5581c97ec9a95e3190707e73cf54ffc3421a3c4f936`**, as expected.
- My fix-check tests (`FC.spec.ts`, 3 tests) plus the 42: **45 / 45 pass**. They are in
  `/tmp/claude-0/-home-claude/01aac551-8987-5a2a-8c8f-73ac9893e8c4/scratchpad/audit/picks-fc/assembly/__tests__/FC.spec.ts`.
- The repo was not modified.

## Status of findings

| ID | Was | Status | How verified |
|---|---|---|---|
| P-1 | High | **Fixed** | `config.generation` (field 6) and `pending_game.generation` (field 3) are new. `announce_game` stamps the current generation. `accept_owner` writes `generation + 1`, with no loop. `apply_game` refuses an older generation (`Picks.ts` apply_game). The regression test plants 35 announcements, does the handover, then: apply is refused, `get_game` and `list_pending` show none, and the new owner can announce again with a fresh 48 hours. |
| P-2 | Medium | **Fixed** | `tighten_game` removes that game's pending entry and emits `cancelled`. Regression test: a stranger's `apply_game` after the tightening fails with "nothing announced". |
| P-3 | Low | Moved to the sponsor | Sponsor v3 uses an allowlist row with the exact Picks shape and a wire scanner. Audited in AUDIT-SPONSOR-V3-REPORT.md. |
| P-4 | Low | **Fixed** | `check.cjs` requires the only import to be `env.invoke_system_call` and no `i32.const 601` in the release `.wat`. I confirmed there are 0 occurrences. Note: the check would also catch an unrelated constant 601; that would be a false alarm, never a miss. |
| P-5, P-6 | Info | Open (testnet and deploy) | Unchanged. Still: confirm stored height = height of the including block, and that the on-chain flags are all three on. |
| P-7 | Info | **Fixed** | `list_pending`: at most 50 per page, at most 200 entries scanned, read-only, current generation only. See PF-1. |
| P-8, P-9 | Info | Accepted | Unchanged. |
| P-10 | Info | Partly fixed | The workflow now also triggers on `tools/pbjs-helpers/**`. The upgrade notice still stays set after an upload; that is accepted as harmless. |

## New findings

### PF-1: `list_pending` can return an empty page with no way to continue (Low)

- **Where:** `Picks.ts` `list_pending`, the loop `i < 200` and `start_after` being a game id.
- **Scenario:** Stale entries (from earlier generations) are never deleted unless cancelled or overwritten. If 200 or
  more stale entries come before a live one in id order, one call scans 200, returns nothing, and does not tell the
  caller where it stopped. A monitor reads "nothing pending". A previous owner can set this up on purpose: announce
  200+ low ids before the handover, so the new owner's later announcements on higher ids are hidden from
  `list_pending`.
- **Impact:** A monitoring blind spot only. An announcement still needs the current owner, the 48 hours, and is
  visible through `game_event` and `get_game`. The new owner can clear stale entries with `cancel_game_change`, which
  has no generation check (tested).
- **Fix:** Return `next` (the last key scanned) in `list_pending_result`, and tell clients to page until `next` is 0.
  Alternatively, let `apply_game` or `announce_game` delete stale entries as they meet them.
- **Proof:** I reasoned this from the code. In the mock VM, ids at or above 128 sort unreliably, so I could place only
  100 stale entries before a live one. With 100 the live one is still found (`FC.spec.ts`, PF-1 test passes); the 200
  limit is a plain loop bound.

## Checked and sound (what the fixes could have broken)

- **Generation can't be reset or rolled back:** only `accept_owner` builds a new config. `propose_owner` (set or
  cancel) and `schedule_upgrade` (set or cancel) modify the existing config, so they keep `generation`. The test shows
  it is still 1 after all four, and 2 after a second handover, which kills the first generation's leftovers too.
- **Overflow:** u64, +1 per handover, at least 48 hours apart. It cannot overflow.
- **A stale entry doesn't block anything:** a new `announce_game` for the same id overwrites it (tested). `cancel` and
  `tighten` remove it. `gameCount` counts registered games only, so stale entries don't use up the 32 slots.
- **`get_game`** hides stale entries. Events are unchanged.
- **Cost:** `list_pending` makes at most 200 `get_next` reads plus 1 config read and writes nothing. `accept_owner` is
  now O(1).
- **Old state:** a config or pending entry written before this change decodes with generation 0, which matches a
  generation-0 contract. This is a fresh deploy, so nothing to migrate.
- **ABI:** `list_pending` was added and the 15 earlier entry points are unchanged (`check.cjs` compares them). The
  `pick` entry point is still `0x8ce33c6c`.
- **The rest of the audit still holds:** my P-3 decoder attack, the upgrade attacks and the edge tests all still pass.

## Not checked

- On-chain ordering of more than 200 stale entries (mock VM key-order limitation; reasoned instead).
- P-5 head-info semantics (testnet).

## Re-check: d2a8f2e (/home/claude/knode, branch `picks`)

**Verdict: ready for testnet.** Tests pass **46 / 46** (30 original + 16 audit and fix-check). `npm run check` passes.
Release sha256 **`700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594`**, as expected.

- **PF-1: fixed.** `list_pending` now sets `next` whenever it stopped early, either because the page is full or
  because it scanned 200 entries. That includes the case where it stopped early with nothing found, which is the
  blind spot. Game ids start at 1, so `next = 0` can only mean "done". The cursor is the last key scanned, so the next
  call continues after it with nothing skipped and nothing repeated. A full page that ends exactly on the last entry
  returns a non-zero `next`, and the next call then returns an empty page with `next = 0`. That is harmless. The kept
  regression test covers a full page, continuing from `next`, and the end.
- No other Picks code changed. The proto adds `list_pending_result.next = 2`, which is backward-compatible.
- No new findings.
