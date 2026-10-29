# Independent review: Picks v2 CARD type (Combo Card), 2026-10-28

Reviewer: an independent agent that saw only the code and the intended rules (not the author's reasoning).
Scope: `picks/` diff of commit 455ff58 (CARD choice type, kind 4) and the card tests. Not uploaded; this is a
pre-audit review. The formal audit and the 48-hour upgrade come after Block X launches (owner, 2026-10-28).

**Verdict: no High or Medium findings.** No way found to store a card that breaks the rules, escape a leg lock on a
change, overflow or divide by zero in the lock math, or move tokens / pay Mana. Storage is backward compatible (new
fields only); kinds 1–3 behave exactly as before. 62/62 tests and `npm run check` passed at review time.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| CR-1 | Low | On a change, a stored leg that is "not open yet" (because `tighten_game` shortened its leg type's `ahead`) was refused as `LEG_LOCKED`, though it hadn't locked. Stricter, not looser; wrong message. | **Fixed**: a stored leg blocks a change only if it has locked (`legOpenAt != 1`). Test added. |
| CR-2 | Low | Tests didn't cover what some names/comments claimed: a card holding a switched-off leg type being changed; announce changing `code`/`lock_mode` or reordering leg types; a stored height (Block X) leg locking a change; `lead` raised by tighten; a non-card game tightened into carrying leg types. | **Fixed**: 5 tests added (67 contract tests). The misleading comment removed. |
| CR-3 | Info | The 48-hour announce may loosen an existing leg type (`lead` down, `ahead` up, re-enable) and may add a new code with the same clock as an existing one (an "alias", e.g. a second Win code), which would allow two legs of the same kind on one race. | **Accepted**: announce is the public 48-hour path (as for kinds 1–3). The page offers only the known codes, and the recorder leaves out any card with a code it doesn't know (and warns). The owner must not announce alias codes; noted for the formal audit. |
| CR-4 | Info | The same legs in a different order count as a change (spends a change and a daily pick). | **Accepted**: costs only the player; the page always sends legs in lock order. |

Confirmed correct by the reviewer: overflowing leg targets are locked, never wrapped; `target - lead` and
`target - pos` can't underflow; `round_size >= 1` everywhere (no division by zero); the card's own-day rule applies to
new cards and changes; tighten can't add leg types, re-enable one or raise `max_legs`; every loop is bounded (≤10 legs,
≤16 leg types).
