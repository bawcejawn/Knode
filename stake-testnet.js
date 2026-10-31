/* stake-testnet.html: the shared stake panel and status bar (stake-panel.js) against the vault v6 TEST copy on the
   Koinos testnet, signed by the testnet-only wallet (stake-testnet-wallet.js). Test KOIN only. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const K = window.KStake, TW = window.KTestStakeWallet, lib = window.koilib || window.koinos || window;
  const say = (t) => { $("tn-err").textContent = t; $("tn-err").hidden = !t; };
  if (!K || !TW || !lib.Provider) { say("The page's scripts didn't load. Reload the page."); return; }
  const chosen = () => { const m = /^#g(\d{1,3})$/.exec(location.hash); return m ? Number(m[1]) : 7; };

  function showWallet() {
    const a = TW.address;
    $("tn-addr").textContent = a || "not connected";
    $("tn-connect").textContent = a ? "Switch wallet" : "Connect a testnet wallet";
    $("tn-copy").hidden = !a;
    $("tn-faucet-cmd").textContent = a ? `/faucet ${a}` : "/faucet <your address>";
  }
  $("tn-connect").addEventListener("click", () => TW.connect());
  $("tn-copy").addEventListener("click", () => { try { navigator.clipboard.writeText(`/faucet ${TW.address}`); $("tn-copy").textContent = "Copied"; setTimeout(() => ($("tn-copy").textContent = "Copy faucet command"), 1500); } catch { /* copy by hand */ } });
  TW.subscribe(showWallet);

  let panel = null;
  function showGame() {
    const id = chosen();
    if (id < 2) return;
    $("tn-badge").replaceChildren();
    K.badge($("tn-badge"), { game: id, href: `#g${id}` });
    $("tn-game").replaceChildren();
    panel = K.mount($("tn-game"), { game: id });
    $("tn-gid").textContent = String(id);
  }
  window.addEventListener("hashchange", showGame);

  fetch("testnet/vault.json", { cache: "no-cache" }).then((r) => r.json()).then(async (cfg) => {
    const provider = new lib.Provider([cfg.rpc]);
    TW.init({ provider, chainId: cfg.chainId, contract: cfg.contract, vhp: cfg.vhp, koin: cfg.koin });
    $("tn-vault").textContent = cfg.contract;
    showWallet();
    const live = await K.live();
    $("tn-soon").hidden = live;
    if (!live) return;
    const links = {};
    for (let g = 2; g < 100; g++) links[g] = `#g${g}`;
    K.mountList($("tn-list"), { links });
    showGame();
  }).catch((e) => say(`Couldn't reach the testnet: ${String((e && e.message) || e)}`));
})();
