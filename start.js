/* start.html: the page script (moved out of the HTML so the Content-Security-Policy can refuse inline scripts). */
(function () {
  // the same Koinos project list as the game page (site/ads.json)
  fetch("ads.json", { cache: "no-cache" }).then(function (r) { return r.ok ? r.json() : {}; }).then(function (a) {
    var list = (a.ecosystem || []), grid = document.getElementById("eco-grid");
    list.forEach(function (h) {
      try { var u = new URL(h.link); if (u.protocol !== "https:") return; } catch (e) { return; }
      var x = document.createElement("a"); x.className = "eco-item"; x.href = h.link; x.target = "_blank"; x.rel = "noopener";
      var b = document.createElement("b"); b.textContent = h.name; var s = document.createElement("span"); s.textContent = h.tagline;
      x.appendChild(b); x.appendChild(s); grid.appendChild(x);
    });
  }).catch(function () {});
})();
