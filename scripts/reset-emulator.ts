// Standalone CLI entry point: `pnpm reset:emulator`. Wipes every Auth
// account and Firestore collection this app writes to, then reseeds the
// canonical baseline - see resetEmulatorTestState's own doc comment for
// why this is destructive and deliberately not part of `pnpm dev`.
//
// Same env-loading approach as scripts/seed-emulator-users.ts - `dev:
// true` is what makes this resolve emulator values instead of silently
// loading the live project.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true);

async function main() {
  const { resetEmulatorTestState } = await import("../src/server/dev/emulator-reset");

  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) {
    console.error("Set EMULATOR_TEST_USER_PASSWORD in .env.local before running `pnpm reset:emulator`.");
    process.exit(1);
  }

  await resetEmulatorTestState(password);
  console.log("Emulator reset: Auth + Firestore wiped, canonical test identities and access-control data reseeded.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
