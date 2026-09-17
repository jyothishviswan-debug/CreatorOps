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
import { CAMPAIGNS_COLLECTIONS } from "@/server/campaigns/firestore";
import { seedCampaignsData } from "@/server/campaigns/seed-campaigns-data";
import { DISCOVERY_COLLECTIONS } from "@/server/discovery/firestore";
import { seedDiscoveryData } from "@/server/discovery/seed-discovery-data";
import { PARTNERS_COLLECTIONS } from "@/server/partners/firestore";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { RESTRICTED_FINANCIAL_IDENTITIES_COLLECTION } from "@/server/shared/restricted-financial-identity";
import { VENDORS_COLLECTIONS } from "@/server/vendors/firestore";
import { seedVendorsData } from "@/server/vendors/seed-vendors-data";

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

async function deleteCollection(collectionRef: FirebaseFirestore.CollectionReference): Promise<void> {
  const db = getAdminFirestore();
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

// leads/{uid}/events is a subcollection - deleting a lead's own document
// does NOT cascade-delete it (Firestore never cascades), so each lead's
// events must be deleted explicitly before (or regardless of) the lead
// document itself, or they'd linger as orphaned, inaccessible-via-list
// data and break "produces the same baseline on every test run".
async function deleteLeadsCollectionWithEvents(): Promise<void> {
  const db = getAdminFirestore();
  const leadsRef = db.collection(DISCOVERY_COLLECTIONS.leads);
  for (;;) {
    const snapshot = await leadsRef.limit(200).get();
    if (snapshot.empty) return;
    for (const doc of snapshot.docs) {
      await deleteCollection(doc.ref.collection(DISCOVERY_COLLECTIONS.leadEvents));
    }
    const batch = db.batch();
    for (const doc of snapshot.docs) batch.delete(doc.ref);
    await batch.commit();
  }
}

// partners/{uid}/events is a subcollection - same cascade concern as
// leads/{uid}/events (see deleteLeadsCollectionWithEvents above).
async function deletePartnersCollectionWithEvents(): Promise<void> {
  const db = getAdminFirestore();
  const partnersRef = db.collection(PARTNERS_COLLECTIONS.partners);
  for (;;) {
    const snapshot = await partnersRef.limit(200).get();
    if (snapshot.empty) return;
    for (const doc of snapshot.docs) {
      await deleteCollection(doc.ref.collection(PARTNERS_COLLECTIONS.partnerEvents));
    }
    const batch = db.batch();
    for (const doc of snapshot.docs) batch.delete(doc.ref);
    await batch.commit();
  }
}

// vendors/{uid}/events is a subcollection - same cascade concern as
// leads/{uid}/events and partners/{uid}/events above.
async function deleteVendorsCollectionWithEvents(): Promise<void> {
  const db = getAdminFirestore();
  const vendorsRef = db.collection(VENDORS_COLLECTIONS.vendors);
  for (;;) {
    const snapshot = await vendorsRef.limit(200).get();
    if (snapshot.empty) return;
    for (const doc of snapshot.docs) {
      await deleteCollection(doc.ref.collection(VENDORS_COLLECTIONS.vendorEvents));
    }
    const batch = db.batch();
    for (const doc of snapshot.docs) batch.delete(doc.ref);
    await batch.commit();
  }
}

// campaigns/{uid}/events is a subcollection - same cascade concern as
// leads/{uid}/events, partners/{uid}/events, and vendors/{uid}/events
// above.
async function deleteCampaignsCollectionWithEvents(): Promise<void> {
  const db = getAdminFirestore();
  const campaignsRef = db.collection(CAMPAIGNS_COLLECTIONS.campaigns);
  for (;;) {
    const snapshot = await campaignsRef.limit(200).get();
    if (snapshot.empty) return;
    for (const doc of snapshot.docs) {
      await deleteCollection(doc.ref.collection(CAMPAIGNS_COLLECTIONS.campaignEvents));
    }
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
  const db = getAdminFirestore();

  await deleteAllAuthUsers();
  for (const collectionName of Object.values(COLLECTIONS)) {
    await deleteCollection(db.collection(collectionName));
  }
  await deleteLeadsCollectionWithEvents();
  await deleteCollection(db.collection(DISCOVERY_COLLECTIONS.leadRestrictedKyc));
  await deletePartnersCollectionWithEvents();
  await deleteCollection(db.collection(PARTNERS_COLLECTIONS.partnerAccounts));
  await deleteCollection(db.collection(PARTNERS_COLLECTIONS.partnerAccountIdentityClaims));
  await deleteVendorsCollectionWithEvents();
  await deleteCollection(db.collection(VENDORS_COLLECTIONS.vendorPartnerLinks));
  await deleteCollection(db.collection(VENDORS_COLLECTIONS.vendorPartnerActiveClaims));
  // Step 8A.1: the one canonical, cross-domain restricted-identity
  // collection - covers both Partner and Vendor subjects, deleted once.
  await deleteCollection(db.collection(RESTRICTED_FINANCIAL_IDENTITIES_COLLECTION));
  await deleteCampaignsCollectionWithEvents();

  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  await seedDiscoveryData();
  await seedPartnersData();
  await seedVendorsData();
  await seedCampaignsData();
}
