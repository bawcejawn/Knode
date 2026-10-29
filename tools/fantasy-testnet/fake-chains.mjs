// Two small fake Koinos chains for rehearsing the Fantasy testnet kit without the internet (tests and
// tools/fantasy-testnet/rehearse.mjs only; never used against a real network):
//   - a fake TESTNET: one block producer (like the real one), test KOIN, and a faithful-enough Picks contract (owner-only
//     announce with a 10-minute wait, apply, every pick kind the contract has: one address, a list of distinct addresses,
//     a number; the lock `lead` before the target, the opening `ahead`, changes and the daily cap);
//   - a fake MAINNET: blocks every 3 s signed by a weighted field of producers (some miss blocks), with VHP balances, and
//     the real mainnet chain id, so the kit's "scoring chain must be mainnet" check is exercised too.
// Both answer the JSON-RPC calls koilib makes. They share one clock; advance(ms) moves it forward.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { Contract, Provider, Signer } from "koilib";
import { tokenAbi } from "../../bot/token-abi.ts";

const b64url = (b) => Buffer.from(b).toString("base64url");
const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
const nonceB64 = (n) => { const out = [0x28]; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return b64url(out); };
export const randomAddress = () => new Signer({ privateKey: crypto.randomBytes(32).toString("hex") }).getAddress();
export const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
export const TESTNET_CHAIN_ID = "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==";
export const MAINNET_VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq";

/** A shared clock: real time plus an offset that advance() moves. */
export function makeClock() { const c = { offset: 0, now: () => Date.now() + c.offset, advance: (ms) => { c.offset += ms; } }; return c; }

/**
 * producers: [[address, weight (number, or a function of the block time), vhp (number)], ...]
 * picksAbi: the Picks ABI file (only the testnet has a Picks contract); owner: its owner address.
 */
export async function startFakeChain({ name, clock, chainId, producers, blockMs = 3000, historyMs = 9 * 86400000, picksAbiFile = null, owner = null,
  koin = "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju", vhp = MAINNET_VHP, timelockMs = 600000, t0 = null }) {
  const T0 = t0 ?? Math.floor((clock.now() - historyMs) / blockMs) * blockMs;
  const heightAt = (t) => Math.floor((t - T0) / blockMs);
  const timeOf = (h) => T0 + h * blockMs;
  const weightOf = (w, t) => (typeof w === "function" ? w(t) : w);
  const total = (t) => producers.reduce((s, [, w]) => s + weightOf(w, t), 0);
  const signerOf = (h) => {
    const t = timeOf(h), x = (parseInt(crypto.createHash("sha256").update(name + h).digest("hex").slice(0, 8), 16) / 2 ** 32) * total(t);
    let acc = 0;
    for (const [a, w] of producers) { acc += weightOf(w, t); if (x < acc) return a; }
    return producers[0][0];
  };
  const idOf = (h) => "0x1220" + crypto.createHash("sha256").update(`${name}-block-${h}`).digest("hex");
  const bal = new Map(), nonces = new Map(), uploaded = new Set(), txAt = new Map();   // txAt: height → the transactions in that block
  for (const [a, , v] of producers) if (v) bal.set(`${vhp}|${a}`, BigInt(Math.round(v * 1e8)));
  const P = { owner, games: new Map(), pending: new Map(), picks: new Map(), usage: new Map() };
  const picksAbi = picksAbiFile ? JSON.parse(fs.readFileSync(picksAbiFile, "utf8")) : null;
  const dummy = new Provider(["http://127.0.0.1:1"]), coders = new Map();
  const coder = (id, abi) => { if (!coders.has(id)) coders.set(id, new Contract({ id, abi, provider: dummy })); return coders.get(id); };
  const method = (abi, ep) => Object.entries(abi.methods).find(([, m]) => Number(m.entry_point) === Number(ep));
  const abiOf = (id) => (id === koin || id === vhp ? tokenAbi : uploaded.has(id) && picksAbi ? picksAbi : null);
  const getBal = (tok, a) => bal.get(`${tok}|${a}`) ?? 0n;
  const fail = (msg) => { const e = new Error(msg); e.revert = true; throw e; };
  const log = [];                                           // every accepted pick, for the rehearsal's checks

  function checkGame(g) {
    if (typeof g.name !== "string" || !g.name || Buffer.byteLength(g.name) > 40) fail("PICKS: name must be 1 to 40 bytes");
    const kind = Number(g.kind), ls = Number(g.list_size);
    if (kind === 1 && ls !== 1) fail("PICKS: a one-producer game has list_size 1 and no number range");
    if (kind === 2 && !(ls >= 2 && ls <= 10)) fail("PICKS: a list game has list_size 2 to 10 and no number range");
    if (![1, 2, 3].includes(kind)) fail("PICKS: kind must be 1, 2 or 3");
    if (![1, 2].includes(Number(g.lock_mode))) fail("PICKS: lock_mode must be 1 or 2");
    if (!(Number(g.round_size) >= 1 && Number(g.round_offset) < Number(g.round_size))) fail("PICKS: round_size must be at least 1 and above round_offset");
    const minLead = Number(g.lock_mode) === 1 ? 100 : 300000, maxAhead = Number(g.lock_mode) === 1 ? 35 * 28800 : 35 * 86400000;
    if (Number(g.lead) < minLead) fail("PICKS: lead must be at least 100 blocks (or 5 minutes)");
    if (!(Number(g.ahead) > Number(g.lead) && Number(g.ahead) <= maxAhead)) fail("PICKS: ahead must be above lead and at most 35 days");
    if (Number(g.max_picks_per_day) < 1 || Number(g.max_picks_per_day) > 50) fail("PICKS: picks per day must be 1 to 50");
  }
  function call(contract, fn, args, payer, t, h) {
    if (contract === koin || contract === vhp) {
      // effective_balance_of: the VHP block production uses (the race cards read it since audit BX-3 b). The fake chain
      // has no 20-block delay, so it is the balance.
      if (fn === "balance_of" || fn === "effective_balance_of") return { value: String(getBal(contract, args.owner)) };
      if (fn === "total_supply") return { value: String([...bal.entries()].filter(([k]) => k.startsWith(contract + "|")).reduce((s, [, v]) => s + v, 0n)) };
      if (fn === "transfer") {
        if (args.from !== payer) fail("from is not the signer");
        const v = BigInt(args.value);
        if (getBal(contract, args.from) < v) fail("insufficient balance");
        bal.set(`${contract}|${args.from}`, getBal(contract, args.from) - v);
        bal.set(`${contract}|${args.to}`, getBal(contract, args.to) + v);
        return {};
      }
      return {};
    }
    switch (fn) {
      case "get_game": return { game: P.games.get(Number(args.game)), pending: P.pending.get(Number(args.game)) };
      case "get_config": return { owner: P.owner };
      case "list_games": return { games: [...P.games.values()] };
      case "get_pick": return { pick: P.picks.get(`${args.game}|${args.round}|${args.player}`) };
      case "list_picks": {
        const rows = [...P.picks.entries()].filter(([k]) => k.startsWith(`${args.game}|${args.round}|`)).map(([k, v]) => ({ player: k.split("|")[2], pick: v }))
          .sort((a, b) => (a.player < b.player ? -1 : 1)).filter((r) => !args.start_after || r.player > args.start_after).slice(0, Math.min(100, args.limit || 100));
        return { rows };
      }
      case "get_usage": { const u = P.usage.get(`${args.game}|${args.player}`); const day = Math.floor(t / 86400000); return { day: String(day), picks_today: u && u.day === day ? u.count : 0, max_picks_per_day: P.games.get(Number(args.game))?.max_picks_per_day ?? 0 }; }
      case "announce_game": {
        if (payer !== P.owner) fail("PICKS: owner only");
        checkGame(args.game);
        P.pending.set(Number(args.game.id), { game: args.game, eta: String(t + timelockMs), generation: "0" });
        return { eta: String(t + timelockMs) };
      }
      case "apply_game": {
        const p = P.pending.get(Number(args.game));
        if (!p) fail("PICKS: nothing announced");
        if (t < Number(p.eta)) fail("PICKS: not yet");
        P.games.set(Number(args.game), p.game); P.pending.delete(Number(args.game));
        return {};
      }
      case "pick": {
        const g = P.games.get(Number(args.game));
        if (!g || !g.enabled) fail("PICKS: this game is closed");
        if (args.player !== payer) fail("PICKS: the player must sign");
        const pos = Number(g.lock_mode) === 1 ? h : t;
        const target = Number(args.round) * Number(g.round_size) + Number(g.round_offset);
        if (!(target > Number(g.lead) && pos < target - Number(g.lead))) fail("PICKS: this round is locked");
        if (target - pos > Number(g.ahead)) fail("PICKS: this round is not open yet");
        const list = Array.isArray(args.producers) ? args.producers : [], n = String(args.number || "0");
        if (Number(g.kind) === 3) { if (list.length || BigInt(n) < BigInt(g.number_min) || BigInt(n) > BigInt(g.number_max)) fail("PICKS: the choice doesn't fit this game"); }
        else if (n !== "0" || list.length < 1 || list.length > Number(g.list_size) || !list.every(isAddr) || new Set(list).size !== list.length) fail("PICKS: the choice doesn't fit this game");
        const key = `${args.game}|${args.round}|${args.player}`, cur = P.picks.get(key);
        if (cur && cur.number === n && cur.producers.length === list.length && cur.producers.every((a, i) => a === list[i])) fail("PICKS: that is already your pick");
        if (cur && cur.changes >= Number(g.max_changes)) fail("PICKS: this pick can't be changed again");
        const day = Math.floor(t / 86400000), uk = `${args.game}|${args.player}`, u = P.usage.get(uk);
        const count = u && u.day === day ? u.count : 0;
        if (count >= Number(g.max_picks_per_day)) fail("PICKS: today's picks for this game are used up");
        P.usage.set(uk, { day, count: count + 1 });
        P.picks.set(key, { producers: [...list], number: n, height: String(h), time: String(t), changes: cur ? cur.changes + 1 : 0 });
        log.push({ game: Number(args.game), round: Number(args.round), player: args.player, producers: [...list], t });
        return {};
      }
      default: fail(`fake: ${fn} not supported`);
    }
  }
  const block = (h) => {
    const t = timeOf(h), id = idOf(h);
    return { block_id: id, block_height: String(h), block: { id, header: { previous: idOf(h - 1), height: String(h), timestamp: String(t), signer: signerOf(h) }, transactions: txAt.get(h) ?? [] },
      receipt: { events: [{ source: koin, name: "koinos.contracts.token.mint_event" }, { source: vhp, name: "koinos.contracts.token.burn_event" }] } };
  };
  async function rpc(m, p) {
    const head = heightAt(clock.now());
    switch (m) {
      case "chain.get_chain_id": return { chain_id: chainId };
      case "chain.get_head_info": return { head_topology: { id: idOf(head), height: String(head), previous: idOf(head - 1) }, last_irreversible_block: String(head - 20), head_block_time: String(timeOf(head)) };
      case "block_store.get_blocks_by_height": {
        const a = Number(p.ancestor_start_height), n = Math.min(Number(p.num_blocks), 1000), items = [];
        for (let h = a; h < a + n && h <= head; h++) if (h >= 1) items.push(block(h));
        return { block_items: items };
      }
      case "chain.get_account_rc": return { rc: String(getBal(koin, p.account)) };
      case "chain.get_account_nonce": return { nonce: nonceB64(nonces.get(p.account) ?? 0) };
      case "chain.get_resource_limits": return { resource_limit_data: { disk_storage_limit: "1", disk_storage_cost: "1", network_bandwidth_limit: "1", network_bandwidth_cost: "1", compute_bandwidth_limit: "1", compute_bandwidth_cost: "1" } };
      case "contract_meta_store.get_contract_meta": return uploaded.has(p.contract_id) ? { meta: { hash: "0x1220", system: false } } : {};
      case "chain.read_contract": {
        const abi = abiOf(p.contract_id);
        if (!abi) throw new Error("fake: no such contract " + p.contract_id);
        const [fn, mm] = method(abi, p.entry_point);
        const c = coder(p.contract_id, abi);
        const args = p.args ? await c.serializer.deserialize(p.args, mm.argument) : {};
        const out = call(p.contract_id, fn, JSON.parse(JSON.stringify(args)), null, timeOf(head), head);
        return { result: b64url(await c.serializer.serialize(JSON.parse(JSON.stringify(out ?? {})), mm.return)), logs: [] };
      }
      case "chain.submit_transaction": {
        const tx = p.transaction, payer = tx.header.payer, t = timeOf(head + 1);
        if (tx.header.chain_id !== chainId) throw new Error("fake: wrong chain id");
        if (BigInt(tx.header.rc_limit) > getBal(koin, payer)) throw new Error("fake: insufficient pending account resources");
        for (const op of tx.operations) {
          if (op.upload_contract) {
            if (op.upload_contract.contract_id !== payer) throw new Error("fake: upload must be signed by the contract wallet");
            uploaded.add(op.upload_contract.contract_id);
            continue;
          }
          const cc = op.call_contract, abi = abiOf(cc.contract_id);
          if (!abi) throw new Error("fake: no such contract " + cc.contract_id);
          const [fn, mm] = method(abi, cc.entry_point);
          const args = await coder(cc.contract_id, abi).serializer.deserialize(cc.args, mm.argument);
          try { call(cc.contract_id, fn, JSON.parse(JSON.stringify(args)), payer, t, head + 1); }
          catch (e) { if (e.revert) throw new Error(JSON.stringify({ error: e.message })); throw e; }
        }
        nonces.set(payer, (nonces.get(payer) ?? 0) + 1);
        bal.set(`${koin}|${payer}`, getBal(koin, payer) - 1000000n);
        if (!txAt.has(head + 1)) txAt.set(head + 1, []);
        txAt.get(head + 1).push({ id: tx.id, header: tx.header, operations: [] });
        return { receipt: { id: tx.id, payer, rc_used: "1000000", reverted: false, events: [], logs: [] } };
      }
      default: throw new Error("fake: method not supported: " + m);
    }
  }
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      let j = {};
      try { j = JSON.parse(body); const result = await rpc(j.method, j.params ?? {}); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result })); }
      catch (e) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id ?? 1, error: { code: -32603, message: e.message, data: e.message } })); }
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${server.address().port}`, server, T0, heightAt, timeOf, koin, vhp, picks: P, log,
    faucet: (addr, k) => bal.set(`${koin}|${addr}`, getBal(koin, addr) + BigInt(Math.round(k * 1e8))),
    balanceOf: (addr) => getBal(koin, addr),
    markUploaded: (id) => uploaded.add(id),
    close: () => new Promise((ok) => server.close(ok)),
  };
}
