/* install.html: show the steps for this device first, and offer the browser's own install prompt where it has one. */
(function () {
  var ua = navigator.userAgent || "";
  var os = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "ios" : /Android/.test(ua) ? "android" : "desktop";
  var cards = document.querySelectorAll(".inst[data-os]"), main = document.getElementById("main");
  cards.forEach(function (c) {
    if (c.dataset.os === os) { c.classList.add("inst-mine"); main.insertBefore(c, document.getElementById("inst-auto").nextSibling); }
  });
  var standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  var done = document.getElementById("inst-done"), auto = document.getElementById("inst-auto"), btn = document.getElementById("inst-btn");
  if (standalone) { auto.hidden = false; btn.hidden = true; done.hidden = false; done.textContent = "You're already using the Knode app."; }
  var deferred = null;
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; auto.hidden = false; });
  btn.addEventListener("click", function () {
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.then(function (r) { if (r && r.outcome === "accepted") { btn.hidden = true; done.hidden = false; } deferred = null; });
  });
  window.addEventListener("appinstalled", function () { btn.hidden = true; done.hidden = false; auto.hidden = false; });
  // The install prompt needs the app's service worker (the same one the game registers).
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(function () {});
  // Share
  var url = document.getElementById("share-url").textContent.trim(), sb = document.getElementById("share-btn");
  sb.addEventListener("click", function () {
    if (navigator.share) navigator.share({ title: "Knode", text: "Play Knode, the daily Koinos prediction game", url: url }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { sb.textContent = "Link copied"; setTimeout(function () { sb.textContent = "Share"; }, 1500); }, function () {});
  });
})();
