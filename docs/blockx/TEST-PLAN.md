# Who Signs Block X: testnet test plan

Tick each line, and note anything odd with the time, the target block and what you saw. Game 92 (a target every 300
blocks, ~15 min) is the fast way to test; game 2 runs the real mainnet settings.

## A. Setup (runbook steps 0–5)

- [ ] `picks` tests: 46 / 46 pass
- [ ] `build-testnet` says the untouched copy rebuilds to `700c296a…`
- [ ] `status --testnet`: expected build ✔, all three overrides ON ✔, owner ✔
- [ ] Games 2 and 92 announced, applied after 10 minutes, shown ON in `status`
- [ ] Applying before the 10 minutes are up is refused ("the 48-hour notice has not passed": the message keeps the
      mainnet wording)

## B. The contract's rules (on the page, game 92)

- [ ] 12 targets shown, the next one within ~15 min
- [ ] A pick is confirmed ("Pick confirmed") and shows "Your pick" after a reload
- [ ] Changing a pick works; after 5 changes the button switches off
- [ ] Picking the same producer again: "That is already your pick"
- [ ] "x of 50 picks left today" counts down, changes included
- [ ] A target within 20 blocks of its lock disappears from the list
- [ ] `lock-test 92`: ✔ height as designed, ✔ nothing applied at or after the lock
- [ ] `pause 92`: picks are refused ("This game is switched off right now"); results of earlier picks still appear

## C. Wallets

- [ ] Test wallet: made, address copied, faucet claim arrives, picks work
- [ ] Reload: the same Test wallet comes back
- [ ] Kondor on the testnet: connect and pick (or note "Refresh check" loop)
- [ ] With no test KOIN: a clear "no test Mana yet" message, nothing sent
- [ ] The mainnet site (`site/blockx.html`, the guest wallet) is unchanged after using the testnet page: guest wallet
      address the same, nothing new connected

## D. Results and leaderboards (recorder running)

- [ ] Within ~20 min of a target, Results shows its signer and your pick right or wrong
- [ ] A right pick scores the multiplier shown when you picked (×1 while the testnet has one producer)
- [ ] Today / This week / All time update; the Staked and Free play tabs split correctly (the test wallet is Free play)
- [ ] Two wallets with the same points: the one with the earlier last right pick ranks first
- [ ] After a week ends + 12 h: Last week is final and lists the test prizes (top 2 of Free play with picks on 3+
      days)

## E. Mana

- [ ] `mana-test 92`: Mana per pick for 1, 3 and 7 picks, sent to Claude
- [ ] 30+ picks in a day from one wallet all go through (Mana held ~5 min after each is fine)

## F. Afterwards

- [ ] Everything above passes, or each failure has a note
- [ ] Run the audit bot with `claude/audit-blockx-prompt.md`
- [ ] Claude fixes the findings; the audit bot fix-checks them
- [ ] Only then: the mainnet plan (sponsor v3 limits, upload with `--mainnet`, announce game 2, 48-hour wait)
