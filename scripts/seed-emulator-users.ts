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
  const { seedAccessControlData } = await import("../src/server/authz/seed-access-data");
  const { seedDiscoveryData } = await import("../src/server/discovery/seed-discovery-data");
  const { seedPartnersData } = await import("../src/server/partners/seed-partners-data");
  const { seedVendorsData } = await import("../src/server/vendors/seed-vendors-data");

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

  // Access-control data (users/accessGrants/scopeAssignments/
  // sensitiveAccessGrants) depends on the Auth users above already existing.
  await seedAccessControlData();
  console.log("Seeded access-control data (users, accessGrants, scopeAssignments, sensitiveAccessGrants).");

  // Step 6A: a small, deterministic Discovery dataset (leads across every
  // lifecycle state, one converted Partner) - depends on the identities
  // above already existing.
  await seedDiscoveryData();
  console.log("Seeded Discovery data (leads across every lifecycle state, one converted Partner).");

  // Step 7A: a small, deterministic Partners dataset (every status,
  // multiple accounts, one restricted-identity subject) - depends on the
  // Discovery-converted Partner above already existing.
  await seedPartnersData();
  console.log("Seeded Partners data (every status, multiple Partner Accounts, one restricted-identity subject).");

  // Step 8A: a small, deterministic Vendors dataset (every status, M:N
  // relationship links including one ended historical link and one
  // payee relationship, one restricted-identity subject) - depends on
  // the Partners above already existing.
  await seedVendorsData();
  console.log("Seeded Vendors data (every status, Vendor<->Partner relationship links, one restricted-identity subject).");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
