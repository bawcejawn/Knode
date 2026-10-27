import { MockVM } from "@koinos/mock-vm";

// Runs the contract's tests inside a simulated Koinos chain (no network, no KOIN).
export default {
  entries: ["assembly/__tests__/**/*.spec.ts"],
  include: ["assembly/__tests__/**/*.include.ts"],
  disclude: [/node_modules/i],
  async instantiate(memory, createImports, instantiate, binary) {
    const mockVM = new MockVM();
    const myImports = {
      wasi_snapshot_preview1: { fd_write: () => {}, proc_exit: () => {} },
      env: { ...mockVM.getImports() },
    };
    const instance = instantiate(binary, createImports(myImports));
    instance.then((result) => {
      // Reserve plenty of memory up front: the test runtime never frees, and the simulated chain keeps views of the
      // memory that a later grow would invalidate.
      result.exports.memory.grow(2048);
      mockVM.setInstance(result);
    });
    return instance;
  },
  coverage: [],
  outputBinary: false,
};
