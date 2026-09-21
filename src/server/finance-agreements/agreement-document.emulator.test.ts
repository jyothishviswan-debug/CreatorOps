// Step 14B.1 - the ORIGINAL signed Agreement document (durable Drive copy) against the running Firestore/Auth emulator (no mocks of the
// services). Drive is ALWAYS the in-memory FAKE adapter: nothing here can reach Google, and a static test guards that. The PDF bytes go
// through the REAL upload service into an in-memory ContractArtifactStore.
//
// Proves: the exact uploaded bytes reach the adapter (no generated substitute), one Drive file per Agreement VERSION, an idempotent retry
// (same file / reference, no second file, even concurrently), a failed attempt that keeps the source artifact and stays retriable, a truthful
// NOT_CONFIGURED (no fabricated link), the Finance detail and the Partner / Vendor projection carrying the SAME file reference, v1 / v2 keeping
// distinct files, an honest label for a revision without a new signed file, activation blocked until the document is stored, the role / scope /
// sensitive matrix (link only with finance_contracts; profile-only access gets nothing; out-of-scope is neutral), and events without links.
//
// Hermetic: every actor's ONLY scope is a per-run private REGION; fixtures are private-region Partners / Vendors with unique ids; everything
// created is removed afterwards.
import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { COLLECTIONS } from "@/server/authz/firestore";
import { scopeGrantDocId } from "@/server/authz/scope";
import { seedAccessControlData } from "@/server/authz/seed-access-data";
import type { ActorContext, ScopeGrant, ScopeGrantInput } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { partnersCollection } from "@/server/partners/firestore";
import { partnerDocSchema, type PartnerDoc } from "@/server/partners/types";
import { vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema, type VendorDoc } from "@/server/vendors/types";

import {
  activateAgreementVersion,
  attachExtractionProposals,
  confirmAgreementVersion,
  createAgreementDraft,
  createAgreementRevision,
  decideField,
  getAgreementDetail,
  getAgreementDocumentStatus,
  listAgreementEvents,
  listCounterpartyAgreementDocuments,
  storeAgreementDocument,
  type AgreementDetailDto,
} from "./index";
import { contractArtifactClaimId, uploadContractArtifact } from "./contract-service";
import { createInMemoryArtifactStore, setContractArtifactStoreForTests, type ContractArtifactStore } from "./contract-artifacts/store";
import { sha256Hex } from "./contract-artifacts/validation";
import { setAgreementDocumentStorageForTests } from "./document-storage";
import { agreementClaimId, financeAgreementClaimsCollection, financeAgreementEventsCollection, financeAgreementExtractionRunsCollection, financeAgreementVersionsCollection, financeAgreementsCollection, financeContractArtifactsCollection } from "./firestore";
import { generateExtractionRunRef } from "./ids";
import { installFakeAgreementDocumentStorage, samplePdfBytes } from "./testing/agreement-document-fixtures";
import { READY_DECISIONS, type FieldDecisionSeed } from "./testing/agreement-service-fixtures";
import { extractionRunDocSchema, type AgreementCounterpartyInput, type FinanceAgreementsErrorResult, type FinanceAgreementsServiceResult } from "./types";

vi.setConfig({ testTimeout: 90_000 });

const runId = Date.now();
const R_IN = `fad-in-${runId}`;
const R_OUT = `fad-out-${runId}`;
const NEUTRAL = { ok: false, code: "not_found", message: "Not found." };

const cleanup: FirebaseFirestore.DocumentReference[] = [];
const agreementRefs: string[] = [];
const claimIds: string[] = [];
const grantDocIds: string[] = [];
let counter = 0;

let artifactStore: ContractArtifactStore = createInMemoryArtifactStore();
let drive = installFakeAgreementDocumentStorage();

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
}, 60_000);

beforeEach(() => {
  artifactStore = createInMemoryArtifactStore();
  setContractArtifactStoreForTests(artifactStore);
  drive = installFakeAgreementDocumentStorage();
});

afterEach(() => {
  setContractArtifactStoreForTests(null);
  drive.restore();
});

afterAll(async () => {
  const db = getAdminFirestore();
  for (const ref of agreementRefs.splice(0)) await db.recursiveDelete(financeAgreementsCollection().doc(ref));
  await Promise.all(claimIds.splice(0).map((id) => financeAgreementClaimsCollection().doc(id).delete()));
  await Promise.all(cleanup.splice(0).map((ref) => ref.delete()));
  await Promise.all(grantDocIds.splice(0).map((id) => db.collection(COLLECTIONS.scopeAssignments).doc(id).delete()));
});

// ---- Actors -----------------------------------------------------------------------------------------------------------------
type Role = ActorContext["role"];
async function syntheticActor(role: Role, grants: ScopeGrantInput[] = [{ type: "REGION", region: R_IN }]): Promise<ActorContext> {
  const uid = `fad-${role}-${runId}-${randomUUID().slice(0, 6)}`;
  const grantedAt = new Date().toISOString();
  for (const input of grants) {
    const id = scopeGrantDocId(uid, input);
    await getAdminFirestore().collection(COLLECTIONS.scopeAssignments).doc(id).set({ ...input, uid, grantedAt, grantedBy: "fad-test" } as ScopeGrant);
    grantDocIds.push(id);
  }
  return { uid, email: `${uid}@example.test`, role, displayName: `FAD ${role}`, userRef: `fad-ref-${uid}` };
}

// ---- Fixtures ---------------------------------------------------------------------------------------------------------------
async function seedPartner(): Promise<PartnerDoc> {
  counter += 1;
  const uid = `fad-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = `FAD Partner ${counter} ${runId}`;
  const partner = partnerDocSchema.parse({ uid, partnerRef: `ref-${uid}`, version: 1, displayName, displayNameLower: displayName.toLowerCase(), legalName: null, email: `partner-${counter}@example.test`, phone: "+91 90000 00000", status: "ACTIVE", regionIds: [R_IN], createdAt: now, createdByUserRef: "fad-test", updatedAt: now, updatedByUserRef: "fad-test" });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  cleanup.push(ref);
  return partner;
}

async function seedVendor(): Promise<VendorDoc> {
  counter += 1;
  const uid = `fad-vendor-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = `FAD Vendor ${counter} ${runId}`;
  const vendor = vendorDocSchema.parse({ uid, vendorRef: `ref-${uid}`, version: 1, displayName, displayNameLower: displayName.toLowerCase(), vendorType: "AGENCY", email: `vendor-${counter}@example.test`, status: "ACTIVE", regionIds: [R_IN], createdAt: now, createdByUserRef: "fad-test", updatedAt: now, updatedByUserRef: "fad-test" });
  const ref = vendorsCollection().doc(uid);
  await ref.set(vendor);
  cleanup.push(ref);
  return vendor;
}

// ---- Result helpers ---------------------------------------------------------------------------------------------------------
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
const refOf = (cp: AgreementCounterpartyInput) => (cp.type === "PARTNER" ? cp.partnerRef : cp.vendorRef);

let reqCounter = 0;
const requestId = () => `req-${runId}-${(reqCounter += 1)}`;
const docVersionOf = (detail: AgreementDetailDto) => detail.selectedVersion!.docVersion;

async function newAgreement(actor: ActorContext, counterparty: AgreementCounterpartyInput): Promise<AgreementDetailDto> {
  const clientRequestId = `crid-${runId}-${(counter += 1)}-${randomUUID().slice(0, 6)}`;
  const outcome = must(await createAgreementDraft(actor, { clientRequestId, counterparty }, requestId()), "create");
  agreementRefs.push(outcome.agreement.head.agreementRef);
  claimIds.push(agreementClaimId(actor.uid, clientRequestId));
  return outcome.agreement;
}

async function decideAll(actor: ActorContext, detail: AgreementDetailDto, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
  let current = detail;
  for (const seed of seeds) {
    current = must(await decideField(actor, { agreementRef: current.head.agreementRef, version: current.selectedVersion!.version, expectedDocVersion: docVersionOf(current), fieldKey: seed.fieldKey, decision: seed.decision, ...(seed.value !== undefined ? { value: seed.value } : {}) }, requestId()), `decide ${seed.fieldKey}`);
  }
  return current;
}

async function acceptPending(actor: ActorContext, detail: AgreementDetailDto): Promise<AgreementDetailDto> {
  const pending = Object.entries(detail.selectedVersion!.draft).filter(([, entry]) => entry?.decision === "PENDING").map(([fieldKey]) => ({ fieldKey, decision: "ACCEPTED" as const }));
  return decideAll(actor, detail, pending as FieldDecisionSeed[]);
}

async function confirm(actor: ActorContext, detail: AgreementDetailDto) {
  return must(await confirmAgreementVersion(actor, { agreementRef: detail.head.agreementRef, version: detail.selectedVersion!.version, expectedDocVersion: docVersionOf(detail) }, requestId()), "confirm");
}

// Uploads a REAL PDF through the upload service (the bytes land in the in-memory artifact store), records a synthetic extraction run for it and
// attaches that run to the open version.
async function attachSignedFile(actor: ActorContext, detail: AgreementDetailDto, counterparty: AgreementCounterpartyInput, file: { bytes: Buffer; fileName: string }): Promise<AgreementDetailDto> {
  const uploaded = must(await uploadContractArtifact(actor, { fileName: file.fileName, bytes: file.bytes, counterparty: { type: counterparty.type, ref: refOf(counterparty) } }, requestId()), "upload");
  claimIds.push(contractArtifactClaimId(counterparty.type, refOf(counterparty), sha256Hex(file.bytes)));
  cleanup.push(financeContractArtifactsCollection().doc(uploaded.artifact.artifactRef));
  const agreementRef = detail.head.agreementRef;
  const run = extractionRunDocSchema.parse({
    runRef: generateExtractionRunRef(),
    agreementRef,
    artifactRef: uploaded.artifact.artifactRef,
    status: "EXTRACTED",
    reasonCodes: [],
    parserVersion: "test-parser-1",
    pageCount: 1,
    charCount: 100,
    proposals: [{ fieldKey: "currency", normalizedValue: "INR", confidence: "HIGH", warnings: [], requiresHumanConfirmation: true, source: { page: 1 } }],
    createdAt: new Date().toISOString(),
    createdByUserRef: "fad-test",
  });
  await financeAgreementExtractionRunsCollection(agreementRef).doc(run.runRef).set(run);
  return must(await attachExtractionProposals(actor, { agreementRef, version: detail.selectedVersion!.version, expectedDocVersion: docVersionOf(detail), extractionRunRef: run.runRef }, requestId()), "attach").agreement;
}

// create -> upload real PDF -> attach -> decide READY -> accept -> confirm. Returns the confirmed detail.
async function confirmedWithFile(manager: ActorContext, counterparty: AgreementCounterpartyInput, file = { bytes: samplePdfBytes(`file-${(counter += 1)}-${runId}`), fileName: "Signed Agreement.pdf" }) {
  const created = await newAgreement(manager, counterparty);
  const attached = await attachSignedFile(manager, created, counterparty, file);
  const ready = await acceptPending(manager, await decideAll(manager, attached, READY_DECISIONS));
  return { confirmed: await confirm(manager, ready), file };
}

// create -> decide READY -> accept -> confirm, with NO signed file at all.
async function confirmedManual(manager: ActorContext, counterparty: AgreementCounterpartyInput) {
  const created = await newAgreement(manager, counterparty);
  return confirm(manager, await acceptPending(manager, await decideAll(manager, created, READY_DECISIONS)));
}

const store = (actor: ActorContext | null, detail: AgreementDetailDto, version = detail.selectedVersion!.version) => storeAgreementDocument(actor, { agreementRef: detail.head.agreementRef, version }, requestId());
const activate = (actor: ActorContext, detail: AgreementDetailDto, version = detail.selectedVersion!.version, headDocVersion = detail.head.docVersion) => activateAgreementVersion(actor, { agreementRef: detail.head.agreementRef, version, expectedDocVersion: headDocVersion }, requestId());
const fresh = async (actor: ActorContext, agreementRef: string, version?: number) => must(await getAgreementDetail(actor, agreementRef, version ? { version } : {}), "detail");

async function rawVersion(agreementRef: string, version: number) {
  return (await financeAgreementVersionsCollection(agreementRef).doc(String(version)).get()).data() as Record<string, unknown>;
}
async function rawEvents(agreementRef: string) {
  const snap = await financeAgreementEventsCollection(agreementRef).get();
  return snap.docs.map((doc) => doc.data() as { kind: string; version: number; actorUserRef: string; metadata: Record<string, unknown> | null });
}
async function rawHeadDocVersion(agreementRef: string): Promise<number> {
  return ((await financeAgreementsCollection().doc(agreementRef).get()).data() as { docVersion: number }).docVersion;
}

// The confirmed parts of a version - byte-identical after a document write. (`document`, docVersion and updatedAt / updatedByUserRef are the ONLY
// things a store attempt may change.)
const CONFIRMED_KEYS = ["terms", "contactSnapshot", "identityStatusSnapshot", "fieldProvenance", "effective", "confirmation", "source", "counterparty", "draft", "sourceMode", "status", "activation", "createdAt", "createdByUserRef"] as const;
const confirmedParts = (raw: Record<string, unknown>) => JSON.stringify(CONFIRMED_KEYS.map((key) => raw[key]));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// =====================================================================================================================
describe("the original signed document reaches storage byte for byte", () => {
  it("stores the EXACT uploaded PDF once (never a generated substitute), records the reference on the version only, and leaves every confirmed part untouched", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const { confirmed, file } = await confirmedWithFile(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;
    expect(confirmed.selectedVersion!.document).toMatchObject({ status: "PENDING", hasLink: false, canStore: true, fileName: null });

    const before = await rawVersion(ref, 1);
    const outcome = must(await store(manager, confirmed), "store");
    expect(outcome).toMatchObject({ outcome: "stored", retriable: false, document: { status: "STORED", fileName: "Signed Agreement.pdf", hasLink: true, attemptCount: 1, canStore: false, message: null } });
    // the Manager holds no finance_contracts: it learns that a link exists, never the link
    expect(outcome.document.link).toBeUndefined();

    // 1. the adapter received the exact uploaded bytes
    expect(drive.storage.files).toHaveLength(1);
    const [stored] = drive.storage.files;
    expect(stored!.receivedSha256).toBe(sha(file.bytes));
    expect(Buffer.from(stored!.bytes).equals(file.bytes)).toBe(true);
    expect(drive.storage.calls[0]).toMatchObject({ byteLength: file.bytes.byteLength, mimeType: "application/pdf", target: "PARTNER", outcome: "created" });
    expect(stored!.metadata).toEqual({ agreementRef: ref, version: 1, counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef, artifactSha256: sha(file.bytes) });
    expect(stored!.idempotencyKey).toBe(createHash("sha256").update(`${ref}|1|${sha(file.bytes)}`).digest("hex"));
    expect(stored!.driveFileName).toBe(`Signed Agreement [${ref} v1].pdf`);
    // ... and they are the same bytes the artifact store still holds
    const rawBefore = before.source as { contractArtifactRef: string };
    const artifactRaw = (await financeContractArtifactsCollection().doc(rawBefore.contractArtifactRef).get()).data() as { storageLocator: string; sha256: string };
    expect(sha(await artifactStore.get(artifactRaw.storageLocator))).toBe(sha(file.bytes));
    expect(artifactRaw.sha256).toBe(sha(file.bytes));

    // 2. the reference is on the VERSION (own write, docVersion + 1); every confirmed part is byte-identical; the head is untouched
    const after = await rawVersion(ref, 1);
    expect(after.document).toMatchObject({ status: "STORED", driveFileId: stored!.fileId, driveLink: stored!.webViewLink, fileName: "Signed Agreement.pdf", storedByUserRef: manager.userRef, artifactRef: rawBefore.contractArtifactRef, artifactSha256: sha(file.bytes), attemptCount: 1, lastFailureCode: null });
    expect(after.docVersion).toBe((before.docVersion as number) + 1);
    expect(after.updatedByUserRef).toBe(manager.userRef);
    expect(confirmedParts(after)).toBe(confirmedParts(before));
    expect(await rawHeadDocVersion(ref)).toBe(confirmed.head.docVersion);

    // 3. one audit event with allowlisted metadata only - never the link or the Drive file id
    const events = (await rawEvents(ref)).filter((event) => event.kind === "document_stored");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ version: 1, actorUserRef: manager.userRef, metadata: { version: 1, documentStatus: "STORED", fileName: "Signed Agreement.pdf", artifactRef: rawBefore.contractArtifactRef, attemptCount: 1 } });
    expect(JSON.stringify(events)).not.toContain(stored!.fileId);
    expect(JSON.stringify(events)).not.toMatch(/drive\.invalid|https?:/i);
  });

  it("is IDEMPOTENT: a retry returns the same reference with no second file and no second adapter call - even when three requests race", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const { confirmed } = await confirmedWithFile(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;

    const first = must(await store(manager, confirmed), "first");
    const again = must(await store(manager, confirmed), "again");
    expect(first.outcome).toBe("stored");
    expect(again).toMatchObject({ outcome: "already_stored", retriable: false, document: { status: "STORED", storedAt: first.document.storedAt } });
    expect(drive.storage.files).toHaveLength(1);
    expect(drive.storage.calls).toHaveLength(1);
    expect((await rawEvents(ref)).filter((event) => event.kind === "document_stored")).toHaveLength(1);

    // racing requests on a fresh version: still ONE file and ONE recorded store
    const other = await confirmedWithFile(manager, partnerCp(partner));
    const results = await Promise.all([1, 2, 3].map(() => store(manager, other.confirmed)));
    const outcomes = results.map((result) => must(result, "race").outcome);
    expect(outcomes.filter((outcome) => outcome === "stored")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "already_stored")).toHaveLength(2);
    expect(drive.storage.files).toHaveLength(2);
    const otherRef = other.confirmed.head.agreementRef;
    expect((await rawEvents(otherRef)).filter((event) => event.kind === "document_stored")).toHaveLength(1);
    expect(new Set(results.map((result) => must(result, "race").document.storedAt)).size).toBe(1);
  });
});

// =====================================================================================================================
describe("a failed store is retriable and non-destructive", () => {
  it("keeps the source artifact, never claims 'stored', records a safe failure, blocks activation, and a retry succeeds with the same single file", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const { confirmed, file } = await confirmedWithFile(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;

    drive.storage.failNext(1, "drive_unavailable");
    const failure = must(await store(manager, confirmed), "failing store");
    expect(failure).toMatchObject({ outcome: "failed", retriable: true, document: { status: "FAILED", hasLink: false, attemptCount: 1, canStore: true, storedAt: null, message: expect.stringMatching(/temporarily unavailable/i) } });
    expect(failure.document.link).toBeUndefined();
    expect(drive.storage.files).toHaveLength(0);

    const raw = await rawVersion(ref, 1);
    expect(raw.document).toMatchObject({ status: "FAILED", driveFileId: null, driveLink: null, storedAt: null, storedByUserRef: null, attemptCount: 1, lastFailureCode: "drive_unavailable" });
    // the source artifact is intact: metadata and bytes are still there
    const artifactRef = (raw.source as { contractArtifactRef: string }).contractArtifactRef;
    const artifactRaw = (await financeContractArtifactsCollection().doc(artifactRef).get()).data() as { storageLocator: string };
    expect(Buffer.from(await artifactStore.get(artifactRaw.storageLocator)).equals(file.bytes)).toBe(true);
    // the failure is audited by code only
    expect((await rawEvents(ref)).filter((event) => event.kind === "document_store_failed")).toEqual([expect.objectContaining({ version: 1, metadata: expect.objectContaining({ documentStatus: "FAILED", failureCode: "drive_unavailable", attemptCount: 1, fileName: "Signed Agreement.pdf" }) })]);

    // activation is blocked with the plain reason (and it says why)
    const blocked = failed(await activate(head, confirmed));
    expect(blocked).toMatchObject({ code: "not_ready", blockers: [{ code: "agreement_document_not_stored", message: expect.stringMatching(/could not be stored yet/i) }] });

    // a second failure counts attempts and stays FAILED
    drive.storage.failNext(1, "quota_exceeded");
    expect(must(await store(manager, confirmed), "second failure").document).toMatchObject({ status: "FAILED", attemptCount: 2 });
    expect((await rawVersion(ref, 1)).document).toMatchObject({ lastFailureCode: "quota_exceeded", attemptCount: 2 });

    // the retry succeeds: same version, ONE file, attempt count carried on
    const retried = must(await store(manager, confirmed), "retry");
    expect(retried).toMatchObject({ outcome: "stored", document: { status: "STORED", attemptCount: 3, canStore: false } });
    expect(drive.storage.files).toHaveLength(1);
    expect((await rawVersion(ref, 1)).document).toMatchObject({ status: "STORED", driveFileId: drive.storage.files[0]!.fileId, lastFailureCode: null });
    must(await activate(head, confirmed), "activate after storing");
  });

  it("an artifact whose bytes no longer match its checksum (or are gone) stores NOTHING and says so; restoring the bytes lets the retry succeed", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const { confirmed, file } = await confirmedWithFile(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;

    const original = artifactStore;
    setContractArtifactStoreForTests({ ...original, get: async () => samplePdfBytes("tampered") });
    const mismatch = must(await store(manager, confirmed), "mismatch");
    expect(mismatch).toMatchObject({ outcome: "failed", document: { status: "FAILED", message: expect.stringMatching(/checksum/i) } });
    setContractArtifactStoreForTests({ ...original, get: async () => { throw new Error("gone"); } });
    const gone = must(await store(manager, confirmed), "gone");
    expect(gone).toMatchObject({ outcome: "failed", document: { status: "FAILED", message: expect.stringMatching(/read back/i) } });
    expect(drive.storage.files).toHaveLength(0);
    expect((await rawVersion(ref, 1)).document).toMatchObject({ status: "FAILED", lastFailureCode: "artifact_unavailable", attemptCount: 2 });

    setContractArtifactStoreForTests(original);
    const retried = must(await store(manager, confirmed), "retry");
    expect(retried.outcome).toBe("stored");
    expect(drive.storage.files[0]!.receivedSha256).toBe(sha(file.bytes));
  });
});

// =====================================================================================================================
describe("Drive storage not configured is stated truthfully", () => {
  it("fabricates no link, blocks activation with a plain reason that says so, and works once storage is configured", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const { confirmed } = await confirmedWithFile(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;

    setAgreementDocumentStorageForTests("NOT_CONFIGURED");
    // before any attempt, the status route already tells the truth about configuration
    expect(must(await getAgreementDocumentStatus(manager, { agreementRef: ref }), "status")).toMatchObject({ storageConfigured: false, document: { status: "PENDING", hasLink: false } });

    const outcome = must(await store(manager, confirmed), "store");
    expect(outcome).toMatchObject({ outcome: "failed", retriable: true, document: { status: "NOT_CONFIGURED", message: "Drive storage not configured", hasLink: false, canStore: true } });
    expect(outcome.document.link).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toMatch(/https?:/i);
    expect(drive.storage.calls).toHaveLength(0);
    expect((await rawVersion(ref, 1)).document).toMatchObject({ status: "FAILED", driveFileId: null, driveLink: null, lastFailureCode: "not_configured" });
    expect(failed(await activate(head, confirmed))).toMatchObject({ code: "not_ready", blockers: [{ code: "agreement_document_not_stored", message: expect.stringMatching(/Drive storage is not configured/) }] });

    // configured now: the same version stores, and activation opens
    setAgreementDocumentStorageForTests(drive.storage);
    expect(must(await store(manager, confirmed), "store configured")).toMatchObject({ outcome: "stored", document: { status: "STORED", attemptCount: 2 } });
    must(await activate(head, confirmed), "activate");
  });

  it("with no override in a test run the default resolution is NOT_CONFIGURED - a test can never reach real Drive", async () => {
    if (process.env.FINANCE_AGREEMENT_DRIVE_MODE === "fake") return; // an explicit fake selection is not "not configured"
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const { confirmed } = await confirmedWithFile(manager, partnerCp(partner));
    setAgreementDocumentStorageForTests(null);
    const outcome = must(await store(manager, confirmed), "store");
    expect(outcome).toMatchObject({ outcome: "failed", document: { status: "NOT_CONFIGURED", hasLink: false } });
    expect(drive.storage.calls).toHaveLength(0);
  });
});

// =====================================================================================================================
describe("one file per Agreement VERSION; each version keeps its own reference", () => {
  it("v1 and v2 (a NEW signed file) are distinct Drive files; v1 is unchanged after v2 is stored; v2 needs its own store before activation", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const cp = partnerCp(partner);
    const v1File = { bytes: samplePdfBytes(`v1-${runId}`), fileName: "Deal v1.pdf" };
    const v2File = { bytes: samplePdfBytes(`v2-${runId}`), fileName: "Deal v2 amended.pdf" };

    const { confirmed: v1 } = await confirmedWithFile(manager, cp, v1File);
    const ref = v1.head.agreementRef;
    must(await store(manager, v1), "store v1");
    const v1Stored = (await rawVersion(ref, 1)).document as Record<string, unknown>;
    const active = must(await activate(head, v1), "activate v1");

    // a revision starts with NO signed file of its own; attach the newly signed one, confirm, and it becomes v2's own
    const revised = must(await createAgreementRevision(head, { agreementRef: ref, expectedDocVersion: active.head.docVersion }, requestId()), "revise");
    expect(revised.selectedVersion!.document).toMatchObject({ status: "NOT_APPLICABLE", message: "No new signed document for this version" });
    const withFile = await attachSignedFile(manager, revised, cp, v2File);
    const v2 = await confirm(manager, await acceptPending(manager, withFile));
    expect(v2.selectedVersion!.document).toMatchObject({ status: "PENDING", canStore: true });

    // activation of v2 is blocked until v2's OWN document is stored
    expect(failed(await activate(head, v2))).toMatchObject({ code: "not_ready", blockers: [{ code: "agreement_document_not_stored" }] });
    must(await store(manager, v2), "store v2");
    expect(drive.storage.files).toHaveLength(2);
    const [f1, f2] = drive.storage.files;
    expect(f1!.fileId).not.toBe(f2!.fileId);
    expect(f1!.receivedSha256).toBe(sha(v1File.bytes));
    expect(f2!.receivedSha256).toBe(sha(v2File.bytes));
    expect([f1!.driveFileName, f2!.driveFileName]).toEqual([`Deal v1 [${ref} v1].pdf`, `Deal v2 amended [${ref} v2].pdf`]);
    expect(f1!.idempotencyKey).not.toBe(f2!.idempotencyKey);

    // v1's reference never moved
    expect((await rawVersion(ref, 1)).document).toEqual(v1Stored);
    expect((await rawVersion(ref, 2)).document).toMatchObject({ status: "STORED", driveFileId: f2!.fileId });
    must(await activate(head, v2, 2, (await rawHeadDocVersion(ref))), "activate v2");
    expect((await rawVersion(ref, 1)).document).toEqual(v1Stored);
    const detail = await fresh(head, ref);
    expect(detail.versions.map((version) => [version.version, version.document.status, version.document.link])).toEqual([[2, "STORED", f2!.webViewLink], [1, "STORED", f1!.webViewLink]]);
  });

  it("a revision WITHOUT a new signed file is labelled honestly (never shown as the prior file), is not blocked from activation, and cannot store a document", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const cp = partnerCp(partner);
    const { confirmed: v1 } = await confirmedWithFile(manager, cp);
    const ref = v1.head.agreementRef;
    must(await store(manager, v1), "store v1");
    const active = must(await activate(head, v1), "activate v1");
    const v1Stored = (await rawVersion(ref, 1)).document as Record<string, unknown>;

    const revised = must(await createAgreementRevision(head, { agreementRef: ref, expectedDocVersion: active.head.docVersion }, requestId()), "revise");
    const v2 = await confirm(manager, await decideAll(manager, revised, [{ fieldKey: "fixedComponent", decision: "CORRECTED", value: { applicable: true, amountMinor: 6_000_000 } }]));
    expect(v2.selectedVersion!.document).toEqual({ status: "NOT_APPLICABLE", fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: "No new signed document for this version", canStore: false });
    expect(failed(await store(manager, v2))).toMatchObject({ code: "conflict", message: expect.stringMatching(/no signed Agreement file of its own/i) });
    const before = drive.storage.calls.length;
    const activated = must(await activate(head, v2, 2), "activate v2 without a new file");
    expect(activated.head).toMatchObject({ status: "ACTIVE", activeVersion: 2 });
    expect(drive.storage.calls.length).toBe(before);
    expect((await rawVersion(ref, 1)).document).toEqual(v1Stored);

    // the contextual list shows v1's document and v2's honest label - never v1's file under v2
    const listed = must(await listCounterpartyAgreementDocuments(head, { counterpartyType: "PARTNER", ref: partner.partnerRef }), "list");
    expect(listed.documents.map((row) => [row.version, row.lifecycle, row.document.status])).toEqual([[2, "ACTIVE", "NOT_APPLICABLE"], [1, "SUPERSEDED", "STORED"]]);
  });

  it("a manual-only Agreement (no signed file at all) activates without any document and is labelled 'No new signed document'", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const confirmed = await confirmedManual(manager, partnerCp(partner));
    expect(confirmed.selectedVersion!.document.status).toBe("NOT_APPLICABLE");
    must(await activate(head, confirmed), "activate");
    expect(drive.storage.calls).toHaveLength(0);
  });
});

// =====================================================================================================================
describe("Finance and the Partner / Vendor projection carry the SAME file reference", () => {
  it.each(["PARTNER", "VENDOR"] as const)("%s: the Finance detail, the status read and the contextual list show one file id / link (one physical file, several references); the folder target follows the counterparty type", async (type) => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = type === "PARTNER" ? await seedPartner() : null;
    const vendor = type === "VENDOR" ? await seedVendor() : null;
    const cp = partner ? partnerCp(partner) : vendorCp(vendor!);
    const { confirmed } = await confirmedWithFile(manager, cp);
    const ref = confirmed.head.agreementRef;
    must(await store(manager, confirmed), "store");

    expect(drive.storage.files).toHaveLength(1);
    const file = drive.storage.files[0]!;
    expect(file.target).toBe(type);
    expect(file.metadata.counterpartyType).toBe(type);

    const detail = await fresh(head, ref);
    const status = must(await getAgreementDocumentStatus(head, { agreementRef: ref }), "status");
    const listed = must(await listCounterpartyAgreementDocuments(head, { counterpartyType: type, ref: refOf(cp) }), "list");
    expect(detail.selectedVersion!.document).toMatchObject({ status: "STORED", link: file.webViewLink });
    expect(status).toMatchObject({ agreementRef: ref, version: 1, storageConfigured: true, document: { status: "STORED", link: file.webViewLink } });
    expect(listed).toMatchObject({ counterpartyType: type, ref: refOf(cp), linksVisible: true, hasMore: false });
    expect(listed.documents).toEqual([expect.objectContaining({ agreementRef: ref, version: 1, lifecycle: "DRAFT", confirmed: true, headStatus: "DRAFT", document: expect.objectContaining({ status: "STORED", link: file.webViewLink, fileName: "Signed Agreement.pdf" }) })]);
    // the same reference, stored ONCE on the version: the projection reads it, nothing else holds a copy
    expect((await rawVersion(ref, 1)).document).toMatchObject({ driveFileId: file.fileId, driveLink: file.webViewLink });

    // the Manager (no finance_contracts) sees the SAME file's status and name - but no link anywhere
    const managerList = must(await listCounterpartyAgreementDocuments(manager, { counterpartyType: type, ref: refOf(cp) }), "manager list");
    expect(managerList).toMatchObject({ linksVisible: false, documents: [{ document: { status: "STORED", hasLink: true, fileName: "Signed Agreement.pdf" } }] });
    expect(JSON.stringify([managerList, await fresh(manager, ref), must(await getAgreementDocumentStatus(manager, { agreementRef: ref }), "s")])).not.toMatch(/drive\.invalid|"link"|driveLink|driveFileId/);
  });

  it("lists only that counterparty's own Agreements, and skips an untouched empty draft", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const otherPartner = await seedPartner();
    await confirmedWithFile(manager, partnerCp(otherPartner));
    await newAgreement(manager, partnerCp(partner)); // an empty draft: not a document
    const empty = must(await listCounterpartyAgreementDocuments(manager, { counterpartyType: "PARTNER", ref: partner.partnerRef }), "empty");
    expect(empty.documents).toEqual([]);
    const { confirmed } = await confirmedWithFile(manager, partnerCp(partner));
    const listed = must(await listCounterpartyAgreementDocuments(manager, { counterpartyType: "PARTNER", ref: partner.partnerRef }), "list");
    expect(listed.documents.map((row) => row.agreementRef)).toEqual([confirmed.head.agreementRef]);
    expect(listed.documents[0]!.document.status).toBe("PENDING");
  });
});

// =====================================================================================================================
describe("activation readiness", () => {
  it("an artifact-backed version cannot be activated until its original document is STORED; then it can", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const { confirmed } = await confirmedWithFile(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;

    const blocked = failed(await activate(head, confirmed));
    expect(blocked).toMatchObject({ code: "not_ready", message: "Store the signed Agreement document before activating this version.", blockers: [{ code: "agreement_document_not_stored" }] });
    expect(await rawHeadDocVersion(ref)).toBe(confirmed.head.docVersion);
    expect((await rawVersion(ref, 1)).status).toBe("DRAFT");

    must(await store(manager, confirmed), "store");
    const active = must(await activate(head, confirmed), "activate");
    expect(active.head).toMatchObject({ status: "ACTIVE", activeVersion: 1 });
    expect(active.selectedVersion!.document).toMatchObject({ status: "STORED", canStore: false });
  });

  it("a stale head docVersion is still reported as stale (the document check does not mask it)", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const { confirmed } = await confirmedWithFile(manager, partnerCp(partner));
    expect(failed(await activate(head, confirmed, 1, 99))).toMatchObject({ code: "stale_write" });
  });
});

// =====================================================================================================================
describe("who may store, and who may see the link", () => {
  it("viewer / analyst / signed-out hold nothing; Manager and Head may store; only finance_contracts holders (Head, Super Admin) receive the link; profile-only access gets nothing", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const superAdmin = await syntheticActor("super_admin");
    const viewer = await syntheticActor("viewer");
    const analyst = await syntheticActor("analyst");
    const partner = await seedPartner();
    const { confirmed } = await confirmedWithFile(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;
    const input = { agreementRef: ref, version: 1 };
    const rawBefore = JSON.stringify(await rawVersion(ref, 1));

    // no Finance feature (viewer / analyst have Partner profile access only) and not signed in: denied on every surface; nothing written
    for (const actor of [viewer, analyst]) {
      expect(failed(await storeAgreementDocument(actor, input, requestId()))).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
      expect(failed(await getAgreementDocumentStatus(actor, { agreementRef: ref }))).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
      expect(failed(await listCounterpartyAgreementDocuments(actor, { counterpartyType: "PARTNER", ref: partner.partnerRef }))).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
    }
    expect(failed(await storeAgreementDocument(null, input, requestId()))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    expect(failed(await getAgreementDocumentStatus(null, { agreementRef: ref }))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    expect(failed(await listCounterpartyAgreementDocuments(null, { counterpartyType: "PARTNER", ref: partner.partnerRef }))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    expect(JSON.stringify(await rawVersion(ref, 1))).toBe(rawBefore);
    expect(drive.storage.calls).toHaveLength(0);

    // the Manager (manage_agreements, NO finance_contracts) stores but never receives a link
    const stored = must(await storeAgreementDocument(manager, input, requestId()), "manager store");
    expect(stored.document.link).toBeUndefined();
    expect(stored.agreement.selectedVersion!.document.link).toBeUndefined();
    expect(stored.agreement.versions.every((version) => version.document.link === undefined)).toBe(true);
    const link = drive.storage.files[0]!.webViewLink;

    // Head and Super Admin hold finance_contracts: the link is delivered on every read surface
    for (const actor of [head, superAdmin]) {
      expect((await fresh(actor, ref)).selectedVersion!.document.link).toBe(link);
      expect(must(await getAgreementDocumentStatus(actor, { agreementRef: ref }), "status").document.link).toBe(link);
      expect(must(await listCounterpartyAgreementDocuments(actor, { counterpartyType: "PARTNER", ref: partner.partnerRef }), "list").documents[0]!.document.link).toBe(link);
      expect(must(await storeAgreementDocument(actor, input, requestId()), "replay").document.link).toBe(link);
    }
    for (const dto of [await fresh(manager, ref), must(await listAgreementEvents(manager, ref), "events")]) expect(JSON.stringify(dto)).not.toContain(link);
  });

  it("an actor outside the counterparty's live scope gets the neutral not-found on every surface - even for a forged ref - and nothing is written", async () => {
    const manager = await syntheticActor("partnership_manager");
    const outsider = await syntheticActor("partnership_head", [{ type: "REGION", region: R_OUT }]);
    const partner = await seedPartner();
    const { confirmed } = await confirmedWithFile(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;
    const rawBefore = JSON.stringify(await rawVersion(ref, 1));

    expect(failed(await storeAgreementDocument(outsider, { agreementRef: ref, version: 1 }, requestId()))).toMatchObject(NEUTRAL);
    expect(failed(await getAgreementDocumentStatus(outsider, { agreementRef: ref }))).toMatchObject(NEUTRAL);
    expect(failed(await listCounterpartyAgreementDocuments(outsider, { counterpartyType: "PARTNER", ref: partner.partnerRef }))).toMatchObject(NEUTRAL);
    expect(failed(await storeAgreementDocument(outsider, { agreementRef: `agr_${"0".repeat(20)}`, version: 1 }, requestId()))).toMatchObject(NEUTRAL);
    expect(failed(await listCounterpartyAgreementDocuments(outsider, { counterpartyType: "PARTNER", ref: "no-such-partner" }))).toMatchObject(NEUTRAL);
    expect(JSON.stringify(await rawVersion(ref, 1))).toBe(rawBefore);
    expect(drive.storage.calls).toHaveLength(0);
  });
});

// =====================================================================================================================
describe("input validation and eligibility", () => {
  it("rejects malformed input, an unknown version, an unconfirmed version, a version without its own signed file and a stale version docVersion", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const cp = partnerCp(partner);

    // an unconfirmed draft that already has its signed file attached
    const created = await newAgreement(manager, cp);
    const attached = await attachSignedFile(manager, created, cp, { bytes: samplePdfBytes(`unconfirmed-${runId}`), fileName: "x.pdf" });
    expect(attached.selectedVersion!.document).toMatchObject({ status: "PENDING", canStore: false });
    expect(failed(await store(manager, attached))).toMatchObject({ code: "conflict", message: expect.stringMatching(/Confirm this version/) });

    // confirmed, manual-only
    const manual = await confirmedManual(manager, cp);
    expect(failed(await store(manager, manual))).toMatchObject({ code: "conflict", message: expect.stringMatching(/no signed Agreement file of its own/i) });

    // malformed / unknown / stale (on a genuine candidate)
    const { confirmed } = await confirmedWithFile(manager, cp);
    const ref = confirmed.head.agreementRef;
    for (const bad of [{ agreementRef: ref, version: 0 }, { agreementRef: ref, version: 1.5 }, { agreementRef: ref }, { agreementRef: ref, version: 1, extra: true }, { agreementRef: "nope", version: 1 }]) {
      expect(failed(await storeAgreementDocument(manager, bad, requestId())).code, JSON.stringify(bad)).toMatch(/invalid_input|not_found/);
    }
    expect(failed(await storeAgreementDocument(manager, { agreementRef: ref, version: 9 }, requestId()))).toMatchObject(NEUTRAL);
    expect(failed(await storeAgreementDocument(manager, { agreementRef: ref, version: 1, expectedDocVersion: 999 }, requestId()))).toMatchObject({ code: "stale_write" });
    expect(drive.storage.calls).toHaveLength(0);
    expect(must(await storeAgreementDocument(manager, { agreementRef: ref, version: 1, expectedDocVersion: confirmed.selectedVersion!.docVersion }, requestId()), "with the right docVersion").outcome).toBe("stored");
  });
});

// =====================================================================================================================
describe("audit events carry no link, no Drive id and no secret", () => {
  it("every document event holds only allowlisted keys, the file NAME and a status / failure code", async () => {
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const { confirmed } = await confirmedWithFile(manager, partnerCp(partner));
    const ref = confirmed.head.agreementRef;

    drive.storage.failNext(1, "access_denied");
    must(await store(manager, confirmed), "failing store");
    must(await store(manager, confirmed), "store");
    const events = (await rawEvents(ref)).filter((event) => event.kind === "document_stored" || event.kind === "document_store_failed");
    expect(events.map((event) => event.kind).sort()).toEqual(["document_store_failed", "document_stored"]);
    const allowed = new Set(["version", "documentStatus", "fileName", "artifactRef", "attemptCount", "failureCode"]);
    for (const event of events) for (const key of Object.keys(event.metadata ?? {})) expect(allowed.has(key), `metadata key ${key}`).toBe(true);
    const link = drive.storage.files[0]!;
    for (const view of [JSON.stringify(events), JSON.stringify(must(await listAgreementEvents(head, ref), "events (head)"))]) {
      expect(view).not.toContain(link.fileId);
      expect(view).not.toContain(link.webViewLink);
      expect(view).not.toMatch(/drive\.invalid|https?:|storageLocator|finance-contracts\//i);
    }
    const dto = must(await listAgreementEvents(head, ref), "events").events.filter((event) => event.kind.startsWith("document_"));
    expect(dto).toHaveLength(2);
  });
});
