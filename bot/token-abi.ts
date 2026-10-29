// The token contract interface (KOIN and VHP), used for approvals before deposits, and the Proof-of-Burn system
// contract's (burning KOIN into VHP, reading a producer's registered key).
const ADDR = { "(koinos.btype)": "ADDRESS" };
const U64 = { jstype: "JS_STRING" };
const B64 = { "(koinos.btype)": "BASE64" };
const f = (id: number, type: string, options?: object) => (options ? { type, id, options } : { type, id });

export const tokenAbi = {
  methods: {
    balance_of: { entry_point: 0x5c721497, argument: "token.balance_of_arguments", return: "token.balance_of_result", read_only: true },
    // VHP only (koinos-contracts-as contracts/vhp): the balance block production uses; added VHP counts after 20 blocks.
    effective_balance_of: { entry_point: 0x629f31e6, argument: "token.balance_of_arguments", return: "token.balance_of_result", read_only: true },
    allowance:  { entry_point: 0x32f09fa1, argument: "token.allowance_arguments",  return: "token.allowance_result",  read_only: true },
    transfer:   { entry_point: 0x27f576ca, argument: "token.transfer_arguments",   return: "token.transfer_result",   read_only: false },
    approve:    { entry_point: 0x74e21680, argument: "token.approve_arguments",    return: "token.approve_result",    read_only: false },
    total_supply: { entry_point: 0xb0da3934, argument: "token.total_supply_arguments", return: "token.total_supply_result", read_only: true },
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
          total_supply_arguments: { fields: {} },
          total_supply_result: { fields: { value: f(1, "uint64", U64) } },
        },
      },
    },
  },
};

export const pobAbi = {
  methods: {
    burn:           { entry_point: 0x859facc5, argument: "pob.burn_arguments",           return: "pob.burn_result",           read_only: false },
    get_public_key: { entry_point: 0x96634f68, argument: "pob.get_public_key_arguments", return: "pob.get_public_key_result", read_only: true },
  },
  koilib_types: {
    nested: {
      pob: {
        nested: {
          burn_arguments: { fields: { token_amount: f(1, "uint64", U64), burn_address: f(2, "bytes", ADDR), vhp_address: f(3, "bytes", ADDR) } },
          burn_result: { fields: {} },
          get_public_key_arguments: { fields: { producer: f(1, "bytes", ADDR) } },
          get_public_key_result: { fields: { value: f(1, "bytes", B64) } },
        },
      },
    },
  },
};
