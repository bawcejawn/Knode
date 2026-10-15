// The token contract interface (KOIN and VHP), used for approvals before deposits. Same as probes/scripts/abi.ts.
const ADDR = { "(koinos.btype)": "ADDRESS" };
const U64 = { jstype: "JS_STRING" };
const f = (id: number, type: string, options?: object) => (options ? { type, id, options } : { type, id });

export const tokenAbi = {
  methods: {
    balance_of: { entry_point: 0x5c721497, argument: "token.balance_of_arguments", return: "token.balance_of_result", read_only: true },
    allowance:  { entry_point: 0x32f09fa1, argument: "token.allowance_arguments",  return: "token.allowance_result",  read_only: true },
    transfer:   { entry_point: 0x27f576ca, argument: "token.transfer_arguments",   return: "token.transfer_result",   read_only: false },
    approve:    { entry_point: 0x74e21680, argument: "token.approve_arguments",    return: "token.approve_result",    read_only: false },
  },
  koilib_types: {
    nested: {
      token: {
        nested: {
          balance_of_arguments: { fields: { owner: f(1, "bytes", ADDR) } },
          balance_of_result: { fields: { value: f(1, "uint64", U64) } },
          allowance_arguments: { fields: { owner: f(1, "bytes", ADDR), spender: f(2, "bytes", ADDR) } },
          allowance_result: { fields: { value: f(1, "uint64", U64) } },
          transfer_arguments: { fields: { from: f(1, "bytes", ADDR), to: f(2, "bytes", ADDR), value: f(3, "uint64", U64) } },
          transfer_result: { fields: {} },
          approve_arguments: { fields: { owner: f(1, "bytes", ADDR), spender: f(2, "bytes", ADDR), value: f(3, "uint64", U64) } },
          approve_result: { fields: {} },
        },
      },
    },
  },
};
