/**
 * How the bot talks to the game contract. Two interchangeable implementations:
 *
 *   KoinosChain  the real chain through a public RPC node (koilib). Reads are free; writes are signed transactions.
 *   SimChain     a simulated chain on this computer: the SAME contract code (the test build, whose token ledger
 *                lives inside the contract) running in the Koinos mock VM, with block heights taken from the
 *                repo's real block history. Used by `npm run bot -- rehearse` to run whole weeks in minutes.
 *
 * Both return results in the same JSON shape (koilib's: numbers ≥ 2^32 as strings, addresses in base58,
 * hashes as 0x-hex), so the bot's logic cannot tell them apart.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { Provider, Signer, Contract, Transaction, Serializer, utils } from "koilib";

export const ABI_FILE = "game/abi/kpred.koilib.json";
export const loadAbi = () => JSON.parse(fs.readFileSync(ABI_FILE, "utf8"));

export type Call = { method: string; args: any; contract?: string; abi?: any };
export type Sent = { ok: boolean; error?: string; rcUsed?: string; txId?: string };

export interface Chain {
  readonly kind: "koinos" | "sim";
  readonly contractId: string;
  head(): Promise<{ height: number; lib: number }>;
  /** Read-only call. Returns the decoded result ({} when empty). Throws if the contract refuses. */
  read(method: string, args?: any): Promise<any>;
  /** One transaction with one or more operations, signed by `signers` (the first is the payee, whose nonce is
   *  used). `sponsored`: optional request for the contract to pay Mana for one answer, settle, or claim by a
   *  staked player, up to the on-chain cap (2 KOIN at deployment; the owner can set it to 0). The website never asks
   *  for it (players pay their own Mana); the bot uses it for settles. */
  send(calls: Call[], signers: Signer[], opts?: { sponsored?: boolean; payer?: string; rcLimitKoin?: number }): Promise<Sent>;
  mana(address: string): Promise<bigint>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const toSat = (koin: number) => BigInt(Math.round(koin * 1e8));
export const showKoin = (s: string | number | bigint | undefined) => (Number(s ?? 0) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 8 });

// ═══════════════════════════════ real chain ═══════════════════════════════

export class KoinosChain implements Chain {
  readonly kind = "koinos" as const;
  readonly provider: Provider;
  readonly abi = loadAbi();
  private contract: Contract;

  constructor(readonly rpc: string, readonly contractId: string) {
    this.provider = new Provider([rpc]);
    this.contract = new Contract({ id: contractId, abi: this.abi, provider: this.provider });
  }

  async head() {
    const h: any = await this.retry("head", () => this.provider.getHeadInfo());
    return { height: Number(h.head_topology.height), lib: Number(h.last_irreversible_block) };
  }

  async read(method: string, args: any = {}) {
    const { result } = await this.retry(method, () => (this.contract.functions as any)[method](args));
    return result ?? {};
  }

  async mana(address: string) {
    return BigInt(await this.retry("mana", () => this.provider.getAccountRc(address)));
  }

  /** Network hiccups are retried; a refusal by the contract is not (it would be refused again). */
  private async retry<T>(label: string, fn: () => Promise<T>, tries = 5): Promise<T> {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        const network = /fetch failed|ECONN|ETIMEDOUT|socket|network|50[234]|429|timeout/i.test(msg);
        if (!network || i >= tries) throw e;
        await sleep(2000 * i);
      }
    }
  }

  async op(c: Call) {
    const contract = c.contract ? new Contract({ id: c.contract, abi: c.abi, provider: this.provider }) : this.contract;
    return (await (contract.functions as any)[c.method](c.args, { onlyOperation: true })).operation;
  }

  async send(calls: Call[], signers: Signer[], opts: { sponsored?: boolean; payer?: string; rcLimitKoin?: number } = {}): Promise<Sent> {
    // The mempool keeps counting recent transactions against an account's Mana for a few minutes; that refusal
    // costs nothing, so wait and retry (proven on mainnet with the probes).
    for (let attempt = 1; ; attempt++) {
      const r = await this.sendOnce(calls, signers, opts);
      if (r.ok || !/pending account resources/i.test(r.error ?? "") || attempt >= 12) return r;
      await sleep(20_000);
    }
  }

  private async sendOnce(calls: Call[], signers: Signer[], opts: { sponsored?: boolean; payer?: string; rcLimitKoin?: number }): Promise<Sent> {
    try {
      const payee = signers[0].getAddress();
      const payer = opts.sponsored ? this.contractId : opts.payer ?? payee;
      const available = await this.mana(payer);
      const cap = toSat(opts.rcLimitKoin ?? 2);
      const limit = (available * 95n) / 100n < cap ? (available * 95n) / 100n : cap;
      const tx = new Transaction({ signer: signers[0], provider: this.provider, options: { payer, payee, rcLimit: limit.toString() } });
      for (const c of calls) await tx.pushOperation(await this.op(c));
      await tx.prepare();
      let t: any = tx.transaction;
      for (const s of signers) t = await s.signTransaction(t);
      const { receipt, transaction } = await this.provider.sendTransaction(t);
      if ((receipt as any)?.reverted) {
        await transaction.wait("byBlock", 60_000).catch(() => undefined); // a reverted transaction still uses its nonce
        return { ok: false, rcUsed: String((receipt as any).rc_used ?? 0), txId: t.id, error: `reverted: ${JSON.stringify((receipt as any).logs ?? [])}` };
      }
      // Only a transaction seen in a block counts as done. If it is not confirmed in time, report a failure:
      // the bot re-checks the chain on its next run instead of assuming it went through.
      const confirmed = await transaction.wait("byBlock", 180_000).then(() => true, () => false);
      if (!confirmed) return { ok: false, txId: t.id, error: "sent, but not seen in a block within 3 minutes (will be re-checked next run)" };
      return { ok: true, rcUsed: String((receipt as any)?.rc_used ?? 0), txId: t.id };
    } catch (e) {
      return { ok: false, error: (e as Error).message ?? String(e) };
    }
  }
}

// ═══════════════════════════════ simulated chain ═══════════════════════════════

const require = createRequire(import.meta.url);

/** Runs the contract's test build in the Koinos mock VM. Every call runs a fresh instance of the contract (as on
 *  the real chain) against a database that is rolled back when the call fails. */
export class SimChain implements Chain {
  readonly kind = "sim" as const;
  readonly abi: any;
  private ser: Serializer;
  private vm: any;
  private koinos: any;
  private module!: WebAssembly.Module;
  private K: any; // mock-vm constants
  height = 0;
  /** Every failed write, for the rehearsal's report. */
  failures: Array<{ method: string; error: string }> = [];
  calls = 0;

  /** `abi`: the game's by default; the Desk's for the Desk's compatibility test. */
  constructor(readonly contractId: string, private wasmFile: string, abi: any = loadAbi()) {
    this.abi = abi;
    this.ser = new Serializer(abi.koilib_types);
    const { MockVM } = require("@koinos/mock-vm");
    this.K = require("@koinos/mock-vm/src/constants");
    this.koinos = require("@koinos/proto-js").koinos;
    this.vm = new MockVM(true);
  }

  async init() {
    this.module = await WebAssembly.compile(fs.readFileSync(this.wasmFile));
  }

  /** Replace the contract's code, as an upgrade does: everything stored stays exactly as it is. */
  async setCode(wasmFile: string) {
    this.wasmFile = wasmFile;
    await this.init();
  }

  time = 0;
  /** Move the simulated chain to block h with timestamp t (ms). */
  setHeight(h: number, t?: number) { this.height = h; if (t !== undefined) this.time = t; }
  async head() { return { height: this.height, lib: this.height - 60 }; }
  async mana(_address: string) { return 10n ** 12n; }

  private put(key: Uint8Array, bytes: Uint8Array) { this.vm.db.putObject(this.K.METADATA_SPACE, key, bytes); }

  /** Run one entry point as `authorities` (the accounts that "signed"). */
  private async run(method: string, args: any, authorities: string[]): Promise<{ ok: boolean; result?: any; error?: string }> {
    const m = this.abi.methods[method];
    if (!m) throw new Error(`no method ${method}`);
    const argBytes = await this.ser.serialize(args ?? {}, m.argument);
    const r = await this.exec(m.entry_point | 0, argBytes, authorities);
    if (!r.ok) return r;
    const result = m.return && r.bytes!.length ? await this.ser.deserialize(r.bytes!, m.return) : {};
    return { ok: true, result };
  }

  /** An upgrade as the chain applies it: the transaction carries an upload_contract operation for this contract, and
   *  the code is replaced only if the running contract's own `authorize(contract_upload)` agrees (audit U1-01). */
  async uploadAuthorized(wasmFile: string, authorities: string[], flags = { call: true, tx: true, upload: true }): Promise<boolean> {
    const k = this.koinos;
    const tx = k.protocol.transaction.encode({ operations: [{ upload_contract: {
      contract_id: utils.decodeBase58(this.contractId), bytecode: fs.readFileSync(wasmFile),
      authorizes_call_contract: flags.call, authorizes_transaction_application: flags.tx, authorizes_upload_contract: flags.upload } }] }).finish();
    const args = k.chain.authorize_arguments.encode({ type: k.chain.authorization_type.contract_upload }).finish();
    const r = await this.exec(0x4a2dbd90, args, authorities, tx);           // the authorize entry point
    const yes = r.ok && !!k.chain.authorize_result.decode(r.bytes!).value;
    if (yes) await this.setCode(wasmFile);
    return yes;
  }

  /** Runs one entry point with raw argument bytes; returns the raw result bytes. */
  private async exec(entryPoint: number, argBytes: Uint8Array, authorities: string[], txBytes?: Uint8Array): Promise<{ ok: boolean; bytes?: Uint8Array; error?: string }> {
    const k = this.koinos;
    this.vm.db.commitTransaction(); // snapshot: a failing call rolls back to here
    this.put(this.K.CONTRACT_ID_KEY, utils.decodeBase58(this.contractId));
    this.put(this.K.ENTRY_POINT_KEY, k.chain.value_type.encode({ int32_value: entryPoint }).finish());
    this.put(this.K.CONTRACT_ARGUMENTS_KEY, argBytes);
    this.put(this.K.CONTRACT_RESULT_KEY, new Uint8Array(0));
    this.put(this.K.EXIT_CODE_KEY, k.chain.value_type.encode({ int32_value: 0 }).finish());
    this.put(this.K.BLOCK_KEY, k.protocol.block.encode({ header: { height: String(this.height), timestamp: String(this.time) } }).finish());
    this.put(this.K.HEAD_INFO_KEY, k.chain.head_info.encode({ head_topology: { height: String(this.height) }, last_irreversible_block: String(this.height - 60) }).finish());
    this.put(this.K.CALLER_KEY, k.chain.caller_data.encode({ caller: new Uint8Array(0), caller_privilege: 1 }).finish());
    this.put(this.K.TRANSACTION_KEY, txBytes ?? k.protocol.transaction.encode({}).finish());
    this.put(this.K.AUTHORITY_KEY, k.chain.list_type.encode({
      values: authorities.map((a) => ({ bytes_value: utils.decodeBase58(a), int32_value: 0, bool_value: true })),
    }).finish());
    this.vm.db.commitTransaction();

    const instance = await WebAssembly.instantiate(this.module, {
      wasi_snapshot_preview1: { fd_write: () => 0, proc_exit: () => {} },
      env: { ...this.vm.getImports() },
    });
    (instance.exports.memory as WebAssembly.Memory).grow(16);
    this.vm.setInstance(instance);
    let code = 0, message = "";
    try {
      (instance.exports._start as Function)();
    } catch (e: any) {
      if (typeof e?.code === "number") { code = e.code; message = e.message; }
      else { code = -1; message = e?.message ?? String(e); }
    }
    if (code !== 0) return { ok: false, error: message || `exit code ${code}` };
    const res = this.vm.db.getObject(this.K.METADATA_SPACE, this.K.CONTRACT_RESULT_KEY);
    return { ok: true, bytes: res?.value ?? new Uint8Array(0) };
  }

  async read(method: string, args: any = {}) {
    const r = await this.run(method, args, []);
    if (!r.ok) throw new Error(r.error);
    return r.result ?? {};
  }

  /** Writes: every operation runs in order; if one fails, everything in the transaction is undone. */
  async send(calls: Call[], signers: Signer[], _opts: { sponsored?: boolean } = {}): Promise<Sent> {
    return this.sendAs(calls, signers.map((s) => s.getAddress()));
  }

  /** `record`: count failures (the bot's own transactions should never fail; players' may, on purpose). */
  async sendAs(calls: Call[], authorities: string[], record = true): Promise<Sent> {
    if (record) this.calls++;
    this.vm.db.commitTransaction();
    const before = new (this.vm.db.db.constructor)(this.vm.db.db); // snapshot of the whole state for multi-op rollback
    for (const c of calls) {
      if (c.contract && c.contract !== this.contractId) continue; // token approvals: the sim ledger needs none
      const r = await this.run(c.method, c.args, authorities);
      if (!r.ok) {
        this.vm.db.initDb(before);
        if (record) this.failures.push({ method: c.method, error: r.error ?? "" });
        return { ok: false, error: r.error };
      }
    }
    return { ok: true, txId: "0x" + crypto.randomBytes(8).toString("hex") };
  }

  // ───── the simulated token ledger inside the test build (storage space 90: tag 1 KOIN, 2 VHP, 3 Mana) ─────
  private ledgerKey(tag: number, who: string) {
    const a = utils.decodeBase58(who);
    const k = new Uint8Array(a.length + 1);
    k[0] = tag;
    k.set(a, 1);
    return k;
  }
  private space() { return { system: false, id: 90, zone: utils.decodeBase58(this.contractId) }; }
  async ledgerGet(tag: number, who: string): Promise<bigint> {
    const o = this.vm.db.getObject(this.space(), this.ledgerKey(tag, who));
    if (!o) return 0n;
    // The test ledger's record is { uint64 amount = 1 } in both contracts: read field 1 (a varint) directly.
    const b: Uint8Array = o.value;
    let i = 0, out = 0n;
    while (i < b.length) {
      const key = b[i++];
      let v = 0n, shift = 0n, byte: number;
      do { byte = b[i++]; v |= BigInt(byte & 0x7f) << shift; shift += 7n; } while (byte & 0x80);
      if (key === 0x08) out = v;
    }
    return out;
  }
  async ledgerSet(tag: number, who: string, amount: bigint) {
    const bytes: number[] = [];
    if (amount > 0n) { bytes.push(0x08); let v = amount; do { let x = Number(v & 0x7fn); v >>= 7n; if (v) x |= 0x80; bytes.push(x); } while (v); }
    this.vm.db.putObject(this.space(), this.ledgerKey(tag, who), new Uint8Array(bytes));
    this.vm.db.commitTransaction();
  }
  async ledgerAdd(tag: number, who: string, amount: bigint) {
    await this.ledgerSet(tag, who, (await this.ledgerGet(tag, who)) + amount);
  }
}
