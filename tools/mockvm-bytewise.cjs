// Makes @koinos/mock-vm's database order keys as the chain does: bytewise.
//
// The mock VM's database compares keys with JavaScript's < and >, which turn Buffers into UTF-8 strings. Every byte
// from 0x80 up decodes to the same replacement character, so keys that differ only there collide, and neighbouring
// keys come back in the wrong order (found by the vault fuzz, 2026-10-28; RepoLens fix-check 2, V2-1). This patches:
//   - the sorted map's comparator, its transaction backup and rebuilds (exact-key reads and writes);
//   - getNextObject / getPrevObject (paging), which compare the raw keys within one space, bytewise.
// Used by the bot's SimChain (bot/chain.ts) and the contract tests (game/as-pect.config.js).
"use strict";
const path = require("path");

function bytewise(a, b) {
  a = a || new Uint8Array(0); b = b || new Uint8Array(0);   // total, also for a missing key (fix-check 3, V3-11)
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

const hex = (k) => Buffer.from(k.buffer, k.byteOffset, k.byteLength).toString("hex");

/** A map from byte-string keys, listed in byte order. Exact reads and writes are O(1). */
class BytewiseMap {
  constructor(entries = []) { this.m = new Map(); for (const [k, v] of entries) this.set(k, v); }
  get size() { return this.m.size; }
  has(k) { return this.m.has(hex(k)); }
  get(k) { const e = this.m.get(hex(k)); return e ? e[1] : undefined; }
  set(k, v) { this.m.set(hex(k), [k, v]); return this; }
  delete(k) { return this.m.delete(hex(k)); }
  unordered() { return this.m.values(); }
  sorted() { return [...this.m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1]); }
  entries() { return this.sorted()[Symbol.iterator](); }
  keys() { return this.sorted().map((e) => e[0])[Symbol.iterator](); }
  values() { return this.sorted().map((e) => e[1])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
}

/** Patch one mock-VM Database instance in place. `from`: a file inside the project using mock-vm (module lookup). */
function patchDatabase(db, from = __filename) {
  // Resolve from the caller's real folder only (fix-check 4, C4-2/C4-3: no fallback, so a wrong path fails loudly and
  // nothing is ever loaded from a shared folder such as /tmp/node_modules).
  const base = path.dirname(require.resolve("@koinos/mock-vm", { paths: [path.dirname(from)] }));
  const { koinos } = require(require.resolve("@koinos/proto-js", { paths: [base] }));
  const sameSpace = (s, space) =>
    !!s.system === !!space.system && (s.id || 0) === (space.id || 0) && bytewise(s.zone || new Uint8Array(0), space.zone || new Uint8Array(0)) === 0;
  const canonical = (space) => ({ id: space.id !== 0 ? space.id : null, system: space.system ? space.system : null,
    zone: space.zone && space.zone.length !== 0 ? space.zone : null });

  // The mock VM's own map is an unbalanced sorted tree: filled in key order it turns into a list (slow, and a stack
  // overflow at about 5,500 objects: fix-check 3, V3-2). This map is a hash map keyed by the bytes in hex; it sorts
  // only when listed in order, and hex order is byte order.
  db.comparator = bytewise;
  db.commitTransaction = () => { db.backupDb = new BytewiseMap(db.db.entries()); };
  db.initDb = (arr = []) => { db.db = new BytewiseMap(arr instanceof BytewiseMap || (arr && typeof arr.entries === "function" && !Array.isArray(arr)) ? arr.entries() : arr); db.commitTransaction(); };
  db.initDb([...db.db.entries()]);

  // The next (or previous) key in the same space, by raw key bytes. A full scan: fine for the simulator's sizes.
  const step = (space, key, dir) => {
    let best = null, bestKey = null;
    for (const [k, v] of db.db.unordered()) {
      const d = koinos.chain.database_key.decode(k);
      if (!sameSpace(d.space || {}, space)) continue;
      const c = bytewise(d.key, key);
      if (dir > 0 ? c <= 0 : c >= 0) continue;
      if (bestKey === null || (dir > 0 ? bytewise(d.key, bestKey) < 0 : bytewise(d.key, bestKey) > 0)) { best = v; bestKey = d.key; }
    }
    return bestKey === null ? null : koinos.chain.database_object.create({ exists: true, value: best, key: bestKey });
  };
  // Store copies (fix-check 4, C4-4): the mock VM hands over views into the contract's wasm memory, which a later
  // memory.grow would detach, leaving the stored value empty.
  const put = db.putObject.bind(db);
  db.putObject = (space, key, obj) => put(space, new Uint8Array(key), new Uint8Array(obj));
  db.getNextObject = (space, key) => step(canonical(space), key, 1);
  db.getPrevObject = (space, key) => step(canonical(space), key, -1);
  return db;
}

module.exports = { patchDatabase, bytewise, BytewiseMap };
