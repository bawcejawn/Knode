// Hand-written koilib ABIs for the probe contract and the two system contracts the probes touch.
// Entry points are the first 4 bytes of sha256(method name) — checked against the names below.

const ADDR = { "(koinos.btype)": "ADDRESS" };
const B64 = { "(koinos.btype)": "BASE64" };
const U64 = { jstype: "JS_STRING" };

const f = (id: number, type: string, options?: object) => (options ? { type, id, options } : { type, id });

export const kprobeAbi = {
  methods: {
    info:         { entry_point: 0x06271baf, argument: "kprobe.info_arguments",         return: "kprobe.info_result",         read_only: true },
    init:         { entry_point: 0xbb54068a, argument: "kprobe.init_arguments",         return: "kprobe.init_result",         read_only: false },
    deposit_vhp:  { entry_point: 0x8ed1d782, argument: "kprobe.deposit_vhp_arguments",  return: "kprobe.deposit_vhp_result",  read_only: false },
    deposit_koin: { entry_point: 0x1fca9c49, argument: "kprobe.deposit_koin_arguments", return: "kprobe.deposit_koin_result", read_only: false },
    withdraw_vhp: { entry_point: 0xc1610dbd, argument: "kprobe.withdraw_vhp_arguments", return: "kprobe.withdraw_vhp_result", read_only: false },
    compound:     { entry_point: 0xee0df97c, argument: "kprobe.compound_arguments",     return: "kprobe.compound_result",     read_only: false },
    register_key: { entry_point: 0xa4d25b41, argument: "kprobe.register_key_arguments", return: "kprobe.register_key_result", read_only: false },
    ping:         { entry_point: 0x758d61f2, argument: "kprobe.ping_arguments",         return: "kprobe.ping_result",         read_only: false },
    stress:       { entry_point: 0xf43dc879, argument: "kprobe.stress_arguments",       return: "kprobe.stress_result",       read_only: false },
    sweep:        { entry_point: 0xdfd33796, argument: "kprobe.sweep_arguments",        return: "kprobe.sweep_result",        read_only: false },
  },
  koilib_types: {
    nested: {
      kprobe: {
        nested: {
          info_arguments: { fields: {} },
          info_result: {
            fields: {
              contract: f(1, "bytes", ADDR), owner: f(2, "bytes", ADDR), koin: f(3, "bytes", ADDR),
              vhp: f(4, "bytes", ADDR), pob: f(5, "bytes", ADDR),
              koin_balance: f(6, "uint64", U64), vhp_balance: f(7, "uint64", U64), mana: f(8, "uint64", U64),
              head_height: f(9, "uint64", U64), credited_total: f(10, "uint64", U64), pings: f(11, "uint64", U64),
              producer_key: f(12, "bytes", B64),
            },
          },
          init_arguments: { fields: { owner: f(1, "bytes", ADDR) } },
          init_result: { fields: {} },
          deposit_vhp_arguments: { fields: { from: f(1, "bytes", ADDR), amount: f(2, "uint64", U64) } },
          deposit_vhp_result: { fields: { credited: f(1, "uint64", U64) } },
          deposit_koin_arguments: { fields: { from: f(1, "bytes", ADDR), amount: f(2, "uint64", U64) } },
          deposit_koin_result: { fields: { credited: f(1, "uint64", U64) } },
          withdraw_vhp_arguments: { fields: { to: f(1, "bytes", ADDR), amount: f(2, "uint64", U64) } },
          withdraw_vhp_result: { fields: {} },
          compound_arguments: { fields: { keep_reserve: f(1, "uint64", U64) } },
          compound_result: { fields: { burned: f(1, "uint64", U64), mana_before: f(2, "uint64", U64) } },
          register_key_arguments: { fields: { public_key: f(1, "bytes", B64) } },
          register_key_result: { fields: {} },
          ping_arguments: { fields: { note: f(1, "string") } },
          ping_result: { fields: { count: f(1, "uint64", U64), payer: f(2, "bytes", ADDR) } },
          stress_arguments: { fields: { writes: f(1, "uint32"), bins: f(2, "uint32") } },
          stress_result: { fields: { sum: f(1, "uint64", U64) } },
          sweep_arguments: { fields: {} },
          sweep_result: { fields: { koin: f(1, "uint64", U64), vhp: f(2, "uint64", U64) } },
        },
      },
    },
  },
};

// KOIN and VHP share the same token interface.
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
