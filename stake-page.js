/* stake.html: the staking page. Your stake in every game, one game's full stake panel (stake-panel.js; #g<id> picks
   the game), and the "Where to stake" list. Daily Questions keeps its own buttons on its page; this page shows its
   standing and links there. Every transaction goes through the shared panel and the player's own wallet. */
(() => {
  "use strict";
  const K = window.KStake;
  const $ = (id) => document.getElementById(id);
  if (!K || !$("game-panel")) return;
  // The vault's game ids (claude/knodegames-plan.md, the game id registry) and each game's page.
  const GAMES = [
    [7, "Producer Race", "race.html"], [2, "Who Signs Block X", "blockx.html"], [3, "Survivor", "survivor.html"],
    [4, "Fantasy Producers", "fantasy.html"], [6, "Block Golf", "golf.html"], [8, "Combo Card", "combo.html"],
    [9, "Producer Bracket", "bracket.html"], [13, "Last Node Standing", "lastnode.html"],
  ];
  const chosen = () => { const m = /^#g(\d{1,3})$/.exec(location.hash); const id = m ? Number(m[1]) : 0; return GAMES.some(([g]) => g === id) ? id : 0; };

  K.badge($("q-badge"), { game: 1, href: "index.html#play" });

  let panel = null, live = false;
  function showGame() {
    if (!live) return;
    const id = chosen() || 7;
    if (chosen() === 0 && location.hash === "#g1") { location.href = "index.html#play"; return; }
    $("pick").replaceChildren(...GAMES.map(([g, name]) => {
      const a = document.createElement("a");
      a.href = `#g${g}`; a.textContent = name;
      if (g === id) a.setAttribute("aria-current", "page");
      return a;
    }));
    const box = $("game-panel");
    box.replaceChildren();
    panel = K.mount(box, { game: id });
    $("game-box").hidden = false;
  }
  window.addEventListener("hashchange", showGame);

  K.live().then((v) => {
    live = v;
    $("soon").hidden = v;
    if (!v) return;
    const links = { 1: "index.html#play" };
    for (const [g] of GAMES) links[g] = `#g${g}`;
    K.mountList($("list"), { links });
    showGame();
    if (chosen()) $("game-box").scrollIntoView({ block: "start" });
  }).catch(() => { $("soon").hidden = false; });
})();
