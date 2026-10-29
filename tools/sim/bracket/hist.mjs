// Producer Bracket: field size by week and all-pair fairness over the real block history. Run: node tools/sim/bracket/hist.mjs
import fs from "node:fs"; import zlib from "node:zlib";
const REPO = new URL("../../..", import.meta.url).pathname.replace(/\/$/, ""); await import(REPO+"/race-math.js"); const M=globalThis.KRaceMath;
const lines=zlib.gunzipSync(fs.readFileSync(REPO+"/data/blocks-compact.csv.gz")).toString().split("\n");
const S=lines[0].split(",").length-1; let t=Number(lines[1].split(",")[2]); const days=new Map();
for(let i=2;i<lines.length;i++){if(!lines[i])continue;const[s,dt]=lines[i].split(",");t+=Number(dt);const d=Math.floor(t/864e5);let m=days.get(d);if(!m)days.set(d,m=new Float64Array(S));m[+s]++;}
const dk=[...days.keys()].sort((a,b)=>a-b).slice(1,-1);
const sizes=[]; const buckets={}; 
for(let di=7;di<dk.length;di++){const tr=new Float64Array(S);for(let j=di-7;j<di;j++)days.get(dk[j]).forEach((v,s)=>tr[s]+=v);
 const td=days.get(dk[di]),ts=tr.reduce((a,b)=>a+b),ds=td.reduce((a,b)=>a+b);
 const o=[...tr.keys()].filter(s=>tr[s]/ts*ds/4>=10).sort((a,b)=>tr[b]-tr[a]); const k=o.map(s=>tr[s]/ts*ds);
 sizes.push([new Date(dk[di]*864e5).toISOString().slice(0,10),o.length]);
 const c=M.calibrate(k.map(x=>x/4),1000).c;
 for(let a=0;a<o.length;a++)for(let b=a+1;b<o.length;b++){const r=k[a]/k[b];const B=r<2?"ratio <2":r<10?"ratio 2-10":r<40?"ratio 10-40":"ratio 40+";
  const e=buckets[B]||(buckets[B]=[0,0,0]); e[0]+=td[o[a]]*(k[0]/k[a])>td[o[b]]*(k[0]/k[b]); const h=i=>M.handicapOf(k[i]/4,k[0]/4,c); e[1]+=td[o[a]]*h(a)>td[o[b]]*h(b); e[2]++;}}
console.log("Field size by week (first day of each week):"); for(let i=0;i<sizes.length;i+=7)console.log(" ",sizes[i][0],sizes.slice(i,i+7).map(x=>x[1]).join(" "));
console.log("All pairs, all days: bigger producer wins the day (fair 50%)");
for(const[B,e]of Object.entries(buckets))console.log(`  ${B.padEnd(12)} plain ${(100*e[0]/e[2]).toFixed(1)}%  race ${(100*e[1]/e[2]).toFixed(1)}%  n=${e[2]}`);
