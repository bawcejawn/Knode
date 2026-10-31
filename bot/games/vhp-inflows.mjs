/**
 * VHP moved into a producer over a range of blocks, read with nothing but fetch (no koilib): the verify job's copy of
 * Block X's scoringVhpMoves / vhpInflows / canonicalTransferValue / lastVarint (bot/games/blockx.ts, audits BX-53,
 * BX-72, BX-77, BX-84, BX-90). The verify job runs without installed packages (Repo Lens fix-check 3 FC3-3), so it can't
 * import blockx.ts. tests/audit/combo-verify.test.mjs checks that this copy gives exactly what blockx.ts gives, on the
 * same receipts, so a change to one without the other fails the tests.
 */
export class NonCanonicalTransfer extends Error {}
export const MOVE_MARGIN = 25;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 (Bitcoin alphabet) to bytes; throws on anything else. */
export function decodeBase58(s) {
  if (typeof s !== "string" || !s.length) throw new Error("not base58");
  let n = 0n;
  for (const ch of s) { const v = B58.indexOf(ch); if (v < 0) throw new Error("not base58"); n = n * 58n + BigInt(v); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch !== "1") break; out.unshift(0); }
  return new Uint8Array(out);
}
/** Bytes to base58 (Bitcoin alphabet). */
export function encodeBase58(b) {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = "1" + s; }
  return s;
}

const b64 = (data) => {
  if (typeof data !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(data)) throw new Error("a VHP transfer's event data isn't base64");
  return new Uint8Array(Buffer.from(data, "base64"));
};
function varintBytes(v) {
  const o = [];
  do { let x = Number(v & 0x7fn); v >>= 7n; if (v) x |= 0x80; o.push(x); } while (v);
  return o;
}
/** As blockx.ts canonicalTransferValue: the value of a VHP transfer to `to`, only from the one standard encoding. */
export function canonicalTransferValue(data, to) {
  let b;
  try { b = b64(data); } catch (e) { throw new NonCanonicalTransfer(`a VHP transfer to ${to}: ${e.message}`); }
  const bad = (why) => new NonCanonicalTransfer(`a VHP transfer to ${to} isn't in the standard encoding (${why})`);
  let i = 0;
  const vint = () => {
    let r = 0n, sh = 0n;
    for (let k = 0; k < 10; k++) { if (i >= b.length) throw bad("cut short"); const x = b[i++]; r |= BigInt(x & 0x7f) << sh; if (!(x & 0x80)) return r; sh += 7n; }
    throw bad("a varint over 10 bytes");
  };
  const lenField = (tag) => {
    if (b[i] !== tag) return null;
    i++;
    const n = vint();
    if (n > BigInt(b.length - i)) throw bad("a length past the end");
    const out = b.subarray(i, i + Number(n)); i += Number(n);
    return out;
  };
  const from = lenField(0x0a);
  const toB = lenField(0x12) ?? new Uint8Array(0);
  let value = 0n, hasValue = false;
  if (b[i] === 0x18) { i++; value = vint(); hasValue = true; }
  const memo = lenField(0x22);
  if (i !== b.length) throw bad("unexpected fields");
  let want;
  try { want = decodeBase58(to); } catch { throw bad("not an address"); }
  if (toB.length !== want.length || toB.some((x, k) => x !== want[k])) throw bad("its `to` isn't the event's receiver");
  if (value > 0xffffffffffffffffn) throw bad("a value over 64 bits");
  const enc = [];
  const put = (tag, x) => { if (x) enc.push(tag, ...varintBytes(BigInt(x.length)), ...x); };
  put(0x0a, from); put(0x12, toB);
  if (hasValue) enc.push(0x18, ...varintBytes(value));
  put(0x22, memo);
  if (enc.length !== b.length || enc.some((x, k) => x !== b[k])) throw bad("not the shortest encoding");
  return value;
}
/** As blockx.ts lastVarint: the last varint of field `want`; null when the bytes don't parse. */
export function lastVarint(data, want) {
  let b;
  try { b = typeof data === "string" ? new Uint8Array(Buffer.from(data, "base64")) : new Uint8Array(0); } catch { return null; }
  let i = 0, last = null;
  const vint = () => { let r = 0n, sh = 0n; for (let k = 0; k < 10; k++) { if (i >= b.length) return null; const x = b[i++]; r |= BigInt(x & 0x7f) << sh; if (!(x & 0x80)) return r & 0xffffffffffffffffn; sh += 7n; } return null; };
  while (i < b.length) {
    const tag = vint(); if (tag === null) return null;
    const f = Number(tag >> 3n), w = Number(tag & 7n);
    if (w === 0) { const v = vint(); if (v === null) return null; if (f === want) last = v; }
    else if (w === 1) { i += 8; }
    else if (w === 2) { const n = vint(); if (n === null || i + Number(n) > b.length) return null; i += Number(n); }
    else if (w === 5) { i += 4; }
    else return null;
    if (i > b.length) return null;
  }
  return last;
}
/** As blockx.ts vhpInflows: VHP received by `who` in one block receipt. */
export function vhpInflows(receipt, vhp, who) {
  const events = [...(receipt?.events ?? []), ...((receipt?.transaction_receipts ?? [])).flatMap((t) => t?.events ?? [])];
  let sum = 0n;
  for (const e of events) {
    if (!e || e.source !== vhp || typeof e.name !== "string") continue;
    const mint = /mint/i.test(e.name), transfer = /transfer/i.test(e.name);
    if (!mint && !transfer) continue;
    if (!Array.isArray(e.impacted) || e.impacted[0] !== who) continue;
    if (transfer) { sum += canonicalTransferValue(e.data, who); continue; }
    const value = lastVarint(e.data, 2);
    if (value !== null) sum += value;
  }
  return sum;
}
/** As blockx.ts scoringVhpMoves: every block of from..to, contiguous and checked, 200 a call, read in order. */
export async function scoringVhpMoves(node, headId, vhp, who, from, to) {
  let sum = 0n;
  for (let s = Math.max(1, from); s <= to; s += 200) {
    const n = Math.min(200, to - s + 1), items = [];
    while (items.length < n) {
      const at = s + items.length;
      const res = await node.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(at), num_blocks: n - items.length, return_block: false, return_receipt: true });
      const page = res?.block_items ?? [];
      if (!page.length) break;
      items.push(...page.slice(0, n - items.length));
    }
    if (items.length !== n || items.some((it, k) => Number(it?.block_height) !== s + k)) throw new Error(`receipts ${s}-${s + n - 1}: the node returned ${items.length} of ${n} blocks, or out of order`);
    for (const it of items) sum += vhpInflows(it?.receipt, vhp, who);
  }
  return sum;
}
