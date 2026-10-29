// F4-W regression / failing tests (node:test). NOT RUN HERE (static review). Run from the repo root: APP=. node --test f4w.failing.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const APP = process.env.APP || ".";
const read = (f) => fs.readFileSync(`${APP}/${f}`, "utf8");

// W-1 (Low): the move page is also published at https://knodegames.com/tools/old-origin-guest/guest-move.html (repo root is
// the Pages root, .nojekyll), where it finds the CURRENT guest key and offers to erase it. It must run only on the old origin.
test("W-1: guest-move.html does nothing unless it runs at bawcejawn.github.io", () => {
  const h = read("tools/old-origin-guest/guest-move.html");
  assert.match(h, /location\.hostname\s*!==?\s*["']bawcejawn\.github\.io["']/, "page checks it is on the old origin before reading or erasing");
});

// W-2 (Low): http: is accepted for knodegames.com; only the dev hosts need http.
test("W-2: guest origin needs https on knodegames.com", () => {
  const src = read("wallet.js");
  const body = src.slice(src.indexOf("const GUEST_ORIGINS"), src.indexOf("const NO_GUEST"));
  const guestOrigin = new Function("window", body + "\nreturn guestOrigin();");
  assert.equal(guestOrigin({ location: new URL("http://knodegames.com/") }), false);
  assert.equal(guestOrigin({ location: new URL("https://knodegames.com/") }), true);
  assert.equal(guestOrigin({ location: new URL("http://localhost:8080/") }), true);
});

// BX-41 regression: board.js shows the recorder's boardPlace (ties share) on the Staked board, podium and "You: #n".
test("BX-41: tied staked rows show the same place and the same medal", () => {
  const src = read("board.js");
  assert.match(src, /placeOf = \(r, i\) => \(Number\.isInteger\(r\.boardPlace\)/);
  // behaviour: see the scratch fuzz t-board.mjs (20,000 random weeks vs an independent competition-rank oracle)
});
