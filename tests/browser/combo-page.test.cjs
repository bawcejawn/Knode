// CC-C1: a send during the 60 s refresh (loadMine) goes to slot 0 and overwrites card 1.
const test = require("node:test"), assert = require("node:assert");
const H = require("./harness.cjs");

test("CC-C1: Send during a refresh must not overwrite card 1", { timeout: 60000 }, async () => {
  const now = Date.now(), day = Math.floor(now / H.DAY), r = Math.floor(now / 21600000) + 3;
  const card1 = { legs: [{ code: 1, round: String(r), producer: H.PRODS[2] }, { code: 2, round: String(r), producer: H.PRODS[3] }], changes: 0 };
  let slow = false;
  const t = await H.open({ legs: H.openLegs(now), slots: (round) => (round === day * 3 ? card1 : null), delay: () => (slow ? 3000 : 0) });
  try {
    const { page } = t;
    await page.waitForFunction(() => /Send card 2 of 3/.test(document.getElementById("send").textContent) && !document.getElementById("send").disabled, null, { timeout: 20000 });
    await page.evaluate(() => { window.__sent = []; window.KWallet.send = async (label, ops) => { window.__sent.push({ label, args: ops[0].call_contract.args }); throw new Error("cancel"); }; });
    slow = true;                                                                  // chain reads now take 3 s
    await page.evaluate(() => { const i = window.__intervals.find((x) => x.ms === 60000); i.f(); });   // the 60 s refresh starts
    assert.match(await page.textContent("#send"), /Send card 2 of 3/);            // what the player sees
    await page.click("#send");
    await page.waitForFunction(() => window.__sent.length > 0, null, { timeout: 20000 });
    const sent = await page.evaluate(() => window.__sent[0]);
    const args = await H.ser.deserialize(sent.args, "picks.pick_arguments");
    assert.strictEqual(Number(args.round), day * 3 + 1, `sent to round ${args.round} (slot ${Number(args.round) - day * 3}), label "${sent.label}": overwrites card 1`);
  } finally { await t.browser.close(); }
});

test("CC-C1 (b): a failed read of today's cards must not show card 1 as free and send over it", { timeout: 60000 }, async () => {
  const now = Date.now(), day = Math.floor(now / H.DAY), r = Math.floor(now / 21600000) + 3;
  const card1 = { legs: [{ code: 1, round: String(r), producer: H.PRODS[2] }, { code: 2, round: String(r), producer: H.PRODS[3] }], changes: 0 };
  let fail = false;
  const t = await H.open({ legs: H.openLegs(now), slots: (round) => (round === day * 3 ? card1 : null), failPick: () => fail });
  try {
    const { page } = t;
    await page.waitForFunction(() => /Send card 2 of 3/.test(document.getElementById("send").textContent) && !document.getElementById("send").disabled, null, { timeout: 20000 });
    await page.evaluate(() => { window.__sent = []; window.KWallet.send = async (label, ops) => { window.__sent.push({ label, args: ops[0].call_contract.args }); throw new Error("cancel"); }; });
    fail = true;                                                                  // one node hiccup on the 60 s refresh
    await page.evaluate(() => window.__intervals.find((x) => x.ms === 60000).f());
    await page.waitForTimeout(1500);
    const label = await page.textContent("#send"), disabled = await page.$eval("#send", (b) => b.disabled);
    if (!disabled) { await page.click("#send"); await page.waitForFunction(() => window.__sent.length > 0, null, { timeout: 20000 }); }
    const sent = await page.evaluate(() => window.__sent[0] || null);
    const round = sent ? Number((await H.ser.deserialize(sent.args, "picks.pick_arguments")).round) : null;
    assert.ok(disabled || round !== day * 3, `button "${label}" sent to slot 0 (round ${round}): card 1 overwritten`);
  } finally { await t.browser.close(); }
});
