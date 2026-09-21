// Step 14B - the Finance Agreements WORKSPACE, counterparty picker and permissions against the running Firestore/Auth emulator
// (no mocks). Proves, through the REAL services, gates and grants:
//   - the head `display` list projection is maintained in the same transaction as every head write, refreshes
//     unresolvedFieldCount / extractionStatus / dates / type, and NEVER changes head.docVersion (activate / revise still succeed
//     with the head docVersion the client last saw, after decide / attach / confirm);
//   - scope-first visibility (self / region / team / PARTNER grant / explicit vendor / global) with live counterparty
//     re-verification - an out-of-scope Partner or Vendor Agreement never appears, neutral;
//   - filters, deterministic order, opaque cursor paging over more rows than a page, truncation disclosure (injectable small
//     ceiling; the production constant is unchanged);
//   - no restricted value, scope internal or storage detail in ANY DTO (JSON walk); KYC as status only;
//   - counterparty search / preview authorization and content; the five-role permission matrix.
//
// Hermetic: every synthetic actor's scope is a per-run private REGION (or an explicit grant to fixtures made here); fixtures are
// private-region Partners / Accounts / Vendors with unique names; past effective dates; injectable clock for period filters; no
// whole-collection size assertion (a global-scope actor is always narrowed by a per-run name tag); everything created is removed.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { COLLECTIONS } from "@/server/authz/firestore";
import { scopeGrantDocId } from "@/server/authz/scope";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext, ScopeGrant, ScopeGrantInput } from "@/server/authz/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { partnerAccountsCollection, partnersCollection } from "@/server/partners/firestore";
import { partnerAccountDocSchema, partnerDocSchema, type PartnerDoc } from "@/server/partners/types";
import { restrictedFinancialIdentitiesCollection, restrictedFinancialIdentityDocSchema, restrictedIdentityDocId } from "@/server/shared/restricted-financial-identity";
import { vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema, type VendorDoc } from "@/server/vendors/types";

import {
  activateAgreementVersion,
  AGREEMENT_HEAD_SCAN_CEILING,
  attachExtractionProposals,
  confirmAgreementVersion,
  createAgreementDraft,
  createAgreementRevision,
  decideField,
  endAgreement,
  getCounterpartyPreview,
  getFinanceAgreementPermissions,
  listAgreementsWorkspace,
  resumeAgreement,
  searchCounterparties,
  storeAgreementDocument,
  suspendAgreement,
  type AgreementDetailDto,
  type AgreementWorkspaceDto,
  type CounterpartyPreviewDto,
  type CreateAgreementDraftOutcome,
} from "./index";
import {
  agreementClaimId,
  financeAgreementClaimsCollection,
  financeAgreementExtractionRunsCollection,
  financeAgreementsCollection,
} from "./firestore";
import { createInMemoryArtifactStore, setContractArtifactStoreForTests } from "./contract-artifacts/store";
import { generateExtractionRunRef } from "./ids";
import { installFakeAgreementDocumentStorage, seedByteBackedArtifact } from "./testing/agreement-document-fixtures";
import { READY_DECISIONS, type FieldDecisionSeed } from "./testing/agreement-service-fixtures";
import { agreementHeadDocSchema, extractionRunDocSchema, type AgreementCounterpartyInput, type FinanceAgreementsErrorResult, type FinanceAgreementsServiceResult } from "./types";

vi.setConfig({ testTimeout: 90_000 });

const runId = Date.now();
const R_IN = `faw-in-${runId}`;
const R_OUT = `faw-out-${runId}`;
const R_THIRD = `faw-third-${runId}`;
const TAG = `FAW${runId}`;

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

// A synthetic actor: the ROLE's real feature / action / sensitive grants + a scope made of exactly the grants named here.
async function syntheticActor(role: Role, grants: ScopeGrantInput[] = [{ type: "REGION", region: R_IN }]): Promise<ActorContext> {
  const uid = `faw-${role}-${runId}-${randomUUID().slice(0, 6)}`;
  const grantedAt = new Date().toISOString();
  for (const input of grants) {
    const id = scopeGrantDocId(uid, input);
    await getAdminFirestore()
      .collection(COLLECTIONS.scopeAssignments)
      .doc(id)
      .set({ ...input, uid, grantedAt, grantedBy: "faw-test" } as ScopeGrant);
    grantDocIds.push(id);
  }
  return { uid, email: `${uid}@example.test`, role, displayName: `FAW ${role}`, userRef: `faw-ref-${uid}` };
}

// ---- Fixtures ----------------------------------------------------------------------------------------------------------
type PartnerOver = { regionIds?: string[]; teamIds?: string[]; ownerUid?: string | null; name?: string; status?: "ACTIVE" | "INACTIVE"; email?: string | null; phone?: string | null; legalName?: string | null };

async function seedPartner(over: PartnerOver = {}): Promise<PartnerDoc> {
  counter += 1;
  const uid = `faw-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = over.name ?? `${TAG} Partner ${counter}`;
  const partner = partnerDocSchema.parse({
    uid,
    partnerRef: `ref-${uid}`,
    version: 1,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    legalName: over.legalName ?? null,
    email: over.email === undefined ? `partner-${counter}@example.test` : over.email,
    phone: over.phone === undefined ? "+91 90000 00000" : over.phone,
    status: over.status ?? "ACTIVE",
    regionIds: over.regionIds ?? [R_IN],
    teamIds: over.teamIds ?? [],
    ownerUid: over.ownerUid ?? null,
    createdAt: now,
    createdByUserRef: "faw-test",
    updatedAt: now,
    updatedByUserRef: "faw-test",
  });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  cleanup.push(ref);
  return partner;
}

async function seedAccount(partner: PartnerDoc, platform: string, over: { handle?: string; primary?: boolean } = {}) {
  counter += 1;
  const uid = `faw-account-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const account = partnerAccountDocSchema.parse({
    uid,
    partnerAccountRef: `ref-${uid}`,
    version: 1,
    partnerRef: partner.partnerRef,
    platform,
    handle: over.handle ?? `handle_${counter}`,
    primary: over.primary ?? false,
    normalizedIdentity: `${platform.trim().toLowerCase()}:${uid}`,
    status: "ACTIVE",
    createdAt: now,
    createdByUserRef: "faw-test",
    updatedAt: now,
    updatedByUserRef: "faw-test",
  });
  const ref = partnerAccountsCollection().doc(uid);
  await ref.set(account);
  cleanup.push(ref);
  return account;
}

async function seedVendor(over: { regionIds?: string[]; name?: string; status?: "ACTIVE" | "INACTIVE" } = {}): Promise<VendorDoc> {
  counter += 1;
  const uid = `faw-vendor-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = over.name ?? `${TAG} Vendor ${counter}`;
  const vendor = vendorDocSchema.parse({
    uid,
    vendorRef: `ref-${uid}`,
    version: 1,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    vendorType: "AGENCY",
    email: `vendor-${counter}@example.test`,
    status: over.status ?? "ACTIVE",
    regionIds: over.regionIds ?? [R_IN],
    createdAt: now,
    createdByUserRef: "faw-test",
    updatedAt: now,
    updatedByUserRef: "faw-test",
  });
  const ref = vendorsCollection().doc(uid);
  await ref.set(vendor);
  cleanup.push(ref);
  return vendor;
}

// Synthetic identity values (invented) - the tests prove NONE of them reaches any workspace / picker DTO.
const SECRETS = { pan: "QWERT4321Z", aadhaar: "234123412346", account: "998877665544", ifsc: "TEST0009876", holder: "Zed Holder Name", gst: "27QWERT4321Z1Z9", bankName: "Secret Bank Of Tests" };

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
    bank: parts.bank ? { accountHolderName: SECRETS.holder, accountNumber: SECRETS.account, ifsc: SECRETS.ifsc, bankName: SECRETS.bankName, branchName: "Test Branch" } : null,
    evidence: [{ docType: "pan", kind: "link", url: "https://example.test/secret-evidence-link", fileName: null, addedAt: now, addedByUserRef: "faw-test" }],
    updatedAt: now,
    updatedByUserRef: "faw-test",
  });
  const ref = restrictedFinancialIdentitiesCollection().doc(doc.uid);
  await ref.set(doc);
  cleanup.push(ref);
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

async function newAgreement(actor: ActorContext, counterparty: AgreementCounterpartyInput): Promise<CreateAgreementDraftOutcome> {
  const clientRequestId = `crid-${runId}-${(counter += 1)}-${randomUUID().slice(0, 6)}`;
  const outcome = must(await createAgreementDraft(actor, { clientRequestId, counterparty }, requestId()), "create");
  agreementRefs.push(outcome.agreement.head.agreementRef);
  claimIds.push(agreementClaimId(actor.uid, clientRequestId));
  return outcome;
}

const docVersionOf = (detail: AgreementDetailDto) => detail.selectedVersion!.docVersion;

async function decideAll(actor: ActorContext, detail: AgreementDetailDto, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
  let current = detail;
  for (const seed of seeds) {
    current = must(
      await decideField(actor, { agreementRef: current.head.agreementRef, version: current.selectedVersion!.version, expectedDocVersion: docVersionOf(current), fieldKey: seed.fieldKey, decision: seed.decision, ...(seed.value !== undefined ? { value: seed.value } : {}) }, requestId()),
      `decide ${seed.fieldKey}`,
    );
  }
  return current;
}

async function acceptPending(actor: ActorContext, detail: AgreementDetailDto): Promise<AgreementDetailDto> {
  const pending = Object.entries(detail.selectedVersion!.draft)
    .filter(([, entry]) => entry?.decision === "PENDING")
    .map(([fieldKey]) => ({ fieldKey, decision: "ACCEPTED" as const }));
  return decideAll(actor, detail, pending as FieldDecisionSeed[]);
}

async function confirm(actor: ActorContext, detail: AgreementDetailDto) {
  return must(await confirmAgreementVersion(actor, { agreementRef: detail.head.agreementRef, version: detail.selectedVersion!.version, expectedDocVersion: docVersionOf(detail) }, requestId()), "confirm");
}

async function confirmedAgreement(manager: ActorContext, counterparty: AgreementCounterpartyInput, seeds: FieldDecisionSeed[] = READY_DECISIONS) {
  const created = await newAgreement(manager, counterparty);
  return confirm(manager, await acceptPending(manager, await decideAll(manager, created.agreement, seeds)));
}

async function activate(actor: ActorContext, detail: AgreementDetailDto, expectedHeadDocVersion = detail.head.docVersion) {
  return must(await activateAgreementVersion(actor, { agreementRef: detail.head.agreementRef, version: detail.selectedVersion!.version, expectedDocVersion: expectedHeadDocVersion }, requestId()), "activate");
}

const rawHead = async (agreementRef: string) => agreementHeadDocSchema.parse((await financeAgreementsCollection().doc(agreementRef).get()).data());

// The workspace narrowed to this run's fixtures (a per-run name tag) and listed for `actor`.
async function workspace(actor: ActorContext, query: Record<string, unknown> = {}, options?: Parameters<typeof listAgreementsWorkspace>[2]): Promise<AgreementWorkspaceDto> {
  return must(await listAgreementsWorkspace(actor, { q: TAG, ...query }, options), "workspace");
}
const refsOf = (dto: AgreementWorkspaceDto) => dto.rows.map((row) => row.agreementRef);

// =====================================================================================================================
// Head `display` projection (list projection, maintained in the SAME transaction as every head write)
// =====================================================================================================================
describe("head display projection", () => {
  it("createAgreementDraft writes the projection with the head: name (+ lower-cased copy), unresolved = PENDING prefills, DRAFT, nothing confirmed", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner({ name: `${TAG} Display Create Partner`, legalName: "Legal Name Pvt Ltd" });
    const created = await newAgreement(manager, partnerCp(partner));
    const head = await rawHead(created.agreement.head.agreementRef);
    const pendingCount = Object.values(created.agreement.selectedVersion!.draft).filter((entry) => entry?.decision === "PENDING").length;
    expect(pendingCount).toBeGreaterThan(0);
    expect(head.display).toMatchObject({
      counterpartyName: partner.displayName,
      counterpartyNameLower: partner.displayName.toLowerCase(),
      unresolvedFieldCount: pendingCount,
      openVersionConfirmed: false,
      extractionStatus: null,
      governingStatus: "DRAFT",
      agreementType: null,
      sourceMode: "MANUAL",
    });
    expect(head.display?.projectedAt).toBe(head.createdAt);
  });

  it("decide refreshes unresolvedFieldCount and the draft dates in the same transaction - head.docVersion is NEVER bumped (updatedAt is)", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const created = await newAgreement(manager, partnerCp(partner));
    const ref = created.agreement.head.agreementRef;
    const before = await rawHead(ref);

    const first = must(await decideField(manager, { agreementRef: ref, version: 1, expectedDocVersion: docVersionOf(created.agreement), fieldKey: "counterpartyName", decision: "ACCEPTED" }, requestId()), "decide name");
    const afterOne = await rawHead(ref);
    expect(afterOne.display!.unresolvedFieldCount).toBe(before.display!.unresolvedFieldCount - 1);
    expect(afterOne.docVersion).toBe(before.docVersion);
    expect(first.head.docVersion).toBe(before.docVersion);
    expect(afterOne.updatedAt > before.updatedAt).toBe(true);
    expect(afterOne.updatedByUserRef).toBe(manager.userRef);

    const second = must(await decideField(manager, { agreementRef: ref, version: 1, expectedDocVersion: docVersionOf(first), fieldKey: "effectiveDate", decision: "CORRECTED", value: "2024-02-01" }, requestId()), "decide date");
    const third = must(await decideField(manager, { agreementRef: ref, version: 1, expectedDocVersion: docVersionOf(second), fieldKey: "agreementNumber", decision: "CORRECTED", value: "AG-2024-01" }, requestId()), "decide number");
    expect(third.head.docVersion).toBe(before.docVersion);
    const afterThree = await rawHead(ref);
    expect(afterThree.display).toMatchObject({ effectiveFrom: "2024-02-01", effectiveTo: null, agreementNumber: "AG-2024-01", unresolvedFieldCount: before.display!.unresolvedFieldCount - 1 });
    expect(afterThree.docVersion).toBe(before.docVersion);
  });

  it("confirm projects the frozen dates / type / number / source mode with 0 unresolved and openVersionConfirmed; docVersion still unchanged", async () => {
    const manager = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    const confirmed = await confirmedAgreement(manager, partnerCp(partner), [...READY_DECISIONS, { fieldKey: "agreementNumber", decision: "CORRECTED", value: "AG-9" }]);
    const head = await rawHead(confirmed.head.agreementRef);
    expect(head.docVersion).toBe(1);
    expect(head.display).toMatchObject({
      unresolvedFieldCount: 0,
      openVersionConfirmed: true,
      effectiveFrom: "2024-01-01",
      effectiveTo: "2024-12-31",
      agreementNumber: "AG-9",
      agreementType: "FIXED_PLUS_INCENTIVE_PLUS_REQUIRED_CONTENT",
      sourceMode: "MANUAL",
      governingStatus: "DRAFT",
    });
  });

  it("CONCURRENCY: activate still succeeds with the head docVersion the client saw at creation, after every decide + the confirm rewrote the head display", async () => {
    const manager = await syntheticActor("partnership_manager");
    const headActor = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const created = await newAgreement(manager, partnerCp(partner));
    const seenHeadDocVersion = created.agreement.head.docVersion;
    expect(seenHeadDocVersion).toBe(1);

    const confirmed = await confirm(manager, await acceptPending(manager, await decideAll(manager, created.agreement, READY_DECISIONS)));
    // The head's projection changed many times, its docVersion did not - the client's copy is still current.
    expect((await rawHead(confirmed.head.agreementRef)).docVersion).toBe(seenHeadDocVersion);
    expect(confirmed.head.docVersion).toBe(seenHeadDocVersion);

    const active = must(await activateAgreementVersion(headActor, { agreementRef: confirmed.head.agreementRef, version: 1, expectedDocVersion: seenHeadDocVersion }, requestId()), "activate with the stale-looking head docVersion");
    expect(active.head).toMatchObject({ status: "ACTIVE", activeVersion: 1, docVersion: seenHeadDocVersion + 1 });
    // A genuinely stale docVersion is still refused (the optimistic check is intact).
    expect(failed(await activateAgreementVersion(headActor, { agreementRef: confirmed.head.agreementRef, version: 1, expectedDocVersion: seenHeadDocVersion }, requestId())).code).toBe("stale_write");
  });

  it("CONCURRENCY (revision): after revise, decide + confirm on the revision never invalidate the head docVersion revise returned; activating it works and supersedes v1", async () => {
    const manager = await syntheticActor("partnership_manager");
    const headActor = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const v1 = await activate(headActor, await confirmedAgreement(manager, partnerCp(partner)));

    const revised = must(await createAgreementRevision(headActor, { agreementRef: v1.head.agreementRef, expectedDocVersion: v1.head.docVersion }, requestId()), "revise");
    const seenAfterRevise = revised.head.docVersion;
    const afterRevise = await rawHead(v1.head.agreementRef);
    // Governing v1 dates stay on the projection while the revision is open; revision prefills are ACCEPTED, so nothing is unresolved.
    expect(afterRevise.display).toMatchObject({ governingStatus: "ACTIVE", effectiveFrom: "2024-01-01", unresolvedFieldCount: 0, openVersionConfirmed: false, extractionStatus: null });

    const edited = must(await decideField(manager, { agreementRef: v1.head.agreementRef, version: 2, expectedDocVersion: docVersionOf(revised), fieldKey: "terminationDate", decision: "CORRECTED", value: "2025-06-30" }, requestId()), "decide on revision");
    expect((await rawHead(v1.head.agreementRef)).docVersion).toBe(seenAfterRevise);
    // The projection describes the GOVERNING version's dates until the revision activates.
    expect((await rawHead(v1.head.agreementRef)).display).toMatchObject({ effectiveTo: "2024-12-31" });

    const confirmedRevision = await confirm(manager, edited);
    expect((await rawHead(v1.head.agreementRef)).docVersion).toBe(seenAfterRevise);
    expect((await rawHead(v1.head.agreementRef)).display).toMatchObject({ openVersionConfirmed: true, effectiveTo: "2024-12-31" });

    const v2 = must(await activateAgreementVersion(headActor, { agreementRef: v1.head.agreementRef, version: 2, expectedDocVersion: seenAfterRevise }, requestId()), "activate revision");
    expect(v2.head).toMatchObject({ status: "ACTIVE", activeVersion: 2, openVersion: null });
    expect(confirmedRevision.selectedVersion!.version).toBe(2);
    expect((await rawHead(v1.head.agreementRef)).display).toMatchObject({ governingStatus: "ACTIVE", effectiveFrom: "2024-01-01", effectiveTo: "2025-06-30", openVersionConfirmed: false, unresolvedFieldCount: 0 });
  });

  it("suspend / resume / end / revise each refresh the projection's governing status in the same transaction", async () => {
    const manager = await syntheticActor("partnership_manager");
    const headActor = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const active = await activate(headActor, await confirmedAgreement(manager, partnerCp(partner)));
    const ref = active.head.agreementRef;
    expect((await rawHead(ref)).display).toMatchObject({ governingStatus: "ACTIVE", openVersionConfirmed: false, unresolvedFieldCount: 0 });

    const suspended = must(await suspendAgreement(headActor, { agreementRef: ref, expectedDocVersion: active.head.docVersion, reason: "Paused for review" }, requestId()), "suspend");
    expect((await rawHead(ref)).display?.governingStatus).toBe("SUSPENDED");
    const resumed = must(await resumeAgreement(headActor, { agreementRef: ref, expectedDocVersion: suspended.head.docVersion }, requestId()), "resume");
    expect((await rawHead(ref)).display?.governingStatus).toBe("ACTIVE");
    const revised = must(await createAgreementRevision(headActor, { agreementRef: ref, expectedDocVersion: resumed.head.docVersion }, requestId()), "revise");
    // suspending with an open revision keeps describing both the governing (dates) and the open (unresolved) version
    const suspendedAgain = must(await suspendAgreement(headActor, { agreementRef: ref, expectedDocVersion: revised.head.docVersion, reason: "Paused again" }, requestId()), "suspend again");
    expect((await rawHead(ref)).display).toMatchObject({ governingStatus: "SUSPENDED", effectiveFrom: "2024-01-01", openVersionConfirmed: false });
    const ended = must(await endAgreement(headActor, { agreementRef: ref, expectedDocVersion: suspendedAgain.head.docVersion, reason: "Relationship concluded" }, requestId()), "end");
    expect(ended.head.status).toBe("ENDED");
    expect((await rawHead(ref)).display).toMatchObject({ governingStatus: "ENDED", effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31" });
  });

  it("attaching an extraction run records display.extractionStatus (and counts the newly proposed PENDING fields); a new revision resets it", async () => {
    const manager = await syntheticActor("partnership_manager");
    const headActor = await syntheticActor("partnership_head");
    const partner = await seedPartner();
    const created = await newAgreement(manager, partnerCp(partner));
    const ref = created.agreement.head.agreementRef;

    // Step 14B.1: this artifact-backed version is activated below, which now needs its original signed document stored first - so the
    // artifact has REAL bytes in an in-memory artifact store and the document goes to the FAKE Drive adapter (no Google call).
    const artifactStore = createInMemoryArtifactStore();
    setContractArtifactStoreForTests(artifactStore);
    const drive = installFakeAgreementDocumentStorage();
    onTestFinished(() => {
      setContractArtifactStoreForTests(null);
      drive.restore();
    });
    const seeded = await seedByteBackedArtifact({ type: "PARTNER", ref: partner.partnerRef, artifactStore, label: "workspace-display" });
    cleanup.push(seeded.docRef);
    const artifact = seeded.artifact;
    const run = extractionRunDocSchema.parse({
      runRef: generateExtractionRunRef(),
      agreementRef: ref,
      artifactRef: artifact.artifactRef,
      status: "PARTIAL",
      reasonCodes: [],
      parserVersion: "test-parser-1",
      pageCount: 2,
      charCount: 900,
      proposals: [
        { fieldKey: "currency", normalizedValue: "INR", confidence: "HIGH", warnings: [], requiresHumanConfirmation: true, source: { page: 1 } },
        { fieldKey: "paymentCycle", normalizedValue: "MONTHLY", confidence: "MEDIUM", warnings: [], requiresHumanConfirmation: true, source: { page: 1 } },
      ],
      createdAt: new Date().toISOString(),
      createdByUserRef: "faw-test",
    });
    await financeAgreementExtractionRunsCollection(ref).doc(run.runRef).set(run);

    const before = await rawHead(ref);
    const outcome = must(await attachExtractionProposals(manager, { agreementRef: ref, version: 1, expectedDocVersion: docVersionOf(created.agreement), extractionRunRef: run.runRef }, requestId()), "attach");
    const after = await rawHead(ref);
    expect(outcome.attachedCount).toBe(2);
    expect(after.docVersion).toBe(before.docVersion);
    expect(after.display).toMatchObject({ extractionStatus: "PARTIAL", unresolvedFieldCount: before.display!.unresolvedFieldCount + 2, sourceMode: "EXTRACTED" });

    // decisions keep the extraction status; confirming + activating + revising resets it for the fresh revision
    const confirmed = await confirm(manager, await acceptPending(manager, await decideAll(manager, outcome.agreement, READY_DECISIONS)));
    expect((await rawHead(ref)).display?.extractionStatus).toBe("PARTIAL");
    must(await storeAgreementDocument(manager, { agreementRef: ref, version: 1 }, requestId()), "store document");
    const active = await activate(headActor, confirmed);
    must(await createAgreementRevision(headActor, { agreementRef: ref, expectedDocVersion: active.head.docVersion }, requestId()), "revise");
    expect((await rawHead(ref)).display?.extractionStatus).toBeNull();
  });
});

// ---- JSON walk: no restricted value, scope internal or storage detail in ANY DTO -------------------------------------------------
const FORBIDDEN_KEYS = new Set([
  "uid", "ownerUid", "regionIds", "teamIds", "partnerUid", "vendorUid", "storageLocator", "bucket", "signedUrl",
  "panNumber", "aadhaarNumber", "bankAccountNumber", "accountNumber", "ifsc", "accountHolderName", "panHolderName", "gstin", "gstNumber", "bankName", "branchName",
  "address", "pinCode", "evidence", "url", "rawSnippet", "locator",
]);

function assertNoRestricted(dto: unknown, label: string) {
  const seen: string[] = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}[${index}]`));
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        expect(FORBIDDEN_KEYS.has(key), `${label}: forbidden key "${key}" at ${path}`).toBe(false);
        visit(child, `${path}.${key}`);
      }
      return;
    }
    if (typeof value === "string") seen.push(value);
  };
  visit(dto, "$");
  const text = JSON.stringify(dto);
  for (const secret of Object.values(SECRETS)) expect(text, `${label}: leaked a restricted value`).not.toContain(secret);
  expect(text, `${label}: leaked an evidence link`).not.toContain("secret-evidence-link");
  expect(seen.some((value) => /^gs:\/\//.test(value) || /storage\.googleapis/.test(value)), `${label}: storage detail`).toBe(false);
}

// =====================================================================================================================
// Scope-first visibility + live re-verification
// =====================================================================================================================
describe("workspace scope", () => {
  const scpTag = `${TAG}-scp`;
  const teamId = `faw-team-${runId}`;
  let creator: ActorContext;
  const refs: Record<string, string> = {};
  const partners: Record<string, PartnerDoc> = {};
  const vendors: Record<string, VendorDoc> = {};
  let selfActor: ActorContext;

  beforeAll(async () => {
    creator = await syntheticActor("partnership_head", [{ type: "REGION", region: R_IN }, { type: "REGION", region: R_OUT }, { type: "REGION", region: R_THIRD }]);
    selfActor = await syntheticActor("partnership_manager", [{ type: "SELF" }]);
    partners.in = await seedPartner({ name: `${scpTag} Partner In`, regionIds: [R_IN] });
    partners.out = await seedPartner({ name: `${scpTag} Partner Out`, regionIds: [R_OUT] });
    partners.team = await seedPartner({ name: `${scpTag} Partner Team`, regionIds: [R_THIRD], teamIds: [teamId] });
    partners.self = await seedPartner({ name: `${scpTag} Partner Self`, regionIds: [R_THIRD], ownerUid: selfActor.uid });
    partners.both = await seedPartner({ name: `${scpTag} Partner Both`, regionIds: [R_IN], teamIds: [teamId] });
    vendors.in = await seedVendor({ name: `${scpTag} Vendor In`, regionIds: [R_IN] });
    vendors.out = await seedVendor({ name: `${scpTag} Vendor Out`, regionIds: [R_OUT] });
    for (const [key, partner] of Object.entries(partners)) refs[`p:${key}`] = (await newAgreement(creator, partnerCp(partner))).agreement.head.agreementRef;
    for (const [key, vendor] of Object.entries(vendors)) refs[`v:${key}`] = (await newAgreement(creator, vendorCp(vendor))).agreement.head.agreementRef;
  }, 120_000);

  const scopedRefs = async (actor: ActorContext, query: Record<string, unknown> = {}) => refsOf(await workspace(actor, { q: scpTag, ...query })).sort();
  const expectRefs = (...keys: string[]) => keys.map((key) => refs[key]!).sort();

  it("a REGION-scoped actor sees exactly the in-region Partner and Vendor Agreements - never an out-of-region one (neutral)", async () => {
    const regionActor = await syntheticActor("partnership_manager", [{ type: "REGION", region: R_IN }]);
    const dto = await workspace(regionActor, { q: scpTag });
    expect(refsOf(dto).sort()).toEqual(expectRefs("p:in", "p:both", "v:in"));
    expect(dto.totalInBoundedSet).toBe(3);
    for (const key of ["p:out", "p:team", "p:self", "v:out"]) expect(refsOf(dto)).not.toContain(refs[key]);
    assertNoRestricted(dto, "region workspace");
  });

  it("a TEAM grant reaches the team's Partners (and a head reachable by both region and team appears ONCE)", async () => {
    const teamActor = await syntheticActor("partnership_manager", [{ type: "TEAM", teamId }]);
    expect(await scopedRefs(teamActor)).toEqual(expectRefs("p:team", "p:both"));
    const both = await syntheticActor("partnership_manager", [{ type: "REGION", region: R_IN }, { type: "TEAM", teamId }]);
    const listed = refsOf(await workspace(both, { q: scpTag }));
    expect(listed).toHaveLength(new Set(listed).size);
    expect([...listed].sort()).toEqual(expectRefs("p:in", "p:both", "p:team", "v:in"));
  });

  it("a SELF grant reaches only records the actor owns", async () => {
    expect(await scopedRefs(selfActor)).toEqual(expectRefs("p:self"));
  });

  it("a PARTNER grant reaches exactly that Partner's Agreements (and an EXPLICIT partner record grant does too)", async () => {
    const partnerGrant = await syntheticActor("partnership_manager", [{ type: "PARTNER", partnerId: partners.out!.uid }]);
    expect(await scopedRefs(partnerGrant)).toEqual(expectRefs("p:out"));
    const explicitPartner = await syntheticActor("partnership_manager", [{ type: "EXPLICIT_RECORD", resourceType: "partner", resourceId: partners.team!.uid }]);
    expect(await scopedRefs(explicitPartner)).toEqual(expectRefs("p:team"));
  });

  it("a Vendor Agreement is reachable through an EXPLICIT vendor record grant only - never through a Partner grant or a linked Partner", async () => {
    const explicitVendor = await syntheticActor("partnership_manager", [{ type: "EXPLICIT_RECORD", resourceType: "vendor", resourceId: vendors.out!.uid }]);
    expect(await scopedRefs(explicitVendor)).toEqual(expectRefs("v:out"));
    const partnerGrantOnly = await syntheticActor("partnership_manager", [{ type: "PARTNER", partnerId: partners.out!.uid }]);
    expect(await scopedRefs(partnerGrantOnly, { counterpartyType: "VENDOR" })).toEqual([]);
  });

  it("a GLOBAL scope reaches every fixture (narrowed only by the per-run name tag); an actor with no grants sees nothing", async () => {
    const globalActor = await syntheticActor("partnership_head", [{ type: "GLOBAL" }]);
    expect(await scopedRefs(globalActor)).toEqual(Object.values(refs).sort());
    const nobody = await syntheticActor("partnership_manager", []);
    const dto = await workspace(nobody, { q: scpTag });
    expect(dto.rows).toEqual([]);
    expect(dto.totalInBoundedSet).toBe(0);
  });

  it("scope is LIVE: a head whose stored snapshot says in-region disappears once its Partner moves out of the actor's region, and returns when moved back", async () => {
    const regionActor = await syntheticActor("partnership_manager", [{ type: "REGION", region: R_IN }]);
    expect(await scopedRefs(regionActor)).toContain(refs["p:in"]);
    const partnerDoc = partnersCollection().doc(partners.in!.uid);
    await partnerDoc.update({ regionIds: [R_OUT] });
    try {
      expect((await rawHead(refs["p:in"]!)).regionIds).toEqual([R_IN]); // the stale snapshot still says in-region
      expect(await scopedRefs(regionActor)).not.toContain(refs["p:in"]);
    } finally {
      await partnerDoc.update({ regionIds: [R_IN] });
    }
    expect(await scopedRefs(regionActor)).toContain(refs["p:in"]);
  });

  it("a head whose counterparty was deleted or re-keyed (uid mismatch) is dropped, never shown", async () => {
    const regionActor = await syntheticActor("partnership_manager", [{ type: "REGION", region: R_IN }]);
    const orphan = await seedPartner({ name: `${scpTag} Orphan`, regionIds: [R_IN] });
    const orphanRef = (await newAgreement(creator, partnerCp(orphan))).agreement.head.agreementRef;
    expect(await scopedRefs(regionActor)).toContain(orphanRef);
    await financeAgreementsCollection().doc(orphanRef).update({ partnerUid: "someone-else" });
    expect(await scopedRefs(regionActor)).not.toContain(orphanRef);
    await financeAgreementsCollection().doc(orphanRef).update({ partnerUid: orphan.uid });
    await partnersCollection().doc(orphan.uid).delete();
    expect(await scopedRefs(regionActor)).not.toContain(orphanRef);
  });

  it("rows carry the LIVE counterparty name, not the stored snapshot", async () => {
    const regionActor = await syntheticActor("partnership_manager", [{ type: "REGION", region: R_IN }]);
    const partner = await seedPartner({ name: `${scpTag} Before Rename`, regionIds: [R_IN] });
    const ref = (await newAgreement(creator, partnerCp(partner))).agreement.head.agreementRef;
    await partnersCollection().doc(partner.uid).update({ displayName: `${scpTag} After Rename`, displayNameLower: `${scpTag} After Rename`.toLowerCase() });
    const dto = await workspace(regionActor, { q: "after rename" });
    expect(dto.rows.find((row) => row.agreementRef === ref)?.counterparty.displayName).toBe(`${scpTag} After Rename`);
    // ... and the old snapshot name still finds it (search covers both)
    expect(refsOf(await workspace(regionActor, { q: "before rename" }))).toContain(ref);
  });
});

// =====================================================================================================================
// Filters (lifecycle / type / search / platform / period / discrepancy) + primary action hint + KYC status per row
// =====================================================================================================================
describe("workspace filters and row content", () => {
  const fltTag = `${TAG}-flt`;
  const refs: Record<string, string> = {};
  let managerActor: ActorContext;
  let headActor: ActorContext;
  const kycPartner = { pan: true, bank: true, gst: "number", aadhaar: true } as const;

  beforeAll(async () => {
    managerActor = await syntheticActor("partnership_manager", [{ type: "REGION", region: R_IN }]);
    headActor = await syntheticActor("partnership_head", [{ type: "REGION", region: R_IN }]);
    const alpha = await seedPartner({ name: `${fltTag} Alpha`, regionIds: [R_IN] });
    const alphaAccount = await seedAccount(alpha, "Instagram");
    const beta = await seedPartner({ name: `${fltTag} Beta`, regionIds: [R_IN] });
    const betaAccount = await seedAccount(beta, "YouTube");
    const gamma = await seedPartner({ name: `${fltTag} Gamma`, regionIds: [R_IN] });
    const gammaIg = await seedAccount(gamma, "instagram");
    const gammaYt = await seedAccount(gamma, "youtube");
    const delta = await seedPartner({ name: `${fltTag} Delta`, regionIds: [R_IN] });
    const vendor = await seedVendor({ name: `${fltTag} Vendor`, regionIds: [R_IN] });
    await seedRestrictedIdentity({ type: "PARTNER", uid: alpha.uid, ref: alpha.partnerRef }, kycPartner);
    await seedRestrictedIdentity({ type: "VENDOR", uid: vendor.uid, ref: vendor.vendorRef }, { pan: true });

    // A1 ACTIVE (2024) - Alpha / instagram, full KYC
    refs.a1 = (await activate(headActor, await confirmedAgreement(managerActor, partnerCp(alpha, [alphaAccount.partnerAccountRef])))).head.agreementRef;
    // A2 DRAFT with unresolved fields - Beta / youtube
    refs.a2 = (await newAgreement(managerActor, partnerCp(beta, [betaAccount.partnerAccountRef]))).agreement.head.agreementRef;
    // A3 confirmed, awaiting activation - Vendor (partial KYC)
    refs.a3 = (await confirmedAgreement(managerActor, vendorCp(vendor))).head.agreementRef;
    // A4 SUSPENDED - Gamma / instagram + youtube
    const gammaActive = await activate(headActor, await confirmedAgreement(managerActor, partnerCp(gamma, [gammaIg.partnerAccountRef, gammaYt.partnerAccountRef])));
    must(await suspendAgreement(headActor, { agreementRef: gammaActive.head.agreementRef, expectedDocVersion: gammaActive.head.docVersion, reason: "Paused for review" }, requestId()), "suspend");
    refs.a4 = gammaActive.head.agreementRef;
    // A5 ENDED - Delta / no accounts
    const deltaActive = await activate(headActor, await confirmedAgreement(managerActor, partnerCp(delta)));
    must(await endAgreement(headActor, { agreementRef: deltaActive.head.agreementRef, expectedDocVersion: deltaActive.head.docVersion, reason: "Relationship concluded" }, requestId()), "end");
    refs.a5 = deltaActive.head.agreementRef;
  }, 180_000);

  const list = async (actor: ActorContext, query: Record<string, unknown> = {}, options?: Parameters<typeof listAgreementsWorkspace>[2]) => refsOf(await workspace(actor, { q: fltTag, ...query }, options)).sort();
  const expectRefs = (...keys: string[]) => keys.map((key) => refs[key]!).sort();
  const at = (date: string) => ({ now: () => new Date(`${date}T12:00:00.000Z`) });

  it("no filter lists every fixture; lifecycle and counterparty-type filters narrow", async () => {
    expect(await list(managerActor)).toEqual(expectRefs("a1", "a2", "a3", "a4", "a5"));
    expect(await list(managerActor, { lifecycle: "ACTIVE" })).toEqual(expectRefs("a1"));
    expect(await list(managerActor, { lifecycle: "DRAFT" })).toEqual(expectRefs("a2", "a3"));
    expect(await list(managerActor, { lifecycle: "SUSPENDED" })).toEqual(expectRefs("a4"));
    expect(await list(managerActor, { lifecycle: "ENDED" })).toEqual(expectRefs("a5"));
    expect(await list(managerActor, { counterpartyType: "VENDOR" })).toEqual(expectRefs("a3"));
    expect(await list(managerActor, { counterpartyType: "PARTNER" })).toEqual(expectRefs("a1", "a2", "a4", "a5"));
  });

  it("counterparty name search is a case-insensitive substring; platform matches the Partner's platform scope only", async () => {
    expect(await list(managerActor, { q: `${fltTag} beta` })).toEqual(expectRefs("a2"));
    expect(await list(managerActor, { q: "GAMMA" })).toEqual(expectRefs("a4")); // case-insensitive, substring (not just a prefix)
    expect(await list(managerActor, { q: `${fltTag} Gam` })).toEqual(expectRefs("a4"));
    expect(await list(managerActor, { q: "no-such-name-zzz" })).toEqual([]);
    expect(await list(managerActor, { platform: "instagram" })).toEqual(expectRefs("a1", "a4"));
    expect(await list(managerActor, { platform: "YOUTUBE" })).toEqual(expectRefs("a2", "a4"));
    expect(await list(managerActor, { platform: "tiktok" })).toEqual([]);
  });

  it("period=current: the governing version covers 'today' (injectable clock); a draft, an ended and an out-of-range Agreement do not", async () => {
    expect(await list(managerActor, { period: "current" }, at("2024-06-15"))).toEqual(expectRefs("a1", "a4"));
    expect(await list(managerActor, { period: "current" }, at("2025-06-15"))).toEqual([]);
    expect(await list(managerActor, { period: "current" }, at("2023-06-15"))).toEqual([]);
    expect(await list(managerActor, { period: "current" }, at("2024-12-31"))).toEqual(expectRefs("a1", "a4"));
  });

  it("period=YYYY-MM: the effective range overlaps that month (any lifecycle with dates)", async () => {
    expect(await list(managerActor, { period: "2024-06" })).toEqual(expectRefs("a1", "a3", "a4", "a5"));
    expect(await list(managerActor, { period: "2024-01" })).toEqual(expectRefs("a1", "a3", "a4", "a5"));
    expect(await list(managerActor, { period: "2023-12" })).toEqual([]);
    expect(await list(managerActor, { period: "2025-01" })).toEqual([]);
  });

  it("discrepancy=open: only Agreements with unresolved (PENDING) fields", async () => {
    expect(await list(managerActor, { discrepancy: "open" })).toEqual(expectRefs("a2"));
  });

  it("an invalid filter value is ignored with ONE neutral notice - it never widens beyond scope or fails the page", async () => {
    const dto = await workspace(managerActor, { q: fltTag, lifecycle: "SUPERSEDED", period: "soon" });
    expect(refsOf(dto).sort()).toEqual(expectRefs("a1", "a2", "a3", "a4", "a5"));
    expect(dto.notices).toEqual(["Some filters were not valid and were ignored."]);
  });

  it("row content: live name, type, platform scope, lifecycle, versions, projected dates / type, extraction + unresolved, primary action per role", async () => {
    const dto = await workspace(headActor, { q: fltTag });
    const row = (key: string) => dto.rows.find((r) => r.agreementRef === refs[key])!;
    expect(row("a1")).toMatchObject({ counterparty: { type: "PARTNER", displayName: `${fltTag} Alpha`, platformScope: ["instagram"] }, lifecycle: "ACTIVE", currentVersion: 1, openVersion: null, effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31", agreementType: "FIXED_PLUS_INCENTIVE_PLUS_REQUIRED_CONTENT", sourceMode: "MANUAL", unresolvedFieldCount: 0, hasDiscrepancy: false, extractionStatus: null, awaitingActivation: false });
    expect(row("a2")).toMatchObject({ lifecycle: "DRAFT", currentVersion: 1, openVersion: 1, agreementType: null, hasDiscrepancy: true, awaitingActivation: false, counterparty: { platformScope: ["youtube"] } });
    // Step 14C: a never-activated Agreement whose open version is CONFIRMED is "awaiting activation" (lifecycle stays DRAFT - no new backend state); nothing else is.
    expect(row("a3")).toMatchObject({ lifecycle: "DRAFT", openVersion: 1, awaitingActivation: true, primaryAction: { kind: "REVIEW" } });
    for (const key of ["a1", "a4", "a5"]) expect(row(key).awaitingActivation, key).toBe(false);
    expect(row("a2").unresolvedFieldCount).toBeGreaterThan(0);
    expect(row("a3")).toMatchObject({ counterparty: { type: "VENDOR", platformScope: [] }, lifecycle: "DRAFT", openVersion: 1 });
    expect(row("a4")).toMatchObject({ lifecycle: "SUSPENDED", counterparty: { platformScope: ["instagram", "youtube"] } });
    expect(row("a5")).toMatchObject({ lifecycle: "ENDED", currentVersion: 1 });
    for (const item of dto.rows) expect(item.lastUpdatedAt).toBeTruthy();

    // Head (may manage + activate)
    expect(row("a1").primaryAction).toEqual({ kind: "CREATE_REVISION", version: null });
    expect(row("a2").primaryAction).toEqual({ kind: "CONTINUE_DRAFT", version: 1 });
    expect(row("a3").primaryAction).toEqual({ kind: "REVIEW", version: 1 });
    expect(row("a4").primaryAction).toEqual({ kind: "OPEN", version: 1 });
    expect(row("a5").primaryAction).toEqual({ kind: "OPEN", version: 1 });
    // Manager (manage only): can continue a draft, but cannot review-for-activation or revise
    const asManager = await workspace(managerActor, { q: fltTag });
    const mrow = (key: string) => asManager.rows.find((r) => r.agreementRef === refs[key])!;
    expect(mrow("a2").primaryAction).toEqual({ kind: "CONTINUE_DRAFT", version: 1 });
    expect(mrow("a3").primaryAction).toEqual({ kind: "OPEN", version: 1 });
    expect(mrow("a1").primaryAction).toEqual({ kind: "OPEN", version: 1 });
  });

  it("permissions are in the DTO, computed from real grants (Manager: manage, no activate; Head: both)", async () => {
    expect((await workspace(managerActor, { q: fltTag })).permissions).toMatchObject({ canView: true, canManage: true, canActivate: false, canViewContractDetail: false, canViewIdentity: false, canManageCounterpartyKyc: false });
    expect((await workspace(headActor, { q: fltTag })).permissions).toMatchObject({ canView: true, canManage: true, canActivate: true, canViewContractDetail: true });
  });

  it("KYC per row is STATUS only: the state is visible to a Manager (components RESTRICTED); with the identity category the components appear - never a value", async () => {
    const asManager = await workspace(managerActor, { q: fltTag });
    const asHead = await workspace(headActor, { q: fltTag });
    const kyc = (dto: AgreementWorkspaceDto, key: string) => dto.rows.find((r) => r.agreementRef === refs[key])!.kyc;
    expect(kyc(asManager, "a1")).toEqual({ state: "AVAILABLE", components: { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" } });
    expect(kyc(asManager, "a3").state).toBe("INCOMPLETE");
    expect(kyc(asManager, "a2").state).toBe("MISSING");
    expect(kyc(asHead, "a1")).toEqual({ state: "AVAILABLE", components: { pan: "PRESENT", aadhaar: "PRESENT", gst: "PRESENT", bank: "PRESENT" } });
    expect(kyc(asHead, "a3")).toEqual({ state: "INCOMPLETE", components: { pan: "PRESENT", aadhaar: "NOT_APPLICABLE", gst: "MISSING", bank: "MISSING" } });
    expect(kyc(asHead, "a2")).toMatchObject({ state: "MISSING", components: { pan: "MISSING", bank: "MISSING" } });
  });

  it("NO restricted value, scope internal, evidence link or storage detail in any workspace DTO (JSON walk), for a Manager and a Head", async () => {
    assertNoRestricted(await workspace(managerActor, { q: fltTag }), "manager workspace");
    assertNoRestricted(await workspace(headActor, { q: fltTag }), "head workspace");
  });

  it("legacy heads written before Step 14B (no display) still list with safe defaults", async () => {
    const partner = await seedPartner({ name: `${fltTag} Legacy`, regionIds: [R_IN] });
    const created = await newAgreement(managerActor, partnerCp(partner));
    await financeAgreementsCollection().doc(created.agreement.head.agreementRef).update({ display: null });
    const dto = await workspace(managerActor, { q: `${fltTag} Legacy` });
    expect(dto.rows).toHaveLength(1);
    expect(dto.rows[0]).toMatchObject({ lifecycle: "DRAFT", agreementNumber: null, effectiveFrom: null, unresolvedFieldCount: 0, hasDiscrepancy: false, extractionStatus: null, awaitingActivation: false, primaryAction: { kind: "CONTINUE_DRAFT", version: 1 } });
    expect(dto.rows[0]!.counterparty.displayName).toBe(`${fltTag} Legacy`);
  });
});

// =====================================================================================================================
// Deterministic paging (more rows than a page, incl. more heads than the scan page), opaque cursor, truncation disclosure
// =====================================================================================================================
describe("workspace paging and bounded scan", () => {
  const R_PAGE = `faw-page-${runId}`;
  const pgTag = `${TAG}-pg`;
  const TOTAL = 105; // > the 100-head scan page, > five UI pages
  let regionActor: ActorContext;
  const created: string[] = [];

  beforeAll(async () => {
    const creator = await syntheticActor("partnership_head", [{ type: "REGION", region: R_PAGE }]);
    regionActor = await syntheticActor("partnership_manager", [{ type: "REGION", region: R_PAGE }]);
    const partners = [await seedPartner({ name: `${pgTag} One`, regionIds: [R_PAGE] }), await seedPartner({ name: `${pgTag} Two`, regionIds: [R_PAGE] }), await seedPartner({ name: `${pgTag} Three`, regionIds: [R_PAGE] })];
    for (let start = 0; start < TOTAL; start += 15) {
      const batch = await Promise.all(Array.from({ length: Math.min(15, TOTAL - start) }, (_, i) => newAgreement(creator, partnerCp(partners[(start + i) % partners.length]!))));
      created.push(...batch.map((outcome) => outcome.agreement.head.agreementRef));
    }
  }, 240_000);

  async function expectedOrder(): Promise<string[]> {
    const heads = await Promise.all(created.map((ref) => rawHead(ref)));
    return heads.sort((a, b) => (a.updatedAt !== b.updatedAt ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.agreementRef < b.agreementRef ? -1 : 1)).map((head) => head.agreementRef);
  }

  it("the production scan ceiling constant is unchanged, and a default read discloses it without truncation", async () => {
    expect(AGREEMENT_HEAD_SCAN_CEILING).toBe(500);
    const dto = must(await listAgreementsWorkspace(regionActor, { q: pgTag }), "default");
    expect(dto.disclosure).toEqual({ headsRead: TOTAL, headsTruncated: false, scanLimit: 500 });
    expect(dto.totalInBoundedSet).toBe(TOTAL);
    expect(dto.notices).toEqual([]);
  });

  it("the default page size is 20 with an opaque cursor; following it walks every row exactly once in (updatedAt desc, agreementRef) order", async () => {
    const expected = await expectedOrder();
    const first = must(await listAgreementsWorkspace(regionActor, { q: pgTag }), "first");
    expect(first.rows).toHaveLength(20);
    expect(first).toMatchObject({ offset: 0, pageSize: 20, totalInBoundedSet: TOTAL });
    expect(first.nextCursor).toBeTruthy();
    expect(first.nextCursor).not.toMatch(/^\d+$/);

    const seen: string[] = [];
    let page: AgreementWorkspaceDto = first;
    let pages = 1;
    for (;;) {
      seen.push(...refsOf(page));
      if (!page.nextCursor) break;
      page = must(await listAgreementsWorkspace(regionActor, { q: pgTag, cursor: page.nextCursor }), "next");
      pages += 1;
      expect(page.offset).toBe((pages - 1) * 20);
    }
    expect(pages).toBe(6);
    expect(page.rows).toHaveLength(TOTAL - 100);
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    expect(seen).toEqual(expected);
  });

  it("a smaller limit pages identically (7 per page) and two reads of the same query are byte-identical (deterministic)", async () => {
    const expected = await expectedOrder();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const dto: AgreementWorkspaceDto = must(await listAgreementsWorkspace(regionActor, { q: pgTag, limit: 7, ...(cursor ? { cursor } : {}) }), "page");
      expect(dto.rows.length).toBeLessThanOrEqual(7);
      seen.push(...refsOf(dto));
      cursor = dto.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(Math.ceil(TOTAL / 7));
    expect(seen).toEqual(expected);

    const a = must(await listAgreementsWorkspace(regionActor, { q: pgTag, limit: 20 }), "a");
    const b = must(await listAgreementsWorkspace(regionActor, { q: pgTag, limit: 20 }), "b");
    expect(refsOf(a)).toEqual(refsOf(b));
    expect(a.nextCursor).toBe(b.nextCursor);
  });

  it("a page size above 20 is clamped to 20; a tampered or garbage cursor restarts at the first page, never errors", async () => {
    const big = must(await listAgreementsWorkspace(regionActor, { q: pgTag, limit: 500 }), "big");
    expect(big.rows).toHaveLength(20);
    const first = must(await listAgreementsWorkspace(regionActor, { q: pgTag }), "first");
    for (const cursor of ["!!!not-a-cursor", Buffer.from(JSON.stringify({ o: -5 })).toString("base64url"), Buffer.from(JSON.stringify({ o: 9_999_999 })).toString("base64url"), "x".repeat(400)]) {
      const dto = must(await listAgreementsWorkspace(regionActor, { q: pgTag, cursor }), "tampered");
      expect(refsOf(dto)).toEqual(refsOf(first));
    }
    // a well-formed cursor past the end is an empty page, not an error
    const past = must(await listAgreementsWorkspace(regionActor, { q: pgTag, cursor: Buffer.from(JSON.stringify({ o: 5000 })).toString("base64url") }), "past");
    expect(past.rows).toEqual([]);
    expect(past.nextCursor).toBeNull();
  });

  it("TRUNCATION: with a small injected ceiling only that many heads are read, the response says so, and the total is presented as a lower bound", async () => {
    const expected = await expectedOrder();
    const truncated = must(await listAgreementsWorkspace(regionActor, { q: pgTag, limit: 20 }, { headCeiling: 10 }), "ceiling 10");
    expect(truncated.disclosure).toEqual({ headsRead: 10, headsTruncated: true, scanLimit: 10 });
    expect(truncated.totalInBoundedSet).toBe(10);
    expect(truncated.rows).toHaveLength(10);
    expect(truncated.nextCursor).toBeNull();
    // the bounded set is the NEWEST heads (scope-first, updatedAt desc)
    expect(refsOf(truncated)).toEqual(expected.slice(0, 10));
    expect(truncated.notices.join(" ")).toMatch(/10 most recently updated Agreements/);

    // exactly at the ceiling is NOT truncation; one under is
    expect(must(await listAgreementsWorkspace(regionActor, { q: pgTag }, { headCeiling: TOTAL }), "exact").disclosure).toEqual({ headsRead: TOTAL, headsTruncated: false, scanLimit: TOTAL });
    const across = must(await listAgreementsWorkspace(regionActor, { q: pgTag }, { headCeiling: TOTAL - 1 }), "one under");
    expect(across.disclosure).toMatchObject({ headsRead: TOTAL - 1, headsTruncated: true });
    // the scan crossed its 100-head page boundary correctly (cursor path) and the ceiling still applied
    const crossing = must(await listAgreementsWorkspace(regionActor, { q: pgTag }, { headCeiling: 103 }), "103");
    expect(crossing.disclosure).toEqual({ headsRead: 103, headsTruncated: true, scanLimit: 103 });
    expect(crossing.totalInBoundedSet).toBe(103);
  });

  it("an invalid ceiling option is ignored (the production ceiling applies)", async () => {
    for (const headCeiling of [0, -3, 1.5, Number.NaN]) {
      expect(must(await listAgreementsWorkspace(regionActor, { q: pgTag }, { headCeiling }), "bad ceiling").disclosure.scanLimit).toBe(500);
    }
  });
});

// =====================================================================================================================
// Access: authentication / feature / five roles
// =====================================================================================================================
describe("workspace access", () => {
  it("unauthenticated -> not_authenticated; Viewer and Analyst (no finance grant) -> feature_denied; Manager / Head / Admin may read", async () => {
    expect(failed(await listAgreementsWorkspace(null, {}))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    for (const role of ["viewer", "analyst"]) expect(failed(await listAgreementsWorkspace(await seededActor(role), { q: TAG }))).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
    for (const role of ["partnership_manager", "partnership_head", "super_admin"]) expect((await listAgreementsWorkspace(await seededActor(role), { q: `${TAG}-nothing-matches` })).ok, role).toBe(true);
  });

  it("the response never reveals whether out-of-scope Agreements exist (an actor with no scope gets an empty, ordinary result)", async () => {
    const nobody = await syntheticActor("partnership_manager", []);
    const dto = must(await listAgreementsWorkspace(nobody, {}), "no scope");
    expect(dto).toMatchObject({ rows: [], nextCursor: null, totalInBoundedSet: 0, disclosure: { headsRead: 0, headsTruncated: false }, notices: [] });
  });
});

// =====================================================================================================================
// Counterparty picker: search + preview
// =====================================================================================================================
describe("counterparty search", () => {
  const srchTag = `${TAG}-srch`;
  let manager: ActorContext;
  const fixtures: Record<string, PartnerDoc | VendorDoc> = {};

  beforeAll(async () => {
    manager = await syntheticActor("partnership_manager", [{ type: "REGION", region: R_IN }]);
    fixtures.active = await seedPartner({ name: `${srchTag} Alpha Active`, regionIds: [R_IN] });
    fixtures.inactive = await seedPartner({ name: `${srchTag} Alpha Inactive`, regionIds: [R_IN], status: "INACTIVE" });
    fixtures.out = await seedPartner({ name: `${srchTag} Alpha Out`, regionIds: [R_OUT] });
    fixtures.vActive = await seedVendor({ name: `${srchTag} Alpha Vendor`, regionIds: [R_IN] });
    fixtures.vInactive = await seedVendor({ name: `${srchTag} Alpha Vendor Inactive`, regionIds: [R_IN], status: "INACTIVE" });
    fixtures.vOut = await seedVendor({ name: `${srchTag} Alpha Vendor Out`, regionIds: [R_OUT] });
  });

  const search = async (actor: ActorContext, input: Record<string, unknown>) => must(await searchCounterparties(actor, input), "search");
  const names = (dto: { results: Array<{ displayName: string }> }) => dto.results.map((r) => r.displayName).sort();

  it("returns ONLY in-scope ACTIVE Partners, display identity only, by name prefix (case-insensitive)", async () => {
    const dto = await search(manager, { type: "PARTNER", q: srchTag.toUpperCase() });
    expect(names(dto)).toEqual([`${srchTag} Alpha Active`]);
    expect(dto.results[0]).toEqual({ type: "PARTNER", ref: (fixtures.active as PartnerDoc).partnerRef, displayName: `${srchTag} Alpha Active`, regions: [R_IN], status: "ACTIVE" });
    expect(dto.hasMore).toBe(false);
    assertNoRestricted(dto, "partner search");
  });

  it("returns ONLY in-scope ACTIVE Vendors; a Vendor never appears in a Partner search and vice versa", async () => {
    const dto = await search(manager, { type: "VENDOR", q: srchTag });
    expect(names(dto)).toEqual([`${srchTag} Alpha Vendor`]);
    expect(dto.results[0]).toMatchObject({ type: "VENDOR", regions: [R_IN], status: "ACTIVE" });
    expect(names(await search(manager, { type: "PARTNER", q: `${srchTag} Alpha Vendor` }))).toEqual([]);
    expect(names(await search(manager, { type: "VENDOR", q: `${srchTag} Alpha Active` }))).toEqual([]);
  });

  it("scope is per actor: an explicit vendor grant reaches exactly that Vendor; a different region reaches its own; no grant reaches nothing", async () => {
    const explicit = await syntheticActor("partnership_manager", [{ type: "EXPLICIT_RECORD", resourceType: "vendor", resourceId: (fixtures.vOut as VendorDoc).uid }]);
    expect(names(await search(explicit, { type: "VENDOR", q: srchTag }))).toEqual([`${srchTag} Alpha Vendor Out`]);
    expect(names(await search(explicit, { type: "PARTNER", q: srchTag }))).toEqual([]);
    const outActor = await syntheticActor("partnership_manager", [{ type: "REGION", region: R_OUT }]);
    expect(names(await search(outActor, { type: "PARTNER", q: srchTag }))).toEqual([`${srchTag} Alpha Out`]);
    const nobody = await syntheticActor("partnership_manager", []);
    expect(names(await search(nobody, { type: "PARTNER", q: srchTag }))).toEqual([]);
  });

  it("an empty query lists the first in-scope ACTIVE counterparties; limit is bounded to 10 and hasMore is honest; input is strict", async () => {
    const region = `faw-many-${runId}`;
    const actor = await syntheticActor("partnership_manager", [{ type: "REGION", region }]);
    for (let i = 0; i < 13; i += 1) await seedPartner({ name: `${srchTag} Many ${String(i).padStart(2, "0")}`, regionIds: [region] });
    await seedPartner({ name: `${srchTag} Many Inactive`, regionIds: [region], status: "INACTIVE" });
    const partners = await search(actor, { type: "PARTNER" });
    expect(partners.results).toHaveLength(10);
    expect(partners.hasMore).toBe(true);
    expect(partners.results.every((r) => r.status === "ACTIVE")).toBe(true);
    expect((await search(actor, { type: "PARTNER", limit: 3 })).results).toHaveLength(3);
    const narrowed = await search(actor, { type: "PARTNER", q: `${srchTag} Many 1` });
    expect(names(narrowed)).toEqual([`${srchTag} Many 10`, `${srchTag} Many 11`, `${srchTag} Many 12`]);
    expect(narrowed.hasMore).toBe(false);
    expect(failed(await searchCounterparties(actor, {})).code).toBe("invalid_input"); // type is required
    expect(failed(await searchCounterparties(actor, { type: "PARTNER", limit: 11 })).code).toBe("invalid_input");
    expect(failed(await searchCounterparties(actor, { type: "PARTNER", limit: Number.NaN })).code).toBe("invalid_input");
    expect(failed(await searchCounterparties(actor, { type: "PARTNER", q: "x".repeat(81) })).code).toBe("invalid_input");
    expect(failed(await searchCounterparties(actor, { type: "CREATOR" })).code).toBe("invalid_input");
    expect(failed(await searchCounterparties(actor, { type: "PARTNER", scope: "GLOBAL" })).code).toBe("invalid_input"); // strict: no client-supplied scope
  });

  it("requires finance + manage_agreements: unauthenticated, Viewer and Analyst are denied; Manager, Head and Admin may search", async () => {
    expect(failed(await searchCounterparties(null, { type: "PARTNER" }))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    for (const role of ["viewer", "analyst"]) expect(failed(await searchCounterparties(await seededActor(role), { type: "PARTNER", q: srchTag })), role).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
    for (const role of ["partnership_manager", "partnership_head", "super_admin"]) expect((await searchCounterparties(await seededActor(role), { type: "PARTNER", q: `${srchTag}-none` })).ok, role).toBe(true);
  });

  it("finance READ without manage_agreements is refused on the action (a per-user override removes it)", async () => {
    const uid = `faw-noman-${runId}-${randomUUID().slice(0, 6)}`;
    const overrideRef = getAdminFirestore().collection(COLLECTIONS.userAccessOverrides).doc(uid);
    cleanup.push(overrideRef);
    await overrideRef.set({ uid, version: 1, features: { finance: { view: true, actions: { manage_agreements: false } } } });
    const actor: ActorContext = { uid, email: `${uid}@example.test`, role: "partnership_manager", displayName: "no manage", userRef: `ref-${uid}` };
    expect(failed(await searchCounterparties(actor, { type: "PARTNER", q: srchTag }))).toMatchObject({ code: "unauthorized", reason: "action_denied" });
    expect(failed(await getCounterpartyPreview(actor, { type: "PARTNER", ref: (fixtures.active as PartnerDoc).partnerRef }))).toMatchObject({ code: "unauthorized", reason: "action_denied" });
  });
});

describe("counterparty preview", () => {
  const prvTag = `${TAG}-prv`;
  let manager: ActorContext;
  let headActor: ActorContext;
  let partner: PartnerDoc;
  let otherPartner: PartnerDoc;
  let vendor: VendorDoc;
  const accounts: Record<string, string> = {};

  beforeAll(async () => {
    manager = await syntheticActor("partnership_manager", [{ type: "REGION", region: R_IN }]);
    headActor = await syntheticActor("partnership_head", [{ type: "REGION", region: R_IN }]);
    partner = await seedPartner({ name: `${prvTag} Preview Partner`, regionIds: [R_IN], legalName: "Preview Legal Pvt Ltd", email: "preview@example.test", phone: "+91 91111 11111" });
    otherPartner = await seedPartner({ name: `${prvTag} Other Partner`, regionIds: [R_IN] });
    vendor = await seedVendor({ name: `${prvTag} Preview Vendor`, regionIds: [R_IN] });
    accounts.ig = (await seedAccount(partner, "Instagram", { handle: "preview_ig", primary: true })).partnerAccountRef;
    accounts.yt = (await seedAccount(partner, "YouTube", { handle: "preview_yt" })).partnerAccountRef;
    accounts.other = (await seedAccount(otherPartner, "instagram", { handle: "someone_elses" })).partnerAccountRef;
    await seedRestrictedIdentity({ type: "PARTNER", uid: partner.uid, ref: partner.partnerRef }, { pan: true, bank: true, aadhaar: true, gst: "number" });
    await seedRestrictedIdentity({ type: "VENDOR", uid: vendor.uid, ref: vendor.vendorRef }, { pan: true, gst: "not_applicable" });
  });

  const preview = async (actor: ActorContext, type: string, ref: string): Promise<CounterpartyPreviewDto> => must(await getCounterpartyPreview(actor, { type, ref }), "preview");

  it("a Partner preview is master data + Partner Accounts (THIS Partner's only) + status; address / PIN are explicitly unavailable", async () => {
    const dto = await preview(manager, "PARTNER", partner.partnerRef);
    expect(dto).toMatchObject({ source: "CreatorOps master data", type: "PARTNER", ref: partner.partnerRef, displayName: `${prvTag} Preview Partner`, legalName: "Preview Legal Pvt Ltd", email: "preview@example.test", phone: "+91 91111 11111", regions: [R_IN], status: "ACTIVE" });
    expect(dto.partnerAccounts.map((a) => a.partnerAccountRef).sort()).toEqual([accounts.ig, accounts.yt].sort());
    expect(dto.partnerAccounts.map((a) => a.partnerAccountRef)).not.toContain(accounts.other);
    expect(dto.partnerAccounts.find((a) => a.partnerAccountRef === accounts.ig)).toEqual({ partnerAccountRef: accounts.ig, platform: "instagram", handle: "preview_ig", displayName: null, profileUrl: null, status: "ACTIVE", primary: true });
    expect(dto.unavailableFields).toEqual([
      { fieldKey: "address", reason: "no_canonical_field" },
      { fieldKey: "pinCode", reason: "no_canonical_field" },
    ]);
    assertNoRestricted(dto, "manager partner preview");
  });

  it("KYC is STATUS only: a Manager sees the state with RESTRICTED components (and a RESTRICTED GSTIN status); a Head with the identity category sees component statuses - never a value", async () => {
    const asManager = await preview(manager, "PARTNER", partner.partnerRef);
    expect(asManager.kyc).toEqual({ state: "AVAILABLE", components: { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" }, valuesVisible: false });
    expect(asManager.gstinStatus).toBe("RESTRICTED");
    const asHead = await preview(headActor, "PARTNER", partner.partnerRef);
    expect(asHead.kyc).toEqual({ state: "AVAILABLE", components: { pan: "PRESENT", aadhaar: "PRESENT", gst: "PRESENT", bank: "PRESENT" }, valuesVisible: true });
    expect(asHead.gstinStatus).toBe("PRESENT");
    assertNoRestricted(asHead, "head partner preview");
    const missing = await preview(headActor, "PARTNER", otherPartner.partnerRef);
    expect(missing.kyc).toMatchObject({ state: "MISSING", components: { pan: "MISSING", bank: "MISSING", gst: "MISSING" } });
    expect(missing.gstinStatus).toBe("MISSING");
  });

  it("a Vendor preview has no Partner Accounts, no Aadhaar (NOT_APPLICABLE) and the Vendor category's own KYC status", async () => {
    const asHead = await preview(headActor, "VENDOR", vendor.vendorRef);
    expect(asHead).toMatchObject({ type: "VENDOR", ref: vendor.vendorRef, partnerAccounts: [], email: vendor.email, kyc: { state: "INCOMPLETE", components: { pan: "PRESENT", aadhaar: "NOT_APPLICABLE", gst: "NOT_APPLICABLE", bank: "MISSING" }, valuesVisible: true }, gstinStatus: "NOT_APPLICABLE" });
    expect((await preview(manager, "VENDOR", vendor.vendorRef)).kyc.components).toEqual({ pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" });
    assertNoRestricted(asHead, "vendor preview");
  });

  it("out-of-scope, unknown and forged references all answer the same neutral not_found; a Partner ref given as a Vendor (and vice versa) is not found either", async () => {
    const NEUTRAL = { ok: false, code: "not_found", message: "Not found." };
    const outPartner = await seedPartner({ name: `${prvTag} Out Partner`, regionIds: [R_OUT] });
    const outVendor = await seedVendor({ name: `${prvTag} Out Vendor`, regionIds: [R_OUT] });
    expect(await getCounterpartyPreview(manager, { type: "PARTNER", ref: outPartner.partnerRef })).toMatchObject(NEUTRAL);
    expect(await getCounterpartyPreview(manager, { type: "VENDOR", ref: outVendor.vendorRef })).toMatchObject(NEUTRAL);
    expect(await getCounterpartyPreview(manager, { type: "PARTNER", ref: "ref-does-not-exist" })).toMatchObject(NEUTRAL);
    expect(await getCounterpartyPreview(manager, { type: "VENDOR", ref: partner.partnerRef })).toMatchObject(NEUTRAL);
    expect(await getCounterpartyPreview(manager, { type: "PARTNER", ref: vendor.vendorRef })).toMatchObject(NEUTRAL);
  });

  it("validates its input strictly and enforces the finance + manage_agreements gate", async () => {
    expect(failed(await getCounterpartyPreview(manager, { type: "PARTNER" })).code).toBe("invalid_input");
    expect(failed(await getCounterpartyPreview(manager, { type: "PARTNER", ref: "" })).code).toBe("invalid_input");
    expect(failed(await getCounterpartyPreview(manager, { type: "PARTNER", ref: partner.partnerRef, scope: "GLOBAL" })).code).toBe("invalid_input");
    expect(failed(await getCounterpartyPreview(null, { type: "PARTNER", ref: partner.partnerRef }))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    for (const role of ["viewer", "analyst"]) expect(failed(await getCounterpartyPreview(await seededActor(role), { type: "PARTNER", ref: partner.partnerRef })), role).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
  });
});

// =====================================================================================================================
// Permissions: the five-role matrix from REAL grants
// =====================================================================================================================
describe("finance agreement permissions", () => {
  const BASE = { canView: false, canManage: false, canActivate: false, canViewContractDetail: false, canViewIdentity: false, canManageCounterpartyKyc: false, canCreatePartner: false, canCreateVendor: false, canManagePartnerAccounts: false };
  const permissions = async (role: string, type?: string) => must(await getFinanceAgreementPermissions(await seededActor(role), type), role);

  it("Viewer and Analyst hold nothing (no finance grant): every boolean is false - the page renders the neutral denied state", async () => {
    for (const role of ["viewer", "analyst"]) {
      for (const type of [undefined, "PARTNER", "VENDOR"]) expect(await permissions(role, type), `${role} ${type}`).toMatchObject(BASE);
    }
  });

  it("Manager prepares (view + manage) but never activates and holds no sensitive category or identity-management right; it holds the owning create rights (Step 14B.1)", async () => {
    for (const type of [undefined, "PARTNER", "VENDOR"]) expect(await permissions("partnership_manager", type), `manager ${type}`).toMatchObject({ ...BASE, canView: true, canManage: true, canCreatePartner: true, canCreateVendor: true, canManagePartnerAccounts: true });
  });

  it("Step 14B.1 five-role matrix for the onboarding booleans (real grants): Viewer/Analyst none; Manager/Head/Admin hold the owning create + account rights", async () => {
    for (const role of ["viewer", "analyst"]) expect(await permissions(role), role).toMatchObject({ canCreatePartner: false, canCreateVendor: false, canManagePartnerAccounts: false });
    for (const role of ["partnership_manager", "partnership_head", "super_admin"]) {
      for (const type of [undefined, "PARTNER", "VENDOR"]) expect(await permissions(role, type), `${role} ${type}`).toMatchObject({ canCreatePartner: true, canCreateVendor: true, canManagePartnerAccounts: true });
    }
  });

  it("Step 14B.1: a per-user override removing partners:create / vendors:create / manage_partner_accounts is honoured independently of manage_agreements", async () => {
    const uid = `faw-onb-override-${runId}-${randomUUID().slice(0, 6)}`;
    const overrideRef = getAdminFirestore().collection(COLLECTIONS.userAccessOverrides).doc(uid);
    cleanup.push(overrideRef);
    const actor: ActorContext = { uid, email: `${uid}@example.test`, role: "partnership_head", displayName: "override", userRef: `ref-${uid}` };
    expect(must(await getFinanceAgreementPermissions(actor), "baseline")).toMatchObject({ canManage: true, canCreatePartner: true, canCreateVendor: true, canManagePartnerAccounts: true });
    await overrideRef.set({ uid, version: 1, features: { partners: { actions: { create: false, manage_partner_accounts: false } }, vendors: { actions: { create: false } } } });
    expect(must(await getFinanceAgreementPermissions(actor), "no owning create")).toMatchObject({ canView: true, canManage: true, canCreatePartner: false, canCreateVendor: false, canManagePartnerAccounts: false });
  });

  it("Head and Super Admin hold view + manage + activate + finance_contracts, and the identity category / KYC management for the requested counterparty type", async () => {
    for (const role of ["partnership_head", "super_admin"]) {
      expect(await permissions(role), role).toMatchObject({ canView: true, canManage: true, canActivate: true, canViewContractDetail: true, canViewIdentity: false, canManageCounterpartyKyc: false, counterpartyType: null });
      for (const type of ["PARTNER", "VENDOR"]) expect(await permissions(role, type), `${role} ${type}`).toMatchObject({ canView: true, canManage: true, canActivate: true, canViewContractDetail: true, canViewIdentity: true, canManageCounterpartyKyc: true, counterpartyType: type });
    }
  });

  it("the per-type detail is always present regardless of the requested type", async () => {
    const dto = await permissions("partnership_head");
    expect(dto.byCounterpartyType).toEqual({ PARTNER: { canViewIdentity: true, canManageCounterpartyKyc: true }, VENDOR: { canViewIdentity: true, canManageCounterpartyKyc: true } });
    const manager = await permissions("partnership_manager");
    expect(manager.byCounterpartyType).toEqual({ PARTNER: { canViewIdentity: false, canManageCounterpartyKyc: false }, VENDOR: { canViewIdentity: false, canManageCounterpartyKyc: false } });
  });

  it("a per-user override that removes an action or the feature is honoured (real grants, not role names)", async () => {
    const uid = `faw-override-${runId}-${randomUUID().slice(0, 6)}`;
    const overrideRef = getAdminFirestore().collection(COLLECTIONS.userAccessOverrides).doc(uid);
    cleanup.push(overrideRef);
    const actor: ActorContext = { uid, email: `${uid}@example.test`, role: "partnership_head", displayName: "override", userRef: `ref-${uid}` };
    expect(must(await getFinanceAgreementPermissions(actor), "baseline").canActivate).toBe(true);
    await overrideRef.set({ uid, version: 1, features: { finance: { actions: { activate_agreements: false } } } });
    expect(must(await getFinanceAgreementPermissions(actor), "no activate")).toMatchObject({ canView: true, canManage: true, canActivate: false });
    await overrideRef.set({ uid, version: 2, features: { finance: { view: false, actions: {} } } });
    expect(must(await getFinanceAgreementPermissions(actor), "no feature")).toMatchObject(BASE);
  });

  it("unauthenticated is denied; an unknown counterpartyType is invalid input; a blank one means none", async () => {
    expect(failed(await getFinanceAgreementPermissions(null))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    expect(failed(await getFinanceAgreementPermissions(await seededActor("super_admin"), "CREATOR")).code).toBe("invalid_input");
    expect(must(await getFinanceAgreementPermissions(await seededActor("super_admin"), ""), "blank")).toMatchObject({ counterpartyType: null });
  });
});
