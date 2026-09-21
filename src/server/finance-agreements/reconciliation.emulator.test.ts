// Step 14A - the reconciliation / KYC-status / master-data-command layer against the running Firestore/Auth emulator
// (no mocks except two narrow spies that force a failure or a missing sensitive category).
//
// Proves: every reconciliation state (MATCH, MISSING_IN_CREATOROPS, MISSING_IN_AGREEMENT, MISMATCH, NOT_APPLICABLE,
// RESTRICTED, UNAVAILABLE); that reads / extraction attach / reconciliation NEVER write a Partner, Vendor or KYC document
// (raw docs byte-identical); that master data changes only through an explicit command that obeys the OWNING module's
// authorization; that a mismatch needs a deliberate acknowledged resolution; the KYC status matrix; that restricted
// values reach neither an ordinary Agreement read nor a reconciliation / KYC status without the sensitive categories;
// that KYC is written ONLY through the canonical restrictedFinancialIdentities store and no Finance document ever holds
// an identity value; and that audit events carry names and flags, never values.
//
// Hermetic by construction: every synthetic actor's ONLY scope is a per-run private REGION; fixtures are private-region
// Partners / Vendors with unique ids and unique identity values; nothing asserts a whole-collection size; every created
// document (agreement heads with subcollections, claims, artifacts, restricted identities, restricted extractions,
// access overrides, grants) is removed afterwards.
import { randomInt, randomUUID } from "node:crypto";

import { DocumentReference, Transaction, WriteBatch } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as sensitiveModule from "@/server/authz/sensitive";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { COLLECTIONS } from "@/server/authz/firestore";
import { scopeGrantDocId } from "@/server/authz/scope";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext, ScopeGrant, ScopeGrantInput } from "@/server/authz/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { partnerAccountsCollection, partnersCollection } from "@/server/partners/firestore";
import { partnerAccountDocSchema, partnerDocSchema, type PartnerDoc } from "@/server/partners/types";
import * as restrictedIdentityShared from "@/server/shared/restricted-financial-identity";
import { restrictedFinancialIdentitiesCollection, restrictedFinancialIdentityDocSchema, restrictedIdentityDocId } from "@/server/shared/restricted-financial-identity";
import { vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema, type VendorDoc } from "@/server/vendors/types";

import { attachExtractionProposals, confirmAgreementVersion, createAgreementDraft, decideField, getAgreementDetail } from "./index";
import { READY_DECISIONS } from "./testing/agreement-service-fixtures";
import {
  agreementClaimId,
  financeAgreementClaimsCollection,
  financeAgreementEventsCollection,
  financeAgreementExtractionRunsCollection,
  financeAgreementRestrictedExtractionsCollection,
  financeAgreementVersionsCollection,
  financeAgreementsCollection,
  financeContractArtifactsCollection,
} from "./firestore";
import { getAgreementKycStatus } from "./kyc-status-service";
import { applyExtractedKycToCanonical, updateCounterpartyContactFromAgreement } from "./master-data-commands";
import { getAgreementReconciliation } from "./reconciliation-service";
import { generateContractArtifactRef, generateExtractionRunRef } from "./ids";
import {
  contractArtifactDocSchema,
  extractionRunDocSchema,
  restrictedExtractionDocSchema,
  type AgreementCounterpartyInput,
  type FinanceAgreementsErrorResult,
  type FinanceAgreementsServiceResult,
} from "./types";
import type { FieldReconciliationDto } from "./reconciliation-compare";

vi.setConfig({ testTimeout: 60_000 });

const runId = Date.now();
const R_IN = `rec-in-${runId}`;
const R_OUT = `rec-out-${runId}`;

const uidByRole = new Map<string, string>();
const cleanup: FirebaseFirestore.DocumentReference[] = [];
// Partners / Vendors are removed RECURSIVELY: the owning modules append audit events under them (partners/{uid}/events ...).
const recursiveCleanup: FirebaseFirestore.DocumentReference[] = [];
const agreementRefs: string[] = [];
const claimIds: string[] = [];
const runRefs: string[] = [];
const artifactDocRefs: FirebaseFirestore.DocumentReference[] = [];
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

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  const db = getAdminFirestore();
  for (const ref of agreementRefs.splice(0)) await db.recursiveDelete(financeAgreementsCollection().doc(ref));
  await Promise.all(claimIds.splice(0).map((id) => financeAgreementClaimsCollection().doc(id).delete()));
  await Promise.all(runRefs.splice(0).map((ref) => financeAgreementRestrictedExtractionsCollection().doc(ref).delete()));
  for (const ref of recursiveCleanup.splice(0)) await db.recursiveDelete(ref);
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
// exactly the grants named here (default: the private IN region) - nothing else. `deny` adds a per-user OVERRIDE that
// switches individual owning-module actions off (the tri-state override the access system already supports).
async function syntheticActor(role: Role, options: { grants?: ScopeGrantInput[]; deny?: Array<{ feature: "partners" | "vendors"; action: "edit" | "manage_partner_restricted_identity" | "manage_vendor_restricted_identity" }> } = {}): Promise<ActorContext> {
  const uid = `rec-${role}-${runId}-${randomUUID().slice(0, 6)}`;
  const grantedAt = new Date().toISOString();
  for (const input of options.grants ?? [{ type: "REGION", region: R_IN }]) {
    const id = scopeGrantDocId(uid, input);
    await getAdminFirestore()
      .collection(COLLECTIONS.scopeAssignments)
      .doc(id)
      .set({ ...input, uid, grantedAt, grantedBy: "rec-test" } as ScopeGrant);
    grantDocIds.push(id);
  }
  if (options.deny?.length) {
    const features: Record<string, { actions: Record<string, boolean> }> = {};
    for (const { feature, action } of options.deny) (features[feature] ??= { actions: {} }).actions[action] = false;
    const overrideRef = getAdminFirestore().collection(COLLECTIONS.userAccessOverrides).doc(uid);
    await overrideRef.set({ uid, features, version: 1 });
    cleanup.push(overrideRef);
  }
  return { uid, email: `${uid}@example.test`, role, displayName: `REC ${role}`, userRef: `rec-ref-${uid}` };
}

// ---- Synthetic identity values (invented, unique per run) -------------------------------------------------------------------
const letters = (n: number) => Array.from({ length: n }, () => String.fromCharCode(65 + randomInt(0, 26))).join("");
const digits = (n: number) => Array.from({ length: n }, () => String(randomInt(0, 10))).join("");
const newPan = () => `${letters(3)}P${letters(1)}${digits(4)}${letters(1)}`;
const newGstin = () => `29${letters(5)}${digits(4)}${letters(1)}1Z5`;
const newAadhaar = () => `${randomInt(2, 10)}${digits(11)}`;
const newAccount = () => digits(12);
const newIfsc = () => `${letters(4)}0${digits(6)}`;

type Secrets = { pan: string; gst: string; aadhaar: string; account: string; ifsc: string; holder: string };
const newSecrets = (): Secrets => ({ pan: newPan(), gst: newGstin(), aadhaar: newAadhaar(), account: newAccount(), ifsc: newIfsc(), holder: `Holder ${letters(6)}` });

// ---- Fixtures ----------------------------------------------------------------------------------------------------------
async function seedPartner(over: { regionIds?: string[]; email?: string | null; phone?: string | null; legalName?: string | null } = {}): Promise<PartnerDoc> {
  counter += 1;
  const uid = `rec-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = `REC Partner ${counter} ${runId}`;
  const partner = partnerDocSchema.parse({
    uid,
    partnerRef: `ref-${uid}`,
    version: 1,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    legalName: over.legalName === undefined ? null : over.legalName,
    email: over.email === undefined ? `partner-${counter}-${runId}@example.test` : over.email,
    phone: over.phone === undefined ? null : over.phone,
    status: "ACTIVE",
    regionIds: over.regionIds ?? [R_IN],
    createdAt: now,
    createdByUserRef: "rec-test",
    updatedAt: now,
    updatedByUserRef: "rec-test",
  });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  recursiveCleanup.push(ref);
  // a command may CREATE the canonical identity record for this subject: always remove it
  cleanup.push(restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("PARTNER", uid)));
  return partner;
}

async function seedVendor(over: { regionIds?: string[]; email?: string | null; phone?: string | null } = {}): Promise<VendorDoc> {
  counter += 1;
  const uid = `rec-vendor-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = `REC Vendor ${counter} ${runId}`;
  const vendor = vendorDocSchema.parse({
    uid,
    vendorRef: `ref-${uid}`,
    version: 1,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    vendorType: "AGENCY",
    email: over.email === undefined ? `vendor-${counter}-${runId}@example.test` : over.email,
    phone: over.phone === undefined ? null : over.phone,
    status: "ACTIVE",
    regionIds: over.regionIds ?? [R_IN],
    createdAt: now,
    createdByUserRef: "rec-test",
    updatedAt: now,
    updatedByUserRef: "rec-test",
  });
  const ref = vendorsCollection().doc(uid);
  await ref.set(vendor);
  recursiveCleanup.push(ref);
  cleanup.push(restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("VENDOR", uid)));
  return vendor;
}

type Subject = { type: "PARTNER" | "VENDOR"; uid: string; ref: string };
const partnerSubject = (partner: PartnerDoc): Subject => ({ type: "PARTNER", uid: partner.uid, ref: partner.partnerRef });
const vendorSubject = (vendor: VendorDoc): Subject => ({ type: "VENDOR", uid: vendor.uid, ref: vendor.vendorRef });

type IdentityParts = { pan?: boolean; bank?: boolean; aadhaar?: boolean; gst?: "number" | "not_applicable"; evidence?: Array<"pan" | "aadhaar" | "gst" | "bank" | "other"> };
async function seedRestrictedIdentity(subject: Subject, secrets: Secrets, parts: IdentityParts = {}) {
  const now = new Date().toISOString();
  const doc = restrictedFinancialIdentityDocSchema.parse({
    uid: restrictedIdentityDocId(subject.type, subject.uid),
    subjectType: subject.type,
    subjectRef: subject.ref,
    version: 1,
    pan: parts.pan ? { number: secrets.pan } : null,
    aadhaar: parts.aadhaar ? { number: secrets.aadhaar } : null,
    gst: parts.gst === "number" ? { applicable: true, number: secrets.gst } : parts.gst === "not_applicable" ? { applicable: false } : null,
    bank: parts.bank ? { accountHolderName: secrets.holder, accountNumber: secrets.account, ifsc: secrets.ifsc, bankName: "Test Bank", branchName: "Test Branch" } : null,
    evidence: (parts.evidence ?? []).map((docType) => ({ docType, kind: "link", url: `https://drive.example.test/secret-${randomUUID()}`, fileName: null, addedAt: now, addedByUserRef: "rec-test" })),
    updatedAt: now,
    updatedByUserRef: "rec-test",
  });
  const ref = restrictedFinancialIdentitiesCollection().doc(doc.uid);
  await ref.set(doc);
  cleanup.push(ref);
  return ref;
}

const identityRef = (subject: Subject) => restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId(subject.type, subject.uid));

async function seedArtifact(type: "PARTNER" | "VENDOR", ref: string) {
  const artifact = contractArtifactDocSchema.parse({
    artifactRef: generateContractArtifactRef(),
    fileName: "synthetic-contract.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1234,
    sha256: "a".repeat(64),
    uploadedByUserRef: "rec-test",
    uploadedAt: new Date().toISOString(),
    counterparty: { type, ref },
    status: "EXTRACTED",
    storageLocator: `test/${randomUUID()}`,
  });
  const docRef = financeContractArtifactsCollection().doc(artifact.artifactRef);
  await docRef.set(artifact);
  cleanup.push(docRef);
  artifactDocRefs.push(docRef);
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
    createdByUserRef: "rec-test",
  });
  await financeAgreementExtractionRunsCollection(agreementRef).doc(run.runRef).set(run);
  return run;
}

// The restricted extraction record (server-only): written directly with the Admin SDK per restrictedExtractionDocSchema.
async function seedRestrictedExtraction(agreementRef: string, artifactRef: string, runRef: string, rawValues: Record<string, string>) {
  const doc = restrictedExtractionDocSchema.parse({
    runRef,
    agreementRef,
    artifactRef,
    fields: Object.fromEntries(Object.entries(rawValues).map(([fieldKey, rawValue]) => [fieldKey, { rawSnippet: "synthetic snippet", locator: "page 1", rawValue }])),
    createdAt: new Date().toISOString(),
  });
  await financeAgreementRestrictedExtractionsCollection().doc(runRef).set(doc);
  runRefs.push(runRef);
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

const partnerCp = (partner: PartnerDoc): AgreementCounterpartyInput => ({ type: "PARTNER", partnerRef: partner.partnerRef });
const vendorCp = (vendor: VendorDoc): AgreementCounterpartyInput => ({ type: "VENDOR", vendorRef: vendor.vendorRef });

let reqCounter = 0;
const requestId = () => `req-${runId}-${(reqCounter += 1)}`;

async function newAgreement(actor: ActorContext, counterparty: AgreementCounterpartyInput) {
  const clientRequestId = `crid-${runId}-${(counter += 1)}-${randomUUID().slice(0, 6)}`;
  const outcome = must(await createAgreementDraft(actor, { clientRequestId, counterparty }, requestId()), "create");
  agreementRefs.push(outcome.agreement.head.agreementRef);
  claimIds.push(agreementClaimId(actor.uid, clientRequestId));
  return outcome.agreement;
}

const docVersionOf = async (actor: ActorContext, agreementRef: string) => must(await getAgreementDetail(actor, agreementRef), "detail").selectedVersion!.docVersion;

async function decide(actor: ActorContext, agreementRef: string, fieldKey: string, decision: "ACCEPTED" | "CORRECTED" | "UNAVAILABLE" | "NOT_APPLICABLE", value?: unknown) {
  return must(
    await decideField(actor, { agreementRef, version: 1, expectedDocVersion: await docVersionOf(actor, agreementRef), fieldKey, decision, ...(value !== undefined ? { value } : {}) }, requestId()),
    `decide ${fieldKey}`,
  );
}

// Creates the Agreement, a contract artifact + extraction run (+ optional restricted extraction), and attaches the run.
async function prepared(actor: ActorContext, subject: Subject, options: { proposals: ProposalSeed[]; restricted?: Record<string, string>; attach?: boolean }) {
  const agreement = await newAgreement(actor, subject.type === "PARTNER" ? { type: "PARTNER", partnerRef: subject.ref } : { type: "VENDOR", vendorRef: subject.ref });
  const agreementRef = agreement.head.agreementRef;
  const artifact = await seedArtifact(subject.type, subject.ref);
  const run = await seedRun(agreementRef, artifact.artifactRef, options.proposals);
  if (options.restricted) await seedRestrictedExtraction(agreementRef, artifact.artifactRef, run.runRef, options.restricted);
  if (options.attach !== false) {
    must(await attachExtractionProposals(actor, { agreementRef, version: 1, expectedDocVersion: await docVersionOf(actor, agreementRef), extractionRunRef: run.runRef }, requestId()), "attach");
  }
  return { agreementRef, runRef: run.runRef, artifactRef: artifact.artifactRef };
}

async function reconcile(actor: ActorContext, agreementRef: string, version?: number) {
  return must(await getAgreementReconciliation(actor, { agreementRef, ...(version ? { version } : {}) }), "reconcile");
}
const fieldOf = (fields: FieldReconciliationDto[], key: string) => fields.find((field) => field.fieldKey === key)!;

// ---- Raw reads (bypass every service) ------------------------------------------------------------------------------------------
async function rawDoc(ref: FirebaseFirestore.DocumentReference) {
  const snap = await ref.get();
  return snap.exists ? JSON.stringify(snap.data()) : null;
}
async function rawEvents(agreementRef: string) {
  const snap = await financeAgreementEventsCollection(agreementRef).get();
  return snap.docs.map((doc) => doc.data() as { kind: string; version: number; actorUserRef: string; metadata: Record<string, unknown> | null; requestId: string; createdAt: string });
}
// The three master documents a reconciliation / extraction must never touch.
async function masterSnapshot(subject: Subject) {
  const master = subject.type === "PARTNER" ? partnersCollection().doc(subject.uid) : vendorsCollection().doc(subject.uid);
  return { master: await rawDoc(master), identity: await rawDoc(identityRef(subject)) };
}

// Every stored document of these agreements (head, versions, events, extraction runs) plus their claims / artifact metadata.
// The RESTRICTED extraction collection is excluded on purpose: it is the server-only home of the raw extracted values.
async function financeDocs(refs: string[]): Promise<unknown[]> {
  const docs: unknown[] = [];
  for (const ref of refs) {
    docs.push((await financeAgreementsCollection().doc(ref).get()).data());
    for (const collection of [financeAgreementVersionsCollection(ref), financeAgreementEventsCollection(ref), financeAgreementExtractionRunsCollection(ref)]) {
      for (const doc of (await collection.get()).docs) docs.push(doc.data());
    }
  }
  for (const ref of artifactDocRefs) docs.push((await ref.get()).data());
  for (const id of claimIds) docs.push((await financeAgreementClaimsCollection().doc(id).get()).data());
  return docs.filter((doc) => doc !== undefined);
}
const financeDocsJson = async (refs: string[]) => (await financeDocs(refs)).map((doc) => JSON.stringify(doc)).join("\n");

// No Finance document may even HAVE a property that names an identity value.
async function expectNoIdentityProperties(refs: string[]) {
  const keys = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        keys.add(key);
        walk(child);
      }
    }
  };
  (await financeDocs(refs)).forEach(walk);
  expect(keys.size).toBeGreaterThan(20);
  for (const forbidden of ["rawValue", "rawSnippet", "locator", "accountNumber", "accountHolderName", "ifsc", "gstNumber", "bankName", "branchName", "evidence", "number"]) expect(keys.has(forbidden), forbidden).toBe(false);
}

function expectNoValues(json: string, secrets: string[]) {
  for (const secret of secrets) expect(json, `leaked ${secret.slice(0, 3)}...`).not.toContain(secret);
}
const secretList = (s: Secrets) => [s.pan, s.gst, s.aadhaar, s.account, s.ifsc, s.holder];

// ---- Firestore write instrumentation (which paths a call wrote) ------------------------------------------------------------------
function instrument() {
  const writes: string[] = [];
  type AnyFn = (...args: unknown[]) => unknown;
  const spies: Array<{ mockRestore: () => void }> = [];
  const wrap = (proto: object, name: string, pathOf: (self: unknown, args: unknown[]) => string) => {
    const original = (proto as unknown as Record<string, AnyFn>)[name]!;
    spies.push(
      vi.spyOn(proto as unknown as Record<string, AnyFn>, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
        writes.push(pathOf(this, args));
        return original.apply(this, args);
      }),
    );
  };
  for (const op of ["set", "create", "update", "delete"] as const) {
    wrap(Transaction.prototype, op, (_self, args) => (args[0] as { path: string }).path);
    wrap(WriteBatch.prototype, op, (_self, args) => (args[0] as { path: string }).path);
    wrap(DocumentReference.prototype, op, (self) => (self as { path: string }).path);
  }
  return { writes, stop: () => spies.splice(0).forEach((spy) => spy.mockRestore()) };
}

const NEUTRAL = { ok: false, code: "not_found", message: "Not found." };

// A Partner with a canonical identity record, an Agreement carrying a full set of extracted proposals + a restricted
// extraction, ATTACHED (proposals PENDING). The extracted email differs from CreatorOps', the phone is new, the PAN
// matches (different formatting), the GSTIN is new, and the bank is on file but absent from the contract.
async function identityScenario(head: ActorContext) {
  const partner = await seedPartner({ legalName: "Acme Talent Private Limited", email: "acme@example.test", phone: null });
  const secrets = newSecrets();
  const extractedGstin = newGstin();
  await seedRestrictedIdentity(partnerSubject(partner), secrets, { pan: true, bank: true });
  const ids = await prepared(head, partnerSubject(partner), {
    proposals: [
      { fieldKey: "emailAddress", normalizedValue: "other@example.test" },
      { fieldKey: "contactNumber", normalizedValue: "+919876543210" },
      { fieldKey: "address", normalizedValue: "12 Test Road, Bengaluru 560001" },
      { fieldKey: "pinCode", normalizedValue: "560001" },
      { fieldKey: "panNumber", normalizedValue: null },
      { fieldKey: "gstin", normalizedValue: null },
    ],
    restricted: { panNumber: secrets.pan.toLowerCase(), gstin: extractedGstin, panHolderName: "Someone Holder" },
  });
  return { partner, secrets, extractedGstin, ...ids };
}

describe("getAgreementReconciliation: every state, computed server-side", () => {
  it("MATCH / MISSING_IN_CREATOROPS / MISMATCH / MISSING_IN_AGREEMENT / UNAVAILABLE across ordinary and identity fields (Head)", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef, runRef, secrets, extractedGstin } = await identityScenario(head);

    const result = await reconcile(head, agreementRef);
    expect(result).toMatchObject({ agreementRef, version: 1, counterpartyType: "PARTNER", versionConfirmed: false, identityCompared: true, extractionRunRef: runRef });

    const f = (key: string) => fieldOf(result.fields, key);
    expect(f("counterpartyName").state).toBe("MATCH"); // master-data prefill of the legal name
    expect(f("state").state).toBe("MATCH"); // the single region prefilled as the state
    expect(f("emailAddress")).toMatchObject({ state: "MISMATCH", canonicalValue: "acme@example.test", extractedValue: "other@example.test" });
    expect(f("contactNumber")).toMatchObject({ state: "MISSING_IN_CREATOROPS", extractedValue: "+919876543210" });
    expect(f("address")).toMatchObject({ state: "UNAVAILABLE", reason: "no_canonical_field" });
    expect(f("pinCode")).toMatchObject({ state: "UNAVAILABLE", reason: "no_canonical_field" });
    expect(f("panNumber")).toMatchObject({ state: "MATCH", canonicalValue: secrets.pan, extractedValue: secrets.pan.toLowerCase() }); // normalized comparison
    expect(f("gstin")).toMatchObject({ state: "MISSING_IN_CREATOROPS", extractedValue: extractedGstin });
    expect(f("panHolderName")).toMatchObject({ state: "UNAVAILABLE", reason: "no_canonical_field" });
    expect(f("bankAccountNumber")).toMatchObject({ state: "MISSING_IN_AGREEMENT", canonicalValue: secrets.account });
    expect(f("ifsc")).toMatchObject({ state: "MISSING_IN_AGREEMENT", canonicalValue: secrets.ifsc });
    expect(f("aadhaarNumber")).toMatchObject({ state: "UNAVAILABLE", reason: "nothing_to_compare" });
    expect(f("platforms")).toMatchObject({ state: "UNAVAILABLE", reason: "nothing_to_compare" });
    expect(result.summary.MATCH).toBeGreaterThanOrEqual(3);
    expect(result.fields.map((field) => field.fieldKey)).toContain("collaboratorPageName");
  });

  it("MISSING_IN_AGREEMENT and NOT_APPLICABLE for ordinary fields once a human decides UNAVAILABLE / NOT_APPLICABLE", async () => {
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner({ email: "keep@example.test", phone: "+91 90000 12345" });
    const agreement = await newAgreement(head, partnerCp(partner));
    const ref = agreement.head.agreementRef;

    // prefilled from master data: still a MATCH until a human says otherwise
    expect(fieldOf((await reconcile(head, ref)).fields, "emailAddress").state).toBe("MATCH");
    await decide(head, ref, "emailAddress", "UNAVAILABLE");
    await decide(head, ref, "contactNumber", "NOT_APPLICABLE");
    const after = (await reconcile(head, ref)).fields;
    expect(fieldOf(after, "emailAddress")).toMatchObject({ state: "MISSING_IN_AGREEMENT", canonicalValue: "keep@example.test", agreementDecision: "UNAVAILABLE", allowedActions: [] });
    expect(fieldOf(after, "contactNumber")).toMatchObject({ state: "NOT_APPLICABLE", reason: "decided_not_applicable" });
  });

  it("a Partner Account is the canonical platform / page: MATCH on the derived platform, MISMATCH when the Agreement names another", async () => {
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    counter += 1;
    const accountUid = `rec-account-${runId}-${counter}`;
    const now = new Date().toISOString();
    const account = partnerAccountDocSchema.parse({ uid: accountUid, partnerAccountRef: `ref-${accountUid}`, version: 1, partnerRef: partner.partnerRef, platform: "Instagram", handle: "acme_official", displayName: "Acme Official", profileUrl: "https://www.instagram.com/acme_official/", normalizedIdentity: `instagram:${accountUid}`, status: "ACTIVE", createdAt: now, createdByUserRef: "rec-test", updatedAt: now, updatedByUserRef: "rec-test" });
    const accountRef = partnerAccountsCollection().doc(accountUid);
    await accountRef.set(account);
    cleanup.push(accountRef);

    const agreement = await newAgreement(head, { type: "PARTNER", partnerRef: partner.partnerRef, partnerAccountRefs: [account.partnerAccountRef] });
    const ref = agreement.head.agreementRef;
    const first = (await reconcile(head, ref)).fields;
    expect(fieldOf(first, "platforms").state).toBe("MATCH"); // prefilled from the derived platformScope
    expect(fieldOf(first, "collaboratorPageLink").state).toBe("MATCH");
    expect(fieldOf(first, "collaboratorPageName").state).toBe("MATCH");

    await decide(head, ref, "collaboratorPageLink", "CORRECTED", "https://www.instagram.com/someone_else/");
    await decide(head, ref, "platforms", "CORRECTED", ["youtube"]);
    const second = (await reconcile(head, ref)).fields;
    expect(fieldOf(second, "collaboratorPageLink")).toMatchObject({ state: "MISMATCH", canonicalValue: "https://www.instagram.com/acme_official/" });
    expect(fieldOf(second, "platforms")).toMatchObject({ state: "MISMATCH", canonicalValue: "instagram" });
    // no master-data command exists for Partner Accounts: only the in-Agreement resolutions are offered
    expect(fieldOf(second, "collaboratorPageLink").allowedActions).toEqual(["KEEP_CREATOROPS_VALUE", "USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY"]);
  });

  it("a Vendor: Aadhaar is NOT_APPLICABLE, platform fields have no canonical home, and the vendor PAN is compared", async () => {
    const head = await syntheticActor("partnership_head");
    const vendor = await seedVendor();
    const secrets = newSecrets();
    await seedRestrictedIdentity(vendorSubject(vendor), secrets, { pan: true });
    const { agreementRef } = await prepared(head, vendorSubject(vendor), {
      proposals: [{ fieldKey: "panNumber", normalizedValue: null }],
      restricted: { panNumber: secrets.pan },
    });
    const fields = (await reconcile(head, agreementRef)).fields;
    expect(fieldOf(fields, "aadhaarNumber")).toMatchObject({ state: "NOT_APPLICABLE", reason: "not_applicable_to_counterparty" });
    for (const key of ["platforms", "collaboratorPageLink", "collaboratorPageName"]) expect(fieldOf(fields, key)).toMatchObject({ state: "UNAVAILABLE", reason: "no_canonical_field" });
    expect(fieldOf(fields, "panNumber")).toMatchObject({ state: "MATCH", canonicalValue: secrets.pan });
    expect(fieldOf(fields, "state").state).toBe("MATCH");
  });

  it("an unreadable canonical identity store is UNAVAILABLE - never reported as an empty (MISSING) store", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef } = await identityScenario(head);
    vi.spyOn(restrictedIdentityShared, "getRestrictedFinancialIdentityDoc").mockRejectedValue(new Error("store down"));
    const fields = (await reconcile(head, agreementRef)).fields;
    for (const key of ["panNumber", "gstin", "bankAccountNumber", "ifsc", "aadhaarNumber"]) expect(fieldOf(fields, key)).toMatchObject({ state: "UNAVAILABLE", reason: "canonical_unreadable" });
    expect(fieldOf(fields, "emailAddress").state).toBe("MISMATCH");
  });

  it("a CONFIRMED version is compared through its frozen terms; the Agreement can no longer be re-resolved but a master-data update stays available", async () => {
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner({ legalName: "Acme Talent Private Limited", email: "frozen@example.test" });
    const agreementRef = (await newAgreement(head, partnerCp(partner))).head.agreementRef;
    for (const seed of READY_DECISIONS) await decide(head, agreementRef, seed.fieldKey, seed.decision, seed.value);
    const pending = Object.entries(must(await getAgreementDetail(head, agreementRef), "detail").selectedVersion!.draft)
      .filter(([, entry]) => entry?.decision === "PENDING")
      .map(([fieldKey]) => fieldKey);
    for (const fieldKey of pending) await decide(head, agreementRef, fieldKey, "ACCEPTED");
    must(await confirmAgreementVersion(head, { agreementRef, version: 1, expectedDocVersion: await docVersionOf(head, agreementRef) }, requestId()), "confirm");

    // CreatorOps' email later changes (fixture drift, written directly): the FROZEN email now disagrees.
    await partnersCollection().doc(partner.uid).update({ email: "drifted@example.test", version: 2 });
    const confirmed = await reconcile(head, agreementRef);
    expect(confirmed).toMatchObject({ versionConfirmed: true, versionStatus: "DRAFT" });
    expect(fieldOf(confirmed.fields, "counterpartyName").state).toBe("MATCH");
    expect(fieldOf(confirmed.fields, "emailAddress")).toMatchObject({ state: "MISMATCH", confirmedValue: "frozen@example.test", canonicalValue: "drifted@example.test", agreementDecision: "ACCEPTED" });
    // frozen: no in-Agreement resolution, only the deliberate master-data one
    expect(fieldOf(confirmed.fields, "emailAddress").allowedActions).toEqual(["OVERWRITE_MASTER_DATA_WITH_AGREEMENT_VALUE"]);
  });
});

describe("RESTRICTED identity: no value, no result, without BOTH finance_contracts and the identity category", () => {
  const IDENTITY_KEYS = ["gstin", "aadhaarNumber", "panNumber", "panHolderName", "bankAccountNumber", "ifsc"];

  it("Manager (holds manage_agreements, holds NEITHER category): every identity field is RESTRICTED with no value and no match result; ordinary fields still compare", async () => {
    const head = await syntheticActor("partnership_head");
    const manager = await syntheticActor("partnership_manager");
    const { agreementRef, secrets, extractedGstin } = await identityScenario(head);

    const result = await reconcile(manager, agreementRef);
    expect(result).toMatchObject({ identityCompared: false, extractionRunRef: null });
    for (const key of IDENTITY_KEYS) {
      expect(fieldOf(result.fields, key), key).toEqual({ fieldKey: key, label: expect.any(String), group: "identity", state: "RESTRICTED", reason: "identity_access_required", source: { canonical: null, agreement: null }, allowedActions: [] });
    }
    expectNoValues(JSON.stringify(result), [...secretList(secrets), extractedGstin, secrets.pan.toLowerCase(), "Someone Holder"]);
    expect(fieldOf(result.fields, "emailAddress")).toMatchObject({ state: "MISMATCH", canonicalValue: "acme@example.test" });
  });

  it("the RESTRICTED result does not vary with the data (a matching and a wholly different identity look identical)", async () => {
    const head = await syntheticActor("partnership_head");
    const manager = await syntheticActor("partnership_manager");
    const first = await identityScenario(head);
    const second = await identityScenario(head);
    const a = (await reconcile(manager, first.agreementRef)).fields.filter((field) => IDENTITY_KEYS.includes(field.fieldKey));
    const b = (await reconcile(manager, second.agreementRef)).fields.filter((field) => IDENTITY_KEYS.includes(field.fieldKey));
    expect(a).toEqual(b);
    expect(a.every((field) => field.state === "RESTRICTED")).toBe(true);
  });

  it("BOTH are required: finance_contracts alone, or the identity category alone, still yields RESTRICTED and reads neither restricted store", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef, secrets } = await identityScenario(head);
    for (const withheld of ["finance_contracts", "payment_details"]) {
      const original = sensitiveModule.canAccessSensitive;
      vi.spyOn(sensitiveModule, "canAccessSensitive").mockImplementation(async (actor, category) => (category === withheld ? false : original(actor, category)));
      const io = vi.spyOn(restrictedIdentityShared, "getRestrictedFinancialIdentityDoc");
      const result = await reconcile(head, agreementRef);
      expect(result.identityCompared, withheld).toBe(false);
      for (const key of IDENTITY_KEYS) expect(fieldOf(result.fields, key).state, `${withheld}/${key}`).toBe("RESTRICTED");
      expectNoValues(JSON.stringify(result), secretList(secrets));
      expect(io, `${withheld} must not read the canonical identity store`).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it("an ordinary Agreement read never carries a restricted value, for any actor (extraction attached, identity on file)", async () => {
    const head = await syntheticActor("partnership_head");
    const manager = await syntheticActor("partnership_manager");
    const { agreementRef, secrets, extractedGstin } = await identityScenario(head);
    for (const actor of [head, manager]) {
      const detail = JSON.stringify(must(await getAgreementDetail(actor, agreementRef), "detail"));
      expectNoValues(detail, [...secretList(secrets), extractedGstin, secrets.pan.toLowerCase(), "Someone Holder"]);
    }
  });

  it("Viewer / Analyst (no Finance grant) are denied; an out-of-scope actor and a forged ref get the SAME neutral not_found", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef } = await identityScenario(head);
    for (const role of ["viewer", "analyst"] as const) {
      const denied = failed(await getAgreementReconciliation(await syntheticActor(role), { agreementRef }));
      expect(denied).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
    }
    const outside = await syntheticActor("partnership_head", { grants: [{ type: "REGION", region: R_OUT }] });
    expect(failed(await getAgreementReconciliation(outside, { agreementRef }))).toMatchObject(NEUTRAL);
    expect(failed(await getAgreementReconciliation(head, { agreementRef: "agr_00000000000000000000" }))).toMatchObject(NEUTRAL);
    expect(failed(await getAgreementReconciliation(head, { agreementRef: "nonsense" }))).toMatchObject(NEUTRAL);
    expect(failed(await getAgreementReconciliation(null, { agreementRef }))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    expect(failed(await getAgreementReconciliation(head, { agreementRef, extra: true }))).toMatchObject({ code: "invalid_input" });
  });

  it("Super Admin (both categories) sees identity compared", async () => {
    const head = await syntheticActor("partnership_head");
    const admin = await syntheticActor("super_admin");
    const { agreementRef } = await identityScenario(head);
    expect((await reconcile(admin, agreementRef)).identityCompared).toBe(true);
  });
});

describe("the five seeded roles, through the REAL seeded grants (scope: each role's own plus the private IN region)", () => {
  // The seeded actor keeps its own feature / action / sensitive grants; a REGION grant for the private IN region is added
  // (and removed afterwards) so the fixtures stay hermetic.
  async function seededInScope(role: string): Promise<ActorContext> {
    const actor = await seededActor(role);
    const input = { type: "REGION" as const, region: R_IN };
    const id = scopeGrantDocId(actor.uid, input);
    await getAdminFirestore()
      .collection(COLLECTIONS.scopeAssignments)
      .doc(id)
      .set({ ...input, uid: actor.uid, grantedAt: new Date().toISOString(), grantedBy: "rec-test" } as ScopeGrant);
    grantDocIds.push(id);
    return actor;
  }

  it("Viewer / Analyst denied; Manager sees state only (identity RESTRICTED); Head and Super Admin compare identity - for reconciliation, KYC status and the KYC command", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef, secrets } = await identityScenario(head);

    for (const role of ["viewer", "analyst"]) {
      const actor = await seededInScope(role);
      expect(failed(await getAgreementReconciliation(actor, { agreementRef })), role).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
      expect(failed(await getAgreementKycStatus(actor, agreementRef)), role).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
      expect(failed(await applyExtractedKycToCanonical(actor, kycCommand(agreementRef), requestId())), role).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
    }

    const manager = await seededInScope("partnership_manager");
    expect(await reconcile(manager, agreementRef)).toMatchObject({ identityCompared: false });
    expect(must(await getAgreementKycStatus(manager, agreementRef), "kyc")).toMatchObject({ valuesVisible: false, components: { pan: "RESTRICTED", bank: "RESTRICTED" } });
    expect(failed(await applyExtractedKycToCanonical(manager, kycCommand(agreementRef), requestId()))).toMatchObject({ code: "unauthorized", reason: "sensitive_denied" });
    expectNoValues(JSON.stringify(await reconcile(manager, agreementRef)), secretList(secrets));

    for (const role of ["partnership_head", "super_admin"]) {
      const actor = await seededInScope(role);
      expect(await reconcile(actor, agreementRef), role).toMatchObject({ identityCompared: true });
      expect(must(await getAgreementKycStatus(actor, agreementRef), "kyc"), role).toMatchObject({ valuesVisible: true, state: "INCOMPLETE", components: { pan: "PRESENT", bank: "PRESENT", gst: "MISSING" } });
    }
  });
});

describe("NO silent overwrite: reads, extraction and reconciliation never write a master record", () => {
  it("attach + reconcile + KYC status + accept/correct decisions leave the Partner, the Vendor and the canonical identity documents BYTE-IDENTICAL", async () => {
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner({ legalName: "Acme Talent Private Limited", email: "acme@example.test", phone: null });
    const vendor = await seedVendor({ email: null });
    const secrets = newSecrets();
    await seedRestrictedIdentity(partnerSubject(partner), secrets, { pan: true, bank: true, evidence: ["pan"] });
    await seedRestrictedIdentity(vendorSubject(vendor), newSecrets(), { pan: true });

    const beforePartner = await masterSnapshot(partnerSubject(partner));
    const beforeVendor = await masterSnapshot(vendorSubject(vendor));

    for (const subject of [partnerSubject(partner), vendorSubject(vendor)]) {
      const { agreementRef } = await prepared(head, subject, {
        proposals: [
          { fieldKey: "emailAddress", normalizedValue: "changed@example.test" },
          { fieldKey: "contactNumber", normalizedValue: "+919876543210" },
          { fieldKey: "panNumber", normalizedValue: null },
          { fieldKey: "gstin", normalizedValue: null },
        ],
        restricted: { panNumber: newPan(), gstin: newGstin() },
      });
      await reconcile(head, agreementRef);
      must(await getAgreementKycStatus(head, agreementRef), "kyc");
      await decide(head, agreementRef, "emailAddress", "ACCEPTED");
      await decide(head, agreementRef, "contactNumber", "CORRECTED", "+919000000000");
      await decide(head, agreementRef, "panNumber", "ACCEPTED");
      await reconcile(head, agreementRef);
    }

    expect(await masterSnapshot(partnerSubject(partner))).toEqual(beforePartner);
    expect(await masterSnapshot(vendorSubject(vendor))).toEqual(beforeVendor);
  });

  it("the read services perform NO Firestore write at all", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef } = await identityScenario(head);
    const io = instrument();
    try {
      await reconcile(head, agreementRef);
      must(await getAgreementKycStatus(head, agreementRef), "kyc");
    } finally {
      io.stop();
    }
    expect(io.writes).toEqual([]);
  });
});

describe("getAgreementKycStatus", () => {
  const kyc = async (actor: ActorContext, agreementRef: string) => must(await getAgreementKycStatus(actor, agreementRef), "kyc");

  it("existing KYC => AVAILABLE; nothing => MISSING; partial => INCOMPLETE (Head sees the component detail)", async () => {
    const head = await syntheticActor("partnership_head");
    const full = await seedPartner();
    await seedRestrictedIdentity(partnerSubject(full), newSecrets(), { pan: true, bank: true, gst: "number", aadhaar: true, evidence: ["pan", "bank"] });
    const none = await seedPartner();
    const partial = await seedPartner();
    await seedRestrictedIdentity(partnerSubject(partial), newSecrets(), { pan: true });

    const availableRef = (await newAgreement(head, partnerCp(full))).head.agreementRef;
    expect(await kyc(head, availableRef)).toEqual({
      agreementRef: availableRef,
      counterpartyType: "PARTNER",
      state: "AVAILABLE",
      components: { pan: "PRESENT", aadhaar: "PRESENT", gst: "PRESENT", bank: "PRESENT" },
      valuesVisible: true,
      evidenceTypesPresent: ["bank", "pan"],
    });
    const missingRef = (await newAgreement(head, partnerCp(none))).head.agreementRef;
    expect(await kyc(head, missingRef)).toMatchObject({ state: "MISSING", components: { pan: "MISSING", aadhaar: "MISSING", gst: "MISSING", bank: "MISSING" }, valuesVisible: true });
    const partialRef = (await newAgreement(head, partnerCp(partial))).head.agreementRef;
    expect(await kyc(head, partialRef)).toMatchObject({ state: "INCOMPLETE", components: { pan: "PRESENT", bank: "MISSING" } });
  });

  it("GST declared not applicable does not block AVAILABLE; Aadhaar is tracked but never required; a Vendor's Aadhaar is NOT_APPLICABLE", async () => {
    const head = await syntheticActor("partnership_head");
    const vendor = await seedVendor();
    await seedRestrictedIdentity(vendorSubject(vendor), newSecrets(), { pan: true, bank: true, gst: "not_applicable" });
    const ref = (await newAgreement(head, vendorCp(vendor))).head.agreementRef;
    expect(await kyc(head, ref)).toMatchObject({ state: "AVAILABLE", counterpartyType: "VENDOR", components: { pan: "PRESENT", aadhaar: "NOT_APPLICABLE", gst: "NOT_APPLICABLE", bank: "PRESENT" } });
  });

  it("an actor WITHOUT the identity category sees the STATE only: components RESTRICTED, valuesVisible false, no values or evidence detail anywhere in the DTO", async () => {
    const head = await syntheticActor("partnership_head");
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const secrets = newSecrets();
    await seedRestrictedIdentity(partnerSubject(partner), secrets, { pan: true, bank: true, gst: "number", aadhaar: true, evidence: ["pan", "aadhaar"] });
    const ref = (await newAgreement(head, partnerCp(partner))).head.agreementRef;

    const dto = await kyc(manager, ref);
    expect(dto).toEqual({ agreementRef: ref, counterpartyType: "PARTNER", state: "AVAILABLE", components: { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" }, valuesVisible: false });
    expect(Object.keys(dto)).not.toContain("evidenceTypesPresent");
    const json = JSON.stringify(dto);
    expectNoValues(json, [...secretList(secrets), "drive.example.test", "secret-"]);
    // and neither does the authorized one, even though it sees the detail
    expectNoValues(JSON.stringify(await kyc(head, ref)), [...secretList(secrets), "drive.example.test", "secret-"]);
  });

  it("the state is visible to any actor authorized for the Agreement; Viewer/Analyst, out-of-scope and forged refs are denied identically to every other read", async () => {
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const ref = (await newAgreement(head, partnerCp(partner))).head.agreementRef;
    expect(failed(await getAgreementKycStatus(await syntheticActor("viewer"), ref))).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
    expect(failed(await getAgreementKycStatus(await syntheticActor("analyst"), ref))).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
    const outside = await syntheticActor("partnership_head", { grants: [{ type: "REGION", region: R_OUT }] });
    expect(failed(await getAgreementKycStatus(outside, ref))).toMatchObject(NEUTRAL);
    expect(failed(await getAgreementKycStatus(head, "agr_00000000000000000000"))).toMatchObject(NEUTRAL);
    expect(failed(await getAgreementKycStatus(null, ref))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
  });

  it("FAILS CLOSED: an unreadable store is UNAVAILABLE and no component is ever PRESENT", async () => {
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    await seedRestrictedIdentity(partnerSubject(partner), newSecrets(), { pan: true, bank: true, gst: "number" });
    const ref = (await newAgreement(head, partnerCp(partner))).head.agreementRef;
    vi.spyOn(restrictedIdentityShared, "getRestrictedFinancialIdentityDoc").mockRejectedValue(new Error("store down"));
    const dto = await kyc(head, ref);
    expect(dto.state).toBe("UNAVAILABLE");
    expect(Object.values(dto.components)).not.toContain("PRESENT");
    expect(dto.evidenceTypesPresent).toBeUndefined();
  });
});

// A Partner whose email is set and phone empty, with an Agreement that carries a NEW phone and a DIFFERENT email, both
// ATTACHED as proposals (PENDING) - the decisions are left to each test.
async function contactScenario(actor: ActorContext, options: { vendor?: boolean } = {}) {
  const subject = options.vendor ? vendorSubject(await seedVendor({ email: "old@example.test", phone: null })) : partnerSubject(await seedPartner({ email: "old@example.test", phone: null }));
  const master = subject.type === "PARTNER" ? partnersCollection().doc(subject.uid) : vendorsCollection().doc(subject.uid);
  const ids = await prepared(actor, subject, {
    proposals: [
      { fieldKey: "emailAddress", normalizedValue: "new@example.test" },
      { fieldKey: "contactNumber", normalizedValue: "+919876543210" },
    ],
  });
  const current = async () => (await master.get()).data() as { version: number; email: string | null; phone: string | null };
  return { subject, master, current, ...ids };
}

const contactCommand = (agreementRef: string, over: Record<string, unknown> = {}) => ({ agreementRef, version: 1, fieldKey: "contactNumber", mode: "FILL_MISSING", expectedCounterpartyVersion: 1, ...over });

describe("updateCounterpartyContactFromAgreement: explicit, allowlisted, through the OWNING module", () => {
  it("FILL_MISSING copies the Agreement's DECIDED value onto an empty Partner field, bumps the Partner's version through editPartner, and appends a value-free event", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef, current } = await contactScenario(head);
    await decide(head, agreementRef, "contactNumber", "ACCEPTED");

    const before = await current();
    const outcome = must(await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef), requestId()), "update");
    expect(outcome).toEqual({ agreementRef, version: 1, fieldKey: "contactNumber", mode: "FILL_MISSING", counterpartyType: "PARTNER", counterpartyVersion: before.version + 1 });
    expect(await current()).toMatchObject({ phone: "+919876543210", email: "old@example.test", version: before.version + 1 });

    const events = (await rawEvents(agreementRef)).filter((event) => event.kind === "master_data_updated");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ version: 1, actorUserRef: head.userRef, metadata: { fieldKey: "contactNumber", mode: "FILL_MISSING", counterpartyType: "PARTNER", resolutionAcknowledged: false } });
    expect(Object.keys(events[0]!.metadata!).sort()).toEqual(["counterpartyType", "fieldKey", "mode", "resolutionAcknowledged"]);
    expectNoValues(JSON.stringify(events), ["9876543210", "old@example.test", "new@example.test"]);

    // reconciliation now agrees
    expect(fieldOf((await reconcile(head, agreementRef)).fields, "contactNumber").state).toBe("MATCH");
  });

  it("the value must be DECIDED first: a still-PENDING proposal is refused (not_ready) and nothing changes", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef, master } = await contactScenario(head);
    const before = await rawDoc(master);
    const refused = failed(await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef), requestId()));
    expect(refused).toMatchObject({ code: "not_ready", blockers: [{ code: "field_not_decided" }] });
    expect(await rawDoc(master)).toBe(before);
    expect((await rawEvents(agreementRef)).filter((event) => event.kind === "master_data_updated")).toEqual([]);
  });

  it("FILL_MISSING is REFUSED when CreatorOps already holds a value (conflict), and OVERWRITE_MISMATCH needs a deliberate acknowledged resolution", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef, master, current } = await contactScenario(head);
    await decide(head, agreementRef, "emailAddress", "ACCEPTED");
    const before = await rawDoc(master);

    // FILL on a non-empty canonical email
    expect(failed(await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef, { fieldKey: "emailAddress" }), requestId()))).toMatchObject({ code: "conflict" });
    // OVERWRITE without / with a false acknowledgement / with a too-short reason / with unknown keys
    for (const resolution of [undefined, { acknowledged: false, reason: "Contract is the source of truth" }, { acknowledged: true }, { acknowledged: true, reason: "no" }, { acknowledged: true, reason: "Contract is the source of truth", extra: 1 }]) {
      const refused = failed(await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef, { fieldKey: "emailAddress", mode: "OVERWRITE_MISMATCH", ...(resolution ? { resolution } : {}) }), requestId()));
      expect(refused.code, JSON.stringify(resolution)).toBe("invalid_input");
    }
    expect(await rawDoc(master)).toBe(before);

    // the deliberate one
    const outcome = must(
      await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef, { fieldKey: "emailAddress", mode: "OVERWRITE_MISMATCH", resolution: { acknowledged: true, reason: "Signed contract lists the current address" } }), requestId()),
      "overwrite",
    );
    expect(outcome).toMatchObject({ fieldKey: "emailAddress", mode: "OVERWRITE_MISMATCH", counterpartyVersion: 2 });
    expect(await current()).toMatchObject({ email: "new@example.test", version: 2 });
    const event = (await rawEvents(agreementRef)).find((item) => item.kind === "master_data_updated")!;
    expect(event.metadata).toEqual({ fieldKey: "emailAddress", mode: "OVERWRITE_MISMATCH", counterpartyType: "PARTNER", resolutionAcknowledged: true, reason: "Signed contract lists the current address" });
    expectNoValues(JSON.stringify(event), ["new@example.test", "old@example.test"]);

    // nothing left to overwrite / nothing to replace
    expect(failed(await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef, { fieldKey: "emailAddress", mode: "OVERWRITE_MISMATCH", expectedCounterpartyVersion: 2, resolution: { acknowledged: true, reason: "Again, deliberately" } }), requestId()))).toMatchObject({ code: "conflict" });
    await decide(head, agreementRef, "contactNumber", "ACCEPTED");
    expect(failed(await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef, { mode: "OVERWRITE_MISMATCH", expectedCounterpartyVersion: 2, resolution: { acknowledged: true, reason: "Nothing to replace here" } }), requestId()))).toMatchObject({ code: "conflict" });
  });

  it("the OWNING module decides: a Manager holding manage_agreements WITHOUT partners.edit is denied and nothing changes; the same Manager WITH it succeeds", async () => {
    const head = await syntheticActor("partnership_head");
    const noEdit = await syntheticActor("partnership_manager", { deny: [{ feature: "partners", action: "edit" }] });
    const withEdit = await syntheticActor("partnership_manager");
    const { agreementRef, master, current } = await contactScenario(head);
    await decide(head, agreementRef, "contactNumber", "ACCEPTED");
    const before = await rawDoc(master);
    const eventsBefore = (await rawEvents(agreementRef)).length;

    // reconciliation keeps the STATE but lists no master-data action for the actor the owning module would deny
    expect(fieldOf((await reconcile(noEdit, agreementRef)).fields, "contactNumber")).toMatchObject({ state: "MISSING_IN_CREATOROPS", allowedActions: [] });
    expect(fieldOf((await reconcile(withEdit, agreementRef)).fields, "contactNumber")).toMatchObject({ state: "MISSING_IN_CREATOROPS", allowedActions: ["UPDATE_MASTER_DATA_FROM_AGREEMENT"] });

    expect(failed(await updateCounterpartyContactFromAgreement(noEdit, contactCommand(agreementRef), requestId()))).toMatchObject({ code: "unauthorized", reason: "action_denied" });
    expect(await rawDoc(master)).toBe(before);
    expect((await rawEvents(agreementRef)).length).toBe(eventsBefore);

    must(await updateCounterpartyContactFromAgreement(withEdit, contactCommand(agreementRef), requestId()), "manager update");
    expect((await current()).phone).toBe("+919876543210");
  });

  it("Viewer / Analyst / an actor without manage_agreements are denied; out-of-scope and forged Agreements are neutral not_found", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef, master } = await contactScenario(head);
    await decide(head, agreementRef, "contactNumber", "ACCEPTED");
    const before = await rawDoc(master);
    for (const role of ["viewer", "analyst"] as const) {
      expect(failed(await updateCounterpartyContactFromAgreement(await syntheticActor(role), contactCommand(agreementRef), requestId()))).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
    }
    expect(failed(await updateCounterpartyContactFromAgreement(null, contactCommand(agreementRef), requestId()))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    const outside = await syntheticActor("partnership_head", { grants: [{ type: "REGION", region: R_OUT }] });
    expect(failed(await updateCounterpartyContactFromAgreement(outside, contactCommand(agreementRef), requestId()))).toMatchObject(NEUTRAL);
    expect(failed(await updateCounterpartyContactFromAgreement(head, contactCommand("agr_00000000000000000000"), requestId()))).toMatchObject(NEUTRAL);
    expect(await rawDoc(master)).toBe(before);
  });

  it("only the allowlisted fields are accepted, and the value can never come from the request body", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef, master } = await contactScenario(head);
    await decide(head, agreementRef, "contactNumber", "ACCEPTED");
    const before = await rawDoc(master);
    for (const fieldKey of ["counterpartyName", "panNumber", "state", "address", "legalName", "regionIds"]) {
      expect(failed(await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef, { fieldKey }), requestId())).code, fieldKey).toBe("invalid_input");
    }
    for (const extra of [{ value: "+911111111111" }, { phone: "+911111111111" }, { email: "x@example.test" }, { partnerRef: "other" }]) {
      expect(failed(await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef, extra), requestId())).code, JSON.stringify(extra)).toBe("invalid_input");
    }
    expect(await rawDoc(master)).toBe(before);
  });

  it("a stale Partner version or a stale Agreement docVersion is a stale_write and changes nothing", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef, master } = await contactScenario(head);
    await decide(head, agreementRef, "contactNumber", "ACCEPTED");
    const before = await rawDoc(master);
    expect(failed(await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef, { expectedCounterpartyVersion: 7 }), requestId()))).toMatchObject({ code: "stale_write" });
    expect(failed(await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef, { expectedDocVersion: 99 }), requestId()))).toMatchObject({ code: "stale_write" });
    expect(await rawDoc(master)).toBe(before);
    expect((await rawEvents(agreementRef)).filter((event) => event.kind === "master_data_updated")).toEqual([]);
  });

  it("writes ONLY the owning module's Partner record + its own audit event and the Agreement's own event - never KYC, never the version / head", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef, subject } = await contactScenario(head);
    await decide(head, agreementRef, "contactNumber", "ACCEPTED");
    const io = instrument();
    try {
      must(await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef), requestId()), "update");
    } finally {
      io.stop();
    }
    const unique = [...new Set(io.writes)];
    for (const path of unique) expect(path, path).toMatch(new RegExp(`^(partners/${subject.uid}(/events/[^/]+)?|financeAgreements/${agreementRef}/events/[^/]+)$`));
    expect(unique.some((path) => path === `partners/${subject.uid}`)).toBe(true);
    expect(unique.some((path) => path.startsWith("restrictedFinancialIdentities/"))).toBe(false);
  });

  it("a Vendor counterparty goes through editVendor the same way", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef, current } = await contactScenario(head, { vendor: true });
    await decide(head, agreementRef, "contactNumber", "ACCEPTED");
    const outcome = must(await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef), requestId()), "vendor update");
    expect(outcome).toMatchObject({ counterpartyType: "VENDOR", counterpartyVersion: 2 });
    expect(await current()).toMatchObject({ phone: "+919876543210", version: 2 });
    const noVendorEdit = await syntheticActor("partnership_manager", { deny: [{ feature: "vendors", action: "edit" }] });
    await decide(head, agreementRef, "emailAddress", "ACCEPTED");
    expect(failed(await updateCounterpartyContactFromAgreement(noVendorEdit, contactCommand(agreementRef, { fieldKey: "emailAddress", mode: "OVERWRITE_MISMATCH", expectedCounterpartyVersion: 2, resolution: { acknowledged: true, reason: "Contract is authoritative" } }), requestId()))).toMatchObject({ code: "unauthorized", reason: "action_denied" });
    expect((await current()).email).toBe("old@example.test");
  });

  it("works from a CONFIRMED version's frozen terms too (the decided value is frozen), never from an ended / superseded one", async () => {
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner({ legalName: "Acme Talent Private Limited", email: "frozen@example.test", phone: null });
    const agreementRef = (await newAgreement(head, partnerCp(partner))).head.agreementRef;
    for (const seed of READY_DECISIONS) await decide(head, agreementRef, seed.fieldKey, seed.decision, seed.value);
    await decide(head, agreementRef, "contactNumber", "CORRECTED", "+919811122233");
    const pending = Object.entries(must(await getAgreementDetail(head, agreementRef), "detail").selectedVersion!.draft).filter(([, entry]) => entry?.decision === "PENDING").map(([fieldKey]) => fieldKey);
    for (const fieldKey of pending) await decide(head, agreementRef, fieldKey, "ACCEPTED");
    must(await confirmAgreementVersion(head, { agreementRef, version: 1, expectedDocVersion: await docVersionOf(head, agreementRef) }, requestId()), "confirm");

    must(await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef, { expectedCounterpartyVersion: partner.version }), requestId()), "confirmed update");
    expect(((await partnersCollection().doc(partner.uid).get()).data() as { phone: string }).phone).toBe("+919811122233");
  });
});

// A counterparty with (optionally) a canonical identity record and an Agreement whose extraction carries the given RESTRICTED
// raw values. Identity proposals become value-less acknowledgement entries; `accept` lists the identity fields a human accepted.
type KycScenarioOptions = { vendor?: boolean; canonical?: IdentityParts; extracted: Record<string, string>; accept?: string[] };
async function kycScenario(actor: ActorContext, options: KycScenarioOptions) {
  const partner = options.vendor ? null : await seedPartner();
  const vendor = options.vendor ? await seedVendor() : null;
  const subject = partner ? partnerSubject(partner) : vendorSubject(vendor!);
  const secrets = newSecrets();
  if (options.canonical) await seedRestrictedIdentity(subject, secrets, options.canonical);
  const ids = await prepared(actor, subject, { proposals: Object.keys(options.extracted).map((fieldKey) => ({ fieldKey, normalizedValue: null })), restricted: options.extracted });
  for (const fieldKey of options.accept ?? Object.keys(options.extracted)) await decide(actor, ids.agreementRef, fieldKey, "ACCEPTED");
  const rawIdentity = async () => (await identityRef(subject).get()).data() as Record<string, unknown> | undefined;
  const masterRef = subject.type === "PARTNER" ? partnersCollection().doc(subject.uid) : vendorsCollection().doc(subject.uid);
  return { subject, secrets, rawIdentity, masterRef, ...ids };
}

const kycCommand = (agreementRef: string, over: Record<string, unknown> = {}) => ({ agreementRef, version: 1, components: ["pan"], mode: "FILL_MISSING", ...over });
const RESOLUTION = { acknowledged: true, reason: "Signed contract is the source of truth" };

describe("applyExtractedKycToCanonical: fills the CANONICAL restricted store only, through the owning module", () => {
  it("Partner: FILL_MISSING writes PAN / GST / Aadhaar into the canonical record - and ONLY there; no Finance document ever holds a value; the event names components only", async () => {
    const head = await syntheticActor("partnership_head");
    const pan = newPan();
    const gstin = newGstin();
    const aadhaar = newAadhaar();
    const { subject, agreementRef, rawIdentity, masterRef } = await kycScenario(head, { extracted: { panNumber: pan, gstin, aadhaarNumber: aadhaar } });
    expect(await rawIdentity()).toBeUndefined();

    const proposals = (await reconcile(head, agreementRef)).fields;
    for (const key of ["panNumber", "gstin", "aadhaarNumber"]) expect(fieldOf(proposals, key)).toMatchObject({ state: "MISSING_IN_CREATOROPS", allowedActions: ["UPDATE_MASTER_DATA_FROM_AGREEMENT"] });
    const masterBefore = await rawDoc(masterRef);

    const io = instrument();
    let outcome;
    try {
      outcome = must(await applyExtractedKycToCanonical(head, kycCommand(agreementRef, { components: ["pan", "gst", "aadhaar"] }), requestId()), "apply");
    } finally {
      io.stop();
    }
    expect(outcome).toEqual({ agreementRef, version: 1, counterpartyType: "PARTNER", mode: "FILL_MISSING", components: ["pan", "gst", "aadhaar"], identityVersion: 1 });

    // canonical store
    expect(await rawIdentity()).toMatchObject({ subjectType: "PARTNER", subjectRef: subject.ref, version: 1, pan: { number: pan }, gst: { applicable: true, number: gstin }, aadhaar: { number: aadhaar }, bank: null, evidence: [] });
    // writes: canonical identity store, the owning module's own Partner audit event, the Agreement's own event - nothing else, never the Partner doc
    const unique = [...new Set(io.writes)];
    expect(unique.length).toBeGreaterThan(0);
    for (const path of unique) expect(path, path).toMatch(/^(restrictedFinancialIdentities|partners\/[^/]+\/events|financeAgreements\/[^/]+\/events)\//);
    expect(unique.some((path) => path.startsWith("restrictedFinancialIdentities/"))).toBe(true);
    expect(await rawDoc(masterRef)).toBe(masterBefore);

    // Finance stores no identity data; the event carries names only
    expectNoValues(await financeDocsJson([agreementRef]), [pan, gstin, aadhaar]);
    await expectNoIdentityProperties([agreementRef]);
    const event = (await rawEvents(agreementRef)).find((item) => item.kind === "kyc_updated_from_agreement")!;
    expect(event.metadata).toEqual({ components: ["pan", "gst", "aadhaar"], mode: "FILL_MISSING", counterpartyType: "PARTNER", resolutionAcknowledged: false });

    // reconciliation now agrees; KYC status: PAN / GST / Aadhaar present, bank still missing
    const after = (await reconcile(head, agreementRef)).fields;
    for (const key of ["panNumber", "gstin", "aadhaarNumber"]) expect(fieldOf(after, key).state).toBe("MATCH");
    expect(must(await getAgreementKycStatus(head, agreementRef), "kyc")).toMatchObject({ state: "INCOMPLETE", components: { pan: "PRESENT", gst: "PRESENT", aadhaar: "PRESENT", bank: "MISSING" } });
  });

  it("carries every other component and the evidence through untouched (merged existing + new)", async () => {
    const head = await syntheticActor("partnership_head");
    const gstin = newGstin();
    const { subject, secrets, agreementRef, rawIdentity } = await kycScenario(head, { canonical: { pan: true, bank: true, evidence: ["pan", "bank"] }, extracted: { gstin } });
    const before = (await rawIdentity())!;

    const outcome = must(await applyExtractedKycToCanonical(head, kycCommand(agreementRef, { components: ["gst"] }), requestId()), "apply");
    expect(outcome.identityVersion).toBe(2);
    const after = (await rawIdentity())!;
    expect(after).toMatchObject({ version: 2, gst: { applicable: true, number: gstin }, pan: { number: secrets.pan }, bank: before.bank, evidence: before.evidence, aadhaar: null });
    expect(subject.type).toBe("PARTNER");
  });

  it("NEVER replaces a non-empty component silently: FILL_MISSING conflicts (atomically, nothing is written); OVERWRITE_MISMATCH needs an acknowledged resolution", async () => {
    const head = await syntheticActor("partnership_head");
    const newPanValue = newPan();
    const gstin = newGstin();
    const { secrets, agreementRef, rawIdentity } = await kycScenario(head, { canonical: { pan: true, bank: true }, extracted: { panNumber: newPanValue, gstin } });
    const before = JSON.stringify(await rawIdentity());

    // pan is on file: FILL of [pan, gst] is refused as a whole - gst is NOT written either
    expect(failed(await applyExtractedKycToCanonical(head, kycCommand(agreementRef, { components: ["pan", "gst"] }), requestId()))).toMatchObject({ code: "conflict" });
    expect(failed(await applyExtractedKycToCanonical(head, kycCommand(agreementRef, { components: ["pan"] }), requestId()))).toMatchObject({ code: "conflict" });
    expect(JSON.stringify(await rawIdentity())).toBe(before);

    // OVERWRITE: resolution mandatory
    for (const resolution of [undefined, { acknowledged: false, reason: "Signed contract is the source of truth" }, { acknowledged: true }, { acknowledged: true, reason: "x" }]) {
      const refused = failed(await applyExtractedKycToCanonical(head, kycCommand(agreementRef, { components: ["pan"], mode: "OVERWRITE_MISMATCH", ...(resolution ? { resolution } : {}) }), requestId()));
      expect(refused.code, JSON.stringify(resolution)).toBe("invalid_input");
    }
    // OVERWRITE of an EMPTY component: nothing to replace
    expect(failed(await applyExtractedKycToCanonical(head, kycCommand(agreementRef, { components: ["gst"], mode: "OVERWRITE_MISMATCH", resolution: RESOLUTION }), requestId()))).toMatchObject({ code: "conflict" });
    expect(JSON.stringify(await rawIdentity())).toBe(before);

    // the deliberate overwrite, still through the owning service (version bumps, other components kept)
    const outcome = must(await applyExtractedKycToCanonical(head, kycCommand(agreementRef, { components: ["pan"], mode: "OVERWRITE_MISMATCH", resolution: RESOLUTION }), requestId()), "overwrite");
    expect(outcome).toMatchObject({ components: ["pan"], mode: "OVERWRITE_MISMATCH", identityVersion: 2 });
    expect(await rawIdentity()).toMatchObject({ pan: { number: newPanValue }, bank: { accountNumber: secrets.account }, version: 2 });
    const event = (await rawEvents(agreementRef)).find((item) => item.kind === "kyc_updated_from_agreement")!;
    expect(event.metadata).toEqual({ components: ["pan"], mode: "OVERWRITE_MISMATCH", counterpartyType: "PARTNER", resolutionAcknowledged: true, reason: RESOLUTION.reason });
    expectNoValues(await financeDocsJson([agreementRef]), [newPanValue, gstin, secrets.pan, secrets.account]);

    // identical value: nothing to overwrite
    expect(failed(await applyExtractedKycToCanonical(head, kycCommand(agreementRef, { components: ["pan"], mode: "OVERWRITE_MISMATCH", resolution: RESOLUTION }), requestId()))).toMatchObject({ code: "conflict" });
  });

  it("the OWNING module and the sensitive categories decide: Manager (no finance_contracts / identity category) and a Head whose partners restricted-identity action is switched off are denied; nothing changes", async () => {
    const head = await syntheticActor("partnership_head");
    const manager = await syntheticActor("partnership_manager");
    const noOwningAction = await syntheticActor("partnership_head", { deny: [{ feature: "partners", action: "manage_partner_restricted_identity" }] });
    const { agreementRef, rawIdentity, masterRef } = await kycScenario(head, { extracted: { panNumber: newPan() } });
    const masterBefore = await rawDoc(masterRef);
    const eventsBefore = (await rawEvents(agreementRef)).length;

    expect(failed(await applyExtractedKycToCanonical(manager, kycCommand(agreementRef), requestId()))).toMatchObject({ code: "unauthorized", reason: "sensitive_denied" });
    expect(failed(await applyExtractedKycToCanonical(noOwningAction, kycCommand(agreementRef), requestId()))).toMatchObject({ code: "unauthorized", reason: "action_denied" });
    for (const role of ["viewer", "analyst"] as const) {
      expect(failed(await applyExtractedKycToCanonical(await syntheticActor(role), kycCommand(agreementRef), requestId()))).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
    }
    const outside = await syntheticActor("partnership_head", { grants: [{ type: "REGION", region: R_OUT }] });
    expect(failed(await applyExtractedKycToCanonical(outside, kycCommand(agreementRef), requestId()))).toMatchObject(NEUTRAL);
    expect(failed(await applyExtractedKycToCanonical(null, kycCommand(agreementRef), requestId()))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });

    expect(await rawIdentity()).toBeUndefined();
    expect(await rawDoc(masterRef)).toBe(masterBefore);
    expect((await rawEvents(agreementRef)).length).toBe(eventsBefore);
    // and the allowed one does work
    must(await applyExtractedKycToCanonical(head, kycCommand(agreementRef), requestId()), "head apply");
    expect((await rawIdentity())!.pan).toBeTruthy();
  });

  it("an identity field must first be ACCEPTED on the Agreement; an extraction must be attached; bank is refused; unusable / masked values are refused", async () => {
    const head = await syntheticActor("partnership_head");
    // not accepted
    const undecided = await kycScenario(head, { extracted: { panNumber: newPan() }, accept: [] });
    expect(failed(await applyExtractedKycToCanonical(head, kycCommand(undecided.agreementRef), requestId()))).toMatchObject({ code: "not_ready", blockers: [{ code: "field_not_decided", fieldKey: "panNumber" }] });
    expect(await undecided.rawIdentity()).toBeUndefined();

    // no extraction attached
    const partner = await seedPartner();
    const bare = (await newAgreement(head, partnerCp(partner))).head.agreementRef;
    const noExtraction = failed(await applyExtractedKycToCanonical(head, kycCommand(bare), requestId()));
    expect(noExtraction).toMatchObject({ code: "not_ready" });
    expect(noExtraction.blockers!.map((blocker) => blocker.code)).toContain("no_extraction_attached");

    // bank
    const withBank = await kycScenario(head, { extracted: { bankAccountNumber: newAccount(), ifsc: newIfsc() } });
    expect(failed(await applyExtractedKycToCanonical(head, kycCommand(withBank.agreementRef, { components: ["bank"] }), requestId()))).toMatchObject({ code: "not_ready", blockers: [{ code: "bank_details_incomplete" }] });
    expect(await withBank.rawIdentity()).toBeUndefined();

    // masked Aadhaar, malformed PAN, malformed GSTIN
    const unusable = await kycScenario(head, { extracted: { aadhaarNumber: "XXXXXXXX2346", panNumber: "NOTAPAN", gstin: "NOTAGSTIN" } });
    const refused = failed(await applyExtractedKycToCanonical(head, kycCommand(unusable.agreementRef, { components: ["aadhaar", "pan", "gst"] }), requestId()));
    expect(refused).toMatchObject({ code: "not_ready" });
    expect(refused.blockers!.map((blocker) => blocker.code)).toEqual(["no_usable_extracted_value", "no_usable_extracted_value", "no_usable_extracted_value"]);
    expect(await unusable.rawIdentity()).toBeUndefined();
  });

  it("strict input: no values in the body, no unknown keys, no empty / duplicate component list, no Aadhaar for a Vendor", async () => {
    const head = await syntheticActor("partnership_head");
    const { agreementRef, rawIdentity } = await kycScenario(head, { extracted: { panNumber: newPan() } });
    for (const over of [{ pan: "ABCDE1234F" }, { value: "ABCDE1234F" }, { components: [] }, { components: ["pan", "pan"] }, { components: ["pancard"] }, { mode: "OVERWRITE" }, { version: 0 }]) {
      expect(failed(await applyExtractedKycToCanonical(head, kycCommand(agreementRef, over), requestId())).code, JSON.stringify(over)).toBe("invalid_input");
    }
    expect(await rawIdentity()).toBeUndefined();

    const vendorScenario = await kycScenario(head, { vendor: true, extracted: { panNumber: newPan() } });
    expect(failed(await applyExtractedKycToCanonical(head, kycCommand(vendorScenario.agreementRef, { components: ["aadhaar"] }), requestId()))).toMatchObject({ code: "invalid_input" });
    expect(await vendorScenario.rawIdentity()).toBeUndefined();
  });

  it("Vendor: PAN + GST go through saveVendorRestrictedIdentity into the VENDOR canonical record; the bank on file is kept; no Finance document holds a value", async () => {
    const head = await syntheticActor("partnership_head");
    const pan = newPan();
    const gstin = newGstin();
    const { subject, secrets, agreementRef, rawIdentity, masterRef } = await kycScenario(head, { vendor: true, canonical: { bank: true }, extracted: { panNumber: pan, gstin } });
    const masterBefore = await rawDoc(masterRef);

    const outcome = must(await applyExtractedKycToCanonical(head, kycCommand(agreementRef, { components: ["pan", "gst"] }), requestId()), "vendor apply");
    expect(outcome).toMatchObject({ counterpartyType: "VENDOR", components: ["pan", "gst"], identityVersion: 2 });
    expect(await rawIdentity()).toMatchObject({ subjectType: "VENDOR", subjectRef: subject.ref, version: 2, pan: { number: pan }, gst: { applicable: true, number: gstin }, bank: { accountNumber: secrets.account } });
    expect(await rawDoc(masterRef)).toBe(masterBefore);
    expectNoValues(await financeDocsJson([agreementRef]), [pan, gstin, secrets.account, secrets.ifsc]);
    await expectNoIdentityProperties([agreementRef]);
    const event = (await rawEvents(agreementRef)).find((item) => item.kind === "kyc_updated_from_agreement")!;
    expect(event.metadata).toEqual({ components: ["pan", "gst"], mode: "FILL_MISSING", counterpartyType: "VENDOR", resolutionAcknowledged: false });

    const noVendorAction = await syntheticActor("partnership_head", { deny: [{ feature: "vendors", action: "manage_vendor_restricted_identity" }] });
    expect(failed(await applyExtractedKycToCanonical(noVendorAction, kycCommand(agreementRef, { components: ["pan"], mode: "OVERWRITE_MISMATCH", resolution: RESOLUTION }), requestId()))).toMatchObject({ code: "unauthorized", reason: "action_denied" });
  });
});

describe("audit events and Finance storage hold no restricted value", () => {
  it("every Agreement event of an extraction + reconcile + decide + contact + KYC flow carries only allowlisted names / flags, and no value", async () => {
    const head = await syntheticActor("partnership_head");
    const pan = newPan();
    const gstin = newGstin();
    const { agreementRef, secrets } = await (async () => {
      const partner = await seedPartner({ email: "old@example.test", phone: null });
      const secrets = newSecrets();
      await seedRestrictedIdentity(partnerSubject(partner), secrets, { bank: true });
      const ids = await prepared(head, partnerSubject(partner), {
        proposals: [
          { fieldKey: "contactNumber", normalizedValue: "+919812345678" },
          { fieldKey: "panNumber", normalizedValue: null },
          { fieldKey: "gstin", normalizedValue: null },
        ],
        restricted: { panNumber: pan, gstin },
      });
      return { ...ids, secrets };
    })();
    await decide(head, agreementRef, "contactNumber", "ACCEPTED");
    await decide(head, agreementRef, "panNumber", "ACCEPTED");
    await decide(head, agreementRef, "gstin", "ACCEPTED");
    await reconcile(head, agreementRef);
    must(await updateCounterpartyContactFromAgreement(head, contactCommand(agreementRef, { expectedCounterpartyVersion: 1 }), requestId()), "contact");
    must(await applyExtractedKycToCanonical(head, kycCommand(agreementRef, { components: ["pan", "gst"] }), requestId()), "kyc");

    const events = await rawEvents(agreementRef);
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(["created", "extraction_attached", "field_decided", "master_data_updated", "kyc_updated_from_agreement"]));
    const { AGREEMENT_EVENT_METADATA_ALLOWLIST } = await import("./agreement-events");
    for (const event of events) for (const key of Object.keys(event.metadata ?? {})) expect(Object.keys(AGREEMENT_EVENT_METADATA_ALLOWLIST), `${event.kind}.${key}`).toContain(key);
    const json = await financeDocsJson([agreementRef]);
    expectNoValues(json, [pan, gstin, ...secretList(secrets)]);
  });
});
