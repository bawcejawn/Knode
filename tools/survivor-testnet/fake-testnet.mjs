// A small fake Koinos testnet for rehearsing the Survivor testnet tool without the internet (tests and
// tools/survivor-testnet/rehearse.mjs only; never used against a real network). It answers the JSON-RPC calls koilib
// makes: head, blocks, chain id, nonce, Mana, read_contract and submit_transaction. It keeps tKOIN balances and a
// faithful-enough Picks contract (owner-only announce with a 10-minute wait, apply, picks that lock `lead` before the
// round and open `ahead`, the daily cap, one pick per player per round). Blocks come every `blockMs` from a fixed
// start, signed by a weighted set of producers, so the recorder sees a real-looking field. `advance(ms)` moves its
// clock forward (to skip the 10-minute wait, or to the next round).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Contract, Provider, Signer } from "koilib";
import { tokenAbi } from "../../bot/token-abi.ts";

const b64url = (b) => Buffer.from(b).toString("base64url");
const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
const idOf = (h) => "0x1220" + crypto.createHash("sha256").update("fake-block-" + h).digest("hex");
const nonceB64 = (n) => { const out = [0x28]; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return b64url(out); };

/** A random valid address (for fake producers and the fake VHP token). */
export const randomAddress = () => new Signer({ privateKey: crypto.randomBytes(32).toString("hex") }).getAddress();

export async function startFakeTestnet({ abiFile, owner = null, producers, koin = "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju", vhp = randomAddress(), chainId = "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==", blockMs = 1000, historyMs = 3 * 86400000 } = {}) {
  let offset = 0;
  const now = () => Date.now() + offset;
  const T0 = Math.floor((Date.now() - historyMs) / 1000) * 1000;
  const heightAt = (t) => Math.floor((t - T0) / blockMs);
  const timeOf = (h) => T0 + h * blockMs;
  // producers: [[address, weight], ...]; a weight can be a function of the block time (a producer that goes quiet).
  const total = (t) => producers.reduce((s, [, w]) => s + (typeof w === "function" ? w(t) : w), 0);
  function signerOf(h) {
    const t = timeOf(h), x = (parseInt(crypto.createHash("sha256").update("s" + h).digest("hex").slice(0, 8), 16) / 2 ** 32) * total(t);
    let acc = 0;
    for (const [a, w] of producers) { acc += typeof w === "function" ? w(t) : w; if (x < acc) return a; }
    return producers[0][0];
  }
  const bal = new Map();            // `${token}|${addr}` → bigint
  const nonces = new Map();
  const txAt = new Map();           // height → [tx json]
  const uploaded = new Map();       // contract address → { abi }
  const picks = { owner, games: new Map(), pending: new Map(), picks: new Map(), usage: new Map() };
  const picksAbi = JSON.parse(fs.readFileSync(abiFile, "utf8"));
  const dummy = new Provider(["http://127.0.0.1:1"]);
  const coders = new Map();         // contract → Contract (for the serializer)
  const coder = (id, abi) => { if (!coders.has(id)) coders.set(id, new Contract({ id, abi, provider: dummy })); return coders.get(id); };
  const method = (abi, ep) => Object.entries(abi.methods).find(([, m]) => Number(m.entry_point) === Number(ep));
  const abiOf = (id) => (id === koin || id === vhp ? tokenAbi : uploaded.has(id) ? picksAbi : null);
  const getBal = (tok, a) => bal.get(`${tok}|${a}`) ?? 0n;
  const fail = (msg) => { const e = new Error(msg); e.revert = true; throw e; };

  function call(contract, name, args, payer, t) {
    if (contract === koin || contract === vhp) {
      if (name === "balance_of") return { value: String(getBal(contract, args.owner)) };
      if (name === "transfer") {
        if (args.from !== payer) fail("from is not the signer");
        const v = BigInt(args.value);
        if (getBal(contract, args.from) < v) fail("insufficient balance");
        bal.set(`${contract}|${args.from}`, getBal(contract, args.from) - v);
        bal.set(`${contract}|${args.to}`, getBal(contract, args.to) + v);
        return {};
      }
      return {};
    }
    // the Picks contract
    const P = picks;
    switch (name) {
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
        const g = args.game;
        if (Number(g.kind) === 1 && Number(g.list_size) !== 1) fail("PICKS: a one-producer game has list_size 1 and no number range");
        if (Number(g.lead) < 300000 || !(Number(g.ahead) > Number(g.lead))) fail("PICKS: lead/ahead");
        if (Number(g.max_picks_per_day) < 1 || Number(g.max_picks_per_day) > 50) fail("PICKS: picks per day must be 1 to 50");
        P.pending.set(Number(g.id), { game: g, eta: String(t + 600000), generation: "0" });
        return { eta: String(t + 600000) };
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
        const target = Number(args.round) * Number(g.round_size) + Number(g.round_offset);
        if (!(target > Number(g.lead) && t < target - Number(g.lead))) fail("PICKS: this round is locked");
        if (target - t > Number(g.ahead)) fail("PICKS: this round is not open yet");
        if (!Array.isArray(args.producers) || args.producers.length !== 1 || !isAddr(args.producers[0])) fail("PICKS: the choice doesn't fit this game");
        const key = `${args.game}|${args.round}|${args.player}`, cur = P.picks.get(key);
        if (cur && cur.producers[0] === args.producers[0]) fail("PICKS: that is already your pick");
        if (cur && cur.changes >= Number(g.max_changes)) fail("PICKS: this pick can't be changed again");
        const day = Math.floor(t / 86400000), uk = `${args.game}|${args.player}`, u = P.usage.get(uk);
        const count = u && u.day === day ? u.count : 0;
        if (count >= Number(g.max_picks_per_day)) fail("PICKS: today's picks for this game are used up");
        P.usage.set(uk, { day, count: count + 1 });
        P.picks.set(key, { producers: [args.producers[0]], number: "0", height: String(heightAt(t)), time: String(t), changes: cur ? cur.changes + 1 : 0 });
        return {};
      }
      default: fail(`fake: ${name} not supported`);
    }
  }

  function block(h, withTx) {
    const t = timeOf(h), id = idOf(h);
    return { block_id: id, block_height: String(h), block: { id, header: { previous: idOf(h - 1), height: String(h), timestamp: String(t), signer: signerOf(h) }, transactions: withTx ? txAt.get(h) ?? [] : [] },
      receipt: { events: [{ source: koin, name: "koinos.contracts.token.mint_event" }, { source: vhp, name: "koinos.contracts.token.burn_event" }] } };
  }

  async function rpc(m, p) {
    const head = heightAt(now());
    switch (m) {
      case "chain.get_chain_id": return { chain_id: chainId };
      case "chain.get_head_info": return { head_topology: { id: idOf(head), height: String(head), previous: idOf(head - 1) }, last_irreversible_block: String(head - 20), head_block_time: String(timeOf(head)) };
      case "block_store.get_blocks_by_height": {
        const a = Number(p.ancestor_start_height), n = Math.min(Number(p.num_blocks), 1000), items = [];
        for (let h = a; h < a + n && h <= head; h++) if (h >= 1) items.push(block(h, p.return_block !== false));
        return { block_items: items };
      }
      case "chain.get_account_rc": return { rc: String(getBal(koin, p.account)) };
      case "chain.get_account_nonce": return { nonce: nonceB64(nonces.get(p.account) ?? 0) };
      case "chain.get_resource_limits": return { resource_limit_data: { disk_storage_limit: "1", disk_storage_cost: "1", network_bandwidth_limit: "1", network_bandwidth_cost: "1", compute_bandwidth_limit: "1", compute_bandwidth_cost: "1" } };
      case "contract_meta_store.get_contract_meta": return uploaded.has(p.contract_id) ? { meta: { hash: "0x1220", system: false } } : {};
      case "chain.read_contract": {
        const abi = abiOf(p.contract_id);
        if (!abi) throw new Error("fake: no such contract " + p.contract_id);
        const [name, mm] = method(abi, p.entry_point);
        const c = coder(p.contract_id, abi);
        const args = p.args ? await c.serializer.deserialize(p.args, mm.argument) : {};
        const out = call(p.contract_id, name, args, null, timeOf(head));
        const clean = JSON.parse(JSON.stringify(out ?? {}));
        return { result: b64url(await c.serializer.serialize(clean, mm.return)), logs: [] };
      }
      case "chain.submit_transaction": {
        const tx = p.transaction, payer = tx.header.payer, t = timeOf(head + 1);
        if (tx.header.chain_id !== chainId) throw new Error("fake: wrong chain id");
        if (BigInt(tx.header.rc_limit) > getBal(koin, payer)) throw new Error("fake: not enough Mana for the rc limit");
        for (const op of tx.operations) {
          if (op.upload_contract) {
            if (op.upload_contract.contract_id !== payer) throw new Error("fake: upload must be signed by the contract wallet");
            uploaded.set(op.upload_contract.contract_id, {});
            continue;
          }
          const cc = op.call_contract, abi = abiOf(cc.contract_id);
          if (!abi) throw new Error("fake: no such contract " + cc.contract_id);
          const [name, mm] = method(abi, cc.entry_point);
          const args = await coder(cc.contract_id, abi).serializer.deserialize(cc.args, mm.argument);
          try { call(cc.contract_id, name, JSON.parse(JSON.stringify(args)), payer, t); }
          catch (e) { if (e.revert) throw new Error(JSON.stringify({ error: e.message })); throw e; }
        }
        nonces.set(payer, (nonces.get(payer) ?? 0) + 1);
        bal.set(`${koin}|${payer}`, getBal(koin, payer) - 1000000n);     // 0.01 KOIN of Mana
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
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, server, T0, now, heightAt, timeOf, vhp, koin,
    advance: (ms) => { offset += ms; },
    faucet: (addr, koinAmount) => bal.set(`${koin}|${addr}`, getBal(koin, addr) + BigInt(Math.round(koinAmount * 1e8))),
    setVhp: (addr, v) => bal.set(`${vhp}|${addr}`, BigInt(Math.round(v * 1e8))),
    setKoin: (addr, v) => bal.set(`${koin}|${addr}`, BigInt(Math.round(v * 1e8))),
    picks, balanceOf: (addr) => getBal(koin, addr),
    close: () => new Promise((ok) => server.close(ok)),
  };
}
