import { randomUUID } from "node:crypto";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { COLLECTIONS } from "@/server/authz/firestore";
import { scopeGrantDocId } from "@/server/authz/scope";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext, ScopeGrant, ScopeGrantInput } from "@/server/authz/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { partnerAccountIdentityClaimsCollection, partnerAccountsCollection, partnersCollection } from "@/server/partners/firestore";
import { claimIdFor } from "@/server/partners/identity";
import { partnerDocSchema, type PartnerDoc } from "@/server/partners/types";
import { restrictedFinancialIdentitiesCollection, restrictedFinancialIdentityDocSchema, restrictedIdentityDocId } from "@/server/shared/restricted-financial-identity";
import { vendorPartnerLinksCollection, vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema, type VendorDoc } from "@/server/vendors/types";

import { agreementClaimId, financeAgreementClaimsCollection, financeAgreementsCollection } from "@/server/finance-agreements/firestore";
import { onboardingAgreementClientRequestId, onboardingLedgerId } from "@/server/finance-agreements/onboarding-ledger";
import type { FinanceAgreementsErrorResult, FinanceAgreementsServiceResult } from "@/server/finance-agreements/types";

// Step 14B.1 test support (test-only): a hermetic harness for the onboarding emulator suites. It lives outside src/server/finance-agreements on
// purpose: the Finance query audit (firestore-indexes.test.ts) scans every non-test file of that module, and this file's teardown sweep uses
// `in` / multi-step queries that are test-only cleanup, not module queries.
//
// Every actor's scope is a per-run PRIVATE region; every name / email / phone / handle is unique per run and per call; nothing is asserted about
// whole-collection sizes. Everything an actor CREATED (Partners, Accounts and their identity claims, Vendors, restricted identity docs, owning
// event sub-collections, Agreements and their claims, onboarding ledgers) is swept at teardown by the actor's userRef, plus every fixture the
// harness seeded directly.

export type Role = ActorContext["role"];

export function must<T>(result: FinanceAgreementsServiceResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}${result.blockers ? ` ${JSON.stringify(result.blockers)}` : ""}`);
  return result.data;
}

export function failed<T>(result: FinanceAgreementsServiceResult<T>): FinanceAgreementsErrorResult {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.data).slice(0, 300)}`);
  return result;
}

export function blockerCodes(result: FinanceAgreementsErrorResult): string[] {
  return (result.blockers ?? []).map((blocker) => blocker.code);
}

export type OnboardingHarness = Awaited<ReturnType<typeof createOnboardingHarness>>;

export async function createOnboardingHarness(prefix: string) {
  const runId = Date.now();
  const R_IN = `${prefix}-in-${runId}`;
  const R_OUT = `${prefix}-out-${runId}`;
  const TAG = `${prefix.toUpperCase()}${runId}`;

  const uidByRole = new Map<string, string>();
  const actorRefs: string[] = [];
  const actorUids: string[] = [];
  const grantDocIds: string[] = [];
  const overrideDocIds: string[] = [];
  const cleanupRefs: FirebaseFirestore.DocumentReference[] = [];
  const sweepAgreementRefs: string[] = [];
  const claimIds: string[] = [];
  let counter = 0;

  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  const auth = getAdminAuth();
  for (const identity of TEST_IDENTITIES) uidByRole.set(identity.role, (await auth.getUserByEmail(identity.email)).uid);

  async function seededActor(role: string): Promise<ActorContext> {
    const actor = await resolveActor(uidByRole.get(role)!);
    if (!actor) throw new Error(`no seeded actor for ${role}`);
    return actor;
  }

  // A synthetic actor: the ROLE's real feature / action / sensitive grants, a scope made of exactly the grants named here, and (optionally) a
  // per-user override that removes named owning actions - the proof that grants, not roles, decide.
  async function actor(role: Role, options: { grants?: ScopeGrantInput[]; override?: Record<string, unknown> } = {}): Promise<ActorContext> {
    counter += 1;
    const uid = `${prefix}-${role}-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
    const grantedAt = new Date().toISOString();
    for (const input of options.grants ?? [{ type: "REGION", region: R_IN }]) {
      const id = scopeGrantDocId(uid, input);
      await getAdminFirestore()
        .collection(COLLECTIONS.scopeAssignments)
        .doc(id)
        .set({ ...input, uid, grantedAt, grantedBy: `${prefix}-test` } as ScopeGrant);
      grantDocIds.push(id);
    }
    if (options.override) {
      await getAdminFirestore().collection(COLLECTIONS.userAccessOverrides).doc(uid).set({ uid, version: 1, features: options.override });
      overrideDocIds.push(uid);
    }
    const created: ActorContext = { uid, email: `${uid}@example.test`, role, displayName: `${prefix} ${role}`, userRef: `${prefix}-ref-${uid}` };
    actorRefs.push(created.userRef);
    actorUids.push(uid);
    return created;
  }

  // --- Unique values --------------------------------------------------------------------------------------------------------------
  const next = () => (counter += 1);
  const uniqueName = (label: string) => `${TAG} ${label} ${next()}`;
  const uniqueEmail = () => `onb-${runId}-${next()}@Example.test`;
  const uniquePhone = () => `+91 9${String(runId).slice(-5)} ${String(10000 + next()).slice(-5)}`;
  const uniqueHandle = (label = "h") => `${label}_${runId}_${next()}`;
  const uniqueClientRequestId = () => `onb-${runId}-${next()}-${randomUUID().slice(0, 8)}`;

  // --- Direct fixtures (an existing record made outside the onboarding) ------------------------------------------------------
  async function seedPartner(over: { regionIds?: string[]; name?: string; email?: string | null; phone?: string | null } = {}): Promise<PartnerDoc> {
    const uid = `${prefix}-partner-${runId}-${next()}-${randomUUID().slice(0, 6)}`;
    const now = new Date().toISOString();
    const displayName = over.name ?? uniqueName("Seed Partner");
    const partner = partnerDocSchema.parse({
      uid,
      partnerRef: `ref-${uid}`,
      version: 1,
      displayName,
      displayNameLower: displayName.toLowerCase(),
      legalName: null,
      email: over.email === undefined ? `seed-${next()}@example.test` : over.email,
      phone: over.phone === undefined ? null : over.phone,
      status: "ACTIVE",
      regionIds: over.regionIds ?? [R_IN],
      teamIds: [],
      ownerUid: null,
      createdAt: now,
      createdByUserRef: `${prefix}-seed`,
      updatedAt: now,
      updatedByUserRef: `${prefix}-seed`,
    });
    const ref = partnersCollection().doc(uid);
    await ref.set(partner);
    cleanupRefs.push(ref);
    return partner;
  }

  async function seedVendor(over: { regionIds?: string[]; name?: string; email?: string | null; phone?: string | null } = {}): Promise<VendorDoc> {
    const uid = `${prefix}-vendor-${runId}-${next()}-${randomUUID().slice(0, 6)}`;
    const now = new Date().toISOString();
    const displayName = over.name ?? uniqueName("Seed Vendor");
    const vendor = vendorDocSchema.parse({
      uid,
      vendorRef: `ref-${uid}`,
      version: 1,
      displayName,
      displayNameLower: displayName.toLowerCase(),
      vendorType: "AGENCY",
      email: over.email === undefined ? `seed-${next()}@example.test` : over.email,
      phone: over.phone === undefined ? null : over.phone,
      status: "ACTIVE",
      regionIds: over.regionIds ?? [R_IN],
      createdAt: now,
      createdByUserRef: `${prefix}-seed`,
      updatedAt: now,
      updatedByUserRef: `${prefix}-seed`,
    });
    const ref = vendorsCollection().doc(uid);
    await ref.set(vendor);
    cleanupRefs.push(ref);
    return vendor;
  }

  // A restricted identity document with exactly the parts named (invented values), plus evidence of the named types.
  async function seedRestrictedIdentity(subject: { type: "PARTNER" | "VENDOR"; uid: string; ref: string }, parts: { pan?: boolean; aadhaar?: boolean; bank?: boolean; gst?: "number" | "applicable_no_number" | "not_applicable"; evidence?: Array<"pan" | "aadhaar" | "gst" | "bank" | "other"> } = {}) {
    const now = new Date().toISOString();
    const doc = restrictedFinancialIdentityDocSchema.parse({
      uid: restrictedIdentityDocId(subject.type, subject.uid),
      subjectType: subject.type,
      subjectRef: subject.ref,
      version: 1,
      pan: parts.pan ? { number: "QWERT4321Z" } : null,
      aadhaar: parts.aadhaar ? { number: "234123412346" } : null,
      gst: parts.gst === "number" ? { applicable: true, number: "27QWERT4321Z1Z9" } : parts.gst === "applicable_no_number" ? { applicable: true } : parts.gst === "not_applicable" ? { applicable: false } : null,
      bank: parts.bank ? { accountHolderName: "Zed Holder Name", accountNumber: "998877665544", ifsc: "TEST0009876", bankName: "Secret Bank Of Tests", branchName: "Test Branch" } : null,
      evidence: (parts.evidence ?? []).map((docType) => ({ docType, kind: "link", url: "https://example.test/secret-evidence-link", fileName: `secret-${docType}-scan.pdf`, addedAt: now, addedByUserRef: `${prefix}-seed` })),
      updatedAt: now,
      updatedByUserRef: `${prefix}-seed`,
    });
    const ref = restrictedFinancialIdentitiesCollection().doc(doc.uid);
    await ref.set(doc);
    cleanupRefs.push(ref);
  }

  // Registers an idempotent onboarding request made by `actor` so its ledger and derived Agreement claim are swept.
  function trackRequest(forActor: ActorContext, clientRequestId: string) {
    const ledgerId = onboardingLedgerId(forActor.uid, clientRequestId);
    claimIds.push(ledgerId, agreementClaimId(forActor.uid, onboardingAgreementClientRequestId(ledgerId)));
  }

  function trackAgreement(ref: string) {
    sweepAgreementRefs.push(ref);
  }
  function trackClaim(id: string) {
    claimIds.push(id);
  }

  // --- Teardown -------------------------------------------------------------------------------------------------------------------
  async function inChunks<T>(values: T[], run: (chunk: T[]) => Promise<void>) {
    for (let index = 0; index < values.length; index += 30) await run(values.slice(index, index + 30));
  }

  async function teardown() {
    const db = getAdminFirestore();
    const refs = [...new Set(actorRefs)];
    await inChunks(refs, async (chunk) => {
      // Accounts an actor created on a directly-seeded Partner (the Partner itself is removed with the seeded fixtures), and their identity claims.
      const strayAccounts = await partnerAccountsCollection().where("createdByUserRef", "in", chunk).get();
      for (const account of strayAccounts.docs) {
        const identity = account.data().normalizedIdentity as string | undefined;
        if (identity) await partnerAccountIdentityClaimsCollection().doc(claimIdFor(identity)).delete();
        await account.ref.delete();
      }
      const partners = await partnersCollection().where("createdByUserRef", "in", chunk).get();
      for (const doc of partners.docs) {
        const partnerRef = doc.data().partnerRef as string;
        const accounts = await partnerAccountsCollection().where("partnerRef", "==", partnerRef).get();
        for (const account of accounts.docs) {
          const identity = account.data().normalizedIdentity as string | undefined;
          if (identity) await partnerAccountIdentityClaimsCollection().doc(claimIdFor(identity)).delete();
          await account.ref.delete();
        }
        await restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("PARTNER", doc.id)).delete();
        await db.recursiveDelete(doc.ref);
      }
      const vendors = await vendorsCollection().where("createdByUserRef", "in", chunk).get();
      for (const doc of vendors.docs) {
        const links = await vendorPartnerLinksCollection().where("vendorRef", "==", doc.data().vendorRef).get();
        for (const link of links.docs) await link.ref.delete();
        await restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("VENDOR", doc.id)).delete();
        await db.recursiveDelete(doc.ref);
      }
      const agreements = await financeAgreementsCollection().where("createdByUserRef", "in", chunk).get();
      for (const doc of agreements.docs) await db.recursiveDelete(doc.ref);
    });
    for (const ref of sweepAgreementRefs.splice(0)) await db.recursiveDelete(financeAgreementsCollection().doc(ref));
    await Promise.all(claimIds.splice(0).map((id) => financeAgreementClaimsCollection().doc(id).delete()));
    await Promise.all(cleanupRefs.splice(0).map((ref) => ref.delete()));
    await Promise.all(grantDocIds.splice(0).map((id) => db.collection(COLLECTIONS.scopeAssignments).doc(id).delete()));
    await Promise.all(overrideDocIds.splice(0).map((id) => db.collection(COLLECTIONS.userAccessOverrides).doc(id).delete()));
  }

  return { runId, R_IN, R_OUT, TAG, seededActor, actor, uniqueName, uniqueEmail, uniquePhone, uniqueHandle, uniqueClientRequestId, seedPartner, seedVendor, seedRestrictedIdentity, trackRequest, trackAgreement, trackClaim, teardown, actorRefs, actorUids };
}
