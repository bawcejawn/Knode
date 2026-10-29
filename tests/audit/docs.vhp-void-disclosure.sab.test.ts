// Red-team SABOTEUR (fix check 1dbc129): what players are told about the VHP-swing void vs what the code allows.
// The code lets a question be voided on purpose, late in its window: by the subject (moving its own VHP, Mana only) and
// by ANYONE (sending or burning VHP to a subject, or swapping VHP into the Knode Swap desk, which is a subject like any
// other producer). Players answering on the site are not told either; the README only mentions the subject itself.
// Asserts the SAFE behaviour (the risk is disclosed where players read the rules): FAILS today.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync("index.html", "utf8");
const readme = fs.readFileSync("README.md", "utf8");
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// Attack: a player reads only the site. Safe: the "Anyone can move the results" section says a VHP move can void a
// question on purpose (by the producer itself or by anyone sending it VHP), not only that "it is voided if VHP moves".
test("SAB2-DOC-1: the site's open-network section tells players a question can be voided on purpose by moving a subject's VHP", () => {
  const start = html.indexOf('id="open-network"');
  assert.ok(start > 0, "open-network section exists");
  const section = text(html.slice(start, html.indexOf('<div class="faq">', start)));
  assert.match(section, /(on purpose|deliberately|at will|its own VHP|their own VHP|send(ing)? (it )?VHP|anyone[^.]{0,120}void)/i,
    "SAB2-DOC-1: the site never says that a producer (or anyone sending it VHP) can void a question about it on purpose, late in its window");
});

// Attack: README says only "A subject can still move its own VHP ... to void a question about itself". Safe: it also says
// that a third party can do it (sending/burning VHP to the subject, or a swap into the Knode Swap desk), and what it costs.
test("SAB2-DOC-2: the README's VHP-swing section says third parties (not only the subject) can trigger the void", () => {
  const a = readme.indexOf("How the VHP-swing rule is applied");
  const section = readme.slice(a, readme.indexOf("\n## ", a));
  assert.match(section, /(anyone|any VHP holder|third part|someone else|another (player|account))[^.]{0,200}(send|sending|burn|burning|transfer|swap)/i,
    "SAB2-DOC-2: the README only tells players the SUBJECT can void by moving its own VHP; anyone can do it by sending/burning VHP to the subject or swapping into the desk");
});

// Attack: README justifies ignoring post-window readings with "by then the outcome is public". Safe: it also says how
// much of the window is public at the last reading that does count (up to all of it, at height windowEnd).
test("SAB2-DOC-3: the README does not imply in-window readings are taken before the outcome is known", () => {
  const a = readme.indexOf("How the VHP-swing rule is applied");
  const section = readme.slice(a, readme.indexOf("\n## ", a));
  const claimsPublicOnlyAfter = /after the window's last block never voids[^.]*by then the outcome is public/i.test(section.replace(/\s+/g, " "));
  const admitsLate = /(last (hourly )?reading|last hour|near(ly)? (all|the end)|most of the window|almost all)/i.test(section);
  assert.ok(!claimsPublicOnlyAfter || admitsLate,
    "SAB2-DOC-3: README says readings after the window are ignored because 'by then the outcome is public', but a reading at height windowEnd (or one hour before it) counts when the outcome is already (almost) public");
});
