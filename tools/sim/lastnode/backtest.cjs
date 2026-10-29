const {H,M}=require("./lns.cjs");
const zlib=require("zlib"),fs=require("fs");
const lines=zlib.gunzipSync(fs.readFileSync("process.argv[2] || "data/blocks-compact.csv.gz"")).toString().split("\n");
let signers,t=0; const ts=[],sg=[];
for(const L of lines){ if(!L)continue; if(L.startsWith("#signers")){signers=L.split(",").slice(1);continue} if(L.startsWith("#start")){t=+L.split(",")[2];continue}
  const [s,dt]=L.split(","); t+=+dt; ts.push(t); sg.push(+s); }
const HR=3600e3, DAY=24*HR; const lb=(x)=>{let lo=0,hi=ts.length;while(lo<hi){const m=(lo+hi)>>1; if(ts[m]<x)lo=m+1; else hi=m;}return lo};
function counts(a,b){const c=new Map(); for(let i=lb(a);i<lb(b);i++)c.set(sg[i],(c.get(sg[i])||0)+1); return c}
function calib(ks){ let best=null; for(let c=0;c<=1.5;c+=0.1){ if(c>=Math.sqrt(Math.min(...ks))*0.8)break; const kTop=Math.max(...ks), hs=ks.map(k=>H(k,kTop,c)), R=M.rng(5), win=new Array(ks.length).fill(0);
  const T=1500; for(let t=0;t<T;t++){ const n=ks.length, alive=new Set(ks.keys()), cum=new Float64Array(n);
    while(alive.size>1){ for(const i of alive)cum[i]+=R.poisson(ks[i])*hs[i]; let w=null; for(const i of alive) if(w===null||cum[i]<cum[w])w=i; alive.delete(w);} win[[...alive][0]]++; }
  const f=1/ks.length, e=win.reduce((s,x)=>s+(x/T-f)**2,0); if(!best||e<best.e)best={c:Math.round(c*10)/10,e}; } return best.c }
const start=Math.ceil(ts[0]/DAY)*DAY+4*DAY, end=ts[ts.length-1]-DAY;
const byRank={}, res=[]; let events=0;
for(let d=start; d<end; d+=DAY){
  const t0=d+14*HR, prior=counts(t0-3*DAY,t0), tot=[...prior.values()].reduce((a,b)=>a+b,0), bph=tot/72;
  const field=[...prior.entries()].map(([s,n])=>({s,kh:bph*n/tot})).filter(f=>f.kh>=30).sort((a,b)=>b.kh-a.kh);
  if(field.length<4)continue;
  const ks=field.map(f=>f.kh), c=calib(ks), kTop=ks[0], hs=ks.map(k=>H(k,kTop,c));
  const alive=new Set(field.keys()), cum=new Float64Array(field.length), raw=new Float64Array(field.length); let h=0; const order=[];
  while(alive.size>1){ const cc=counts(t0+h*HR,t0+(h+1)*HR); for(const i of alive){const b=cc.get(field[i].s)||0; raw[i]+=b; cum[i]+=b*hs[i];}
    let w=null; for(const i of alive) if(w===null||cum[i]<cum[w]-1e-9||(Math.abs(cum[i]-cum[w])<=1e-9&&raw[i]<raw[w]))w=i; alive.delete(w); order.push(w); h++; }
  const win=[...alive][0]; events++; const n=field.length; byRank[n]=byRank[n]||{n:0,w:new Array(n).fill(0)}; byRank[n].n++; byRank[n].w[win]++;
  res.push({day:new Date(d).toISOString().slice(0,10),n,c,winRank:win+1, firstOut: order[0]+1});
}
console.log("events",events, "from",res[0].day,"to",res[res.length-1].day);
for(const [n,v] of Object.entries(byRank)) console.log(`field ${n}: ${v.n} events, wins by size rank (1=biggest):`, v.w.join(" "));
const fo={}; res.forEach(r=>fo[r.firstOut]=(fo[r.firstOut]||0)+1); console.log("first knocked out by size rank:",JSON.stringify(fo));
console.log("c used:", JSON.stringify(res.reduce((m,r)=>(m[r.c]=(m[r.c]||0)+1,m),{})));
