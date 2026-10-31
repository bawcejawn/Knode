// The recorder narrates every run (fields set, hours recorded, ::warning:: lines for problems it retries). In these
// tests that is expected and checked through run()'s own `problems`, so the narration is muted to keep a clean run
// readable. LASTNODE_TEST_LOG=1 shows it again.
if (process.env.LASTNODE_TEST_LOG !== "1") console.log = () => {};
