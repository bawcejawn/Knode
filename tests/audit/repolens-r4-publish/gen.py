# Writes one record run's output (the shape bot/games/blockx.ts:run writes at cc524eb) into <out>/blockx/.
# usage: python3 -I gen.py <out> '<json spec>'
# spec: lw (last week), upd_h (hours after lw's end for board.updated), players [[addr, pts, ranked]],
#       prizes [[addr, place]] (lastWeek.prizes), vault: "honest" | null | {rows:[[a,p]], first:[], second:[]},
#       P: true -> write P<lw>.json from prizes; final (default true); vault_week (default lw)
import json, os, sys, datetime
GEN, WEEK = 1792368000000, 7 * 86400000
out, spec = sys.argv[1], json.loads(sys.argv[2])
d = os.path.join(out, "blockx"); os.makedirs(d, exist_ok=True)
lw = spec["lw"]; start = GEN + lw * WEEK; end = start + WEEK
upd = end + int(spec.get("upd_h", 13) * 3600000)
iso = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
pl = sorted(spec["players"], key=lambda r: (-r[1], r[0]))
def view(rows):
    out, place, prev = [], 0, None
    for i, (a, p, rk) in enumerate(rows):
        if prev is None or prev != p: place = i + 1
        prev = p
        out.append({"a": a, "place": place, "boardPlace": place, "pts": p, "correct": p // 5, "picks": 3, "days": 3, "lastCorrect": 100 if p else 0, "ranked": bool(rk)})
    return out
prizes = [{"player": a, "place": pl_, "vhp": 2 if pl_ == 1 else 1} for a, pl_ in spec.get("prizes", [])]
lastWeek = {"week": lw, "start": start, "final": spec.get("final", True), "rows": view(pl), "prizes": prizes}
board = {"v": 1, "updated": iso(upd), "today": {"day": iso(upd)[:10], "rows": []}, "week": {"week": lw + 1, "start": end, "rows": []}, "lastWeek": lastWeek, "allTime": {"rows": view(pl)}}
open(os.path.join(d, "board.json"), "w").write(json.dumps(board, separators=(",", ":")) + "\n")
open(os.path.join(d, "index.json"), "w").write(json.dumps({"v": 1, "updated": iso(upd), "weeks": [lw, lw + 1], "contract": None, "game": 2, "prizesFromWeek": None}, separators=(",", ":")) + "\n")
if spec.get("P"):
    open(os.path.join(d, "P%03d.json" % lw), "w").write(json.dumps({"v": 1, "week": lw, "game": 2, "at": iso(upd), "prizes": prizes}, separators=(",", ":")) + "\n")
v = spec.get("vault")
if v is not None:
    vw = spec.get("vault_week", lw)
    if v == "honest":
        staked = [r for r in view(pl) if r["ranked"] and r["pts"] > 0]
        pts, rows, last, cur = {}, [], None, 256
        for r in staked:
            if r["place"] != last: cur = max(1, cur - 1); last = r["place"]
            rows.append({"player": r["a"], "points": cur})
        first = sorted({x["player"] for x in prizes if x["place"] == 1})
        second = [] if len(first) >= 2 else sorted({x["player"] for x in prizes if x["place"] != 1})
        f = {"game": 2, "week": vw, "final": True, "rows": rows, "first": first, "second": second}
    else:
        f = {"game": 2, "week": vw, "final": True, "rows": [{"player": a, "points": p} for a, p in v["rows"]], "first": v["first"], "second": v["second"]}
    os.makedirs(os.path.join(d, "vault"), exist_ok=True)
    # JSON.stringify (no spaces) + "\n", like the recorder
    open(os.path.join(d, "vault", "W%d.json" % vw), "w").write(json.dumps(f, separators=(",", ":")) + "\n")
