// Tests must never touch the network (CLAUDE.md rule 5). Any code path that
// reaches the global fetch instead of an injected fake fails loudly.
globalThis.fetch = (() =>
  Promise.reject(new Error('Network access is disabled in tests: inject a fake fetch instead.')));
