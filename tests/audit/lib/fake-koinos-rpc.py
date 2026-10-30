# A fake Koinos JSON-RPC node for the Last Node Standing publish tests (fix-check N-1). It answers the three calls the
# publish job makes: chain.get_head_info, block_store.get_blocks_by_height and chain.read_contract (Picks list_picks),
# from a fixture file it re-reads on every request, so a test can change the chain between publishes.
#   python3 fake-koinos-rpc.py <fixture.json> <port file>
# Fixture: {"blocks": {"<height>": [signer, time ms]}, "windows": [...], "lib": height, "picks": {"<game>:<round>": [[player, [producers], time]]},
#           "b": {...}}   ("b" overrides keys for requests to /b, the second node; e.g. different blocks)
# Written separately from the publish job's own client (its encoders and decoders are this file's own).
import base64, json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FIX, PORTFILE = sys.argv[1], sys.argv[2]
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58dec(s):
    n = 0
    for ch in s: n = n * 58 + B58.index(ch)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\0" * (len(s) - len(s.lstrip("1"))) + raw
def b58enc(b):
    n, out = int.from_bytes(b, "big"), ""
    while n: n, r = divmod(n, 58); out = B58[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + out
def varint(n):
    out = b""
    while True:
        x = n & 0x7F; n >>= 7
        out += bytes([x | (0x80 if n else 0)])
        if not n: return out
def ld(field, b): return varint(field << 3 | 2) + varint(len(b)) + b
def vi(field, n): return varint(field << 3) + varint(n)
def parse(b):
    i, out = 0, []
    while i < len(b):
        k, s = 0, 0
        while True:
            x = b[i]; i += 1; k |= (x & 0x7F) << s; s += 7
            if not x & 0x80: break
        f, w = k >> 3, k & 7
        if w == 0:
            v, s = 0, 0
            while True:
                x = b[i]; i += 1; v |= (x & 0x7F) << s; s += 7
                if not x & 0x80: break
            out.append((f, v))
        elif w == 2:
            n, s = 0, 0
            while True:
                x = b[i]; i += 1; n |= (x & 0x7F) << s; s += 7
                if not x & 0x80: break
            out.append((f, b[i:i + n])); i += n
        else: raise ValueError("wire type %d" % w)
    return out
B64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
UNB64 = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
LIST_PICKS = 2118033200

def fixture(node):
    j = json.load(open(FIX))
    if node == "b": j = {**j, **(j.get("b") or {})}
    return j
def answer(node, method, p):
    j = fixture(node)
    blocks = {int(k): v for k, v in (j.get("blocks") or {}).items()}
    # "windows": [{from, to, t0, counts}] — one block every 3 s from t0; each count's signer first, then FILLER; and a
    # filler block just before and just after each window where there is none.
    FILLER = "1" + "z" * 33
    for w in j.get("windows") or []:
        seq = [a for a, n in sorted(w["counts"].items()) for _ in range(int(n))]
        for k, h in enumerate(range(w["from"], w["to"] + 1)): blocks[h] = [seq[k] if k < len(seq) else FILLER, w["t0"] + k * 3000]
    for w in j.get("windows") or []:
        if w["from"] - 1 not in blocks: blocks[w["from"] - 1] = [FILLER, w["t0"] - 3000]
        if w["to"] + 1 not in blocks: blocks[w["to"] + 1] = [FILLER, w["t0"] + 3600000]
    lib = int(j.get("lib") or (max(blocks) if blocks else 0))
    top = max([lib] + list(blocks))
    if method == "chain.get_head_info":
        return {"head_topology": {"id": "0x1220" + "%060x" % top, "height": str(top), "previous": "0x00"}, "last_irreversible_block": str(lib),
                "head_block_time": str(blocks[top][1] if top in blocks else 0)}
    if method == "block_store.get_blocks_by_height":
        a, n = int(p["ancestor_start_height"]), int(p["num_blocks"])
        items = []
        for h in range(a, a + min(n, 200)):
            if h not in blocks: break
            s, t = blocks[h]
            items.append({"block_id": "0x1220" + "%060x" % h, "block_height": str(h),
                          "block": {"id": "0x1220" + "%060x" % h, "header": {"previous": "0x00", "height": str(h), "timestamp": str(t), "signer": s}}})
        return {"block_items": items}
    if method == "chain.read_contract":
        if int(p["entry_point"]) != LIST_PICKS: raise ValueError("unknown entry point")
        args = dict()
        for f, v in parse(UNB64(p["args"])): args[f] = v
        game, rnd, after, limit = args.get(1, 0), args.get(2, 0), args.get(3, b""), args.get(4, 0)
        rows = sorted((j.get("picks") or {}).get("%d:%d" % (game, rnd), []), key=lambda r: b58dec(r[0]))
        if after: rows = [r for r in rows if b58dec(r[0]) > after]
        rows = rows[:min(limit or 100, 100)]
        out = b"".join(ld(1, ld(1, b58dec(r[0])) + ld(2, b"".join(ld(1, b58dec(x)) for x in r[1]) + vi(2, 1) + vi(3, 1) + vi(4, r[2]))) for r in rows)
        return {"result": B64(out)} if out else {}
    raise ValueError("unknown method " + method)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        node = self.path.strip("/") or "a"
        try: body = {"jsonrpc": "2.0", "id": req.get("id"), "result": answer(node, req["method"], req.get("params") or {})}
        except Exception as e: body = {"jsonrpc": "2.0", "id": req.get("id"), "error": {"code": -1, "message": str(e)}}
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
open(PORTFILE + ".tmp", "w").write(str(srv.server_address[1]))
import os; os.replace(PORTFILE + ".tmp", PORTFILE)
srv.serve_forever()
