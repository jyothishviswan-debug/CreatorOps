// Step 5B.1A: deterministic emulator reset for automated test setup only.
// Repeated `pnpm test:e2e` / `pnpm test:emulator` runs each create their
// own throwaway users (provisioned users, lifecycle/audit dev users,
// etc.), and nothing previously cleaned those up between runs - a local
// emulator accumulates hundreds of stale accounts over time, which makes
// pagination/list-based assertions increasingly slow and non-deterministic.
//
// This wipes every Auth account and every Firestore collection this app
// writes to, then reseeds the five canonical test identities + canonical
// authorization data, so every automated test run starts from the exact
// same baseline. It is guarded the same way seedEmulatorTestUsers/
// seedAccessControlData already are (belt-and-suspenders, not redundant -
// this is far more destructive than either of those, so it re-checks
// independently rather than trusting a caller already checked), plus an
// extra check that the emulator hosts themselves are local addresses.
//
// Deliberately NOT wired into `pnpm dev` or `pnpm seed:emulator` - both
// of those must stay non-destructive for a developer's local session.
// Only automated-test entry points (tests/e2e/auth.setup.ts, the vitest
// emulator config's globalSetup) call this.
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { getServerEnv, isUsingEmulators } from "@/lib/env/server";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { COLLECTIONS } from "@/server/authz/firestore";
import { seedAccessControlData } from "@/server/authz/seed-access-data";

const LOCAL_HOST_PATTERN = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

function assertSafeToReset(): void {
  if (!isUsingEmulators()) {
    throw new Error("resetEmulatorTestState: refusing to run - Firebase emulator env vars are not set.");
  }

  const { projectId, authEmulatorHost, firestoreEmulatorHost } = getServerEnv();
  if (!projectId.startsWith("demo-")) {
    throw new Error(`resetEmulatorTestState: refusing to run - resolved project id "${projectId}" doesn't look like the local demo project.`);
  }

  const hosts = [authEmulatorHost, firestoreEmulatorHost].filter((host): host is string => Boolean(host));
  if (hosts.length === 0) {
    throw new Error("resetEmulatorTestState: refusing to run - no emulator host is configured.");
  }
  for (const host of hosts) {
    if (!LOCAL_HOST_PATTERN.test(host)) {
      throw new Error(`resetEmulatorTestState: refusing to run - emulator host "${host}" is not a local address.`);
    }
  }
}

async function deleteAllAuthUsers(): Promise<void> {
  const auth = getAdminAuth();
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    if (page.users.length > 0) {
      await auth.deleteUsers(page.users.map((user) => user.uid));
    }
    pageToken = page.pageToken;
  } while (pageToken);
}

async function deleteCollection(collectionName: string): Promise<void> {
  const db = getAdminFirestore();
  const collectionRef = db.collection(collectionName);
  // Bounded batches, repeated until empty - the same "never an unbounded
  // single operation" discipline every other bulk read/write in this
  // codebase follows, just applied to a delete instead of a list.
  for (;;) {
    const snapshot = await collectionRef.limit(500).get();
    if (snapshot.empty) return;
    const batch = db.batch();
    for (const doc of snapshot.docs) batch.delete(doc.ref);
    await batch.commit();
  }
}

// Wipes every Auth account and every Firestore collection this app
// writes to, then reseeds the canonical baseline. Idempotent in effect
// (running it twice in a row produces the same end state), but NOT a
// no-op like seedEmulatorTestUsers/seedAccessControlData are - it is
// destructive to whatever local emulator state existed before it, by
// design.
export async function resetEmulatorTestState(password: string): Promise<void> {
  assertSafeToReset();

  await deleteAllAuthUsers();
  for (const collectionName of Object.values(COLLECTIONS)) {
    await deleteCollection(collectionName);
  }

  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
}
