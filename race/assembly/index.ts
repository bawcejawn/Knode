import { System, Protobuf, authority } from "@koinos/sdk-as";
import { Race as ContractClass } from "./Race";
import { race as ProtoNamespace } from "./proto/race";

export function main(): i32 {
  const contractArgs = System.getArguments();
  let retbuf = new Uint8Array(1024);

  const c = new ContractClass();

  switch (contractArgs.entry_point) {
    case 0x8ce33c6c: {
      const args = Protobuf.decode<ProtoNamespace.pick_arguments>(
        contractArgs.args,
        ProtoNamespace.pick_arguments.decode
      );
      const res = c.pick(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.empty_object.encode);
      break;
    }

    case 0xf360e6e3: {
      const args = Protobuf.decode<ProtoNamespace.get_pick_arguments>(
        contractArgs.args,
        ProtoNamespace.get_pick_arguments.decode
      );
      const res = c.get_pick(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.get_pick_result.encode);
      break;
    }

    case 0x7e3e9f30: {
      const args = Protobuf.decode<ProtoNamespace.list_picks_arguments>(
        contractArgs.args,
        ProtoNamespace.list_picks_arguments.decode
      );
      const res = c.list_picks(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.list_picks_result.encode);
      break;
    }

    case 0x49afbb7a: {
      const args = Protobuf.decode<ProtoNamespace.get_usage_arguments>(
        contractArgs.args,
        ProtoNamespace.get_usage_arguments.decode
      );
      const res = c.get_usage(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.get_usage_result.encode);
      break;
    }

    case 0xbc4fcdd4: {
      const args = Protobuf.decode<ProtoNamespace.get_config_arguments>(
        contractArgs.args,
        ProtoNamespace.get_config_arguments.decode
      );
      const res = c.get_config(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.config.encode);
      break;
    }

    case 0x4ba58c89: {
      const args = Protobuf.decode<ProtoNamespace.set_config_arguments>(
        contractArgs.args,
        ProtoNamespace.set_config_arguments.decode
      );
      const res = c.set_config(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.empty_object.encode);
      break;
    }

    default:
      System.exit(1);
      break;
  }

  System.exit(0, retbuf);
  return 0;
}

main();
