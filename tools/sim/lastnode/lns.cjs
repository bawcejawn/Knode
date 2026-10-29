require("../../../site/race-math.js");
const M = globalThis.KRaceMath;
const w = require(require("path").resolve(process.env.RACE_W || "W001.json"));
let card=null; for (const r of w.races) for (const c of (r.cards||[])) if (c) card=c;
const all = card.field.map(f=>({a:f.a, kh:f.k/6}));   // expected blocks per hour
const H = (k,kTop,c)=> (kTop/k)*(1-c/Math.sqrt(k))/(1-c/Math.sqrt(kTop));
// simulate one event; mode "sofar" | "hour"; window k for handicap = expected per hour (hour) or per hours-so-far (sofar uses hourly k too)
function event(ks, hs, mode, R, rel) {
  const n=ks.length, alive=new Set([...Array(n).keys()]), cum=new Float64Array(n), raw=new Float64Array(n), order=[];
  while (alive.size>1) {
    const hr=new Float64Array(n), hraw=new Float64Array(n);
    for (const i of alive){ const b=R.poisson(ks[i]*(rel?rel[i]:1)); hraw[i]=b; hr[i]=b*hs[i]; cum[i]+=b*hs[i]; raw[i]+=b; }
    let worst=null;
    for (const i of alive){ const s = mode==="sofar"?cum[i]:hr[i], r= mode==="sofar"?raw[i]:hraw[i];
      if (worst===null) {worst=i;continue}
      const ws = mode==="sofar"?cum[worst]:hr[worst], wr= mode==="sofar"?raw[worst]:hraw[worst];
      if (s<ws-1e-9 || (Math.abs(s-ws)<=1e-9 && (r<wr || (r===wr && R.next()<0.5)))) worst=i; }
    alive.delete(worst); order.push(worst);
  }
  order.push([...alive][0]); return order; // order[0] first out ... last = winner
}
function run(field, c, mode, trials=20000, seed=7, rel=null) {
  const ks=field.map(f=>f.kh), kTop=Math.max(...ks), hs=ks.map(k=>H(k,kTop,c)), R=M.rng(seed), n=ks.length;
  const win=new Array(n).fill(0), place=new Array(n).fill(0);
  for (let t=0;t<trials;t++){ const o=event(ks,hs,mode,R,rel); win[o[n-1]]++; o.forEach((i,p)=>place[i]+=p); }
  return {win:win.map(x=>x/trials), surv:place.map(x=>x/trials)};
}
function spread(r){ const f=1/r.win.length; return {min:Math.min(...r.win), max:Math.max(...r.win), rmse:Math.sqrt(r.win.reduce((s,x)=>s+(x-f)**2,0)/r.win.length)}; }
module.exports={all,run,spread,H,event,M};
if (require.main===module){
  for (const thr of [30,20,10]) {
    const field=all.filter(f=>f.kh>=thr);
    console.log(`\n=== field >= ${thr}/h : ${field.length} nodes (${field.map(f=>f.kh.toFixed(0)).join(",")}) ===`);
    for (const mode of ["sofar","hour"]) {
      let best=null; const rows=[];
      for (let c=-1; c<=2.5+1e-9; c+=0.1){ const cc=Math.round(c*10)/10; if (cc>=Math.sqrt(Math.min(...field.map(f=>f.kh)))*0.8) break;
        const s=spread(run(field,cc,mode,8000,11)); rows.push([cc,s]); if(!best||s.rmse<best[1].rmse) best=[cc,s]; }
      const s0=rows.find(r=>r[0]===0)[1], s2=rows.find(r=>r[0]===0.2);
      console.log(mode.padEnd(6),"c=0:",(s0.min*100).toFixed(1)+"–"+(s0.max*100).toFixed(1)+"%", s2? " c=0.2: "+(s2[1].min*100).toFixed(1)+"–"+(s2[1].max*100).toFixed(1)+"%":"", " best c="+best[0]+": "+(best[1].min*100).toFixed(1)+"–"+(best[1].max*100).toFixed(1)+"%");
    }
  }
}
