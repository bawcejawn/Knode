/* Phone navigation: the bottom tab bar (Play · Race · Swap · Leaders · More) and the "More" sheet with every other page.
   Marks the tab for the page you're on, and opens/closes the sheet. No data, no storage, no network. */
(function () {
  "use strict";
  const bar = document.querySelector(".tabbar");
  const sheet = document.getElementById("more-sheet");
  if (!bar) return;
  const btn = bar.querySelector(".tb-more");

  // A link's "place": its file, plus the view for index.html (#play, #leaderboard, ...; no hash = the welcome page).
  const place = (u) => {
    const file = u.pathname.split("/").pop() || "index.html";
    if (file !== "index.html") return file;
    const view = (u.hash || "").slice(1).split("/")[0];
    return "index.html#" + (["play", "leaderboard", "results", "how", "welcome"].includes(view) ? view : "welcome");
  };

  function mark() {
    const here = place(location);
    let inSheet = false;
    document.querySelectorAll(".tabbar a, .more-panel a").forEach((a) => {
      const on = place(new URL(a.getAttribute("href"), location.href)) === here;
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
      if (on && a.closest(".more-panel")) inSheet = true;
    });
    if (btn) btn.classList.toggle("on", inSheet);
  }

  function open(yes) {
    if (!sheet || !btn) return;
    sheet.hidden = !yes;
    btn.setAttribute("aria-expanded", String(yes));
    document.documentElement.classList.toggle("sheet-open", yes);
  }

  if (btn && sheet) {
    btn.addEventListener("click", () => open(sheet.hidden));
    // Tapping outside the panel, or any link in it, closes the sheet.
    sheet.addEventListener("click", (e) => { if (e.target === sheet || e.target.closest("a")) open(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) { open(false); btn.focus(); } });
    // Turning the phone or widening the window past the phone layout closes it too.
    window.addEventListener("resize", () => { if (!sheet.hidden && window.innerWidth > 760) open(false); });
  }

  // Index switches views by hash; app.js also marks its own tabs, this runs after it so both agree.
  window.addEventListener("hashchange", () => setTimeout(mark, 0));
  window.addEventListener("pageshow", () => { open(false); mark(); });
  mark();
})();
