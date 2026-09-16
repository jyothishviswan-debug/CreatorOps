// Standalone CLI entry point: `pnpm seed:emulator`.
// Loads .env.local the same way Next.js does (see @next/env docs), then
// creates/updates the five deterministic local test users against the
// running Firebase Auth emulator. Refuses to run if emulator env vars
// aren't present - see seedEmulatorTestUsers's own guard.
//
// loadEnvConfig's `dev` parameter (not process.env.NODE_ENV) decides
// whether .env.production.local outranks .env.local; it defaults to
// "not dev" when omitted, same as `next build`. Passing `true` here is
// what makes this resolve emulator values instead of silently loading
// the live project - this is the exact hazard the Step 4A brief warns
// about ("do not use .env.production.local in emulator commands").
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true);

async function main() {
  const { seedEmulatorTestUsers, EMULATOR_TEST_USERS } = await import("../src/server/auth/seed-users");

  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) {
    console.error("Set EMULATOR_TEST_USER_PASSWORD in .env.local before running `pnpm seed:emulator`.");
    process.exit(1);
  }

  await seedEmulatorTestUsers(password);
  console.log(`Seeded ${EMULATOR_TEST_USERS.length} emulator test users:`);
  for (const user of EMULATOR_TEST_USERS) {
    console.log(`  - ${user.email}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
