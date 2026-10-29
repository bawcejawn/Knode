const {all,run}=require("./lns.cjs");
const field=all.filter(f=>f.kh>=30), n=field.length;
for (const c of [0,0.2,0.4]) { const r=run(field,c,"sofar",20000,3);
  const pts=r.surv.map((s,i)=>s+5*r.win[i]);
  console.log(`c=${c} win%:`,r.win.map(x=>(x*100).toFixed(1)).join(" "),"| exp pts (no jump):",pts.map(x=>x.toFixed(2)).join(" "));}
// reliability from real recent blocks vs card VHP share
const b=require(require("path").resolve(process.env.RECENT || "recent-blocks.json")); const cnt=new Map(); b.sig.forEach(i=>cnt.set(b.signers[i],(cnt.get(b.signers[i])||0)+1));
const w=require(require("path").resolve(process.env.RACE_W || "W001.json")); let card; for(const r of w.races) for(const c of (r.cards||[])) if(c) card=c;
const totV=[...card.field,...card.paddock].reduce((s,f)=>s+f.vhp,0), N=b.sig.length;
const rel=field.map(f=>{const v=card.field.find(x=>x.a===f.a).vhp; return (cnt.get(f.a)||0)/(N*v/totV)});
console.log("reliability (actual/expected, last ~2 days):",rel.map(x=>x.toFixed(2)).join(" "));
const r2=run(field,0.2,"sofar",20000,3,rel);
console.log("win% with real reliability:",r2.win.map(x=>(x*100).toFixed(1)).join(" "));
// strategy: pick most reliable vs random, points over a week (7 events)
const best=rel.indexOf(Math.max(...rel)); const pts=r2.surv.map((s,i)=>s+5*r2.win[i]);
console.log("exp pts/event: most-reliable pick",pts[best].toFixed(2)," average pick",(pts.reduce((a,b)=>a+b)/n).toFixed(2)," worst",Math.min(...pts).toFixed(2));
