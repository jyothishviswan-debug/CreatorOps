// Step 14A - the Finance Agreements core against the running Firestore/Auth emulator (no mocks).
// Proves the mutation/read services end to end: transactional idempotent create, decide / attach-extraction / confirm
// (manual, extracted and mixed modes converge on ONE validated terms schema), immutability after confirm, activation with
// atomic supersession, revision, suspend/resume/end, concurrency safety, the five-role matrix through REAL grants,
// neutral denial, in-transaction audit events without restricted values, and the Finance boundary (no money collection and
// no Partner / Vendor / KYC document is ever written).
//
// Hermetic by construction: every synthetic actor's ONLY scope is a per-run private REGION; fixtures are private-region
// Partners/Accounts/Vendors with unique ids; past effective dates; no whole-collection size assertion; every created
// document (agreement heads with their subcollections, claims, artifacts, restricted identities, grants) is removed after.
import { randomUUID } from "node:crypto";

import { DocumentReference, Firestore, Transaction, WriteBatch } from "firebase-admin/firestore";
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
import { restrictedFinancialIdentitiesCollection, restrictedIdentityDocId, restrictedFinancialIdentityDocSchema } from "@/server/shared/restricted-financial-identity";
import { vendorPartnerLinksCollection, vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema, vendorPartnerLinkDocSchema, type VendorDoc } from "@/server/vendors/types";

import {
  activateAgreementVersion,
  attachExtractionProposals,
  confirmAgreementVersion,
  createAgreementDraft,
  createAgreementRevision,
  decideField,
  endAgreement,
  getAgreementDetail,
  getDraftFieldsForReconciliation,
  listAgreementEvents,
  listAgreementsForCounterparty,
  listAgreementVersions,
  resumeAgreement,
  suspendAgreement,
  type AgreementDetailDto,
  type CreateAgreementDraftOutcome,
} from "./index";
import { AGREEMENT_EVENT_METADATA_ALLOWLIST } from "./agreement-events";
import {
  agreementClaimId,
  financeAgreementClaimsCollection,
  financeAgreementEventsCollection,
  financeAgreementExtractionRunsCollection,
  financeAgreementVersionsCollection,
  financeAgreementsCollection,
  financeContractArtifactsCollection,
} from "./firestore";
import { computeIdentityStatus } from "./identity-status";
import { generateAgreementRef, generateContractArtifactRef, generateExtractionRunRef } from "./ids";
import { READY_DECISIONS, SAMPLE_INCENTIVE, SAMPLE_TARGETS, type FieldDecisionSeed } from "./testing/agreement-service-fixtures";
import {
  agreementHeadDocSchema,
  agreementVersionDocSchema,
  confirmedAgreementTermsSchema,
  contractArtifactDocSchema,
  extractionRunDocSchema,
  type AgreementCounterpartyInput,
  type FinanceAgreementsErrorResult,
  type FinanceAgreementsServiceResult,
} from "./types";

vi.setConfig({ testTimeout: 60_000 });

const runId = Date.now();
const R_IN = `fas-in-${runId}`;
const R_OUT = `fas-out-${runId}`;
const NEUTRAL = { ok: false, code: "not_found", message: "Not found." };

const uidByRole = new Map<string, string>();
const cleanup: FirebaseFirestore.DocumentReference[] = [];
const agreementRefs: string[] = [];
const claimIds: string[] = [];
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
  const db = getAdminFirestore();
  // recursiveDelete removes the head AND its versions / events / extractionRuns subcollections.
  for (const ref of agreementRefs.splice(0)) await db.recursiveDelete(financeAgreementsCollection().doc(ref));
  await Promise.all(claimIds.splice(0).map((id) => financeAgreementClaimsCollection().doc(id).delete()));
  await Promise.all(cleanup.splice(0).map((ref) => ref.delete()));
  await Promise.all(grantDocIds.splice(0).map((id) => db.collection(COLLECTIONS.scopeAssignments).doc(id).delete()));
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
  const uid = `fas-${role}-${runId}-${randomUUID().slice(0, 6)}`;
  const grantedAt = new Date().toISOString();
  for (const input of grants) {
    const id = scopeGrantDocId(uid, input);
    await getAdminFirestore()
      .collection(COLLECTIONS.scopeAssignments)
      .doc(id)
      .set({ ...input, uid, grantedAt, grantedBy: "fas-test" } as ScopeGrant);
    grantDocIds.push(id);
  }
  return { uid, email: `${uid}@example.test`, role, displayName: `FAS ${role}`, userRef: `fas-ref-${uid}` };
}

// ---- Fixtures ----------------------------------------------------------------------------------------------------------
async function seedPartner(over: { regionIds?: string[]; email?: string | null; phone?: string | null; legalName?: string | null } = {}): Promise<PartnerDoc> {
  counter += 1;
  const uid = `fas-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = `FAS Partner ${counter} ${runId}`;
  const partner = partnerDocSchema.parse({
    uid,
    partnerRef: `ref-${uid}`,
    version: 1,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    legalName: over.legalName ?? null,
    email: over.email === undefined ? `partner-${counter}@example.test` : over.email,
    phone: over.phone === undefined ? "+91 90000 00000" : over.phone,
    status: "ACTIVE",
    regionIds: over.regionIds ?? [R_IN],
    createdAt: now,
    createdByUserRef: "fas-test",
    updatedAt: now,
    updatedByUserRef: "fas-test",
  });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  cleanup.push(ref);
  return partner;
}

async function seedAccount(partner: PartnerDoc, platform: string) {
  counter += 1;
  const uid = `fas-account-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
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
    createdByUserRef: "fas-test",
    updatedAt: now,
    updatedByUserRef: "fas-test",
  });
  const ref = partnerAccountsCollection().doc(uid);
  await ref.set(account);
  cleanup.push(ref);
  return account;
}

async function seedVendor(over: { regionIds?: string[] } = {}): Promise<VendorDoc> {
  counter += 1;
  const uid = `fas-vendor-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = `FAS Vendor ${counter} ${runId}`;
  const vendor = vendorDocSchema.parse({
    uid,
    vendorRef: `ref-${uid}`,
    version: 1,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    vendorType: "AGENCY",
    email: `vendor-${counter}@example.test`,
    status: "ACTIVE",
    regionIds: over.regionIds ?? [R_IN],
    createdAt: now,
    createdByUserRef: "fas-test",
    updatedAt: now,
    updatedByUserRef: "fas-test",
  });
  const ref = vendorsCollection().doc(uid);
  await ref.set(vendor);
  cleanup.push(ref);
  return vendor;
}

// Synthetic identity values (invented) - the tests prove NONE of them ever reaches an Agreement document or event.
const SECRETS = { pan: "QWERT4321Z", aadhaar: "234123412346", account: "998877665544", ifsc: "TEST0009876", holder: "Zed Holder Name", gst: "27QWERT4321Z1Z9" };

async function seedRestrictedIdentity(subject: { type: "PARTNER" | "VENDOR"; uid: string; ref: string }, parts: { pan?: boolean; bank?: boolean; aadhaar?: boolean; gst?: "number" | "not_applicable" } = {}) {
  const now = new Date().toISOString();
  const doc = restrictedFinancialIdentityDocSchema.parse({
    uid: restrictedIdentityDocId(subject.type, subject.uid),
    subjectType: subject.type,
    subjectRef: subject.ref,
    version: 1,
    pan: parts.pan ? { number: SECRETS.pan } : null,
    aadhaar: parts.aadhaar ? { number: SECRETS.aadhaar } : null,
    gst: parts.gst === "number" ? { applicable: true, number: SECRETS.gst } : parts.gst === "not_applicable" ? { applicable: false } : null,
    bank: parts.bank ? { accountHolderName: SECRETS.holder, accountNumber: SECRETS.account, ifsc: SECRETS.ifsc, bankName: "Test Bank", branchName: "Test Branch" } : null,
    updatedAt: now,
    updatedByUserRef: "fas-test",
  });
  const ref = restrictedFinancialIdentitiesCollection().doc(doc.uid);
  await ref.set(doc);
  cleanup.push(ref);
}

async function seedArtifact(type: "PARTNER" | "VENDOR", ref: string) {
  const artifact = contractArtifactDocSchema.parse({
    artifactRef: generateContractArtifactRef(),
    fileName: "synthetic-contract.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1234,
    sha256: "a".repeat(64),
    uploadedByUserRef: "fas-test",
    uploadedAt: new Date().toISOString(),
    counterparty: { type, ref },
    status: "EXTRACTED",
    storageLocator: `test/${randomUUID()}`,
  });
  const docRef = financeContractArtifactsCollection().doc(artifact.artifactRef);
  await docRef.set(artifact);
  cleanup.push(docRef);
  return artifact;
}

type ProposalSeed = { fieldKey: string; normalizedValue: unknown; confidence?: string; page?: number };
async function seedRun(agreementRef: string, artifactRef: string, proposals: ProposalSeed[]) {
  const run = extractionRunDocSchema.parse({
    runRef: generateExtractionRunRef(),
    agreementRef,
    artifactRef,
    status: "EXTRACTED",
    reasonCodes: [],
    parserVersion: "test-parser-1",
    pageCount: 3,
    charCount: 4000,
    proposals: proposals.map((p) => ({ fieldKey: p.fieldKey, normalizedValue: p.normalizedValue, confidence: p.confidence ?? "MEDIUM", warnings: [], requiresHumanConfirmation: true, source: { page: p.page ?? 1 } })),
    createdAt: new Date().toISOString(),
    createdByUserRef: "fas-test",
  });
  await financeAgreementExtractionRunsCollection(agreementRef).doc(run.runRef).set(run);
  return run;
}

// ---- Result helpers ------------------------------------------------------------------------------------------------------
function must<T>(result: FinanceAgreementsServiceResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}${result.blockers ? ` ${JSON.stringify(result.blockers)}` : ""}`);
  return result.data;
}
function failed<T>(result: FinanceAgreementsServiceResult<T>): FinanceAgreementsErrorResult {
  if (result.ok) throw new Error("expected a failure");
  return result;
}

const partnerCp = (partner: PartnerDoc, accountRefs?: string[]): AgreementCounterpartyInput => ({ type: "PARTNER", partnerRef: partner.partnerRef, ...(accountRefs ? { partnerAccountRefs: accountRefs } : {}) });
const vendorCp = (vendor: VendorDoc): AgreementCounterpartyInput => ({ type: "VENDOR", vendorRef: vendor.vendorRef });

let reqCounter = 0;
const requestId = () => `req-${runId}-${(reqCounter += 1)}`;

async function newAgreement(actor: ActorContext, counterparty: AgreementCounterpartyInput, sourceMode?: "MANUAL" | "EXTRACTED"): Promise<CreateAgreementDraftOutcome> {
  const clientRequestId = `crid-${runId}-${(counter += 1)}-${randomUUID().slice(0, 6)}`;
  const outcome = must(await createAgreementDraft(actor, { clientRequestId, counterparty, ...(sourceMode ? { sourceMode } : {}) }, requestId()), "create");
  agreementRefs.push(outcome.agreement.head.agreementRef);
  claimIds.push(agreementClaimId(actor.uid, clientRequestId));
  return outcome;
}

const docVersionOf = (detail: AgreementDetailDto) => detail.selectedVersion!.docVersion;

// Applies decisions in order, threading the version's docVersion; returns the latest detail.
async function decideAll(actor: ActorContext, detail: AgreementDetailDto, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
  let current = detail;
  for (const seed of seeds) {
    current = must(
      await decideField(
        actor,
        { agreementRef: current.head.agreementRef, version: current.selectedVersion!.version, expectedDocVersion: docVersionOf(current), fieldKey: seed.fieldKey, decision: seed.decision, ...(seed.value !== undefined ? { value: seed.value } : {}) },
        requestId(),
      ),
      `decide ${seed.fieldKey}`,
    );
  }
  return current;
}

// Accepts every remaining PENDING entry (master-data prefills, extracted proposals, identity acknowledgements).
async function acceptPending(actor: ActorContext, detail: AgreementDetailDto): Promise<AgreementDetailDto> {
  const pending = Object.entries(detail.selectedVersion!.draft)
    .filter(([, entry]) => entry?.decision === "PENDING")
    .map(([fieldKey]) => ({ fieldKey, decision: "ACCEPTED" as const }));
  return decideAll(actor, detail, pending as FieldDecisionSeed[]);
}

async function confirm(actor: ActorContext, detail: AgreementDetailDto) {
  return must(await confirmAgreementVersion(actor, { agreementRef: detail.head.agreementRef, version: detail.selectedVersion!.version, expectedDocVersion: docVersionOf(detail) }, requestId()), "confirm");
}

// create -> decide everything -> accept pending -> confirm. Returns the confirmed detail.
async function confirmedAgreement(manager: ActorContext, counterparty: AgreementCounterpartyInput, seeds: FieldDecisionSeed[] = READY_DECISIONS) {
  const created = await newAgreement(manager, counterparty);
  const decided = await decideAll(manager, created.agreement, seeds);
  return confirm(manager, await acceptPending(manager, decided));
}

async function activate(actor: ActorContext, detail: AgreementDetailDto, version?: number) {
  return must(await activateAgreementVersion(actor, { agreementRef: detail.head.agreementRef, version: version ?? detail.selectedVersion!.version, expectedDocVersion: detail.head.docVersion }, requestId()), "activate");
}

async function fresh(actor: ActorContext, agreementRef: string, version?: number) {
  return must(await getAgreementDetail(actor, agreementRef, version ? { version } : {}), "detail");
}

// ---- Raw reads (bypass every service) ------------------------------------------------------------------------------------------
async function rawHead(agreementRef: string) {
  return (await financeAgreementsCollection().doc(agreementRef).get()).data() as Record<string, unknown>;
}
async function rawVersion(agreementRef: string, version: number) {
  return (await financeAgreementVersionsCollection(agreementRef).doc(String(version)).get()).data() as Record<string, unknown>;
}
async function rawVersions(agreementRef: string) {
  const snap = await financeAgreementVersionsCollection(agreementRef).get();
  return snap.docs.map((doc) => doc.data() as Record<string, unknown>).sort((a, b) => (a.version as number) - (b.version as number));
}
async function rawEvents(agreementRef: string) {
  const snap = await financeAgreementEventsCollection(agreementRef).get();
  return snap.docs.map((doc) => doc.data() as { kind: string; version: number; actorUserRef: string; metadata: Record<string, unknown> | null; requestId: string; createdAt: string });
}
async function rawDoc(ref: FirebaseFirestore.DocumentReference) {
  const snap = await ref.get();
  return snap.exists ? JSON.stringify(snap.data()) : null;
}
const governingCount = (versions: Array<Record<string, unknown>>) => versions.filter((v) => v.status === "ACTIVE" || v.status === "SUSPENDED").length;

// ---- Firestore instrumentation (writes by path and transaction; collections touched) -----------------------------------------
type WriteRecord = { op: "set" | "create" | "update" | "delete"; path: string; tx: object | null };

function instrument() {
  const writes: WriteRecord[] = [];
  const collectionsTouched = new Set<string>();
  type AnyFn = (...args: unknown[]) => unknown;
  const spies: Array<{ mockRestore: () => void }> = [];
  const wrap = (proto: object, name: string, before: (self: unknown, args: unknown[]) => void) => {
    const original = (proto as unknown as Record<string, AnyFn>)[name]!;
    spies.push(
      vi.spyOn(proto as unknown as Record<string, AnyFn>, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
        before(this, args);
        return original.apply(this, args);
      }),
    );
  };
  const pathOf = (ref: unknown) => (ref as { path: string }).path;
  for (const op of ["set", "create", "update", "delete"] as const) {
    wrap(Transaction.prototype, op, (self, args) => writes.push({ op, path: pathOf(args[0]), tx: self as object }));
    wrap(WriteBatch.prototype, op, (_self, args) => writes.push({ op, path: pathOf(args[0]), tx: null }));
    wrap(DocumentReference.prototype, op, (self) => writes.push({ op, path: pathOf(self), tx: null }));
  }
  wrap(Firestore.prototype, "collection", (_self, args) => collectionsTouched.add(String(args[0]).split("/")[0]!));
  wrap(Firestore.prototype, "collectionGroup", (_self, args) => collectionsTouched.add(String(args[0])));
  wrap(Firestore.prototype, "doc", (_self, args) => collectionsTouched.add(String(args[0]).split("/")[0]!));
  return { writes, collectionsTouched, stop: () => spies.splice(0).forEach((spy) => spy.mockRestore()) };
}

// A Transaction delegates to its own WriteBatch, which the instrumentation also sees: those are the same write, not a
// second, direct one. Returns the transactional writes and proves NO write happened outside a transaction.
function transactionalWrites(io: ReturnType<typeof instrument>): WriteRecord[] {
  const inTx = io.writes.filter((write) => write.tx !== null);
  const direct = io.writes.filter((write) => write.tx === null);
  const txPaths = inTx.map((write) => write.path).sort();
  expect(direct.map((write) => write.path).sort()).toEqual(txPaths);
  return inTx;
}

const headCountFor = async (partnerRef: string) => (await financeAgreementsCollection().where("counterparty.partnerRef", "==", partnerRef).get()).size;

// =====================================================================================================================
// Draft creation
// =====================================================================================================================
describe("createAgreementDraft", () => {
  it("creates the head + version 1 DRAFT, prefilled from master data (MASTER_DATA / PENDING / 'CreatorOps master data'), with a created event and no identity value", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner({ legalName: "Legal Partner Pvt Ltd" });
    await seedRestrictedIdentity({ type: "PARTNER", uid: partner.uid, ref: partner.partnerRef }, { pan: true, bank: true, aadhaar: true, gst: "number" });
    const outcome = await newAgreement(manager, partnerCp(partner));
    expect(outcome.outcome).toBe("created");

    const { head, selectedVersion, versions } = outcome.agreement;
    expect(head).toMatchObject({ status: "DRAFT", latestVersion: 1, openVersion: 1, activeVersion: null, lastEndedVersion: null, docVersion: 1, counterparty: { type: "PARTNER", ref: partner.partnerRef, partnerAccountRefs: [], platformScope: [] } });
    expect(versions).toHaveLength(1);
    expect(selectedVersion).toMatchObject({ version: 1, status: "DRAFT", confirmed: false, docVersion: 1, terms: null, contactSnapshot: null, sourceMode: "MANUAL" });
    const draft = selectedVersion!.draft;
    expect(draft.counterpartyName).toMatchObject({ value: "Legal Partner Pvt Ltd", origin: "MASTER_DATA", decision: "PENDING" });
    expect(draft.counterpartyName!.provenance.label).toBe("CreatorOps master data");
    expect(draft.emailAddress?.value).toBe(partner.email);
    expect(draft.contactNumber?.value).toBe(partner.phone);
    expect(draft.state?.value).toBe(partner.regionIds[0]);
    for (const entry of Object.values(draft)) expect(entry).toMatchObject({ origin: "MASTER_DATA", decision: "PENDING" });
    for (const key of ["panNumber", "aadhaarNumber", "bankAccountNumber", "ifsc", "gstin", "panHolderName"]) expect(draft).not.toHaveProperty(key);

    // raw docs: parsed shapes, deterministic version doc id, exactly one created event, no identity value anywhere
    const raw = await rawHead(head.agreementRef);
    expect(agreementHeadDocSchema.safeParse(raw).success).toBe(true);
    expect(raw).toMatchObject({ partnerUid: partner.uid, vendorUid: null, regionIds: partner.regionIds, ownerUid: null });
    expect(agreementVersionDocSchema.safeParse(await rawVersion(head.agreementRef, 1)).success).toBe(true);
    const events = await rawEvents(head.agreementRef);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "created", version: 1, actorUserRef: manager.userRef });
    const everything = JSON.stringify([raw, await rawVersions(head.agreementRef), events]);
    for (const secret of Object.values(SECRETS)) expect(everything).not.toContain(secret);
    // the head DTO never exposes scope fields or uids
    expect(JSON.stringify(outcome.agreement)).not.toMatch(/partnerUid|vendorUid|ownerUid|regionIds|teamIds/);
  });

  it("one Partner with Instagram + YouTube accounts stays ONE Partner: one head, platformScope [instagram, youtube], platforms prefilled", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const instagram = await seedAccount(partner, "Instagram");
    const youtube = await seedAccount(partner, " YouTube ");
    const outcome = await newAgreement(manager, partnerCp(partner, [youtube.partnerAccountRef, instagram.partnerAccountRef]));
    const { head, selectedVersion } = outcome.agreement;
    expect(head.counterparty).toMatchObject({ type: "PARTNER", ref: partner.partnerRef, platformScope: ["instagram", "youtube"] });
    expect(head.counterparty.partnerAccountRefs).toEqual([youtube.partnerAccountRef, instagram.partnerAccountRef]);
    expect(selectedVersion!.counterparty).toEqual(head.counterparty);
    expect(selectedVersion!.draft.platforms?.value).toEqual(["instagram", "youtube"]);
    expect(await headCountFor(partner.partnerRef)).toBe(1);
  });

  it("creates a Vendor Agreement bound to the Vendor (never through a Partner)", async () => {
    const manager = await syntheticActor("partnership_manager");
    const vendor = await seedVendor();
    const outcome = await newAgreement(manager, vendorCp(vendor));
    expect(outcome.agreement.head.counterparty).toEqual({ type: "VENDOR", ref: vendor.vendorRef, partnerAccountRefs: [], platformScope: [] });
    expect(outcome.agreement.selectedVersion!.draft.counterpartyName?.value).toBe(vendor.displayName);
    expect(outcome.agreement.selectedVersion!.draft.platforms).toBeUndefined();
    expect(await rawHead(outcome.agreement.head.agreementRef)).toMatchObject({ vendorUid: vendor.uid, partnerUid: null });
  });

  it("rejects an unknown key (a client-supplied scope / platformScope / status) and a malformed request id", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const good = { clientRequestId: `crid-${runId}-strict`, counterparty: partnerCp(partner) };
    for (const bad of [
      { ...good, status: "ACTIVE" },
      { ...good, counterparty: { ...partnerCp(partner), platformScope: ["instagram"] } },
      { ...good, counterparty: { ...partnerCp(partner), regionIds: [R_OUT] } },
      { ...good, clientRequestId: "short" },
      { clientRequestId: good.clientRequestId },
    ]) {
      expect(failed(await createAgreementDraft(manager, bad, requestId()))).toMatchObject({ code: "invalid_input" });
    }
    expect(await headCountFor(partner.partnerRef)).toBe(0);
  });
});

// =====================================================================================================================
// Idempotent create
// =====================================================================================================================
describe("idempotent create", () => {
  it("a retry with the same clientRequestId returns the existing head: same ref, no second head / version / claim / event", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const clientRequestId = `crid-${runId}-retry-${randomUUID().slice(0, 6)}`;
    claimIds.push(agreementClaimId(manager.uid, clientRequestId));
    const first = must(await createAgreementDraft(manager, { clientRequestId, counterparty: partnerCp(partner) }, requestId()), "first");
    agreementRefs.push(first.agreement.head.agreementRef);
    const second = must(await createAgreementDraft(manager, { clientRequestId, counterparty: partnerCp(partner) }, requestId()), "second");
    expect([first.outcome, second.outcome]).toEqual(["created", "existing"]);
    expect(second.agreement.head.agreementRef).toBe(first.agreement.head.agreementRef);
    expect(second.agreement.selectedVersion).toMatchObject({ version: 1 });

    expect(await headCountFor(partner.partnerRef)).toBe(1);
    expect(await rawVersions(first.agreement.head.agreementRef)).toHaveLength(1);
    expect(await rawEvents(first.agreement.head.agreementRef)).toHaveLength(1);
    const claim = await financeAgreementClaimsCollection().doc(agreementClaimId(manager.uid, clientRequestId)).get();
    expect(claim.exists).toBe(true);
    expect(claim.data()).toMatchObject({ agreementRef: first.agreement.head.agreementRef });
  });

  it("a retry writes nothing at all (fast path)", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const clientRequestId = `crid-${runId}-nowrite-${randomUUID().slice(0, 6)}`;
    claimIds.push(agreementClaimId(manager.uid, clientRequestId));
    const first = must(await createAgreementDraft(manager, { clientRequestId, counterparty: partnerCp(partner) }, requestId()), "first");
    agreementRefs.push(first.agreement.head.agreementRef);
    const io = instrument();
    const retry = must(await createAgreementDraft(manager, { clientRequestId, counterparty: partnerCp(partner) }, requestId()), "retry");
    io.stop();
    expect(retry.outcome).toBe("existing");
    expect(io.writes).toEqual([]);
  });

  it("concurrent parallel creates with ONE clientRequestId collapse to exactly one head, one version 1, one created event", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const clientRequestId = `crid-${runId}-parallel-${randomUUID().slice(0, 6)}`;
    claimIds.push(agreementClaimId(manager.uid, clientRequestId));
    const results = await Promise.all([1, 2, 3].map(() => createAgreementDraft(manager, { clientRequestId, counterparty: partnerCp(partner) }, requestId())));
    const data = results.map((result, index) => must(result, `parallel ${index}`));
    const refs = new Set(data.map((d) => d.agreement.head.agreementRef));
    expect(refs.size).toBe(1);
    agreementRefs.push([...refs][0]!);
    expect(data.filter((d) => d.outcome === "created")).toHaveLength(1);
    expect(await headCountFor(partner.partnerRef)).toBe(1);
    expect(await rawVersions([...refs][0]!)).toHaveLength(1);
    expect((await rawEvents([...refs][0]!)).filter((event) => event.kind === "created")).toHaveLength(1);
  });

  it("the same clientRequestId for a DIFFERENT counterparty is a conflict (never another Agreement's head); another actor reusing the id gets its own head", async () => {
    const manager = await syntheticActor("partnership_manager");
    const other = await syntheticActor("partnership_manager");
    const partnerA = await seedPartner();
    const partnerB = await seedPartner();
    const clientRequestId = `crid-${runId}-conflict-${randomUUID().slice(0, 6)}`;
    claimIds.push(agreementClaimId(manager.uid, clientRequestId), agreementClaimId(other.uid, clientRequestId));
    const first = must(await createAgreementDraft(manager, { clientRequestId, counterparty: partnerCp(partnerA) }, requestId()), "first");
    agreementRefs.push(first.agreement.head.agreementRef);
    expect(failed(await createAgreementDraft(manager, { clientRequestId, counterparty: partnerCp(partnerB) }, requestId()))).toMatchObject({ code: "conflict" });
    expect(await headCountFor(partnerB.partnerRef)).toBe(0);
    const theirs = must(await createAgreementDraft(other, { clientRequestId, counterparty: partnerCp(partnerA) }, requestId()), "other actor");
    agreementRefs.push(theirs.agreement.head.agreementRef);
    expect(theirs.outcome).toBe("created");
    expect(theirs.agreement.head.agreementRef).not.toBe(first.agreement.head.agreementRef);
  });
});

// =====================================================================================================================
// Manual / extracted / mixed modes converge on ONE validated terms schema
// =====================================================================================================================
function extractionProposalsFor(seeds: FieldDecisionSeed[]): ProposalSeed[] {
  return seeds.filter((seed) => seed.decision === "CORRECTED" || seed.decision === "ACCEPTED").map((seed, index) => ({ fieldKey: seed.fieldKey, normalizedValue: seed.value, page: 1 + (index % 3) }));
}
const NOT_APPLICABLE_SEEDS = READY_DECISIONS.filter((seed) => seed.decision === "NOT_APPLICABLE");

describe("manual, extracted and mixed modes", () => {
  it("MANUAL, EXTRACTED and MIXED all freeze the SAME validated ConfirmedAgreementTerms schema; sourceMode is computed from field origins", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();

    // MANUAL: every value typed by a human
    const manual = await confirmedAgreement(manager, partnerCp(partner));
    expect(manual.selectedVersion!.sourceMode).toBe("MANUAL");

    // EXTRACTED: attach a run carrying the same values, then accept everything
    const created = await newAgreement(manager, partnerCp(partner), "EXTRACTED");
    const artifact = await seedArtifact("PARTNER", partner.partnerRef);
    const run = await seedRun(created.agreement.head.agreementRef, artifact.artifactRef, [...extractionProposalsFor(READY_DECISIONS), { fieldKey: "panNumber", normalizedValue: null }, { fieldKey: "bankAccountNumber", normalizedValue: null }]);
    const attached = must(await attachExtractionProposals(manager, { agreementRef: created.agreement.head.agreementRef, version: 1, expectedDocVersion: 1, extractionRunRef: run.runRef }, requestId()), "attach");
    expect(attached.attachedCount).toBe(run.proposals.length);
    const extracted = await confirm(manager, await acceptPending(manager, await decideAll(manager, attached.agreement, NOT_APPLICABLE_SEEDS)));
    expect(extracted.selectedVersion!.sourceMode).toBe("EXTRACTED");
    expect(extracted.selectedVersion!.source).toEqual({ contractArtifactRef: artifact.artifactRef, extractionRunRef: run.runRef, parserVersion: "test-parser-1" });

    // MIXED: extracted, but one field corrected by a human
    const mixedCreated = await newAgreement(manager, partnerCp(partner));
    const artifact2 = await seedArtifact("PARTNER", partner.partnerRef);
    const run2 = await seedRun(mixedCreated.agreement.head.agreementRef, artifact2.artifactRef, extractionProposalsFor(READY_DECISIONS));
    const attached2 = must(await attachExtractionProposals(manager, { agreementRef: mixedCreated.agreement.head.agreementRef, version: 1, expectedDocVersion: 1, extractionRunRef: run2.runRef }, requestId()), "attach2");
    const corrected = await decideAll(manager, attached2.agreement, [...NOT_APPLICABLE_SEEDS, { fieldKey: "paymentCycle", decision: "CORRECTED", value: "QUARTERLY" }]);
    const mixed = await confirm(manager, await acceptPending(manager, corrected));
    expect(mixed.selectedVersion!.sourceMode).toBe("MIXED");
    expect(mixed.selectedVersion!.terms!.commercial.paymentCycle).toBe("QUARTERLY");

    // ONE schema: every frozen terms object parses against the strict confirmed-terms schema, and the manual and
    // extracted routes freeze identical terms + contact snapshots for identical values
    for (const detail of [manual, extracted, mixed]) {
      const rawTerms = (await rawVersion(detail.head.agreementRef, 1)).terms;
      expect(confirmedAgreementTermsSchema.safeParse(rawTerms).success).toBe(true);
    }
    expect(extracted.selectedVersion!.terms).toEqual(manual.selectedVersion!.terms);
    expect(extracted.selectedVersion!.contactSnapshot).toEqual(manual.selectedVersion!.contactSnapshot);
    expect(manual.selectedVersion!.terms!.agreementType).toBe("FIXED_PLUS_INCENTIVE_PLUS_REQUIRED_CONTENT");
  });
});

// =====================================================================================================================
// Extraction proposals are only proposals
// =====================================================================================================================
describe("attachExtractionProposals", () => {
  it("attaches as PENDING and NEVER auto-confirms, activates, or touches the Partner, the Vendor link or KYC", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    await seedRestrictedIdentity({ type: "PARTNER", uid: partner.uid, ref: partner.partnerRef }, { pan: true });
    const identityRef = restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("PARTNER", partner.uid));
    const partnerBefore = await rawDoc(partnersCollection().doc(partner.uid));
    const identityBefore = await rawDoc(identityRef);

    const created = await newAgreement(manager, partnerCp(partner));
    const artifact = await seedArtifact("PARTNER", partner.partnerRef);
    const run = await seedRun(created.agreement.head.agreementRef, artifact.artifactRef, [
      { fieldKey: "currency", normalizedValue: "INR", confidence: "HIGH", page: 2 },
      { fieldKey: "emailAddress", normalizedValue: "different@example.test", confidence: "LOW" },
      { fieldKey: "panNumber", normalizedValue: null },
    ]);
    const io = instrument();
    const attached = must(await attachExtractionProposals(manager, { agreementRef: created.agreement.head.agreementRef, version: 1, expectedDocVersion: 1, extractionRunRef: run.runRef }, requestId()), "attach");
    io.stop();

    const version = attached.agreement.selectedVersion!;
    expect(version).toMatchObject({ confirmed: false, status: "DRAFT", terms: null, docVersion: 2 });
    expect(version.draft.currency).toMatchObject({ value: "INR", origin: "EXTRACTED", decision: "PENDING", extractedValue: "INR", decidedByUserRef: null });
    expect(version.draft.currency!.provenance).toMatchObject({ extractionRunRef: run.runRef, page: 2, confidence: "HIGH" });
    // a conflicting proposal replaces the still-PENDING master-data prefill as a candidate - the canonical value stays in the Partner
    expect(version.draft.emailAddress).toMatchObject({ value: "different@example.test", origin: "EXTRACTED", decision: "PENDING" });
    expect(version.draft.panNumber).toMatchObject({ value: null, origin: "EXTRACTED", decision: "PENDING" });
    expect(attached.agreement.head).toMatchObject({ status: "DRAFT", activeVersion: null, openVersion: 1, docVersion: 1 });
    expect(version.source).toEqual({ contractArtifactRef: artifact.artifactRef, extractionRunRef: run.runRef, parserVersion: "test-parser-1" });

    // Finance boundary: only financeAgreements documents were written; Partner and KYC untouched
    expect(io.writes.length).toBeGreaterThan(0);
    for (const write of io.writes) expect(write.path.split("/")[0]).toBe("financeAgreements");
    expect(await rawDoc(partnersCollection().doc(partner.uid))).toBe(partnerBefore);
    expect(await rawDoc(identityRef)).toBe(identityBefore);
    const event = (await rawEvents(created.agreement.head.agreementRef)).find((e) => e.kind === "extraction_attached")!;
    expect(event.metadata).toEqual({ runRef: run.runRef, artifactRef: artifact.artifactRef, parserVersion: "test-parser-1", proposalCount: 3, attachedCount: 3 });
  });

  it("never overwrites a decision a human already made; a re-attach of the same run is idempotent in effect", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const created = await newAgreement(manager, partnerCp(partner));
    const artifact = await seedArtifact("PARTNER", partner.partnerRef);
    const run = await seedRun(created.agreement.head.agreementRef, artifact.artifactRef, [
      { fieldKey: "currency", normalizedValue: "INR" },
      { fieldKey: "paymentCycle", normalizedValue: "MONTHLY" },
    ]);
    const decided = await decideAll(manager, created.agreement, [{ fieldKey: "currency", decision: "CORRECTED", value: "USD" }]);
    const attached = must(await attachExtractionProposals(manager, { agreementRef: created.agreement.head.agreementRef, version: 1, expectedDocVersion: docVersionOf(decided), extractionRunRef: run.runRef }, requestId()), "attach");
    expect(attached).toMatchObject({ attachedCount: 1, keptDecisionCount: 1 });
    expect(attached.agreement.selectedVersion!.draft.currency).toMatchObject({ value: "USD", decision: "CORRECTED", origin: "MANUAL" });
    const again = must(await attachExtractionProposals(manager, { agreementRef: created.agreement.head.agreementRef, version: 1, expectedDocVersion: docVersionOf(attached.agreement), extractionRunRef: run.runRef }, requestId()), "again");
    expect(again.agreement.selectedVersion!.draft.paymentCycle).toMatchObject({ value: "MONTHLY", decision: "PENDING" });
    expect(again.agreement.selectedVersion!.draft.currency).toMatchObject({ value: "USD", decision: "CORRECTED" });
  });

  it("a run that does not exist, belongs to another Agreement, or whose artifact names another counterparty is the neutral not_found; stale is stale", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const otherPartner = await seedPartner();
    const a = await newAgreement(manager, partnerCp(partner));
    const b = await newAgreement(manager, partnerCp(partner));
    const foreignArtifact = await seedArtifact("PARTNER", otherPartner.partnerRef);
    const ownArtifact = await seedArtifact("PARTNER", partner.partnerRef);
    const runOfB = await seedRun(b.agreement.head.agreementRef, ownArtifact.artifactRef, [{ fieldKey: "currency", normalizedValue: "INR" }]);
    const runForeignArtifact = await seedRun(a.agreement.head.agreementRef, foreignArtifact.artifactRef, [{ fieldKey: "currency", normalizedValue: "INR" }]);
    const attach = (extractionRunRef: string, expectedDocVersion = 1) => attachExtractionProposals(manager, { agreementRef: a.agreement.head.agreementRef, version: 1, expectedDocVersion, extractionRunRef }, requestId());
    expect(failed(await attach(generateExtractionRunRef()))).toMatchObject(NEUTRAL);
    expect(failed(await attach(runOfB.runRef))).toMatchObject(NEUTRAL);
    expect(failed(await attach(runForeignArtifact.runRef))).toMatchObject(NEUTRAL);
    expect(failed(await attach(runOfB.runRef, 9))).toMatchObject({ code: "stale_write" });
    expect((await rawVersion(a.agreement.head.agreementRef, 1)).docVersion).toBe(1);
  });
});

// =====================================================================================================================
// Confirmation gate
// =====================================================================================================================
describe("confirmAgreementVersion", () => {
  it("is blocked (not_ready + per-field blockers, no write) until every extracted / prefilled field is decided and the required fields exist", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const created = await newAgreement(manager, partnerCp(partner));
    const artifact = await seedArtifact("PARTNER", partner.partnerRef);
    const run = await seedRun(created.agreement.head.agreementRef, artifact.artifactRef, extractionProposalsFor(READY_DECISIONS));
    const attached = must(await attachExtractionProposals(manager, { agreementRef: created.agreement.head.agreementRef, version: 1, expectedDocVersion: 1, extractionRunRef: run.runRef }, requestId()), "attach");

    const before = JSON.stringify(await rawVersion(created.agreement.head.agreementRef, 1));
    const io = instrument();
    const blocked = failed(await confirmAgreementVersion(manager, { agreementRef: created.agreement.head.agreementRef, version: 1, expectedDocVersion: docVersionOf(attached.agreement) }, requestId()));
    io.stop();
    expect(blocked).toMatchObject({ code: "not_ready" });
    expect(blocked.blockers!.length).toBeGreaterThan(5);
    expect(blocked.blockers!.some((b) => b.code === "field_pending" && b.fieldKey === "currency")).toBe(true);
    expect(blocked.blockers!.some((b) => b.code === "field_undecided" && b.fieldKey === "accountTransferFee")).toBe(true);
    expect(io.writes).toEqual([]);
    expect(JSON.stringify(await rawVersion(created.agreement.head.agreementRef, 1))).toBe(before);
    expect((await rawEvents(created.agreement.head.agreementRef)).some((e) => e.kind === "confirmed")).toBe(false);

    // decide everything -> confirmable
    const ready = await acceptPending(manager, await decideAll(manager, attached.agreement, NOT_APPLICABLE_SEEDS));
    const done = await confirm(manager, ready);
    expect(done.selectedVersion).toMatchObject({ confirmed: true, status: "DRAFT", draft: {} });
    expect(done.selectedVersion!.confirmedByUserRef).toBe(manager.userRef);
  });

  it("requires the counterparty name and an effective date (required_field_missing / field_undecided)", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const created = await newAgreement(manager, partnerCp(partner));
    const bare = await acceptPending(manager, created.agreement);
    const result = failed(await confirmAgreementVersion(manager, { agreementRef: created.agreement.head.agreementRef, version: 1, expectedDocVersion: docVersionOf(bare) }, requestId()));
    expect(result.code).toBe("not_ready");
    expect(result.blockers!.some((b) => b.fieldKey === "effectiveDate")).toBe(true);
    expect(result.blockers!.some((b) => b.fieldKey === "paymentCycle")).toBe(true);
  });

  it("freezes terms / contactSnapshot / fieldProvenance / effective / confirmation together, clears the draft, records STATUS-only KYC", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner({ email: "kyc@example.test" });
    await seedRestrictedIdentity({ type: "PARTNER", uid: partner.uid, ref: partner.partnerRef }, { pan: true, bank: true, aadhaar: true, gst: "not_applicable" });
    const confirmed = await confirmedAgreement(manager, partnerCp(partner));
    const raw = await rawVersion(confirmed.head.agreementRef, 1);
    expect(agreementVersionDocSchema.safeParse(raw).success).toBe(true);
    expect(raw).toMatchObject({
      status: "DRAFT",
      draft: {},
      confirmation: { confirmedByUserRef: manager.userRef },
      effective: { signedDate: "2023-12-20", effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31" },
      identityStatusSnapshot: { state: "AVAILABLE", components: { pan: "PRESENT", aadhaar: "PRESENT", gst: "NOT_APPLICABLE", bank: "PRESENT" } },
    });
    expect(Object.keys(raw.fieldProvenance as object).length).toBeGreaterThan(20);
    // STATUS only: not one identity value in any Agreement document or event
    const everything = JSON.stringify([await rawHead(confirmed.head.agreementRef), await rawVersions(confirmed.head.agreementRef), await rawEvents(confirmed.head.agreementRef)]);
    for (const secret of Object.values(SECRETS)) expect(everything).not.toContain(secret);
    // the shared helper computes the same status
    expect((await computeIdentityStatus("PARTNER", partner.uid)).components).toEqual({ pan: "PRESENT", aadhaar: "PRESENT", gst: "NOT_APPLICABLE", bank: "PRESENT" });
  });

  it("a Vendor's KYC status has Aadhaar NOT_APPLICABLE; a store with nothing recorded is MISSING", async () => {
    const manager = await syntheticActor("partnership_manager");
    const vendor = await seedVendor();
    const confirmed = await confirmedAgreement(manager, vendorCp(vendor));
    expect((await rawVersion(confirmed.head.agreementRef, 1)).identityStatusSnapshot).toMatchObject({ state: "MISSING", components: { pan: "MISSING", aadhaar: "NOT_APPLICABLE", gst: "MISSING", bank: "MISSING" } });
    await seedRestrictedIdentity({ type: "VENDOR", uid: vendor.uid, ref: vendor.vendorRef }, { pan: true, bank: true, gst: "not_applicable" });
    expect((await computeIdentityStatus("VENDOR", vendor.uid)).state).toBe("AVAILABLE");
  });
});

// =====================================================================================================================
// Immutability, activation, revision, supersession
// =====================================================================================================================
const IMMUTABLE_KEYS = ["terms", "contactSnapshot", "identityStatusSnapshot", "fieldProvenance", "effective", "confirmation", "source", "counterparty", "draft", "sourceMode"] as const;
const immutableParts = (raw: Record<string, unknown>) => JSON.stringify(IMMUTABLE_KEYS.map((key) => raw[key]));

describe("immutability after confirm", () => {
  it("decide / attach / confirm on a confirmed version are refused, and its confirmed parts stay byte-identical through activation and later revisions", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const confirmed = await confirmedAgreement(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;
    const v1Before = immutableParts(await rawVersion(ref, 1));

    // decide / attach / re-confirm on the confirmed version
    const artifact = await seedArtifact("PARTNER", partner.partnerRef);
    const run = await seedRun(ref, artifact.artifactRef, [{ fieldKey: "currency", normalizedValue: "USD" }]);
    const dv = docVersionOf(confirmed);
    expect(failed(await decideField(manager, { agreementRef: ref, version: 1, expectedDocVersion: dv, fieldKey: "currency", decision: "CORRECTED", value: "USD" }, requestId()))).toMatchObject({ code: "conflict" });
    expect(failed(await attachExtractionProposals(manager, { agreementRef: ref, version: 1, expectedDocVersion: dv, extractionRunRef: run.runRef }, requestId()))).toMatchObject({ code: "conflict" });
    expect(failed(await confirmAgreementVersion(manager, { agreementRef: ref, version: 1, expectedDocVersion: dv }, requestId()))).toMatchObject({ code: "conflict" });
    expect(immutableParts(await rawVersion(ref, 1))).toBe(v1Before);
    expect((await rawVersion(ref, 1)).docVersion).toBe(dv);

    // activation only changes lifecycle fields
    const active = await activate(head, confirmed);
    expect(immutableParts(await rawVersion(ref, 1))).toBe(v1Before);
    expect(failed(await decideField(manager, { agreementRef: ref, version: 1, expectedDocVersion: active.selectedVersion!.docVersion, fieldKey: "currency", decision: "CORRECTED", value: "USD" }, requestId()))).toMatchObject({ code: "conflict" });

    // a revision, its decisions, its confirmation and its activation never touch version 1's confirmed parts
    const revised = must(await createAgreementRevision(head, { agreementRef: ref, expectedDocVersion: active.head.docVersion }, requestId()), "revise");
    const changed = await confirm(manager, await decideAll(manager, revised, [{ fieldKey: "fixedComponent", decision: "CORRECTED", value: { applicable: true, amountMinor: 6_000_000 } }]));
    expect(immutableParts(await rawVersion(ref, 1))).toBe(v1Before);
    await activate(head, await fresh(head, ref), 2);
    expect(immutableParts(await rawVersion(ref, 1))).toBe(v1Before);
    expect(changed.selectedVersion!.terms!.commercial.fixedComponent).toEqual({ applicable: true, amountMinor: 6_000_000 });
    expect((await rawVersion(ref, 1)).terms).toMatchObject({ commercial: { fixedComponent: { amountMinor: 5_000_000 } } });
  });
});

describe("activateAgreementVersion", () => {
  it("activates a confirmed draft: version ACTIVE, head ACTIVE with activeVersion, event in the same transaction; a Manager may not", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const confirmed = await confirmedAgreement(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;
    const input = { agreementRef: ref, version: 1, expectedDocVersion: confirmed.head.docVersion };

    const io = instrument();
    const denied = failed(await activateAgreementVersion(manager, input, requestId()));
    io.stop();
    expect(denied).toMatchObject({ code: "unauthorized", reason: "action_denied" });
    expect(io.writes).toEqual([]);
    expect((await rawHead(ref)).status).toBe("DRAFT");

    const io2 = instrument();
    const active = must(await activateAgreementVersion(head, input, requestId()), "activate");
    io2.stop();
    expect(active.head).toMatchObject({ status: "ACTIVE", activeVersion: 1, openVersion: null, docVersion: confirmed.head.docVersion + 1 });
    expect(active.selectedVersion).toMatchObject({ status: "ACTIVE", activatedByUserRef: head.userRef, supersededVersion: null });
    expect(await rawHead(ref)).toMatchObject({ status: "ACTIVE", activeVersion: 1, openVersion: null });
    // ONE transaction wrote the version, the head AND the event
    const written = transactionalWrites(io2);
    expect(written.length).toBe(3);
    expect(new Set(written.map((w) => w.tx)).size).toBe(1);
    expect(written.map((w) => w.path.split("/").slice(2).join("/").replace(/\/[0-9a-f-]{36}$/, "/<event>")).sort()).toEqual(["", "events/<event>", "versions/1"]);
    expect((await rawEvents(ref)).find((e) => e.kind === "activated")).toMatchObject({ version: 1, actorUserRef: head.userRef, metadata: { fromStatus: "DRAFT", toStatus: "ACTIVE", agreementType: "FIXED_PLUS_INCENTIVE_PLUS_REQUIRED_CONTENT", effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31" } });
  });

  it("refuses an unconfirmed version, an unknown version and a stale head docVersion; nothing is written", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const draftOnly = await newAgreement(manager, partnerCp(partner));
    const ref = draftOnly.agreement.head.agreementRef;
    const confirmed = await confirmedAgreement(manager, partnerCp(partner));
    const io = instrument();
    expect(failed(await activateAgreementVersion(head, { agreementRef: ref, version: 1, expectedDocVersion: 1 }, requestId()))).toMatchObject({ code: "conflict" });
    expect(failed(await activateAgreementVersion(head, { agreementRef: ref, version: 7, expectedDocVersion: 1 }, requestId()))).toMatchObject(NEUTRAL);
    expect(failed(await activateAgreementVersion(head, { agreementRef: confirmed.head.agreementRef, version: 1, expectedDocVersion: 99 }, requestId()))).toMatchObject({ code: "stale_write" });
    io.stop();
    expect(io.writes).toEqual([]);
    expect((await rawHead(confirmed.head.agreementRef)).status).toBe("DRAFT");
  });
});

describe("revision and supersession", () => {
  it("a revision opens the next DRAFT prefilled from the previous terms; the prior version stays ACTIVE until the replacement activates, then becomes SUPERSEDED in the same transaction", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const confirmed = await confirmedAgreement(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;
    const active = await activate(head, confirmed);

    const revised = must(await createAgreementRevision(head, { agreementRef: ref, expectedDocVersion: active.head.docVersion }, requestId()), "revise");
    expect(revised.head).toMatchObject({ status: "ACTIVE", activeVersion: 1, openVersion: 2, latestVersion: 2 });
    expect(revised.selectedVersion).toMatchObject({ version: 2, status: "DRAFT", confirmed: false });
    const draft2 = revised.selectedVersion!.draft;
    expect(draft2.fixedComponent).toMatchObject({ value: { applicable: true, amountMinor: 5_000_000 }, origin: "MANUAL", decision: "ACCEPTED" });
    expect(draft2.fixedComponent!.provenance.label).toBe("previous version 1");
    expect(draft2.effectiveDate?.value).toBe("2024-01-01");
    expect((await fresh(head, ref, 1)).selectedVersion!.status).toBe("ACTIVE");
    expect(revised.selectedVersion!.counterparty).toEqual(confirmed.selectedVersion!.counterparty);

    // a second revision while one is open is refused
    expect(failed(await createAgreementRevision(head, { agreementRef: ref, expectedDocVersion: revised.head.docVersion }, requestId()))).toMatchObject({ code: "conflict" });

    // prepare v2 (a Manager may) - v1 still governs
    const changed = await confirm(manager, await decideAll(manager, revised, [{ fieldKey: "terminationDate", decision: "CORRECTED", value: "2025-06-30" }]));
    expect(changed.selectedVersion!.confirmed).toBe(true);
    expect((await rawHead(ref))).toMatchObject({ status: "ACTIVE", activeVersion: 1, openVersion: 2 });
    expect((await rawVersion(ref, 1)).status).toBe("ACTIVE");

    const io = instrument();
    const replaced = must(await activateAgreementVersion(head, { agreementRef: ref, version: 2, expectedDocVersion: changed.head.docVersion }, requestId()), "activate v2");
    io.stop();
    expect(replaced.head).toMatchObject({ status: "ACTIVE", activeVersion: 2, openVersion: null });
    expect(replaced.selectedVersion).toMatchObject({ version: 2, status: "ACTIVE", supersededVersion: 1 });
    const v1 = await rawVersion(ref, 1);
    expect(v1).toMatchObject({ status: "SUPERSEDED", supersededByVersion: 2 });
    expect(governingCount(await rawVersions(ref))).toBe(1);
    // supersession is atomic: v2, v1, head and both events were written by ONE transaction
    const written = transactionalWrites(io);
    expect(written.length).toBe(5);
    expect(new Set(written.map((w) => w.tx)).size).toBe(1);
    const events = await rawEvents(ref);
    expect(events.find((e) => e.kind === "superseded")).toMatchObject({ version: 1, metadata: { fromStatus: "ACTIVE", toStatus: "SUPERSEDED", supersededByVersion: 2 } });
    expect(events.find((e) => e.kind === "revision_created")).toMatchObject({ version: 2, metadata: { previousVersion: 1, newVersion: 2 } });
    expect(must(await listAgreementVersions(head, ref), "versions").versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it("a Vendor Agreement's counterparty stays frozen when the Partner's active Vendor link later changes; a revision keeps the same counterparty snapshot", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const vendorOne = await seedVendor();
    const vendorTwo = await seedVendor();
    const now = new Date().toISOString();
    const link = (vendor: VendorDoc, status: "ACTIVE" | "ENDED", suffix: string) =>
      vendorPartnerLinkDocSchema.parse({
        uid: `fas-link-${runId}-${suffix}`,
        vendorPartnerLinkRef: `fas-link-ref-${runId}-${suffix}`,
        version: 1,
        vendorRef: vendor.vendorRef,
        partnerRef: partner.partnerRef,
        relationshipType: "PAYEE",
        payeeRole: true,
        effectiveFrom: "2020-01-01",
        effectiveTo: status === "ENDED" ? "2021-01-01" : null,
        status,
        createdAt: now,
        createdByUserRef: "fas-test",
        updatedAt: now,
        updatedByUserRef: "fas-test",
      });
    const first = link(vendorOne, "ACTIVE", "a");
    const firstRef = vendorPartnerLinksCollection().doc(first.uid);
    await firstRef.set(first);
    cleanup.push(firstRef);

    const vendorAgreement = await confirmedAgreement(manager, vendorCp(vendorOne));
    const partnerAgreement = await confirmedAgreement(manager, partnerCp(partner));
    const vendorActive = await activate(head, vendorAgreement);
    const before = immutableParts(await rawVersion(vendorAgreement.head.agreementRef, 1));

    // the Partner's active Vendor link changes: V1 ended, V2 becomes the active payee
    await firstRef.set(link(vendorOne, "ENDED", "a"));
    const second = link(vendorTwo, "ACTIVE", "b");
    const secondRef = vendorPartnerLinksCollection().doc(second.uid);
    await secondRef.set(second);
    cleanup.push(secondRef);

    const reread = await fresh(head, vendorAgreement.head.agreementRef);
    expect(reread.head.counterparty).toEqual({ type: "VENDOR", ref: vendorOne.vendorRef, partnerAccountRefs: [], platformScope: [] });
    expect(immutableParts(await rawVersion(vendorAgreement.head.agreementRef, 1))).toBe(before);
    const revised = must(await createAgreementRevision(head, { agreementRef: vendorAgreement.head.agreementRef, expectedDocVersion: vendorActive.head.docVersion }, requestId()), "revise");
    expect(revised.selectedVersion!.counterparty).toEqual(reread.head.counterparty);
    expect(revised.head.counterparty.ref).toBe(vendorOne.vendorRef);
    // the Partner Agreement is a separate agreement bound to the Partner
    expect((await fresh(head, partnerAgreement.head.agreementRef)).head.counterparty).toMatchObject({ type: "PARTNER", ref: partner.partnerRef });
  });
});

// =====================================================================================================================
// Suspend / resume / end
// =====================================================================================================================
describe("suspend, resume and end", () => {
  const REASON = "Contract paused pending legal review";

  it("suspend and end need a reason; a Manager may do none of them; history is preserved and nothing is deleted", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const confirmed = await confirmedAgreement(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;
    let current = await activate(head, confirmed);

    for (const action of [suspendAgreement, endAgreement]) {
      expect(failed(await action(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion }, requestId()))).toMatchObject({ code: "invalid_input" });
      expect(failed(await action(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion, reason: "ab" }, requestId()))).toMatchObject({ code: "invalid_input" });
    }
    const io = instrument();
    for (const [action, extra] of [[suspendAgreement, { reason: REASON }], [resumeAgreement, {}], [endAgreement, { reason: REASON }]] as const) {
      expect(failed(await action(manager, { agreementRef: ref, expectedDocVersion: current.head.docVersion, ...extra }, requestId()))).toMatchObject({ code: "unauthorized", reason: "action_denied" });
    }
    io.stop();
    expect(io.writes).toEqual([]);

    current = must(await suspendAgreement(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion, reason: REASON }, requestId()), "suspend");
    expect(current.head).toMatchObject({ status: "SUSPENDED", activeVersion: 1 });
    expect(current.selectedVersion).toMatchObject({ status: "SUSPENDED", suspendReason: REASON });
    expect(current.selectedVersion!.suspendedAt).not.toBeNull();
    // suspending twice is a lifecycle conflict
    expect(failed(await suspendAgreement(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion, reason: REASON }, requestId()))).toMatchObject({ code: "conflict" });

    current = must(await resumeAgreement(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion }, requestId()), "resume");
    expect(current.head.status).toBe("ACTIVE");
    expect(current.selectedVersion).toMatchObject({ status: "ACTIVE", suspendedAt: null, suspendReason: null });
    expect(failed(await resumeAgreement(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion }, requestId()))).toMatchObject({ code: "conflict" });

    current = must(await suspendAgreement(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion, reason: REASON }, requestId()), "suspend again");
    current = must(await endAgreement(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion, reason: "Relationship concluded by mutual consent" }, requestId()), "end from suspended");
    expect(current.head).toMatchObject({ status: "ENDED", activeVersion: null, lastEndedVersion: 1 });
    expect(current.selectedVersion).toMatchObject({ status: "ENDED", endReason: "Relationship concluded by mutual consent" });
    // ENDED is terminal
    for (const [action, extra] of [[suspendAgreement, { reason: REASON }], [resumeAgreement, {}], [endAgreement, { reason: REASON }]] as const) {
      expect(failed(await action(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion, ...extra }, requestId()))).toMatchObject({ code: "conflict" });
    }

    // history: versions still readable, every transition in the event trail with its reason
    expect((await fresh(head, ref, 1)).selectedVersion).toMatchObject({ status: "ENDED", confirmed: true });
    const kinds = (await rawEvents(ref)).map((e) => e.kind);
    for (const kind of ["created", "field_decided", "confirmed", "activated", "suspended", "resumed", "ended"]) expect(kinds).toContain(kind);
    expect(kinds.filter((k) => k === "suspended")).toHaveLength(2);
    expect((await rawEvents(ref)).find((e) => e.kind === "ended")!.metadata).toMatchObject({ fromStatus: "SUSPENDED", toStatus: "ENDED", headStatus: "ENDED", reason: "Relationship concluded by mutual consent" });
    // no delete function exists anywhere in the service surface
    expect(Object.keys(await import("./index")).filter((name) => /delete|remove|purge/i.test(name))).toEqual([]);
  });

  it("after an end a revision can be opened from the ended version and activated: the Agreement is ACTIVE again, the ended version stays ENDED", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const confirmed = await confirmedAgreement(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;
    let current = await activate(head, confirmed);
    current = must(await endAgreement(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion, reason: REASON }, requestId()), "end");
    const revised = must(await createAgreementRevision(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion }, requestId()), "revise");
    expect(revised.selectedVersion!.version).toBe(2);
    expect(revised.selectedVersion!.draft.fixedComponent!.provenance.label).toBe("previous version 1");
    const ready = await confirm(manager, revised);
    const active = must(await activateAgreementVersion(head, { agreementRef: ref, version: 2, expectedDocVersion: ready.head.docVersion }, requestId()), "activate");
    expect(active.head).toMatchObject({ status: "ACTIVE", activeVersion: 2, lastEndedVersion: 1 });
    const versions = await rawVersions(ref);
    expect(versions.map((v) => v.status)).toEqual(["ENDED", "ACTIVE"]);
    expect(governingCount(versions)).toBe(1);
  });
});

// =====================================================================================================================
// Concurrency
// =====================================================================================================================
// An ACTIVE version 1 plus a confirmed, not-yet-active version 2 (the head's open version).
async function activeWithConfirmedRevision(manager: ActorContext, head: ActorContext, partner: PartnerDoc) {
  const confirmed = await confirmedAgreement(manager, partnerCp(partner));
  const active = await activate(head, confirmed);
  const revised = must(await createAgreementRevision(head, { agreementRef: active.head.agreementRef, expectedDocVersion: active.head.docVersion }, requestId()), "revise");
  return confirm(manager, await decideAll(manager, revised, [{ fieldKey: "terminationDate", decision: "CORRECTED", value: "2025-06-30" }]));
}
const isLoser = (result: FinanceAgreementsServiceResult<unknown>) => !result.ok && (result.code === "stale_write" || result.code === "conflict");

describe("concurrency", () => {
  it("parallel activations of the SAME version: exactly one wins, the losers are stale/conflict, never two ACTIVE/SUSPENDED versions", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const ready = await activeWithConfirmedRevision(manager, head, partner);
    const ref = ready.head.agreementRef;
    const input = { agreementRef: ref, version: 2, expectedDocVersion: ready.head.docVersion };
    const results = await Promise.all([1, 2, 3].map(() => activateAgreementVersion(head, input, requestId())));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter(isLoser)).toHaveLength(2);
    const versions = await rawVersions(ref);
    expect(versions.map((v) => v.status)).toEqual(["SUPERSEDED", "ACTIVE"]);
    expect(governingCount(versions)).toBe(1);
    expect(await rawHead(ref)).toMatchObject({ status: "ACTIVE", activeVersion: 2, openVersion: null });
    expect((await rawEvents(ref)).filter((e) => e.kind === "activated" && e.version === 2)).toHaveLength(1);
  });

  it("parallel activations of two DIFFERENT confirmed versions (one a forged orphan) still leave exactly one ACTIVE", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const ready = await activeWithConfirmedRevision(manager, head, partner);
    const ref = ready.head.agreementRef;
    // forge an orphan confirmed version 3 that the head does not name as its open version
    await financeAgreementVersionsCollection(ref).doc("3").set({ ...(await rawVersion(ref, 2)), version: 3 });
    await financeAgreementsCollection().doc(ref).update({ latestVersion: 3 });

    const docVersion = ready.head.docVersion;
    const results = await Promise.all([
      activateAgreementVersion(head, { agreementRef: ref, version: 3, expectedDocVersion: docVersion }, requestId()),
      activateAgreementVersion(head, { agreementRef: ref, version: 2, expectedDocVersion: docVersion }, requestId()),
      activateAgreementVersion(head, { agreementRef: ref, version: 3, expectedDocVersion: docVersion }, requestId()),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const versions = await rawVersions(ref);
    expect(governingCount(versions)).toBe(1);
    expect(versions.map((v) => v.status)).toEqual(["SUPERSEDED", "ACTIVE", "DRAFT"]);
    expect(await rawHead(ref)).toMatchObject({ status: "ACTIVE", activeVersion: 2, openVersion: null });
    // the orphan can never be activated afterwards either (it is not the open version)
    const after = failed(await activateAgreementVersion(head, { agreementRef: ref, version: 3, expectedDocVersion: (await rawHead(ref)).docVersion as number }, requestId()));
    expect(after).toMatchObject({ code: "conflict" });
    expect(governingCount(await rawVersions(ref))).toBe(1);
  });

  it("an activation racing a suspend of the governing version: exactly one commits, the invariant holds either way", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const ready = await activeWithConfirmedRevision(manager, head, partner);
    const ref = ready.head.agreementRef;
    const docVersion = ready.head.docVersion;
    const [activated, suspended] = await Promise.all([
      activateAgreementVersion(head, { agreementRef: ref, version: 2, expectedDocVersion: docVersion }, requestId()),
      suspendAgreement(head, { agreementRef: ref, expectedDocVersion: docVersion, reason: "Paused during a dispute" }, requestId()),
    ]);
    expect([activated.ok, suspended.ok].filter(Boolean)).toHaveLength(1);
    expect([activated, suspended].filter(isLoser)).toHaveLength(1);
    const versions = await rawVersions(ref);
    expect(governingCount(versions)).toBe(1);
    const headDoc = await rawHead(ref);
    expect(headDoc.activeVersion).toBe(activated.ok ? 2 : 1);
    expect(versions.find((v) => v.version === headDoc.activeVersion)!.status).toBe(activated.ok ? "ACTIVE" : "SUSPENDED");
  });

  it("parallel revision requests create exactly one next version", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const active = await activate(head, await confirmedAgreement(manager, partnerCp(partner)));
    const ref = active.head.agreementRef;
    const results = await Promise.all([1, 2, 3].map(() => createAgreementRevision(head, { agreementRef: ref, expectedDocVersion: active.head.docVersion }, requestId())));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter(isLoser)).toHaveLength(2);
    expect((await rawVersions(ref)).map((v) => v.version)).toEqual([1, 2]);
    expect((await rawEvents(ref)).filter((e) => e.kind === "revision_created")).toHaveLength(1);
    expect(await rawHead(ref)).toMatchObject({ latestVersion: 2, openVersion: 2 });
  });

  it("parallel decisions / confirmations carrying the same expectedDocVersion: one wins, the rest are stale; one confirmed event", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const created = await newAgreement(manager, partnerCp(partner));
    const ref = created.agreement.head.agreementRef;
    const decide = (fieldKey: string, value: unknown) => decideField(manager, { agreementRef: ref, version: 1, expectedDocVersion: 1, fieldKey, decision: "CORRECTED", value }, requestId());
    const decisions = await Promise.all([decide("currency", "INR"), decide("paymentCycle", "MONTHLY")]);
    expect(decisions.filter((r) => r.ok)).toHaveLength(1);
    expect(decisions.filter((r) => !r.ok && r.code === "stale_write")).toHaveLength(1);
    expect((await rawEvents(ref)).filter((e) => e.kind === "field_decided")).toHaveLength(1);

    const confirmedOnce = await confirmedAgreement(manager, partnerCp(partner));
    const ref2 = confirmedOnce.head.agreementRef;
    // (already confirmed: three more attempts all lose)
    const again = await Promise.all([1, 2, 3].map(() => confirmAgreementVersion(manager, { agreementRef: ref2, version: 1, expectedDocVersion: docVersionOf(confirmedOnce) }, requestId())));
    expect(again.every((r) => !r.ok)).toBe(true);

    const ready = await decideAll(manager, await acceptPending(manager, (await newAgreement(manager, partnerCp(partner))).agreement), READY_DECISIONS);
    const ref3 = ready.head.agreementRef;
    const racers = await Promise.all([1, 2, 3].map(() => confirmAgreementVersion(manager, { agreementRef: ref3, version: 1, expectedDocVersion: docVersionOf(ready) }, requestId())));
    expect(racers.filter((r) => r.ok)).toHaveLength(1);
    expect(racers.filter(isLoser)).toHaveLength(2);
    expect((await rawEvents(ref3)).filter((e) => e.kind === "confirmed")).toHaveLength(1);
  });
});

// =====================================================================================================================
// The five-role matrix through REAL grants
// =====================================================================================================================
describe("five-role matrix", () => {
  const ABSENT = "feature_denied";

  type Fixture = { draft: AgreementDetailDto; live: AgreementDetailDto; partner: PartnerDoc; run: Awaited<ReturnType<typeof seedRun>> };
  async function fixtures(): Promise<Fixture> {
    const prep = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const draft = (await newAgreement(prep, partnerCp(partner))).agreement;
    const artifact = await seedArtifact("PARTNER", partner.partnerRef);
    const run = await seedRun(draft.head.agreementRef, artifact.artifactRef, [{ fieldKey: "currency", normalizedValue: "INR" }]);
    const live = await activate(prep, await confirmedAgreement(prep, partnerCp(partner)));
    return { draft, live, partner, run };
  }

  // Every service, called with the given actor against the fixture. Inputs are all VALID so only authorization can refuse them.
  function calls(actor: ActorContext | null, f: Fixture) {
    const d = f.draft.head.agreementRef;
    const l = f.live.head.agreementRef;
    const expectedLive = f.live.head.docVersion;
    return {
      create: () => createAgreementDraft(actor, { clientRequestId: `crid-${runId}-mx-${randomUUID().slice(0, 8)}`, counterparty: partnerCp(f.partner) }, requestId()),
      decide: () => decideField(actor, { agreementRef: d, version: 1, expectedDocVersion: 1, fieldKey: "currency", decision: "CORRECTED", value: "INR" }, requestId()),
      attach: () => attachExtractionProposals(actor, { agreementRef: d, version: 1, expectedDocVersion: 1, extractionRunRef: f.run.runRef }, requestId()),
      confirm: () => confirmAgreementVersion(actor, { agreementRef: d, version: 1, expectedDocVersion: 1 }, requestId()),
      activate: () => activateAgreementVersion(actor, { agreementRef: l, version: 1, expectedDocVersion: expectedLive }, requestId()),
      revise: () => createAgreementRevision(actor, { agreementRef: l, expectedDocVersion: expectedLive }, requestId()),
      suspend: () => suspendAgreement(actor, { agreementRef: l, expectedDocVersion: expectedLive, reason: "Paused for review" }, requestId()),
      resume: () => resumeAgreement(actor, { agreementRef: l, expectedDocVersion: expectedLive }, requestId()),
      end: () => endAgreement(actor, { agreementRef: l, expectedDocVersion: expectedLive, reason: "Concluded by consent" }, requestId()),
      detail: () => getAgreementDetail(actor, l),
      versions: () => listAgreementVersions(actor, l),
      events: () => listAgreementEvents(actor, l),
      forCounterparty: () => listAgreementsForCounterparty(actor, { counterpartyType: "PARTNER", ref: f.partner.partnerRef }),
      reconciliation: () => getDraftFieldsForReconciliation(actor, d),
    };
  }
  const WRITES = ["create", "decide", "attach", "confirm", "activate", "revise", "suspend", "resume", "end"] as const;
  const READS = ["detail", "versions", "events", "forCounterparty", "reconciliation"] as const;

  it("an unauthenticated caller is refused everywhere (not_authenticated) and writes nothing", async () => {
    const f = await fixtures();
    const io = instrument();
    for (const [name, call] of Object.entries(calls(null, f))) expect(await call(), name).toMatchObject({ ok: false, code: "unauthorized", reason: "not_authenticated" });
    io.stop();
    expect(io.writes).toEqual([]);
  });

  it("Viewer and Analyst hold no Finance grant: every command AND read is denied at the feature layer; denied attempts write nothing", async () => {
    const f = await fixtures();
    const before = JSON.stringify([await rawHead(f.draft.head.agreementRef), await rawVersions(f.draft.head.agreementRef), await rawHead(f.live.head.agreementRef), await rawVersions(f.live.head.agreementRef)]);
    for (const role of ["viewer", "analyst"] as const) {
      const actor = await syntheticActor(role);
      const io = instrument();
      for (const name of [...WRITES, ...READS]) expect(await calls(actor, f)[name](), `${role} ${name}`).toMatchObject({ ok: false, code: "unauthorized", reason: ABSENT });
      io.stop();
      expect(io.writes, role).toEqual([]);
    }
    const after = JSON.stringify([await rawHead(f.draft.head.agreementRef), await rawVersions(f.draft.head.agreementRef), await rawHead(f.live.head.agreementRef), await rawVersions(f.live.head.agreementRef)]);
    expect(after).toBe(before);
  });

  it("Manager: create / decide / attach / confirm and every read are allowed; activate / revise / suspend / resume / end are denied (action_denied) and write nothing", async () => {
    const f = await fixtures();
    const manager = await syntheticActor("partnership_manager");
    const c = calls(manager, f);
    must(await c.create(), "create");
    for (const name of READS) expect((await c[name]()).ok, name).toBe(true);

    const decided = must(await c.decide(), "decide");
    expect(decided.selectedVersion!.draft.currency).toMatchObject({ value: "INR", decision: "CORRECTED", decidedByUserRef: manager.userRef });
    must(await attachExtractionProposals(manager, { agreementRef: f.draft.head.agreementRef, version: 1, expectedDocVersion: docVersionOf(decided), extractionRunRef: f.run.runRef }, requestId()), "attach");
    // stale docVersion 1: authorization passed, so this is a lifecycle refusal (stale_write), not a denial
    expect(failed(await c.confirm())).toMatchObject({ code: "stale_write" });

    const io = instrument();
    for (const name of ["activate", "revise", "suspend", "resume", "end"] as const) expect(await c[name](), name).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });
    io.stop();
    expect(io.writes).toEqual([]);
    expect((await rawHead(f.live.head.agreementRef)).status).toBe("ACTIVE");
  });

  it("Head holds every action: prepare AND lifecycle (activate -> suspend -> resume -> end); Super Admin holds them explicitly", async () => {
    for (const actorOf of [() => syntheticActor("partnership_head"), () => seededActor("super_admin")]) {
      const actor = await actorOf();
      const partner = await seedPartner();
      const confirmed = await confirmedAgreement(actor, partnerCp(partner)); // create, decide, confirm as this actor
      const ref = confirmed.head.agreementRef;
      let current = await activate(actor, confirmed);
      current = must(await suspendAgreement(actor, { agreementRef: ref, expectedDocVersion: current.head.docVersion, reason: "Paused for review" }, requestId()), "suspend");
      current = must(await resumeAgreement(actor, { agreementRef: ref, expectedDocVersion: current.head.docVersion }, requestId()), "resume");
      const revised = must(await createAgreementRevision(actor, { agreementRef: ref, expectedDocVersion: current.head.docVersion }, requestId()), "revise");
      expect(revised.head.openVersion).toBe(2);
      current = must(await endAgreement(actor, { agreementRef: ref, expectedDocVersion: revised.head.docVersion, reason: "Concluded by consent" }, requestId()), "end");
      expect(current.head.status).toBe("ENDED");
    }
  });
});

// =====================================================================================================================
// Neutral denial + live scope
// =====================================================================================================================
describe("neutral denial", () => {
  it("an out-of-scope caller gets the SAME neutral outcome as for an unknown agreement - on every read and command", async () => {
    const outHead = await syntheticActor("partnership_head", [{ type: "REGION", region: R_OUT }]);
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const draft = (await newAgreement(manager, partnerCp(partner))).agreement;
    const live = await activate(await syntheticActor("partnership_head"), await confirmedAgreement(manager, partnerCp(partner)));
    const unknownRef = generateAgreementRef();
    const artifact = await seedArtifact("PARTNER", partner.partnerRef);
    const run = await seedRun(draft.head.agreementRef, artifact.artifactRef, [{ fieldKey: "currency", normalizedValue: "INR" }]);

    const attempt = (agreementRef: string) => ({
      detail: getAgreementDetail(outHead, agreementRef),
      versions: listAgreementVersions(outHead, agreementRef),
      events: listAgreementEvents(outHead, agreementRef),
      reconciliation: getDraftFieldsForReconciliation(outHead, agreementRef),
      decide: decideField(outHead, { agreementRef, version: 1, expectedDocVersion: 1, fieldKey: "currency", decision: "CORRECTED", value: "INR" }, requestId()),
      attach: attachExtractionProposals(outHead, { agreementRef, version: 1, expectedDocVersion: 1, extractionRunRef: run.runRef }, requestId()),
      confirm: confirmAgreementVersion(outHead, { agreementRef, version: 1, expectedDocVersion: 1 }, requestId()),
      activate: activateAgreementVersion(outHead, { agreementRef, version: 1, expectedDocVersion: 1 }, requestId()),
      revise: createAgreementRevision(outHead, { agreementRef, expectedDocVersion: 1 }, requestId()),
      suspend: suspendAgreement(outHead, { agreementRef, expectedDocVersion: 1, reason: "Paused for review" }, requestId()),
      resume: resumeAgreement(outHead, { agreementRef, expectedDocVersion: 1 }, requestId()),
      end: endAgreement(outHead, { agreementRef, expectedDocVersion: 1, reason: "Concluded by consent" }, requestId()),
    });
    const before = JSON.stringify([await rawHead(draft.head.agreementRef), await rawVersions(draft.head.agreementRef), await rawHead(live.head.agreementRef), await rawVersions(live.head.agreementRef)]);
    const io = instrument();
    for (const ref of [draft.head.agreementRef, live.head.agreementRef]) {
      const unknown = attempt(unknownRef);
      const real = attempt(ref);
      for (const name of Object.keys(real) as Array<keyof ReturnType<typeof attempt>>) {
        const [r, u] = await Promise.all([real[name], unknown[name]]);
        expect(r, name).toEqual(u);
        expect(r, name).toMatchObject(NEUTRAL);
      }
    }
    io.stop();
    expect(io.writes).toEqual([]);
    expect(JSON.stringify([await rawHead(draft.head.agreementRef), await rawVersions(draft.head.agreementRef), await rawHead(live.head.agreementRef), await rawVersions(live.head.agreementRef)])).toBe(before);
  });

  it("creating against an out-of-scope, unknown, forged or foreign-account counterparty is the same neutral outcome and writes nothing", async () => {
    const manager = await syntheticActor("partnership_manager");
    const outPartner = await seedPartner({ regionIds: [R_OUT] });
    const outVendor = await seedVendor({ regionIds: [R_OUT] });
    const mine = await seedPartner();
    const foreign = await seedAccount(outPartner, "instagram");
    const io = instrument();
    const attempts = await Promise.all(
      [
        partnerCp(outPartner),
        { type: "PARTNER" as const, partnerRef: `nope-${runId}` },
        partnerCp(mine, [foreign.partnerAccountRef]),
        vendorCp(outVendor),
        { type: "VENDOR" as const, vendorRef: mine.partnerRef },
      ].map((counterparty, index) => createAgreementDraft(manager, { clientRequestId: `crid-${runId}-neutral-${index}-${randomUUID().slice(0, 6)}`, counterparty }, requestId())),
    );
    io.stop();
    for (const attempt of attempts) expect(attempt).toEqual(NEUTRAL);
    expect(io.writes).toEqual([]);
    expect(await headCountFor(mine.partnerRef)).toBe(0);
  });

  it("a syntactically valid but forged agreementRef is not_found; a malformed one is rejected at the input layer; scope grants key on the doc uid, not the ref", async () => {
    const manager = await syntheticActor("partnership_manager");
    expect(await getAgreementDetail(manager, `agr_${"0".repeat(20)}`)).toMatchObject(NEUTRAL);
    expect(await getAgreementDetail(manager, "not-an-agreement-ref")).toMatchObject(NEUTRAL);
    expect(failed(await confirmAgreementVersion(manager, { agreementRef: "not-an-agreement-ref", version: 1, expectedDocVersion: 1 }, requestId()))).toMatchObject({ code: "invalid_input" });
    expect(failed(await confirmAgreementVersion(manager, { agreementRef: `agr_${"0".repeat(20)}`, version: 1, expectedDocVersion: 1, scope: "GLOBAL" }, requestId()))).toMatchObject({ code: "invalid_input" });

    const partner = await seedPartner({ regionIds: [R_OUT] });
    const byUid = await syntheticActor("partnership_manager", [{ type: "EXPLICIT_RECORD", resourceType: "partner", resourceId: partner.uid }]);
    const byRef = await syntheticActor("partnership_manager", [{ type: "EXPLICIT_RECORD", resourceType: "partner", resourceId: partner.partnerRef }]);
    const created = await newAgreement(byUid, partnerCp(partner));
    expect((await getAgreementDetail(byUid, created.agreement.head.agreementRef)).ok).toBe(true);
    expect(await getAgreementDetail(byRef, created.agreement.head.agreementRef)).toMatchObject(NEUTRAL);
  });

  it("scope is LIVE: moving the Partner out of the actor's region hides its Agreement at once; moving it back restores access", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const created = await newAgreement(manager, partnerCp(partner));
    const ref = created.agreement.head.agreementRef;
    expect((await getAgreementDetail(manager, ref)).ok).toBe(true);
    const partnerDoc = partnersCollection().doc(partner.uid);
    await partnerDoc.update({ regionIds: [R_OUT] });
    expect(await getAgreementDetail(manager, ref)).toMatchObject(NEUTRAL);
    expect(failed(await decideField(manager, { agreementRef: ref, version: 1, expectedDocVersion: 1, fieldKey: "currency", decision: "CORRECTED", value: "INR" }, requestId()))).toMatchObject(NEUTRAL);
    // the head's stale scope snapshot never grants anything
    expect((await rawHead(ref)).regionIds).toEqual([R_IN]);
    await partnerDoc.update({ regionIds: [R_IN] });
    expect((await getAgreementDetail(manager, ref)).ok).toBe(true);
  });
});

// =====================================================================================================================
// Audit events
// =====================================================================================================================
describe("audit events", () => {
  it("every mutation appends its event IN THE SAME transaction; nothing restricted, no contract text and no amount is ever in an event", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner({ email: "events@example.test" });
    await seedRestrictedIdentity({ type: "PARTNER", uid: partner.uid, ref: partner.partnerRef }, { pan: true, bank: true, aadhaar: true, gst: "number" });
    const clientRequestId = `crid-${runId}-events-${randomUUID().slice(0, 6)}`;
    claimIds.push(agreementClaimId(manager.uid, clientRequestId));

    const perTx = new Map<string, WriteRecord[]>();
    const capture = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
      const io = instrument();
      const value = await run();
      io.stop();
      perTx.set(label, transactionalWrites(io));
      return value;
    };

    const created = must(await capture("create", () => createAgreementDraft(manager, { clientRequestId, counterparty: partnerCp(partner) }, requestId())), "create");
    const ref = created.agreement.head.agreementRef;
    agreementRefs.push(ref);
    const decided = await capture("decide", () => decideAll(manager, created.agreement, [READY_DECISIONS[0]!]));
    const rest = await decideAll(manager, decided, READY_DECISIONS.slice(1));
    const ready = await acceptPending(manager, rest);
    const confirmed = must(await capture("confirm", () => confirmAgreementVersion(manager, { agreementRef: ref, version: 1, expectedDocVersion: docVersionOf(ready) }, requestId())), "confirm");
    const active = must(await capture("activate", () => activateAgreementVersion(head, { agreementRef: ref, version: 1, expectedDocVersion: confirmed.head.docVersion }, requestId())), "activate");
    const suspended = must(await capture("suspend", () => suspendAgreement(head, { agreementRef: ref, expectedDocVersion: active.head.docVersion, reason: "Paused during onboarding review" }, requestId())), "suspend");
    const resumed = must(await capture("resume", () => resumeAgreement(head, { agreementRef: ref, expectedDocVersion: suspended.head.docVersion }, requestId())), "resume");
    const revised = must(await capture("revise", () => createAgreementRevision(head, { agreementRef: ref, expectedDocVersion: resumed.head.docVersion }, requestId())), "revise");
    must(await capture("end", () => endAgreement(head, { agreementRef: ref, expectedDocVersion: revised.head.docVersion, reason: "Relationship concluded" }, requestId())), "end");

    // shape of each transaction: {claim?, head, version, event}
    const shape = (label: string) => perTx.get(label)!.map((w) => w.path.split("/").slice(0, 1).concat(w.path.split("/").length > 2 ? w.path.split("/")[2]! : "head").join(":")).sort();
    expect(shape("create")).toEqual(["financeAgreementClaims:head", "financeAgreements:events", "financeAgreements:head", "financeAgreements:versions"]);
    // Step 14B (intended change): decide / confirm ALSO rewrite the head - only its `display` list projection (+ updatedAt), never
    // docVersion or a lifecycle pointer (proved in finance-agreements-workspace.emulator.test.ts) - inside the same transaction.
    for (const label of ["decide", "confirm"]) expect(shape(label), label).toEqual(["financeAgreements:events", "financeAgreements:head", "financeAgreements:versions"]);
    for (const label of ["suspend", "resume", "end"]) expect(shape(label), label).toEqual(["financeAgreements:events", "financeAgreements:head", "financeAgreements:versions"]);
    expect(shape("revise")).toEqual(["financeAgreements:events", "financeAgreements:head", "financeAgreements:versions"]);
    expect(shape("activate")).toEqual(["financeAgreements:events", "financeAgreements:head", "financeAgreements:versions"]);
    for (const [label, writes] of perTx) expect(new Set(writes.map((w) => w.tx)).size, label).toBe(1);

    const events = await rawEvents(ref);
    const kinds = events.map((e) => e.kind);
    const prefilledOutsideReady = Object.keys(created.agreement.selectedVersion!.draft).filter((key) => !READY_DECISIONS.some((seed) => seed.fieldKey === key)).length;
    expect(kinds.filter((k) => k === "field_decided")).toHaveLength(READY_DECISIONS.length + prefilledOutsideReady);
    for (const kind of ["created", "confirmed", "activated", "suspended", "resumed", "revision_created", "ended"]) expect(kinds.filter((k) => k === kind), kind).toHaveLength(1);

    // allowlisted keys only, and not one restricted / contract / amount / contact value in any event
    for (const event of events) {
      for (const key of Object.keys(event.metadata ?? {})) expect(Object.keys(AGREEMENT_EVENT_METADATA_ALLOWLIST), `${event.kind}.${key}`).toContain(key);
      expect(Object.keys(event).sort()).toEqual(["actorUserRef", "createdAt", "kind", "metadata", "requestId", "version"]);
    }
    const text = JSON.stringify(events);
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    for (const leak of ["events@example.test", "5000000", "250000", "Creation and posting", "Acme Talent", "INR", "Invoice by the 5th"]) expect(text, leak).not.toContain(leak);
    expect(events.find((e) => e.kind === "field_decided")!.metadata).toEqual({ fieldKey: expect.any(String), decision: expect.any(String) });
  });

  it("listAgreementEvents is bounded, newest first, redacted; an invalid limit is rejected", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const confirmed = await confirmedAgreement(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;
    const all = must(await listAgreementEvents(manager, ref), "events");
    expect(all.events.length).toBeGreaterThan(10);
    expect(all.events[0]!.kind).toBe("confirmed");
    expect(all.events.map((e) => e.createdAt)).toEqual([...all.events.map((e) => e.createdAt)].sort().reverse());
    const one = must(await listAgreementEvents(manager, ref, { limit: 1 }), "one");
    expect(one.events).toHaveLength(1);
    expect(one.hasMore).toBe(true);
    for (const limit of [0, -1, 101, 1.5, "5"]) expect(failed(await listAgreementEvents(manager, ref, { limit })), String(limit)).toMatchObject({ code: "invalid_input" });
    expect(JSON.stringify(all.events)).not.toMatch(/agreementRef|"uid"/);
  });
});

// =====================================================================================================================
// Commercial terms
// =====================================================================================================================
function collectKeys(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((child) => collectKeys(child, into));
  else if (node && typeof node === "object") {
    for (const [key, child] of Object.entries(node)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

describe("commercial terms", () => {
  it("round-trip: required content count + qualifying unit, minor-unit fixed amount, explicit LFC/SFC, incentive slabs, invoice/payment terms; targets are ALWAYS affectsPayment:false", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const confirmed = await confirmedAgreement(manager, partnerCp(partner));
    const raw = await rawVersion(confirmed.head.agreementRef, 1);
    const terms = confirmedAgreementTermsSchema.parse(raw.terms);
    expect(terms.commercial).toEqual({
      currency: "INR",
      paymentCycle: "MONTHLY",
      fixedComponent: { applicable: true, amountMinor: 5_000_000 },
      monthlyRequiredQualifyingContentCount: 8,
      qualifyingUnit: "reel",
      accountTransferFee: { applicable: false, amountMinor: null, details: null },
      advancePayment: { applicable: false, details: null, amountMinor: null },
      invoiceRequired: true,
      invoiceDueTerms: "Invoice by the 5th of the following month",
      paymentDueTerms: "Payment within 30 days of invoice",
      servicesMandated: "Creation and posting of short-form video content",
      incentive: SAMPLE_INCENTIVE,
      lfcSfc: { byFormat: { reel: "SFC" } },
    });
    expect(terms.dates).toEqual({ signedDate: "2023-12-20", effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31" });
    expect(terms.performanceTargets).toEqual(SAMPLE_TARGETS);
    for (const target of terms.performanceTargets) expect(target.affectsPayment).toBe(false);
    expect(terms.agreementType).toBe("FIXED_PLUS_INCENTIVE_PLUS_REQUIRED_CONTENT");
    expect(confirmed.selectedVersion!.terms).toEqual(terms);
  });

  it("a target that affects payment cannot be stored; LFC/SFC is recorded only when explicit (UNAVAILABLE -> null, never guessed)", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const created = await newAgreement(manager, partnerCp(partner));
    const bad = decideField(manager, { agreementRef: created.agreement.head.agreementRef, version: 1, expectedDocVersion: 1, fieldKey: "performanceTargets", decision: "CORRECTED", value: [{ ...SAMPLE_TARGETS[0], affectsPayment: true }] }, requestId());
    expect(failed(await bad)).toMatchObject({ code: "invalid_input" });
    expect((await rawVersion(created.agreement.head.agreementRef, 1)).docVersion).toBe(1);

    const seeds = READY_DECISIONS.map((s) => (s.fieldKey === "lfcSfc" ? ({ fieldKey: "lfcSfc", decision: "UNAVAILABLE" } as FieldDecisionSeed) : s));
    const confirmed = await confirmedAgreement(manager, partnerCp(partner), seeds);
    expect(confirmed.selectedVersion!.terms!.commercial.lfcSfc).toBeNull();
  });

  it("an amount without a currency, a required count without its unit, and a value of the wrong shape all block confirmation", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const seeds = READY_DECISIONS.map((s) => (s.fieldKey === "currency" ? ({ fieldKey: "currency", decision: "UNAVAILABLE" } as FieldDecisionSeed) : s.fieldKey === "qualifyingUnit" ? ({ fieldKey: "qualifyingUnit", decision: "UNAVAILABLE" } as FieldDecisionSeed) : s));
    const created = await newAgreement(manager, partnerCp(partner));
    const ready = await acceptPending(manager, await decideAll(manager, created.agreement, seeds));
    const blocked = failed(await confirmAgreementVersion(manager, { agreementRef: ready.head.agreementRef, version: 1, expectedDocVersion: docVersionOf(ready) }, requestId()));
    expect(blocked).toMatchObject({ code: "not_ready" });
    expect(blocked.blockers!.map((b) => b.fieldKey)).toEqual(expect.arrayContaining(["currency", "qualifyingUnit"]));

    // a wrong-shaped value never reaches the draft
    for (const [fieldKey, value] of [["currency", "rupees"], ["paymentCycle", "SOMETIMES"], ["fixedComponent", { applicable: true }], ["effectiveDate", "01/04/2025"], ["pinCode", "12345"]] as const) {
      expect(failed(await decideField(manager, { agreementRef: ready.head.agreementRef, version: 1, expectedDocVersion: docVersionOf(ready), fieldKey, decision: "CORRECTED", value }, requestId())), fieldKey).toMatchObject({ code: "invalid_input" });
    }
    // identity VALUE fields and computed fields take no value at all
    for (const fieldKey of ["panNumber", "bankAccountNumber", "gstin"] as const) {
      expect(failed(await decideField(manager, { agreementRef: ready.head.agreementRef, version: 1, expectedDocVersion: docVersionOf(ready), fieldKey, decision: "CORRECTED", value: "X" }, requestId())), fieldKey).toMatchObject({ code: "invalid_input" });
      expect(failed(await decideField(manager, { agreementRef: ready.head.agreementRef, version: 1, expectedDocVersion: docVersionOf(ready), fieldKey, decision: "ACCEPTED", value: "X" }, requestId())), fieldKey).toMatchObject({ code: "invalid_input" });
    }
    expect(failed(await decideField(manager, { agreementRef: ready.head.agreementRef, version: 1, expectedDocVersion: docVersionOf(ready), fieldKey: "agreementType", decision: "ACCEPTED" }, requestId()))).toMatchObject({ code: "invalid_input" });
  });

  it("no Campaign / Assignment / Deliverable / Creator linkage field exists on any stored Agreement document", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const confirmed = await confirmedAgreement(manager, partnerCp(partner));
    const keys = collectKeys([await rawHead(confirmed.head.agreementRef), await rawVersions(confirmed.head.agreementRef), await rawEvents(confirmed.head.agreementRef)]);
    expect([...keys].filter((key) => /campaign|assignment|deliverable|creator|payable|invoiceRef|paymentRef/i.test(key))).toEqual([]);
    expect(keys.size).toBeGreaterThan(50);
  });
});

// =====================================================================================================================
// Reads: detail, KYC status visibility, per-counterparty list, reconciliation seam
// =====================================================================================================================
describe("reads", () => {
  it("detail defaults to the open version, else the active one, else the newest; a requested version is honoured; a bad or unknown version is refused", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const confirmed = await confirmedAgreement(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;
    expect((await fresh(manager, ref)).selectedVersion!.version).toBe(1); // open (confirmed, not yet active)
    const active = await activate(head, confirmed);
    expect(active.selectedVersion!.status).toBe("ACTIVE");
    const revised = must(await createAgreementRevision(head, { agreementRef: ref, expectedDocVersion: active.head.docVersion }, requestId()), "revise");
    expect((await fresh(manager, ref)).selectedVersion!.version).toBe(2); // open beats active
    expect((await fresh(manager, ref, 1)).selectedVersion).toMatchObject({ version: 1, status: "ACTIVE" });
    expect(revised.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(failed(await getAgreementDetail(manager, ref, { version: 0 }))).toMatchObject({ code: "invalid_input" });
    expect(failed(await getAgreementDetail(manager, ref, { version: "1" }))).toMatchObject({ code: "invalid_input" });
    expect(await getAgreementDetail(manager, ref, { version: 9 })).toMatchObject(NEUTRAL);
  });

  it("KYC: the state is visible to any authorized reader, per-component detail only with the owning identity category; values never", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    await seedRestrictedIdentity({ type: "PARTNER", uid: partner.uid, ref: partner.partnerRef }, { pan: true, bank: true, gst: "not_applicable" });
    const vendor = await seedVendor();
    await seedRestrictedIdentity({ type: "VENDOR", uid: vendor.uid, ref: vendor.vendorRef }, { pan: true });

    const partnerAgreement = await confirmedAgreement(manager, partnerCp(partner));
    const asManager = (await fresh(manager, partnerAgreement.head.agreementRef)).selectedVersion!.identityStatus!;
    expect(asManager).toMatchObject({ state: "AVAILABLE", valuesVisible: false, components: { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" } });
    const asHead = (await fresh(head, partnerAgreement.head.agreementRef)).selectedVersion!.identityStatus!;
    expect(asHead).toMatchObject({ state: "AVAILABLE", valuesVisible: false, components: { pan: "PRESENT", aadhaar: "MISSING", gst: "NOT_APPLICABLE", bank: "PRESENT" } });

    const vendorAgreement = await confirmedAgreement(manager, vendorCp(vendor));
    expect((await fresh(manager, vendorAgreement.head.agreementRef)).selectedVersion!.identityStatus).toMatchObject({ state: "INCOMPLETE", components: { pan: "RESTRICTED", bank: "RESTRICTED" } });
    expect((await fresh(head, vendorAgreement.head.agreementRef)).selectedVersion!.identityStatus).toMatchObject({ state: "INCOMPLETE", components: { pan: "PRESENT", aadhaar: "NOT_APPLICABLE", bank: "MISSING" } });
    expect(JSON.stringify([asManager, asHead])).not.toContain(SECRETS.pan);
  });

  it("listAgreementsForCounterparty: only that counterparty's heads, newest first, live scope; a forged head and a neighbour are excluded; out-of-scope is neutral", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const neighbour = await seedPartner();
    const vendor = await seedVendor();
    const first = await newAgreement(manager, partnerCp(partner));
    await decideAll(manager, first.agreement, [{ fieldKey: "currency", decision: "CORRECTED", value: "INR" }]); // bumps only the version
    const second = await newAgreement(manager, partnerCp(partner));
    await newAgreement(manager, partnerCp(neighbour));
    const vendorAgreement = await newAgreement(manager, vendorCp(vendor));
    // a forged head that names this Partner but carries another partnerUid must not be listed
    const forgedRef = generateAgreementRef();
    const now = new Date().toISOString();
    await financeAgreementsCollection().doc(forgedRef).set({ ...(await rawHead(first.agreement.head.agreementRef)), agreementRef: forgedRef, partnerUid: "someone-else", createdAt: now, updatedAt: now });
    agreementRefs.push(forgedRef);

    const listed = must(await listAgreementsForCounterparty(manager, { counterpartyType: "PARTNER", ref: partner.partnerRef }), "list");
    expect(listed.agreements.map((a) => a.agreementRef)).toEqual([second.agreement.head.agreementRef, first.agreement.head.agreementRef]);
    expect(listed.hasMore).toBe(false);
    for (const agreement of listed.agreements) expect(agreement.counterparty.ref).toBe(partner.partnerRef);
    expect(must(await listAgreementsForCounterparty(manager, { counterpartyType: "VENDOR", ref: vendor.vendorRef }), "vendor list").agreements.map((a) => a.agreementRef)).toEqual([vendorAgreement.agreement.head.agreementRef]);

    const outsider = await syntheticActor("partnership_manager", [{ type: "REGION", region: R_OUT }]);
    expect(failed(await listAgreementsForCounterparty(outsider, { counterpartyType: "PARTNER", ref: partner.partnerRef }))).toMatchObject(NEUTRAL);
    expect(failed(await listAgreementsForCounterparty(manager, { counterpartyType: "VENDOR", ref: partner.partnerRef }))).toMatchObject(NEUTRAL);
    expect(failed(await listAgreementsForCounterparty(manager, { counterpartyType: "PARTNER", ref: partner.partnerRef, limit: 500 }))).toMatchObject({ code: "invalid_input" });
    expect(JSON.stringify(listed)).not.toMatch(/partnerUid|regionIds|ownerUid/);
  });

  it("getDraftFieldsForReconciliation: the working draft (unconfirmed) or the frozen terms (confirmed) - never a restricted value", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner({ email: "recon@example.test" });
    await seedRestrictedIdentity({ type: "PARTNER", uid: partner.uid, ref: partner.partnerRef }, { pan: true, bank: true });
    const created = await newAgreement(manager, partnerCp(partner));
    const artifact = await seedArtifact("PARTNER", partner.partnerRef);
    const run = await seedRun(created.agreement.head.agreementRef, artifact.artifactRef, [{ fieldKey: "currency", normalizedValue: "INR" }, { fieldKey: "panNumber", normalizedValue: null }]);
    must(await attachExtractionProposals(manager, { agreementRef: created.agreement.head.agreementRef, version: 1, expectedDocVersion: 1, extractionRunRef: run.runRef }, requestId()), "attach");

    const draftFields = must(await getDraftFieldsForReconciliation(manager, created.agreement.head.agreementRef), "draft fields");
    expect(draftFields).toMatchObject({ agreementRef: created.agreement.head.agreementRef, version: 1, counterpartyType: "PARTNER", confirmed: false, versionStatus: "DRAFT" });
    const byKey = new Map(draftFields.fields.map((f) => [f.fieldKey, f]));
    expect(byKey.get("emailAddress")).toMatchObject({ value: "recon@example.test", origin: "MASTER_DATA", decision: "PENDING" });
    expect(byKey.get("currency")).toMatchObject({ value: "INR", origin: "EXTRACTED", decision: "PENDING" });
    expect(byKey.get("panNumber")).toMatchObject({ restricted: true, value: null });
    for (const field of draftFields.fields) if (field.restricted) expect(field.value).toBeNull();

    const confirmed = await confirmedAgreement(manager, partnerCp(partner));
    const frozen = must(await getDraftFieldsForReconciliation(manager, confirmed.head.agreementRef, 1), "frozen fields");
    expect(frozen).toMatchObject({ confirmed: true });
    const frozenByKey = new Map(frozen.fields.map((f) => [f.fieldKey, f]));
    expect(frozenByKey.get("currency")).toMatchObject({ value: "INR", decision: "CORRECTED" });
    expect(frozenByKey.get("counterpartyName")?.value).toBe("Acme Talent Private Limited");
    expect(JSON.stringify([draftFields, frozen])).not.toContain(SECRETS.pan);
    expect(failed(await getDraftFieldsForReconciliation(manager, confirmed.head.agreementRef, 0))).toMatchObject({ code: "invalid_input" });
  });
});

// =====================================================================================================================
// The Finance boundary
// =====================================================================================================================
describe("Finance boundary", () => {
  it("the whole service surface writes ONLY financeAgreements* documents, never touches a Payable / Invoice / Payment / money collection, and changes no Partner, Vendor, Account or KYC document", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const account = await seedAccount(partner, "instagram");
    const vendor = await seedVendor();
    await seedRestrictedIdentity({ type: "PARTNER", uid: partner.uid, ref: partner.partnerRef }, { pan: true, bank: true });
    await seedRestrictedIdentity({ type: "VENDOR", uid: vendor.uid, ref: vendor.vendorRef }, { pan: true });
    const watched = [partnersCollection().doc(partner.uid), partnerAccountsCollection().doc(account.uid), vendorsCollection().doc(vendor.uid), restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("PARTNER", partner.uid)), restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("VENDOR", vendor.uid))];
    const before = await Promise.all(watched.map(rawDoc));

    const io = instrument();
    for (const counterparty of [partnerCp(partner, [account.partnerAccountRef]), vendorCp(vendor)]) {
      const created = await newAgreement(manager, counterparty);
      const artifact = await seedArtifact(counterparty.type, counterparty.type === "PARTNER" ? counterparty.partnerRef : counterparty.vendorRef);
      // (the run doc below is the TEST's own fixture write, recorded but excluded from the assertion by path)
      const run = await seedRun(created.agreement.head.agreementRef, artifact.artifactRef, [{ fieldKey: "currency", normalizedValue: "INR" }]);
      const attached = must(await attachExtractionProposals(manager, { agreementRef: created.agreement.head.agreementRef, version: 1, expectedDocVersion: 1, extractionRunRef: run.runRef }, requestId()), "attach");
      const ready = await acceptPending(manager, await decideAll(manager, attached.agreement, READY_DECISIONS));
      const confirmed = await confirm(manager, ready);
      let current = await activate(head, confirmed);
      const ref = current.head.agreementRef;
      current = must(await suspendAgreement(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion, reason: "Paused for review" }, requestId()), "suspend");
      current = must(await resumeAgreement(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion }, requestId()), "resume");
      const revised = must(await createAgreementRevision(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion }, requestId()), "revise");
      const second = await confirm(manager, revised);
      current = must(await activateAgreementVersion(head, { agreementRef: ref, version: 2, expectedDocVersion: second.head.docVersion }, requestId()), "activate v2");
      must(await endAgreement(head, { agreementRef: ref, expectedDocVersion: current.head.docVersion, reason: "Relationship concluded" }, requestId()), "end");
      must(await getAgreementDetail(head, ref), "read");
      must(await listAgreementEvents(head, ref), "events");
      must(await listAgreementsForCounterparty(head, { counterpartyType: counterparty.type, ref: counterparty.type === "PARTNER" ? counterparty.partnerRef : counterparty.vendorRef }), "list");
    }
    io.stop();

    const serviceWrites = io.writes.filter((write) => !/\/extractionRuns\//.test(write.path) && !write.path.startsWith("financeContractArtifacts/"));
    expect(serviceWrites.length).toBeGreaterThan(20);
    const roots = new Set(serviceWrites.map((write) => write.path.split("/")[0]));
    expect([...roots].sort()).toEqual(["financeAgreementClaims", "financeAgreements"]);
    expect(serviceWrites.filter((w) => w.op === "delete")).toEqual([]);
    expect([...io.collectionsTouched].filter((name) => /payable|invoice|payment|payee|settlement|ledger|money/i.test(name))).toEqual([]);
    expect([...io.collectionsTouched]).toEqual(expect.arrayContaining(["financeAgreements", "partners", "vendors"]));
    expect(await Promise.all(watched.map(rawDoc))).toEqual(before);
  });

  it("the module has no delete anywhere (static scan of the service files added by this step)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of ["agreement-service.ts", "agreement-lifecycle-service.ts", "agreement-draft.ts", "identity-status.ts", "service-common.ts", "index.ts"]) {
      const source = readFileSync(join(import.meta.dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/\.delete\s*\(|\bdeleteDoc\b|recursiveDelete|\.update\s*\(/);
      expect(source, file).not.toMatch(/collection\(\s*["'`](payables?|invoices?|payments?|partners|vendors|partnerAccounts|restrictedFinancialIdentities)["'`]/);
    }
  });
});
