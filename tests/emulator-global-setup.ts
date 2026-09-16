// Step 5B.1A: runs exactly once before the whole `pnpm test:emulator`
// run (vitest's `globalSetup`, see vitest.emulator.config.mts) - wipes
// the emulator back to a known baseline before this run, the same way
// tests/e2e/auth.setup.ts does for Playwright. Without this, dynamically
// named users each *.emulator.test.ts file creates (dev-<runId>@...,
// lifecycle-<runId>@..., audit-<runId>@...) would otherwise accumulate
// across repeated runs, same problem this whole step is correcting.
export default async function setup(): Promise<void> {
  const { resetEmulatorTestState } = await import("../src/server/dev/emulator-reset");

  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) {
    throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local.");
  }

  await resetEmulatorTestState(password);
}
