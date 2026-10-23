/**
 * Read-only chain checks (audit 2026-10, Section 10; U1-03, U1-04, D1-06). Nothing is signed or sent.
 *
 *   npm run bot -- chain-check
 *
 * For the game and the Desk it reads, straight from the chain:
 *   - the contract's code fingerprint and its three "authorize" switches (all three must be on: without them the
 *     48-hour timelock and "nobody can move the Desk's tokens" protect nothing);
 *   - any announced upgrade, seed withdrawal, treasury change or ownership transfer;
 *   - owner, operator and treasury against deployment.json; the game's retired owner share must be 0.
 * It exits with an error if anything is unexpected.
 */
import { Provider, utils } from "koilib";

/** A contract's metadata as the chain stores it (system object space 3, keyed by the contract id). */
export type ContractMeta = { exists: boolean; hash: string; system: boolean; call: boolean; tx: boolean; upload: boolean };

// ── a few protobuf helpers (enough for these two small messages; no extra packages) ──
function varint(n: number): number[] { const out: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; }
function field(no: number, bytes: Uint8Array | number[]): number[] { return [...varint((no << 3) | 2), ...varint(bytes.length), ...bytes]; }
/** Decodes one protobuf message into { field number: value } (varints as numbers, length-delimited as bytes). */
export function decodeFields(buf: Uint8Array): Map<number, number | Uint8Array> {
  const out = new Map<number, number | Uint8Array>();
  let i = 0;
  const readVarint = () => { let x = 0, s = 0, b; do { if (i >= buf.length) throw new Error("truncated protobuf"); b = buf[i++]; x += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return x; };
  while (i < buf.length) {
    const key = readVarint(), no = Math.floor(key / 8), type = key & 7;
    if (type === 0) out.set(no, readVarint());
    else if (type === 2) { const n = readVarint(); if (i + n > buf.length) throw new Error("truncated protobuf"); out.set(no, buf.slice(i, i + n)); i += n; }
    else throw new Error(`unexpected protobuf wire type ${type}`);
  }
  return out;
}
const b64url = (b: Uint8Array | number[]) => Buffer.from(b).toString("base64url");
const fromB64 = (s: string) => new Uint8Array(Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64"));

/** The get_object system call's arguments for contract metadata: space { system: true, id: 3 }, key = contract id. */
export function metadataArgs(contract: string): string {
  const space = [0x08, 0x01, ...field(2, []), 0x18, 0x03];          // system = true, zone = "", id = 3
  return b64url([...field(1, space), ...field(2, Array.from(utils.decodeBase58(contract)))]);
}
/** Turns the system call's result (get_object_result { database_object { exists, value } }) into ContractMeta. */
export function parseMetadata(resultB64: string | undefined): ContractMeta {
  const none: ContractMeta = { exists: false, hash: "", system: false, call: false, tx: false, upload: false };
  if (!resultB64) return none;
  const obj = decodeFields(fromB64(resultB64)).get(1);
  if (!(obj instanceof Uint8Array)) return none;
  const db = decodeFields(obj);
  const value = db.get(2);
  if (!(value instanceof Uint8Array) || !value.length) return none;
  const m = decodeFields(value);
  const hash = m.get(1);
  return {
    exists: db.get(1) === 1 || value.length > 0,
    hash: hash instanceof Uint8Array ? "0x" + Buffer.from(hash).toString("hex") : "",
    system: m.get(2) === 1, call: m.get(3) === 1, tx: m.get(4) === 1, upload: m.get(5) === 1,
  };
}
export async function contractMetadata(provider: Provider, contract: string): Promise<ContractMeta> {
  const res: any = await provider.call("chain.invoke_system_call", { id: 303, args: metadataArgs(contract) });
  return parseMetadata(res?.value);
}
/** The chain stores the code fingerprint as a multihash: 0x1220 + sha256. */
export const sha256OfMeta = (m: ContractMeta) => (m.hash.startsWith("0x1220") ? m.hash.slice(6) : "");

export type Check = { ok: boolean; text: string };
/** Checks one contract's metadata: it exists, the code is `expectSha256` (if given), all three switches are on. */
export function checkMeta(name: string, m: ContractMeta, expectSha256?: string): Check[] {
  if (!m.exists) return [{ ok: false, text: `${name}: no contract metadata found on chain` }];
  const out: Check[] = [];
  const sha = sha256OfMeta(m);
  if (expectSha256) out.push({ ok: sha === expectSha256.toLowerCase().replace(/^0x/, ""), text: `${name}: code fingerprint ${sha || m.hash} (expected ${expectSha256})` });
  else out.push({ ok: !!sha, text: `${name}: code fingerprint ${sha || m.hash}` });
  const flags = { authorizes_call_contract: m.call, authorizes_transaction_application: m.tx, authorizes_upload_contract: m.upload };
  for (const [k, v] of Object.entries(flags)) out.push({ ok: v, text: `${name}: ${k} = ${v}${v ? "" : "  ← must be true: without it the contract does not decide for its own account"}` });
  return out;
}
