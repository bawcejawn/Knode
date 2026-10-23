/* burn.html: the page script (moved out of the HTML so the Content-Security-Policy can refuse inline scripts). */
(() => {
  "use strict";
  const lib = window.koilib || window.koinos || window;
  const RPC = "https://api.koinos.io";
  const KOIN = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK", VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq", POB = "159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv";
  const UNIT = 100000000n;
  const ADDR = { type: "bytes", options: { "(koinos.btype)": "ADDRESS" } };
  const U64 = { type: "uint64", options: { jstype: "JS_STRING" } };
  const types = { nested: { t: { nested: {
    balance_of_arguments: { fields: { owner: { ...ADDR, id: 1 } } },
    balance_of_result: { fields: { value: { ...U64, id: 1 } } },
    approve_arguments: { fields: { owner: { ...ADDR, id: 1 }, spender: { ...ADDR, id: 2 }, value: { ...U64, id: 3 } } },
    approve_result: { fields: {} },
    burn_arguments: { fields: { token_amount: { ...U64, id: 1 }, burn_address: { ...ADDR, id: 2 }, vhp_address: { ...ADDR, id: 3 } } },
    burn_result: { fields: {} },
  } } } };
  const tokenAbi = { methods: {
    balance_of: { entry_point: 0x5c721497, argument: "t.balance_of_arguments", return: "t.balance_of_result", read_only: true },
    approve: { entry_point: 0x74e21680, argument: "t.approve_arguments", return: "t.approve_result", read_only: false },
  }, koilib_types: types };
  const pobAbi = { methods: { burn: { entry_point: 0x859facc5, argument: "t.burn_arguments", return: "t.burn_result", read_only: false } }, koilib_types: types };

  const provider = new lib.Provider([RPC]);
  const $ = (id) => document.getElementById(id);
  const say = (t) => { $("msg").textContent = t; };
  let account = null, bal = { koin: 0n, vhp: 0n, mana: 0n };

  const show = (u) => { const s = (u < 0n ? 0n : u).toString().padStart(9, "0"); const i = s.slice(0, -8), f = s.slice(-8).replace(/0+$/, ""); return Number(i).toLocaleString() + (f ? "." + f : ""); };
  function toUnits(text) {
    const m = String(text).trim().match(/^(\d*)(?:\.(\d{0,8})\d*)?$/);
    if (!m || (m[1] === "" && !m[2])) return null;
    return BigInt(m[1] || "0") * UNIT + BigInt((m[2] || "").padEnd(8, "0"));
  }

  async function refresh() {
    const tk = (id) => new lib.Contract({ id, abi: tokenAbi, provider });
    const get = async (id) => BigInt(((await tk(id).functions.balance_of({ owner: account })).result || {}).value || "0");
    const [koin, vhp, rc] = await Promise.all([get(KOIN), get(VHP), provider.getAccountRc(account)]);
    bal = { koin, vhp, mana: BigInt(rc || "0") };
    $("b-koin").textContent = show(koin); $("b-vhp").textContent = show(vhp); $("b-mana").textContent = show(bal.mana);
  }
  function maxBurn() {
    const keep = toUnits($("keep").value || "0") ?? 0n;
    let m = bal.koin - keep;
    const manaCap = bal.mana - UNIT / 2n; // leave ~0.5 Mana for this transaction itself
    if (m > manaCap) m = manaCap;
    return m > 0n ? m : 0n;
  }

  const W = window.KWallet;
  W.init({ provider, toast: (t) => say(t), onChange: async (addr) => {
    account = addr;
    $("who").textContent = addr ? `${addr} (${W.label()})` : "Not connected";
    $("connect").textContent = addr ? "Disconnect" : "Connect wallet";
    $("burn").disabled = !addr;
    if (!addr) { ["b-koin", "b-vhp", "b-mana"].forEach((id) => { $(id).textContent = "–"; }); return; }
    try { await refresh(); say("Connected. Check this is the right wallet, enter an amount (or Max), then Burn."); } catch (e) { say(String(e.message || e)); }
  } });
  $("connect").onclick = async () => {
    if (account) return W.disconnect();
    try { await W.connect(); } catch (e) { say(String(e.message || e)); }
  };
  $("max").onclick = () => {
    if (!account) return say("Connect a wallet first.");
    const m = maxBurn();
    $("amt").value = m > 0n ? `${m / 100000000n}.${(m % 100000000n).toString().padStart(8, "0")}`.replace(/\.?0+$/, "") : "0";
    if (m === 0n) say("Nothing to burn: your KOIN is at or below what you keep, or your Mana is low (it refills over about 5 days).");
  };

  $("burn").onclick = async () => {
    if (!account) return say("Connect a wallet first.");
    const amt = toUnits($("amt").value);
    if (!amt || amt <= 0n) return say("Enter how much KOIN to burn.");
    if (amt > bal.koin) return say("That is more KOIN than this wallet has.");
    if (amt > bal.mana - UNIT / 2n) return say(`That's more than your Mana allows right now (${show(bal.mana)}). Use Max, or wait for Mana to refill.`);
    try {
      const koin = new lib.Contract({ id: KOIN, abi: tokenAbi, provider });
      const pob = new lib.Contract({ id: POB, abi: pobAbi, provider });
      const value = amt.toString();
      const op1 = (await koin.functions.approve({ owner: account, spender: POB, value }, { onlyOperation: true })).operation;
      const op2 = (await pob.functions.burn({ token_amount: value, burn_address: account, vhp_address: account }, { onlyOperation: true })).operation;
      say(`Confirm burning ${show(amt)} KOIN in ${W.label()}…`);
      const id = await W.send(`burn ${show(amt)} KOIN into VHP`, [op1, op2]);
      say(id ? `Done: ${show(amt)} KOIN burned into VHP.\nTransaction: ${id}` : `Sent, not yet seen in a block. Check your wallet's history in a minute.`);
      $("amt").value = "";
      await refresh().catch(() => {});
    } catch (e) {
      const m = String(e.message || e);
      say(/reject|denied|cancel/i.test(m) ? `Cancelled in ${W.label()}.` : /mana|rc/i.test(m) ? "Not enough Mana. Burn a bit less, or wait for Mana to refill." : "Not sent: " + m.slice(0, 300));
    }
  };
})();
