const test = require("node:test"), assert = require("node:assert");
const H = require("./harness.cjs");
async function trySend(t, before) {
  const { page } = t;
  await page.evaluate(() => { window.__sent = []; window.KWallet.send = async (label, ops) => { window.__sent.push({ label, args: ops[0].call_contract.args }); throw new Error("cancel"); }; });
  if (before) await before(page);
  await page.click("#send");
  await page.waitForTimeout(2500);
  return { sent: await page.evaluate(() => window.__sent[0] || null), toast: await page.textContent("#toast") };
}
for (const changes of [0, 2]) test(`editing card 1 (changes ${changes}) reaches the wallet`, { timeout: 60000 }, async () => {
  await H.awayFromMidnight();
  const now = Date.now(), day = Math.floor(now / H.DAY), r = Math.floor(now / 21600000) + 3;
  const card1 = { legs: [{ code: 1, round: String(r), producer: H.PRODS[2] }, { code: 2, round: String(r), producer: H.PRODS[3] }], changes };
  const t = await H.open({ vault: "staked", legs: H.openLegs(now), slots: (round) => (round === day * 3 ? card1 : null) });
  try {
    await t.page.waitForFunction(() => /Send card 2 of 3/.test(document.getElementById("send").textContent), null, { timeout: 20000 });
    await t.page.click('[data-k="slot:0"]');
    await t.page.waitForFunction(() => /Send changes to card 1/.test(document.getElementById("send").textContent) && !document.getElementById("send").disabled, null, { timeout: 20000 });
    const { sent, toast } = await trySend(t);
    assert.ok(sent, "blocked: " + toast);
    assert.strictEqual(Number((await H.ser.deserialize(sent.args, "picks.pick_arguments")).round), day * 3);
  } finally { await t.browser.close(); }
});
test("a new card after a card landed (page not refreshed yet) goes to a free slot or is refused, never over the new card", { timeout: 60000 }, async () => {
  await H.awayFromMidnight();
  const now = Date.now(), day = Math.floor(now / H.DAY), r = Math.floor(now / 21600000) + 3;
  const card1 = { legs: [{ code: 1, round: String(r), producer: H.PRODS[2] }, { code: 2, round: String(r), producer: H.PRODS[3] }], changes: 0 };
  let landed = false;
  const t = await H.open({ vault: "staked", legs: H.openLegs(now), slots: (round) => (round === day * 3 || (landed && round === day * 3 + 1) ? card1 : null) });
  try {
    await t.page.waitForFunction(() => /Send card 2 of 3/.test(document.getElementById("send").textContent) && !document.getElementById("send").disabled, null, { timeout: 20000 });
    landed = true;   // another tab sent card 2
    const a = await trySend(t);
    assert.strictEqual(a.sent, null, "first try must be refused");
    const b = await trySend(t);
    assert.ok(b.sent, "second try blocked: " + b.toast);
    assert.strictEqual(Number((await H.ser.deserialize(b.sent.args, "picks.pick_arguments")).round), day * 3 + 2);
  } finally { await t.browser.close(); }
});
