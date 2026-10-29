import { Provider, Contract } from "koilib";
import fs from "node:fs";
const p = new Provider(["https://api.koinos.io"]);
const abi = JSON.parse(fs.readFileSync("game/abi/kpred.koilib.json", "utf8"));
const g = new Contract({ id: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", abi, provider: p }).functions as any;
try {
  const s = (await g.get_state({})).result;
  const c = s.config ?? {};
  console.log(`::warning::reward_rule_week_plus_one=${c.reward_rule_week_plus_one} scorer_rule=${c.scorer_rule_week_plus_one} weeks_closed=${s.weeks_closed} now=${s.time}`);
  console.log(`::warning::config keys ${Object.keys(c).join(",").slice(0, 600)}`);
} catch (e: any) { console.log("::warning::ERR " + e.message); }
