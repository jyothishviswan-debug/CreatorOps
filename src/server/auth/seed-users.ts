import { getAdminAuth } from "@/server/firebase/admin";
import { getServerEnv, isUsingEmulators } from "@/lib/env/server";

// Five canonical-role identities for local development/testing only. Step
// 4A implements "signed in or signed out" alone - these are not yet wired
// to any per-role authorization, but the emails double as a stable seam
// for that later step.
export const EMULATOR_TEST_USERS = [
  { email: "viewer@creatorops.com", displayName: "Viewer (Test)" },
  { email: "analyst@creatorops.com", displayName: "Analyst (Test)" },
  { email: "manager@creatorops.com", displayName: "Manager (Test)" },
  { email: "head@creatorops.com", displayName: "Head (Test)" },
  { email: "admin@creatorops.com", displayName: "Admin (Test)" },
] as const;

// Idempotent: safe to run repeatedly against a running emulator. Refuses
// to run against anything that isn't clearly an emulator, so this can
// never accidentally create accounts on a live Firebase project.
export async function seedEmulatorTestUsers(password: string): Promise<void> {
  if (!isUsingEmulators()) {
    throw new Error("seedEmulatorTestUsers: refusing to run - Firebase emulator env vars are not set.");
  }

  // Belt-and-suspenders: even with emulator routing active, a stray
  // .env.production.local value (loaded ahead of .env.local by a
  // standalone script that never got NODE_ENV=development) could still
  // point the *project id* at the live project's name inside the
  // emulator's own multi-project namespace. Refuse unless it's clearly
  // the local demo project.
  const { projectId } = getServerEnv();
  if (!projectId.startsWith("demo-")) {
    throw new Error(
      `seedEmulatorTestUsers: refusing to run - resolved project id "${projectId}" doesn't look like the local demo project. Check for a leaked .env.production.local value.`,
    );
  }

  const auth = getAdminAuth();

  for (const user of EMULATOR_TEST_USERS) {
    try {
      const existing = await auth.getUserByEmail(user.email);
      await auth.updateUser(existing.uid, {
        password,
        displayName: user.displayName,
        emailVerified: true,
        disabled: false,
      });
    } catch (error) {
      if (isUserNotFound(error)) {
        await auth.createUser({
          email: user.email,
          password,
          displayName: user.displayName,
          emailVerified: true,
        });
      } else {
        throw error;
      }
    }
  }
}

function isUserNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "auth/user-not-found";
}
