import { System, Protobuf, authority } from "@koinos/sdk-as";
import { race } from "./proto/race";

export class Race {
  pick(args: race.pick_arguments): race.empty_object {
    // const player = args.player;
    // const race = args.race;
    // const horse = args.horse;

    // YOUR CODE HERE

    const res = new race.empty_object();

    return res;
  }

  get_pick(args: race.get_pick_arguments): race.get_pick_result {
    // const player = args.player;
    // const race = args.race;

    // YOUR CODE HERE

    const res = new race.get_pick_result();
    // res.pick = ;

    return res;
  }

  list_picks(args: race.list_picks_arguments): race.list_picks_result {
    // const race = args.race;
    // const start_after = args.start_after;
    // const limit = args.limit;

    // YOUR CODE HERE

    const res = new race.list_picks_result();
    // res.rows = ;

    return res;
  }

  get_usage(args: race.get_usage_arguments): race.get_usage_result {
    // const player = args.player;

    // YOUR CODE HERE

    const res = new race.get_usage_result();
    // res.day = ;
    // res.picks_today = ;
    // res.max_picks_per_day = ;

    return res;
  }

  get_config(args: race.get_config_arguments): race.config {
    // YOUR CODE HERE

    const res = new race.config();
    // res.owner = ;
    // res.enabled = ;
    // res.max_picks_per_day = ;

    return res;
  }

  set_config(args: race.set_config_arguments): race.empty_object {
    // const config = args.config;

    // YOUR CODE HERE

    const res = new race.empty_object();

    return res;
  }
}
