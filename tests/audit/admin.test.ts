// The local admin page: values are checked, nothing can be sent without the same preview first, and only this
// computer, with the session key, from the page itself, can use it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { ACTIONS, AREAS, KINDS, commandFor } from "../../admin/actions.ts";

const A = (id: string) => ACTIONS.find((a) => a.id === id)!;

test("values must match exactly; nothing can smuggle in an option such as --send", () => {
  assert.deepEqual(commandFor(A("void"), { id: "12", reason: "wrong window" }), { argv: ["void", "12", "wrong", "window"] });
  assert.ok("error" in commandFor(A("void"), { id: "12", reason: "x --send" }));
  assert.ok("error" in commandFor(A("void"), { id: "12", reason: "--send" }));
  assert.ok("error" in commandFor(A("void"), { id: "-1", reason: "" }));
  assert.ok("error" in commandFor(A("desk-fee"), { percent: "11" }));
  assert.ok("error" in commandFor(A("set-operator"), { address: "1abc --send" }));
  assert.ok("error" in commandFor(A("desk-withdraw"), { token: "koin", amount: "-5" }));
  assert.deepEqual(commandFor(A("desk-withdraw"), { token: "vhp", amount: "1.5" }), { argv: ["withdraw", "vhp", "1.5"] });
  for (const a of ACTIONS) for (const t of a.args) assert.ok(t !== "--send", `${a.id}: --send is added only by the server`);
});

// Owner, 2026-10-29: "every action … clearly identified what its for, game, purpose": every control is complete.
test("every control names its area, kind, purpose, signer and effect; areas are complete; ids are unique", () => {
  const ids = new Set<string>();
  for (const a of ACTIONS) {
    assert.ok(!ids.has(a.id), `${a.id}: duplicate id`); ids.add(a.id);
    assert.ok(AREAS.some((x) => x.id === a.area), `${a.id}: unknown area ${a.area}`);
    assert.ok(a.kind in KINDS, `${a.id}: unknown kind ${a.kind}`);
    for (const f of ["label", "what", "signer"] as const) assert.ok(String(a[f] ?? "").trim().length >= 3, `${a.id}: ${f} is empty`);
    assert.ok(["none", "chain", "files"].includes(a.effect), `${a.id}: effect`);
    if (a.effect === "none") assert.equal(a.sends, false, `${a.id}: read-only never sends`);
    if (a.effect === "chain") assert.ok(a.sends && a.timing, `${a.id}: a chain change sends and says when it takes effect`);
    if (a.effect === "chain") assert.ok(!/^Nobody/.test(a.signer), `${a.id}: a chain change names its signer`);
    assert.equal(a.args.includes("--testnet"), AREAS.find((x) => x.id === a.area)!.status === "testnet", `${a.id}: testnet actions live in testnet areas only`);
    for (const p of a.params ?? []) if (p.value !== undefined && !p.choices) assert.ok(p.pattern.test(p.value), `${a.id}: default ${p.value} fails its own check`);
  }
  for (const ar of AREAS) {
    assert.ok(ar.what.length > 10, `${ar.id}: what`);
    if (ar.status === "planned") assert.ok(ar.later, `${ar.id}: a planned area says what comes later`);
    else assert.ok(ACTIONS.some((a) => a.area === ar.id), `${ar.id}: a live area has controls`);
  }
});

function request(port: number, path: string, opts: { method?: string; host?: string; key?: string; origin?: string; body?: any } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = http.request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET",
      headers: { host: opts.host ?? `127.0.0.1:${port}`, ...(opts.key ? { "x-admin-key": opts.key } : {}), ...(opts.origin ? { origin: opts.origin } : {}), ...(data ? { "content-type": "application/json" } : {}) } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j: any = b; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode!, body: j }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

test("the server: this computer only, the session key, the page's own origin, preview before send", async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["--import", "tsx", "admin/server.ts"], { env: { ...process.env, ADMIN_PORT: String(port), ADMIN_NO_BROWSER: "1" } });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  try {
    for (let i = 0; i < 100 && !/#([0-9a-f]{48})/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    const key = out.match(/#([0-9a-f]{48})/)![1];
    assert.match(out, new RegExp(`http://127\\.0\\.0\\.1:${port}/#`));
    assert.equal((await request(port, "/", {})).status, 200);
    assert.equal((await request(port, "/api/actions", { host: "evil.example" })).status, 403, "DNS rebinding: wrong Host");
    assert.equal((await request(port, "/api/actions", {})).status, 401, "no key");
    assert.equal((await request(port, "/api/actions", { key: "0".repeat(48) })).status, 401, "wrong key");
    assert.equal((await request(port, "/api/actions", { key: "\u00e9".repeat(48) })).status, 401, "a non-ASCII key is refused (audit L-10)");
    assert.equal((await request(port, "/api/actions", { key })).status, 200, "and the server is still up");
    assert.equal((await request(port, "/api/actions", { key, origin: "https://evil.example" })).status, 403, "another website");
    const list = await request(port, "/api/actions", { key });
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.actions) && list.body.actions.length >= 30);
    assert.ok(Array.isArray(list.body.areas) && list.body.kinds.check);
    assert.ok(list.body.actions.every((a: any) => !("pattern" in a) && a.command.startsWith("npm run ")));
    const send = await request(port, "/api/run", { method: "POST", key, body: { action: "pause", values: { state: "on" }, send: true } });
    assert.equal(send.status, 409, "a send without a preview is refused");
    assert.match(send.body.error, /preview it first/);
    const ro = await request(port, "/api/run", { method: "POST", key, body: { action: "chain-check", values: {}, send: true } });
    assert.equal(ro.status, 400, "a read-only action can never send");
    const bad = await request(port, "/api/run", { method: "POST", key, body: { action: "void", values: { id: "1", reason: "--send" } } });
    assert.equal(bad.status, 400);
  } finally { child.kill(); }
});
