// C-W-2 failing test - NOT RUN HERE (static review). Uses the owner's own browser harness (tests/browser/harness.cjs)
// and the real site/combo.html + combo.js in Chromium:  cp to tests/browser/ ; node --test tests/browser/cw2-stake-check.test.cjs
// A wallet with no stake in the Combo Card this week must be refused before anything is signed. At 32fae49 the page
// reads game/abi/kpred.koilib.json, which has no get_game_player (and on refs/x/picks the v6 ABI is kpred-v6.koilib.json),
// so readStake() returns null and Send is enabled for an unstaked wallet.
const test = require("node:test"), assert = require("node:assert");
const H = require("./harness.cjs");
test("C-W-2: an unstaked wallet cannot send a Combo card", { timeout: 60000 }, async () => {
  const now = Date.now();
  // (Fix-check FC-25: with the Vault v6 live and no stake, so the page's stake read itself is what refuses.)
  const t = await H.open({ vault: "unstaked", legs: H.openLegs(now),
    files: { "picks-data/deployment.json": JSON.stringify({ contract: H.PICKS, cards: true }) } });  // the live switch
  try {
    const { page } = t;
    // the Vault (whatever contract game-data/deployment.json names) answers week_stake 0 for every get_game_player:
    // the harness returns an empty result ({}) for contracts other than PICKS, which decodes to week_stake 0.
    await page.waitForFunction(() => /Send card/.test(document.getElementById("send").textContent), null, { timeout: 20000 });
    await page.waitForTimeout(3000);
    const disabled = await page.$eval("#send", (b) => b.disabled), why = await page.$eval("#send", (b) => b.title);
    assert.ok(disabled && /Stake at least 1 VHP/.test(why), `Send is ${disabled ? "disabled" : "ENABLED"} for an unstaked wallet (title: "${why}")`);
  } finally { await t.browser.close(); }
});
