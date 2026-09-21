// Step 14A - real reads against the running Firestore/Auth emulator (no mocks): the Finance Agreements gate.
// Proves feature/action/sensitive gating through the REAL seeded grants for all five roles, and that
// loadAuthorizedCounterparty / loadAuthorizedAgreement apply LIVE Record Scope (grants keyed by doc uid),
// derive platformScope server-side, and answer missing / out-of-scope / forged references identically.
//
// Hermetic by construction: every synthetic actor's ONLY scope is a per-run private REGION (plus, in a few
// tests, one explicit record/Partner grant); fixtures are private-region Partners/Accounts/Vendors/heads with
// unique ids; nothing asserts a whole-collection size; every fixture (and grant) is deleted afterwards.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { COLLECTIONS } from "@/server/authz/firestore";
import { scopeGrantDocId } from "@/server/authz/scope";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext, ScopeGrant, ScopeGrantInput } from "@/server/authz/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { partnerAccountsCollection, partnersCollection } from "@/server/partners/firestore";
import { partnerAccountDocSchema, partnerDocSchema, type PartnerDoc } from "@/server/partners/types";
import { vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema, type VendorDoc } from "@/server/vendors/types";

import { financeAgreementsCollection } from "./firestore";
import {
  loadAuthorizedAgreement,
  loadAuthorizedCounterparty,
  requireContractSensitiveAccess,
  requireFinanceAgreementsAccess,
  requireIdentitySensitiveAccess,
} from "./finance-agreements-gate";
import { generateAgreementRef } from "./ids";
import { agreementHeadDocSchema, type AgreementCounterparty } from "./types";

vi.setConfig({ testTimeout: 30_000 });

const runId = Date.now();
const R_IN = `fa-in-${runId}`;
const R_OUT = `fa-out-${runId}`;
const NEUTRAL = { ok: false, error: { ok: false, code: "not_found", message: "Not found." } };

const uidByRole = new Map<string, string>();
const cleanup: FirebaseFirestore.DocumentReference[] = [];
const grantDocIds: string[] = [];
let counter = 0;

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  const auth = getAdminAuth();
  for (const identity of TEST_IDENTITIES) uidByRole.set(identity.role, (await auth.getUserByEmail(identity.email)).uid);
}, 60_000);

afterAll(async () => {
  await Promise.all(cleanup.splice(0).map((ref) => ref.delete()));
  await Promise.all(grantDocIds.splice(0).map((id) => getAdminFirestore().collection(COLLECTIONS.scopeAssignments).doc(id).delete()));
});

// ---- Actors -----------------------------------------------------------------------------------------------------------
async function seededActor(role: string): Promise<ActorContext> {
  const actor = await resolveActor(uidByRole.get(role)!);
  if (!actor) throw new Error(`no seeded actor for ${role}`);
  return actor;
}

type Role = ActorContext["role"];

// A synthetic actor: the given ROLE's explicit feature/action/sensitive grants (accessGrants/{role}) + a scope made of
// exactly the grants named here (default: the private IN region) - nothing else.
async function syntheticActor(role: Role, grants: ScopeGrantInput[] = [{ type: "REGION", region: R_IN }]): Promise<ActorContext> {
  const uid = `fa-${role}-${runId}-${randomUUID().slice(0, 6)}`;
  const grantedAt = new Date().toISOString();
  for (const input of grants) {
    const id = scopeGrantDocId(uid, input);
    await getAdminFirestore()
      .collection(COLLECTIONS.scopeAssignments)
      .doc(id)
      .set({ ...input, uid, grantedAt, grantedBy: "fa-test" } as ScopeGrant);
    grantDocIds.push(id);
  }
  return { uid, email: `${uid}@example.test`, role, displayName: `FA ${role}`, userRef: `fa-ref-${uid}` };
}

// ---- Fixtures ----------------------------------------------------------------------------------------------------------
async function seedPartner(over: { regionIds?: string[]; ownerUid?: string | null } = {}): Promise<PartnerDoc> {
  counter += 1;
  const uid = `fa-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = `FA Partner ${counter} ${runId}`;
  const partner = partnerDocSchema.parse({
    uid,
    // A ref that differs from the uid, so "scope grants key on uid, not ref" is provable.
    partnerRef: `ref-${uid}`,
    version: 1,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    status: "ACTIVE",
    regionIds: over.regionIds ?? [R_IN],
    ownerUid: over.ownerUid ?? null,
    createdAt: now,
    createdByUserRef: "fa-test",
    updatedAt: now,
    updatedByUserRef: "fa-test",
  });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  cleanup.push(ref);
  return partner;
}

async function seedAccount(partner: PartnerDoc, platform: string) {
  counter += 1;
  const uid = `fa-account-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const account = partnerAccountDocSchema.parse({
    uid,
    partnerAccountRef: `ref-${uid}`,
    version: 1,
    partnerRef: partner.partnerRef,
    platform,
    normalizedIdentity: `${platform.trim().toLowerCase()}:${uid}`,
    status: "ACTIVE",
    createdAt: now,
    createdByUserRef: "fa-test",
    updatedAt: now,
    updatedByUserRef: "fa-test",
  });
  const ref = partnerAccountsCollection().doc(uid);
  await ref.set(account);
  cleanup.push(ref);
  return account;
}

async function seedVendor(over: { regionIds?: string[] } = {}): Promise<VendorDoc> {
  counter += 1;
  const uid = `fa-vendor-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = `FA Vendor ${counter} ${runId}`;
  const vendor = vendorDocSchema.parse({
    uid,
    vendorRef: `ref-${uid}`,
    version: 1,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    vendorType: "AGENCY",
    status: "ACTIVE",
    regionIds: over.regionIds ?? [R_IN],
    createdAt: now,
    createdByUserRef: "fa-test",
    updatedAt: now,
    updatedByUserRef: "fa-test",
  });
  const ref = vendorsCollection().doc(uid);
  await ref.set(vendor);
  cleanup.push(ref);
  return vendor;
}

async function seedHead(over: { counterparty: AgreementCounterparty; partnerUid?: string | null; vendorUid?: string | null; regionIds?: string[] }) {
  const agreementRef = generateAgreementRef();
  const now = new Date().toISOString();
  const head = agreementHeadDocSchema.parse({
    agreementRef,
    docVersion: 1,
    counterparty: over.counterparty,
    ownerUid: null,
    regionIds: over.regionIds ?? [],
    teamIds: [],
    partnerUid: over.partnerUid ?? null,
    vendorUid: over.vendorUid ?? null,
    status: "DRAFT",
    latestVersion: 1,
    openVersion: 1,
    createdAt: now,
    createdByUserRef: "fa-test",
    updatedAt: now,
    updatedByUserRef: "fa-test",
  });
  const ref = financeAgreementsCollection().doc(agreementRef);
  await ref.set(head);
  cleanup.push(ref);
  return head;
}

const partnerHead = (partner: PartnerDoc, over: { regionIds?: string[]; partnerUid?: string } = {}) =>
  seedHead({ counterparty: { type: "PARTNER", partnerRef: partner.partnerRef, partnerAccountRefs: [], platformScope: [] }, partnerUid: over.partnerUid ?? partner.uid, regionIds: over.regionIds });

// ---- Feature / action / sensitive gating through the REAL seeded grants -------------------------------------------------------
describe("requireFinanceAgreementsAccess - five roles, real grants", () => {
  it("unauthenticated -> not_authenticated", async () => {
    expect(await requireFinanceAgreementsAccess(null)).toEqual({ ok: false, reason: "not_authenticated" });
    expect(await requireFinanceAgreementsAccess(null, "manage_agreements")).toEqual({ ok: false, reason: "not_authenticated" });
  });

  it("Viewer and Analyst hold no Finance grant: denied at the feature layer for read AND every action", async () => {
    for (const role of ["viewer", "analyst"]) {
      const actor = await seededActor(role);
      expect(await requireFinanceAgreementsAccess(actor)).toEqual({ ok: false, reason: "feature_denied" });
      expect(await requireFinanceAgreementsAccess(actor, "manage_agreements")).toEqual({ ok: false, reason: "feature_denied" });
      expect(await requireFinanceAgreementsAccess(actor, "activate_agreements")).toEqual({ ok: false, reason: "feature_denied" });
    }
  });

  it("Manager: read + manage_agreements yes, activate_agreements NO (prepare/confirm, never make operational)", async () => {
    const manager = await seededActor("partnership_manager");
    expect(await requireFinanceAgreementsAccess(manager)).toEqual({ ok: true });
    expect(await requireFinanceAgreementsAccess(manager, "manage_agreements")).toEqual({ ok: true });
    expect(await requireFinanceAgreementsAccess(manager, "activate_agreements")).toEqual({ ok: false, reason: "action_denied" });
  });

  it("Head: read + manage_agreements + activate_agreements", async () => {
    const head = await seededActor("partnership_head");
    expect(await requireFinanceAgreementsAccess(head)).toEqual({ ok: true });
    expect(await requireFinanceAgreementsAccess(head, "manage_agreements")).toEqual({ ok: true });
    expect(await requireFinanceAgreementsAccess(head, "activate_agreements")).toEqual({ ok: true });
  });

  it("Super Admin holds both explicitly", async () => {
    const admin = await seededActor("super_admin");
    expect(await requireFinanceAgreementsAccess(admin, "manage_agreements")).toEqual({ ok: true });
    expect(await requireFinanceAgreementsAccess(admin, "activate_agreements")).toEqual({ ok: true });
  });

  it("finance_contracts and the owning identity category are independent of the ACTIONS: Manager (has manage_agreements) holds neither", async () => {
    const manager = await seededActor("partnership_manager");
    expect(await requireContractSensitiveAccess(manager)).toEqual({ ok: false, reason: "sensitive_denied" });
    expect(await requireIdentitySensitiveAccess(manager, "PARTNER")).toEqual({ ok: false, reason: "sensitive_denied" });
    expect(await requireIdentitySensitiveAccess(manager, "VENDOR")).toEqual({ ok: false, reason: "sensitive_denied" });
    for (const role of ["partnership_head", "super_admin"]) {
      const actor = await seededActor(role);
      expect(await requireContractSensitiveAccess(actor)).toEqual({ ok: true });
      expect(await requireIdentitySensitiveAccess(actor, "PARTNER")).toEqual({ ok: true });
      expect(await requireIdentitySensitiveAccess(actor, "VENDOR")).toEqual({ ok: true });
    }
    for (const role of ["viewer", "analyst"]) {
      const actor = await seededActor(role);
      expect(await requireContractSensitiveAccess(actor)).toEqual({ ok: false, reason: "sensitive_denied" });
      expect(await requireIdentitySensitiveAccess(actor, "PARTNER")).toEqual({ ok: false, reason: "sensitive_denied" });
    }
  });
});

// ---- loadAuthorizedCounterparty ---------------------------------------------------------------------------------------------
describe("loadAuthorizedCounterparty", () => {
  it("an in-scope Partner loads with its display name, a scope snapshot and no accounts", async () => {
    const partner = await seedPartner();
    const actor = await syntheticActor("partnership_manager");
    const result = await loadAuthorizedCounterparty(actor, { type: "PARTNER", partnerRef: partner.partnerRef });
    expect(result.ok).toBe(true);
    if (!result.ok || result.authorized.type !== "PARTNER") return;
    expect(result.authorized.displayName).toBe(partner.displayName);
    expect(result.authorized.counterparty).toEqual({ type: "PARTNER", partnerRef: partner.partnerRef, partnerAccountRefs: [], platformScope: [] });
    expect(result.authorized.scope).toEqual({ ownerUid: null, regionIds: [R_IN], teamIds: [], partnerUid: partner.uid, vendorUid: null });
  });

  it("an in-scope Vendor loads with its display name and a vendorUid scope snapshot", async () => {
    const vendor = await seedVendor();
    const actor = await syntheticActor("partnership_manager");
    const result = await loadAuthorizedCounterparty(actor, { type: "VENDOR", vendorRef: vendor.vendorRef });
    expect(result.ok).toBe(true);
    if (!result.ok || result.authorized.type !== "VENDOR") return;
    expect(result.authorized.displayName).toBe(vendor.displayName);
    expect(result.authorized.counterparty).toEqual({ type: "VENDOR", vendorRef: vendor.vendorRef });
    expect(result.authorized.scope).toEqual({ ownerUid: null, regionIds: [R_IN], teamIds: [], partnerUid: null, vendorUid: vendor.uid });
  });

  it("Instagram + YouTube accounts of one Partner stay ONE Partner identity with platformScope [instagram, youtube] (derived server-side)", async () => {
    const partner = await seedPartner();
    const instagram = await seedAccount(partner, "Instagram");
    const youtube = await seedAccount(partner, "  YouTube ");
    const secondInstagram = await seedAccount(partner, "instagram");
    const actor = await syntheticActor("partnership_manager");
    const result = await loadAuthorizedCounterparty(actor, {
      type: "PARTNER",
      partnerRef: partner.partnerRef,
      partnerAccountRefs: [youtube.partnerAccountRef, instagram.partnerAccountRef, secondInstagram.partnerAccountRef, instagram.partnerAccountRef],
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.authorized.type !== "PARTNER") return;
    expect(result.authorized.counterparty.partnerRef).toBe(partner.partnerRef);
    expect(result.authorized.counterparty.platformScope).toEqual(["instagram", "youtube"]);
    // duplicates collapsed, request order kept
    expect(result.authorized.counterparty.partnerAccountRefs).toEqual([youtube.partnerAccountRef, instagram.partnerAccountRef, secondInstagram.partnerAccountRef]);
    expect(result.authorized.partner.uid).toBe(partner.uid);
  });

  it("an out-of-scope Partner, an unknown ref and a forged ref return the SAME neutral outcome", async () => {
    const outOfScope = await seedPartner({ regionIds: [R_OUT] });
    const actor = await syntheticActor("partnership_manager");
    const outcomes = await Promise.all([
      loadAuthorizedCounterparty(actor, { type: "PARTNER", partnerRef: outOfScope.partnerRef }),
      loadAuthorizedCounterparty(actor, { type: "PARTNER", partnerRef: `does-not-exist-${runId}` }),
      loadAuthorizedCounterparty(actor, { type: "PARTNER", partnerRef: outOfScope.uid }), // the uid is not the ref
      loadAuthorizedCounterparty(actor, { type: "PARTNER", partnerRef: "../../etc/passwd" }),
    ]);
    for (const outcome of outcomes) expect(outcome).toEqual(NEUTRAL);
  });

  it("an out-of-scope Vendor, an unknown ref, a forged ref and a Partner ref used as a Vendor ref are all the same neutral outcome", async () => {
    const outOfScope = await seedVendor({ regionIds: [R_OUT] });
    const partner = await seedPartner();
    const actor = await syntheticActor("partnership_manager");
    const outcomes = await Promise.all([
      loadAuthorizedCounterparty(actor, { type: "VENDOR", vendorRef: outOfScope.vendorRef }),
      loadAuthorizedCounterparty(actor, { type: "VENDOR", vendorRef: `does-not-exist-${runId}` }),
      loadAuthorizedCounterparty(actor, { type: "VENDOR", vendorRef: partner.partnerRef }),
    ]);
    for (const outcome of outcomes) expect(outcome).toEqual(NEUTRAL);
  });

  it("Partner Accounts that belong to ANOTHER Partner, do not exist, or belong to an out-of-scope Partner are rejected with the same neutral outcome", async () => {
    const mine = await seedPartner();
    const other = await seedPartner();
    const outOfScope = await seedPartner({ regionIds: [R_OUT] });
    const myAccount = await seedAccount(mine, "instagram");
    const otherAccount = await seedAccount(other, "youtube");
    const foreignAccount = await seedAccount(outOfScope, "instagram");
    const actor = await syntheticActor("partnership_manager");

    expect((await loadAuthorizedCounterparty(actor, { type: "PARTNER", partnerRef: mine.partnerRef, partnerAccountRefs: [myAccount.partnerAccountRef] })).ok).toBe(true);
    const outcomes = await Promise.all([
      loadAuthorizedCounterparty(actor, { type: "PARTNER", partnerRef: mine.partnerRef, partnerAccountRefs: [otherAccount.partnerAccountRef] }),
      loadAuthorizedCounterparty(actor, { type: "PARTNER", partnerRef: mine.partnerRef, partnerAccountRefs: [myAccount.partnerAccountRef, otherAccount.partnerAccountRef] }),
      loadAuthorizedCounterparty(actor, { type: "PARTNER", partnerRef: mine.partnerRef, partnerAccountRefs: [foreignAccount.partnerAccountRef] }),
      loadAuthorizedCounterparty(actor, { type: "PARTNER", partnerRef: mine.partnerRef, partnerAccountRefs: [`no-such-account-${runId}`] }),
      // the account's own Partner is out of scope AND the named Partner is out of scope: still identical
      loadAuthorizedCounterparty(actor, { type: "PARTNER", partnerRef: outOfScope.partnerRef, partnerAccountRefs: [foreignAccount.partnerAccountRef] }),
    ]);
    for (const outcome of outcomes) expect(outcome).toEqual(NEUTRAL);
  });

  it("scope grants key on the doc UID, not the ref: an EXPLICIT_RECORD / PARTNER grant on the uid opens a Partner outside the actor's regions; one on the ref does not", async () => {
    const partner = await seedPartner({ regionIds: [R_OUT] });
    const byUid = await syntheticActor("partnership_manager", [{ type: "EXPLICIT_RECORD", resourceType: "partner", resourceId: partner.uid }]);
    const byPartnerGrant = await syntheticActor("partnership_manager", [{ type: "PARTNER", partnerId: partner.uid }]);
    const byRef = await syntheticActor("partnership_manager", [{ type: "EXPLICIT_RECORD", resourceType: "partner", resourceId: partner.partnerRef }]);
    const input = { type: "PARTNER" as const, partnerRef: partner.partnerRef };
    expect((await loadAuthorizedCounterparty(byUid, input)).ok).toBe(true);
    expect((await loadAuthorizedCounterparty(byPartnerGrant, input)).ok).toBe(true);
    expect(await loadAuthorizedCounterparty(byRef, input)).toEqual(NEUTRAL);
  });

  it("Vendor scope never bridges through a Partner: a PARTNER grant does not open a Vendor, an EXPLICIT_RECORD vendor grant on the uid does", async () => {
    const partner = await seedPartner({ regionIds: [R_OUT] });
    const vendor = await seedVendor({ regionIds: [R_OUT] });
    const partnerGrantee = await syntheticActor("partnership_manager", [{ type: "PARTNER", partnerId: partner.uid }]);
    expect(await loadAuthorizedCounterparty(partnerGrantee, { type: "VENDOR", vendorRef: vendor.vendorRef })).toEqual(NEUTRAL);
    const vendorGrantee = await syntheticActor("partnership_manager", [{ type: "EXPLICIT_RECORD", resourceType: "vendor", resourceId: vendor.uid }]);
    expect((await loadAuthorizedCounterparty(vendorGrantee, { type: "VENDOR", vendorRef: vendor.vendorRef })).ok).toBe(true);
  });

  it("a global-scope actor (Super Admin) sees a Partner in any region", async () => {
    const partner = await seedPartner({ regionIds: [R_OUT] });
    const admin = await seededActor("super_admin");
    expect((await loadAuthorizedCounterparty(admin, { type: "PARTNER", partnerRef: partner.partnerRef })).ok).toBe(true);
  });
});

// ---- loadAuthorizedAgreement --------------------------------------------------------------------------------------------------
describe("loadAuthorizedAgreement", () => {
  it("an in-scope Partner agreement loads (read gate) with the counterparty's display name and LIVE scope", async () => {
    const partner = await seedPartner();
    const head = await partnerHead(partner);
    const actor = await syntheticActor("partnership_manager");
    const result = await loadAuthorizedAgreement(actor, head.agreementRef);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authorized.head.agreementRef).toBe(head.agreementRef);
    expect(result.authorized.counterpartyType).toBe("PARTNER");
    expect(result.authorized.displayName).toBe(partner.displayName);
    expect(result.authorized.liveScope).toEqual({ ownerUid: null, regionIds: [R_IN], teamIds: [], partnerUid: partner.uid, vendorUid: null });
  });

  it("an in-scope Vendor agreement loads", async () => {
    const vendor = await seedVendor();
    const head = await seedHead({ counterparty: { type: "VENDOR", vendorRef: vendor.vendorRef }, vendorUid: vendor.uid });
    const actor = await syntheticActor("partnership_manager");
    const result = await loadAuthorizedAgreement(actor, head.agreementRef, "manage_agreements");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authorized.counterpartyType).toBe("VENDOR");
    expect(result.authorized.liveScope.vendorUid).toBe(vendor.uid);
  });

  it("never trusts the head's stored scope snapshot: live scope decides (stale-in-scope snapshot denied, stale-out snapshot allowed)", async () => {
    const outNow = await seedPartner({ regionIds: [R_OUT] });
    const inNow = await seedPartner({ regionIds: [R_IN] });
    const staleIn = await partnerHead(outNow, { regionIds: [R_IN] }); // snapshot says IN, live Partner is OUT
    const staleOut = await partnerHead(inNow, { regionIds: [R_OUT] }); // snapshot says OUT, live Partner is IN
    const actor = await syntheticActor("partnership_manager");
    expect(await loadAuthorizedAgreement(actor, staleIn.agreementRef)).toEqual(NEUTRAL);
    expect((await loadAuthorizedAgreement(actor, staleOut.agreementRef)).ok).toBe(true);
  });

  it("an out-of-scope agreement, an unknown ref, a malformed ref and an agreement whose counterparty has vanished return the SAME neutral outcome", async () => {
    const outOfScope = await seedPartner({ regionIds: [R_OUT] });
    const outHead = await partnerHead(outOfScope);
    const vanished = await partnerHead(await seedPartner(), { partnerUid: "not-the-live-uid" }); // uid mismatch = counterparty no longer matches
    const missingPartnerHead = await seedHead({ counterparty: { type: "PARTNER", partnerRef: `gone-${runId}`, partnerAccountRefs: [], platformScope: [] }, partnerUid: "gone" });
    const outVendor = await seedVendor({ regionIds: [R_OUT] });
    const outVendorHead = await seedHead({ counterparty: { type: "VENDOR", vendorRef: outVendor.vendorRef }, vendorUid: outVendor.uid });
    const actor = await syntheticActor("partnership_manager");
    const outcomes = await Promise.all([
      loadAuthorizedAgreement(actor, outHead.agreementRef),
      loadAuthorizedAgreement(actor, vanished.agreementRef),
      loadAuthorizedAgreement(actor, missingPartnerHead.agreementRef),
      loadAuthorizedAgreement(actor, outVendorHead.agreementRef),
      loadAuthorizedAgreement(actor, generateAgreementRef()),
      loadAuthorizedAgreement(actor, "not-an-agreement-ref"),
      loadAuthorizedAgreement(actor, "agr_../x"),
    ]);
    for (const outcome of outcomes) expect(outcome).toEqual(NEUTRAL);
  });

  it("applies the action gate: Manager may manage but not activate; Head may activate; Viewer/Analyst are denied at the feature layer even for an in-scope agreement", async () => {
    const partner = await seedPartner();
    const head = await partnerHead(partner);
    const manager = await syntheticActor("partnership_manager");
    const headActor = await syntheticActor("partnership_head");
    const viewer = await syntheticActor("viewer");
    const analyst = await syntheticActor("analyst");

    expect((await loadAuthorizedAgreement(manager, head.agreementRef, "manage_agreements")).ok).toBe(true);
    const managerActivate = await loadAuthorizedAgreement(manager, head.agreementRef, "activate_agreements");
    expect(managerActivate).toMatchObject({ ok: false, error: { code: "unauthorized", reason: "action_denied" } });
    expect((await loadAuthorizedAgreement(headActor, head.agreementRef, "activate_agreements")).ok).toBe(true);
    for (const actor of [viewer, analyst]) {
      expect(await loadAuthorizedAgreement(actor, head.agreementRef)).toMatchObject({ ok: false, error: { code: "unauthorized", reason: "feature_denied" } });
    }
    expect(await loadAuthorizedAgreement(null, head.agreementRef)).toMatchObject({ ok: false, error: { code: "unauthorized", reason: "not_authenticated" } });
  });

  it("an authorized actor without Record Scope is denied exactly like a missing agreement (scope is checked AFTER the feature/action gate)", async () => {
    const partner = await seedPartner({ regionIds: [R_OUT] });
    const head = await partnerHead(partner);
    const noScopeManager = await syntheticActor("partnership_manager");
    const missing = await loadAuthorizedAgreement(noScopeManager, generateAgreementRef());
    const denied = await loadAuthorizedAgreement(noScopeManager, head.agreementRef);
    expect(denied).toEqual(missing);
    expect(denied).toEqual(NEUTRAL);
  });
});
