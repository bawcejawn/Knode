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
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Patch one mock-VM Database instance in place. `from`: a file inside the project using mock-vm (module lookup). */
function patchDatabase(db, from = __filename) {
  const base = path.dirname(require.resolve("@koinos/mock-vm", { paths: [path.dirname(from)] }));
  const { SoMap } = require(require.resolve("somap", { paths: [base] }));
  const { koinos } = require(require.resolve("@koinos/proto-js", { paths: [base] }));
  const sameSpace = (s, space) =>
    !!s.system === !!space.system && (s.id || 0) === (space.id || 0) && bytewise(s.zone || new Uint8Array(0), space.zone || new Uint8Array(0)) === 0;
  const canonical = (space) => ({ id: space.id !== 0 ? space.id : null, system: space.system ? space.system : null,
    zone: space.zone && space.zone.length !== 0 ? space.zone : null });

  db.comparator = bytewise;
  db.commitTransaction = () => { db.backupDb = new SoMap(db.db, bytewise); };
  db.initDb = (arr = []) => { db.db = new SoMap(arr, bytewise); db.commitTransaction(); };
  db.initDb([...db.db.entries()]);

  // The next (or previous) key in the same space, by raw key bytes. A full scan: fine for the simulator's sizes.
  const step = (space, key, dir) => {
    let best = null, bestKey = null;
    for (const [k, v] of db.db.entries()) {
      const d = koinos.chain.database_key.decode(k);
      if (!sameSpace(d.space || {}, space)) continue;
      const c = bytewise(d.key, key);
      if (dir > 0 ? c <= 0 : c >= 0) continue;
      if (bestKey === null || (dir > 0 ? bytewise(d.key, bestKey) < 0 : bytewise(d.key, bestKey) > 0)) { best = v; bestKey = d.key; }
    }
    return bestKey === null ? null : koinos.chain.database_object.create({ exists: true, value: best, key: bestKey });
  };
  db.getNextObject = (space, key) => step(canonical(space), key, 1);
  db.getPrevObject = (space, key) => step(canonical(space), key, -1);
  return db;
}

module.exports = { patchDatabase, bytewise };
