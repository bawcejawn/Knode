/* Knode Games extras: things that run only in the visitor's browser and send nothing anywhere.
   - buildIcs(): a calendar file with a reminder Monday to Saturday at 12:00 UTC, when the day's questions come out.
   - shareLines() / drawShare(): the "share my week" picture, drawn on a canvas on this device. The wallet address is
     left out unless the player ticks "show my address".
   Plain functions on window.KnodeExtras (no modules, so it works with the site's script tags and its CSP). */
(function () {
  "use strict";

  const pad = (n) => String(n).padStart(2, "0");
  const icsDate = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  /** RFC 5545 text: backslash, semicolon, comma and newlines escaped. */
  const icsText = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  /** RFC 5545 lines are at most 75 octets: longer ones continue on the next line after a space. */
  function fold(line) {
    const out = [];
    let rest = line;
    while (rest.length > 74) { out.push(rest.slice(0, 74)); rest = " " + rest.slice(74); }
    out.push(rest);
    return out.join("\r\n");
  }
  /** The next question release at or after `now`: Monday to Saturday, 12:00 UTC. */
  function nextRelease(now) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0));
    if (d.getTime() < now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
    while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);   // no questions on Sunday
    return d;
  }
  /** A calendar file (.ics) with one repeating reminder: Monday to Saturday at 12:00 UTC. */
  function buildIcs(siteUrl, now = new Date()) {
    const start = nextRelease(now);
    const closeLocal = (() => { try { const c = new Date(start); c.setUTCHours(24, 0, 0, 0); return c.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch { return ""; } })();
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Knode//Daily questions//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      "UID:knode-daily-questions@knode",
      `DTSTAMP:${icsDate(now)}`,
      `DTSTART:${icsDate(start)}`,
      "DURATION:PT15M",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA",
      `SUMMARY:${icsText("Knode Games: today's questions are out")}`,
      `DESCRIPTION:${icsText(`Today's Knode Games questions are out. Answers close at 00:00 UTC${closeLocal ? ` (${closeLocal} your time)` : ""}. ${siteUrl}`)}`,
      `URL:${siteUrl}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:PT0M",
      `DESCRIPTION:${icsText("Knode Games questions are out")}`,
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    return lines.map(fold).join("\r\n") + "\r\n";
  }

  /** What the share picture says. stats: { week, pts, place, of, right, decided, free, address }. */
  function shareLines(stats, opts = {}) {
    const s = stats || {};
    const lines = [
      { role: "kicker", text: `KNODE · WEEK ${s.week}` },
      { role: "big", text: `${s.pts} ${s.pts === 1 ? "point" : "points"}` },
      { role: "place", text: s.free ? "Free play" : s.place ? `#${s.place} of ${s.of}` : "Climbing the board" },
    ];
    if (s.decided > 0) lines.push({ role: "right", text: `${s.right} of ${s.decided} right` });
    if (opts.showAddress && s.address) lines.push({ role: "address", text: s.address });
    lines.push({ role: "foot", text: "Call the next blocks on Koinos" });
    return lines;
  }

  /** Draws the share picture (1200 × 630, the size link previews use) on `canvas`. */
  async function drawShare(canvas, stats, opts = {}) {
    try { if (document.fonts) { await Promise.all(["800 120px Archivo", "700 40px Archivo", "800 40px 'Bricolage Grotesque'", "400 30px 'Atkinson Hyperlegible'"].map((f) => document.fonts.load(f).catch(() => {}))); await document.fonts.ready; } } catch { /* fonts are optional */ }
    const W = 1200, H = 630;
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext("2d");
    if (!g) return;
    const L = shareLines(stats, opts), by = (r) => L.find((x) => x.role === r);
    // background: stone, with a navy card
    g.fillStyle = "#F3F1EA"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "#D9D3C2"; g.lineWidth = 2;
    for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(-20, 470 + i * 34); g.bezierCurveTo(300, 420 + i * 34, 700, 540 + i * 34, 1220, 470 + i * 34); g.stroke(); }
    const r = 40, x0 = 60, y0 = 60, w = W - 120, h = 400;
    g.fillStyle = "#14213D";
    g.beginPath(); g.moveTo(x0 + r, y0); g.arcTo(x0 + w, y0, x0 + w, y0 + h, r); g.arcTo(x0 + w, y0 + h, x0, y0 + h, r); g.arcTo(x0, y0 + h, x0, y0, r); g.arcTo(x0, y0, x0 + w, y0, r); g.closePath(); g.fill();
    // logo ring
    g.strokeStyle = "#FF8A4C"; g.lineWidth = 8; g.beginPath(); g.arc(W - 160, 160, 46, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#F2B33D"; g.beginPath(); g.arc(W - 160, 160, 17, 0, Math.PI * 2); g.fill();
    g.textBaseline = "alphabetic";
    g.fillStyle = "#FFB38A"; g.font = "800 30px Archivo, sans-serif"; g.fillText(by("kicker").text, 110, 140);
    g.fillStyle = "#FFF8F1"; g.font = "800 128px Archivo, sans-serif"; g.fillText(by("big").text, 104, 270);
    g.fillStyle = "#C9D2E3"; g.font = "700 46px Archivo, sans-serif";
    const parts = [by("place").text, by("right")?.text].filter(Boolean).join("   ·   ");
    g.fillText(parts, 110, 350);
    if (by("address")) { g.fillStyle = "#C9D2E3"; g.font = "400 24px 'Atkinson Hyperlegible', sans-serif"; g.fillText(by("address").text, 110, 410); }
    g.fillStyle = "#22302B"; g.font = "800 44px 'Bricolage Grotesque', sans-serif"; g.fillText("knode", 60, 560);
    g.fillStyle = "#4A564F"; g.font = "400 30px 'Atkinson Hyperlegible', sans-serif"; g.fillText(by("foot").text, 210, 558);
  }

  const api = { buildIcs, nextRelease, shareLines, drawShare };
  if (typeof window !== "undefined") window.KnodeExtras = api;
  if (typeof globalThis !== "undefined") globalThis.KnodeExtras = api;
})();
