// Step 14B.1: the LIVE-DRIVE GUARD. vitest.emulator.config.mts forwards .env.local (which can hold real
// Google credentials) into test workers, so anything that could reach Google Drive from a test run must
// refuse. This is deliberately a tiny standalone module with no imports: the real adapter, the resolver
// and the tests all consult the same predicate.
//
// A test run = NODE_ENV "test" (vitest sets it) or the VITEST flag. Browser E2E runs a real Next server
// (NODE_ENV development) and is never allowed to use real Drive either - it selects the explicit
// FINANCE_AGREEMENT_DRIVE_MODE=fake adapter instead.
export function isAutomatedTestRun(): boolean {
  return process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
}
