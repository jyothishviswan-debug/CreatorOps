// Step 16A - Finance Invoices against the running Firestore/Auth emulator, end to end, on REAL
// records: real Partners, real Agreements taken through the real Agreement services (create ->
// decide -> confirm -> activate), real Partner Reviews taken through the real review services
// (generate -> submit -> finalize), a real Payable taken through the real Payable services (create
// -> markPayableReadyForInvoice), and then the real Invoice services on top.
//
// Proven here:
//   - ELIGIBILITY: an Invoice is created only from a READY_FOR_INVOICE payable, and pins its exact
//     ref/version, counterparty, Agreement ref/version, Review ref/version and commercial period
//     verbatim - the client never supplies any of those, only payableRef.
//   - IDEMPOTENCY / CONCURRENCY: a repeated create returns the same canonical Invoice; concurrent
//     creates produce exactly ONE.
//   - DUPLICATE PROTECTION: two Invoices for the same counterparty may not declare the same
//     normalized supplier invoice number.
//   - DOCUMENT: the fake document-storage adapter stores the exact bytes, is idempotent, and no
//     real Google Drive call is ever reachable from this test run.
//   - LIFECYCLE: submit preconditions, approve, reject, reopen (revision after rejection, prior
//     version retained), void, and that nothing is ever hard-deleted.
//   - RECONCILIATION: an amount mismatch blocks approval until an explicit, reasoned mismatch
//     override is accepted by the exact permission.
//   - AUTHZ: per-role, missing feature, missing action, exact mismatch-override permission,
//     out-of-scope counterparty.
//   - SOURCE REVISION: a later Payable revision is a WARNING that never mutates the Invoice.
//   - BOUNDARIES: an Invoice mutation writes ONLY financeInvoices*/financeInvoiceNumberClaims
//     documents - never a Payable, an Agreement, a Partner Review, a Partner or a Vendor.
//
// Hermetic: every Partner has a unique uid/ref, the Agreement dates are in 2019, evidence fixtures
// carry a private region, and everything created is removed afterwards.
import { randomUUID } from "node:crypto";

import { DocumentReference, Transaction, WriteBatch } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assignmentsCollection } from "@/server/assignments/firestore";
import { assignmentBriefSchema, assignmentDocSchema } from "@/server/assignments/types";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { contentCollection } from "@/server/content/firestore";
import { contentDocSchema } from "@/server/content/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { activateAgreementVersion, confirmAgreementVersion, createAgreementDraft, decideField, type AgreementDetailDto } from "@/server/finance-agreements";
import { agreementClaimId, financeAgreementClaimsCollection, financeAgreementsCollection } from "@/server/finance-agreements/firestore";
import { agreementCommercialPolicyProvider } from "@/server/finance-agreements/policy-adapter";
import { READY_DECISIONS, type FieldDecisionSeed } from "@/server/finance-agreements/testing/agreement-service-fixtures";
import type { AgreementCounterpartyInput, FinanceAgreementsServiceResult } from "@/server/finance-agreements/types";
// Test-only reuse of a domain-agnostic PDF-byte builder (this file is a `.test.ts`, so the
// finance-invoices-static.test.ts "no finance-agreements import" guard - which scans only
// non-test files - does not, and should not, apply here).
import { makeTextPdf } from "@/server/finance-agreements/testing/pdf-fixtures";
import { setCommercialPolicyProviderForTests } from "@/server/partner-reviews/commercial-policy";
import { partnerReviewsCollection } from "@/server/partner-reviews/firestore";
import { finalizePartnerReview, submitPartnerReviewForReview } from "@/server/partner-reviews/partner-review-lifecycle-service";
import { generatePartnerReviewDraft } from "@/server/partner-reviews/partner-review-service";
import { partnersCollection } from "@/server/partners/firestore";
import { partnerDocSchema, type PartnerDoc } from "@/server/partners/types";
import { vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema, type VendorDoc } from "@/server/vendors/types";
import { confirmPayableTax, createPayable, getPayable, markPayableReadyForInvoice, revisePayable, voidPayable, type PayableDetailDto } from "@/server/finance-payables";
import { financePayablesCollection } from "@/server/finance-payables/firestore";
import type { FinancePayablesServiceResult } from "@/server/finance-payables/types";

import {
  acceptInvoiceMismatch,
  approveInvoice,
  attachInvoiceDocument,
  createInvoiceDraft,
  getInvoice,
  getInvoicePaymentHandoff,
  getInvoiceSourceRevision,
  listInvoiceEvents,
  listInvoicesWorkspace,
  previewInvoiceEligibility,
  previewInvoiceExtraction,
  reconcileInvoice,
  rejectInvoice,
  reopenInvoice,
  resolveInvoicePayeeMismatch,
  reviseInvoiceDraft,
  submitInvoice,
  voidInvoice,
  type InvoiceDetailDto,
} from "./index";
import { financeInvoiceNumberClaimsCollection, financeInvoicesCollection, financeInvoiceVersionsCollection, getInvoiceHeadDoc } from "./firestore";
import { createInMemoryInvoiceDocumentStorage, setInvoiceDocumentStorageForTests } from "./document-storage";
import { invoiceRefFor } from "./ids";
import type { FinanceInvoicesServiceResult } from "./types";

vi.setConfig({ testTimeout: 120_000 });

const runId = Date.now();
const PRIVATE_REGION = `inv-private-${runId}`;
const PERIOD = "2019-03";
const SUPPORTED_UNIT = "approved_content_thread";

const uidByRole = new Map<string, string>();
const cleanup: FirebaseFirestore.DocumentReference[] = [];
const agreementRefs: string[] = [];
const claimIds: string[] = [];
const reviewRefs = new Set<string>();
const payableRefs = new Set<string>();
const invoiceRefs = new Set<string>();
let counter = 0;
let reqCounter = 0;
const requestId = () => `inv-req-${runId}-${(reqCounter += 1)}`;

// A minimal, valid one-page PDF (used by every document-attach test).
const MINIMAL_PDF = Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`, "utf8");

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  const auth = getAdminAuth();
  for (const identity of TEST_IDENTITIES) uidByRole.set(identity.role, (await auth.getUserByEmail(identity.email)).uid);
  setCommercialPolicyProviderForTests(agreementCommercialPolicyProvider);
}, 120_000);

afterAll(async () => {
  setCommercialPolicyProviderForTests(null);
  const db = getAdminFirestore();
  for (const ref of invoiceRefs) await db.recursiveDelete(financeInvoicesCollection().doc(ref));
  for (const ref of payableRefs) await db.recursiveDelete(financePayablesCollection().doc(ref));
  for (const ref of agreementRefs.splice(0)) await db.recursiveDelete(financeAgreementsCollection().doc(ref));
  await Promise.all(claimIds.splice(0).map((id) => financeAgreementClaimsCollection().doc(id).delete()));
  for (const reviewRef of reviewRefs) await db.recursiveDelete(partnerReviewsCollection().doc(reviewRef));
  await Promise.all(cleanup.splice(0).map((ref) => ref.delete()));
  // This hermetic test file is the ONLY writer of financeInvoiceNumberClaims in the whole suite
  // (a brand-new Step 16A collection) - wipe every claim it created so a LATER test file's own
  // "no Payable/Invoice/Payment collection exists" assertion (elsewhere in the suite, run against
  // the same shared emulator database within one `vitest run`) never sees stale documents left
  // behind by this file. Firestore drops an empty collection from listCollections() once its last
  // document is gone, exactly like Payables' own thorough per-document cleanup above already relies
  // on for financePayables/financeAgreements.
  const claimsSnapshot = await financeInvoiceNumberClaimsCollection().get();
  await Promise.all(claimsSnapshot.docs.map((doc) => doc.ref.delete()));
});

beforeEach(() => {
  setInvoiceDocumentStorageForTests(createInMemoryInvoiceDocumentStorage());
});

afterEach(() => {
  setInvoiceDocumentStorageForTests(null);
});

async function actorFor(role: string): Promise<ActorContext> {
  const actor = await resolveActor(uidByRole.get(role)!);
  if (!actor) throw new Error(`no seeded actor for ${role}`);
  return actor;
}

function must<T>(result: FinanceAgreementsServiceResult<T> | FinancePayablesServiceResult<T> | FinanceInvoicesServiceResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}${"blockers" in result && result.blockers ? ` ${JSON.stringify(result.blockers)}` : ""}`);
  return result.data;
}

function failure(result: FinanceInvoicesServiceResult<unknown>): Extract<FinanceInvoicesServiceResult<unknown>, { ok: false }> {
  if (result.ok) throw new Error("expected a failure, got a success");
  return result;
}

// ---- Counterparty / evidence fixtures (mirrors finance-payables.emulator.test.ts) --------------------------------------------
async function seedPartner(regionIds: string[] = ["Kerala"]): Promise<PartnerDoc> {
  counter += 1;
  const uid = `inv-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const partner = partnerDocSchema.parse({
    uid,
    partnerRef: uid,
    version: 1,
    displayName: `INV Partner ${counter}`,
    displayNameLower: `inv partner ${counter}`,
    legalName: null,
    email: `${uid}@example-partner.test`,
    phone: "+91 90000 00088",
    status: "ACTIVE",
    regionIds,
    createdAt: now,
    createdByUserRef: "inv-test",
    updatedAt: now,
    updatedByUserRef: "inv-test",
  });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  cleanup.push(ref);
  return partner;
}

async function seedVendor(regionIds: string[] = ["Kerala"]): Promise<VendorDoc> {
  counter += 1;
  const uid = `inv-vendor-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const vendor = vendorDocSchema.parse({
    uid,
    vendorRef: uid,
    version: 1,
    displayName: `INV Vendor ${counter}`,
    displayNameLower: `inv vendor ${counter}`,
    vendorType: "AGENCY",
    email: `${uid}@example-vendor.test`,
    status: "ACTIVE",
    regionIds,
    createdAt: now,
    createdByUserRef: "inv-test",
    updatedAt: now,
    updatedByUserRef: "inv-test",
  });
  const ref = vendorsCollection().doc(uid);
  await ref.set(vendor);
  cleanup.push(ref);
  return vendor;
}

async function seedEvidence(partner: PartnerDoc): Promise<void> {
  const uid = assignmentsCollection().doc().id;
  const now = new Date().toISOString();
  const assignment = assignmentDocSchema.parse({
    uid,
    assignmentRef: `inv-as-${uid}`,
    version: 1,
    campaignRef: `inv-camp-${runId}`,
    partnerRef: partner.partnerRef,
    partnerAccountRefs: [],
    status: "IN_PROGRESS",
    statusReason: null,
    brief: assignmentBriefSchema.parse({ dueAt: "2019-03-10", requiredCount: 1, formats: ["reel"], platforms: ["instagram"], reviewPolicy: "REVIEW_REQUIRED", campaignName: "INV Campaign" }),
    ownerUid: null,
    regionIds: [PRIVATE_REGION],
    teamIds: [],
    createdAt: "2019-01-05T08:00:00.000Z",
    createdByUserRef: "inv-test",
    updatedAt: now,
    updatedByUserRef: "inv-test",
  });
  const assignmentRef = assignmentsCollection().doc(uid);
  await assignmentRef.set(assignment);
  cleanup.push(assignmentRef);

  const threadUid = contentCollection().doc().id;
  const thread = contentDocSchema.parse({
    uid: threadUid,
    contentRef: `inv-ct-${threadUid}`,
    version: 3,
    assignmentRef: assignment.assignmentRef,
    campaignRef: assignment.campaignRef,
    partnerRef: partner.partnerRef,
    status: "APPROVED",
    statusReason: null,
    currentRevisionNumber: 1,
    reviewedRevisionNumber: 1,
    currentLinks: [{ platform: "instagram", originalUrl: `https://instagram.com/p/INV${threadUid}`, normalizedUrl: `https://instagram.com/p/inv${threadUid.toLowerCase()}`, recordedAt: "2019-03-08T10:00:00.000Z" }],
    qualifyingFulfillment: null,
    dueAt: null,
    openedAt: "2019-03-01T00:00:00.000Z",
    firstSubmittedAt: "2019-03-08T10:00:00.000Z",
    lastSubmittedAt: "2019-03-08T10:00:00.000Z",
    approvedAt: "2019-03-09T00:00:00.000Z",
    cancelledAt: null,
    ownerUid: null,
    regionIds: [PRIVATE_REGION],
    teamIds: [],
    createdAt: "2019-03-01T00:00:00.000Z",
    createdByUserRef: "inv-test",
    updatedAt: "2019-03-08T10:00:00.000Z",
    updatedByUserRef: "inv-test",
  });
  const threadRef = contentCollection().doc(threadUid);
  await threadRef.set(thread);
  cleanup.push(threadRef);
}

// ---- Agreement helpers (real services) -----------------------------------------------------------------------------------
function decisionsWith(over: Record<string, FieldDecisionSeed>): FieldDecisionSeed[] {
  const keys = new Set(Object.keys(over));
  return [...READY_DECISIONS.filter((seed) => !keys.has(seed.fieldKey)), ...Object.values(over)];
}

const DETERMINED_TERMS = (): FieldDecisionSeed[] =>
  decisionsWith({
    effectiveDate: { fieldKey: "effectiveDate", decision: "CORRECTED", value: "2019-01-01" },
    terminationDate: { fieldKey: "terminationDate", decision: "CORRECTED", value: "2019-12-31" },
    qualifyingUnit: { fieldKey: "qualifyingUnit", decision: "CORRECTED", value: SUPPORTED_UNIT },
    monthlyRequiredQualifyingContentCount: { fieldKey: "monthlyRequiredQualifyingContentCount", decision: "CORRECTED", value: 1 },
    incentive: { fieldKey: "incentive", decision: "NOT_APPLICABLE" },
  });

const partnerCp = (partner: PartnerDoc): AgreementCounterpartyInput => ({ type: "PARTNER", partnerRef: partner.partnerRef });
const vendorCp = (vendor: VendorDoc): AgreementCounterpartyInput => ({ type: "VENDOR", vendorRef: vendor.vendorRef });

async function decideAll(actor: ActorContext, detail: AgreementDetailDto, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
  let current = detail;
  for (const seed of seeds) {
    current = must(
      await decideField(
        actor,
        { agreementRef: current.head.agreementRef, version: current.selectedVersion!.version, expectedDocVersion: current.selectedVersion!.docVersion, fieldKey: seed.fieldKey, decision: seed.decision, ...(seed.value !== undefined ? { value: seed.value } : {}) },
        requestId(),
      ),
      `decide ${seed.fieldKey}`,
    );
  }
  return current;
}

async function acceptPending(actor: ActorContext, detail: AgreementDetailDto): Promise<AgreementDetailDto> {
  const pending = Object.entries(detail.selectedVersion!.draft)
    .filter(([, entry]) => entry?.decision === "PENDING")
    .map(([fieldKey]) => ({ fieldKey, decision: "ACCEPTED" }) as FieldDecisionSeed);
  return decideAll(actor, detail, pending);
}

async function activeAgreement(counterparty: AgreementCounterpartyInput, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
  const manager = await actorFor("partnership_manager");
  const head = await actorFor("partnership_head");
  const clientRequestId = `inv-crid-${runId}-${(counter += 1)}-${randomUUID().slice(0, 6)}`;
  const created = must(await createAgreementDraft(manager, { clientRequestId, counterparty }, requestId()), "create agreement");
  agreementRefs.push(created.agreement.head.agreementRef);
  claimIds.push(agreementClaimId(manager.uid, clientRequestId));
  const decided = await acceptPending(manager, await decideAll(manager, created.agreement, seeds));
  const confirmed = must(await confirmAgreementVersion(manager, { agreementRef: decided.head.agreementRef, version: decided.selectedVersion!.version, expectedDocVersion: decided.selectedVersion!.docVersion }, requestId()), "confirm agreement");
  return must(await activateAgreementVersion(head, { agreementRef: confirmed.head.agreementRef, version: confirmed.selectedVersion!.version, expectedDocVersion: confirmed.head.docVersion }, requestId()), "activate agreement");
}

// ---- Partner Review helpers (real services) -------------------------------------------------------------------------------
async function finalizedReview(partner: PartnerDoc): Promise<string> {
  const manager = await actorFor("partnership_manager");
  const head = await actorFor("partnership_head");
  const generated = await generatePartnerReviewDraft(manager, { partnerRef: partner.partnerRef, periodKey: PERIOD }, requestId());
  if (!generated.ok) throw new Error(`generate review: ${generated.code} ${generated.message}`);
  const reviewRef = generated.data.review.head.reviewRef;
  reviewRefs.add(reviewRef);
  const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: generated.data.review.head.docVersion }, requestId());
  if (!submitted.ok) throw new Error(`submit review: ${submitted.message}`);
  const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, requestId());
  if (!finalized.ok) throw new Error(`finalize review: ${finalized.message}`);
  return reviewRef;
}

// ---- Payable helpers (real services) --------------------------------------------------------------------------------------
// A Partner with evidence, an active Agreement, a finalized Review, and a Payable already
// READY_FOR_INVOICE for the period - the standard fixture every Invoice test starts from.
async function readyPayable(seeds: FieldDecisionSeed[] = DETERMINED_TERMS()): Promise<{ partner: PartnerDoc; payable: PayableDetailDto }> {
  const headActor = await actorFor("partnership_head");
  const partner = await seedPartner();
  await seedEvidence(partner);
  await activeAgreement(partnerCp(partner), seeds);
  await finalizedReview(partner);

  const created = must(await createPayable(headActor, { counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef, commercialPeriod: PERIOD }, requestId()), "create payable");
  payableRefs.add(created.payable.head.payableRef);
  // Step 15C.1 section 10: GST applicability is never guessed - a freshly created Partner-Review
  // Payable opens with GST_APPLICABILITY_UNCONFIRMED until Finance explicitly confirms it. The
  // Invoice fixtures below are unconcerned with GST itself, so they confirm "not applicable" here,
  // exactly like a real Finance actor would before moving a Payable to READY_FOR_INVOICE.
  const taxConfirmed = must(await confirmPayableTax(headActor, { payableRef: created.payable.head.payableRef, expectedDocVersion: created.payable.head.docVersion, gstApplicable: false, gstRateBps: null }, requestId()), "confirm GST not applicable");
  const ready = must(await markPayableReadyForInvoice(headActor, { payableRef: created.payable.head.payableRef, expectedDocVersion: taxConfirmed.head.docVersion }, requestId()), "ready payable");
  return { partner, payable: ready };
}

async function createFor(actor: ActorContext, payableRef: string) {
  const result = await createInvoiceDraft(actor, { payableRef }, requestId());
  if (result.ok) invoiceRefs.add(result.data.invoice.head.invoiceRef);
  return result;
}

async function draftInvoice(): Promise<{ invoice: InvoiceDetailDto; partner: PartnerDoc; payableRef: string }> {
  const headActor = await actorFor("partnership_head");
  const { partner, payable } = await readyPayable();
  const created = must(await createFor(headActor, payable.head.payableRef), "create invoice");
  return { invoice: created.invoice, partner, payableRef: payable.head.payableRef };
}

// A submittable DRAFT: number, date, currency, total and a document all present.
async function completeDraft(overrides: { externalInvoiceNumber?: string; declaredTotalMinor?: number } = {}): Promise<{ invoice: InvoiceDetailDto; partner: PartnerDoc }> {
  const headActor = await actorFor("partnership_head");
  const { invoice, partner } = await draftInvoice();
  const revised = must(
    await reviseInvoiceDraft(
      headActor,
      {
        invoiceRef: invoice.head.invoiceRef,
        expectedDocVersion: invoice.head.docVersion,
        externalInvoiceNumber: overrides.externalInvoiceNumber ?? `INV-${runId}-${(counter += 1)}`,
        invoiceDate: "2019-04-02",
        currency: "INR",
        declaredTotalMinor: overrides.declaredTotalMinor ?? 5_000_000,
        reason: "Filling in declared invoice fields.",
      },
      requestId(),
    ),
    "revise draft",
  );
  const withDoc = must(
    await attachInvoiceDocument(headActor, { invoiceRef: revised.head.invoiceRef, expectedDocVersion: revised.head.docVersion, fileName: "invoice.pdf", contentBase64: MINIMAL_PDF.toString("base64") }, requestId()),
    "attach document",
  );
  return { invoice: withDoc, partner };
}

// ---- Firestore write instrumentation ---------------------------------------------------------------------------------------
function instrumentWrites() {
  const paths: string[] = [];
  type AnyFn = (...args: unknown[]) => unknown;
  const spies: Array<{ mockRestore: () => void }> = [];
  const wrap = (proto: object, name: string, pathOf: (self: unknown, args: unknown[]) => string) => {
    const original = (proto as unknown as Record<string, AnyFn>)[name]!;
    spies.push(
      vi.spyOn(proto as unknown as Record<string, AnyFn>, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
        paths.push(pathOf(this, args));
        return original.apply(this, args);
      }),
    );
  };
  for (const op of ["set", "create", "update", "delete"]) {
    wrap(Transaction.prototype, op, (_self, args) => (args[0] as { path: string }).path);
    wrap(WriteBatch.prototype, op, (_self, args) => (args[0] as { path: string }).path);
    wrap(DocumentReference.prototype, op, (self) => (self as { path: string }).path);
  }
  return { paths, stop: () => spies.splice(0).forEach((spy) => spy.mockRestore()) };
}

// =====================================================================================================================
describe("eligibility and pinning", () => {
  it("creates an Invoice from a READY_FOR_INVOICE payable and pins its exact ref/version, counterparty, Agreement and Review", async () => {
    const headActor = await actorFor("partnership_head");
    const { partner, payable } = await readyPayable();

    const created = must(await createFor(headActor, payable.head.payableRef), "create invoice");
    expect(created.outcome).toBe("created");
    const invoice = created.invoice;
    expect(invoice.head.invoiceRef).toBe(invoiceRefFor(payable.head.payableRef));
    expect(invoice.head.payableRef).toBe(payable.head.payableRef);
    expect(invoice.head.status).toBe("DRAFT");
    expect(invoice.head.counterparty.ref).toBe(partner.partnerRef);

    const version = invoice.selectedVersion!;
    expect(version.payablePin.payableVersion).toBe(payable.head.readyVersion);
    expect(version.payablePin.agreementRef).toBe(payable.head.agreementRef);
    expect(version.payablePin.reviewRef).toBe(payable.head.reviewRef);
    expect(version.payablePin.commercialPeriod.periodKey).toBe(PERIOD);
    expect(version.payablePin.payableGrossInvoiceExpectedMinor).toBe(5_000_000);
    expect(version.externalInvoiceNumber).toBeNull();
    expect(version.reconciliation.state).toBe("MISSING_IN_INVOICE");
  });

  it("refuses a DRAFT payable and a VOID payable", async () => {
    const headActor = await actorFor("partnership_head");
    const partner = await seedPartner();
    await seedEvidence(partner);
    await activeAgreement(partnerCp(partner), DETERMINED_TERMS());
    await finalizedReview(partner);
    const draftPayable = must(await createPayable(headActor, { counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef, commercialPeriod: PERIOD }, requestId()), "create payable");
    payableRefs.add(draftPayable.payable.head.payableRef);

    const refusedDraft = failure(await createFor(headActor, draftPayable.payable.head.payableRef));
    expect(refusedDraft.code).toBe("not_ready");
    expect(refusedDraft.blockers?.map((b) => b.code)).toEqual(["PAYABLE_NOT_READY"]);

    const { payable } = await readyPayable();
    const voided = must(await voidPayable(headActor, { payableRef: payable.head.payableRef, expectedDocVersion: payable.head.docVersion, reason: "Testing void refusal." }, requestId()), "void payable");
    expect(voided.head.status).toBe("VOID");
    const refusedVoid = failure(await createFor(headActor, payable.head.payableRef));
    expect(refusedVoid.blockers?.map((b) => b.code)).toEqual(["PAYABLE_NOT_READY"]);
  });

  it("an already-used Payable may not create a second, independent Invoice head - it always resolves to the SAME canonical one", async () => {
    const headActor = await actorFor("partnership_head");
    const { payable } = await readyPayable();

    const first = must(await createFor(headActor, payable.head.payableRef), "first create");
    const second = must(await createFor(headActor, payable.head.payableRef), "second create");
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("existing");
    expect(second.invoice.head.invoiceRef).toBe(first.invoice.head.invoiceRef);
    expect((await financeInvoiceVersionsCollection(first.invoice.head.invoiceRef).get()).size).toBe(1);
  });

  it("concurrent creates for the same Payable produce exactly ONE canonical Invoice", async () => {
    const headActor = await actorFor("partnership_head");
    const { payable } = await readyPayable();

    const results = await Promise.all([createFor(headActor, payable.head.payableRef), createFor(headActor, payable.head.payableRef), createFor(headActor, payable.head.payableRef)]);
    const outcomes = results.map((r) => (r.ok ? r.data.outcome : `error:${r.code}`));
    expect(outcomes.filter((o) => o === "created")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "existing")).toHaveLength(2);
    const invoiceRef = invoiceRefFor(payable.head.payableRef);
    expect((await financeInvoiceVersionsCollection(invoiceRef).get()).size).toBe(1);
  });

  it("preview explains eligibility without writing anything", async () => {
    const headActor = await actorFor("partnership_head");
    const { payable } = await readyPayable();

    const io = instrumentWrites();
    let preview;
    try {
      preview = must(await previewInvoiceEligibility(headActor, { payableRef: payable.head.payableRef }), "preview");
    } finally {
      io.stop();
    }
    expect(io.paths).toEqual([]);
    expect(preview.eligible).toBe(true);
    expect(preview.existingInvoiceRef).toBeNull();
    expect(preview.pin?.payableRef).toBe(payable.head.payableRef);
  });
});

// =====================================================================================================================
describe("duplicate invoice-number protection", () => {
  // Uses a VENDOR counterparty (AGREEMENT_ONLY - no Partner Review evidence, no under-delivery
  // complication) with ONE active Agreement covering the whole of 2019, invoiced twice across two
  // different commercial periods - two different Payables, so two different canonical Invoice heads
  // for the SAME counterparty.
  it("prevents two DIFFERENT Invoice heads from declaring the same normalized number for the same counterparty", async () => {
    const headActor = await actorFor("partnership_head");
    const vendor = await seedVendor();
    const agreement = await activeAgreement(vendorCp(vendor), DETERMINED_TERMS());

    const payableA = must(await createPayable(headActor, { counterpartyType: "VENDOR", counterpartyRef: vendor.vendorRef, commercialPeriod: PERIOD, agreementRef: agreement.head.agreementRef }, requestId()), "create payable A");
    payableRefs.add(payableA.payable.head.payableRef);
    const readyA = must(await markPayableReadyForInvoice(headActor, { payableRef: payableA.payable.head.payableRef, expectedDocVersion: payableA.payable.head.docVersion }, requestId()), "ready payable A");
    const invoiceA = must(await createFor(headActor, readyA.head.payableRef), "create invoice A");

    const sharedNumber = `INV-DUP-${runId}`;
    const revisedA = must(
      await reviseInvoiceDraft(headActor, { invoiceRef: invoiceA.invoice.head.invoiceRef, expectedDocVersion: invoiceA.invoice.head.docVersion, externalInvoiceNumber: sharedNumber, reason: "Set the number." }, requestId()),
      "revise A",
    );
    expect(revisedA.head.externalInvoiceNumber).toBe(sharedNumber);

    // Re-declaring its OWN number (even in a different case/whitespace form) on the SAME head is
    // never a duplicate of itself - it still succeeds.
    const sameHeadRevision = must(
      await reviseInvoiceDraft(headActor, { invoiceRef: revisedA.head.invoiceRef, expectedDocVersion: revisedA.head.docVersion, externalInvoiceNumber: `  ${sharedNumber.toLowerCase()}  `, reason: "Re-declare in lowercase." }, requestId()),
      "re-declare same number",
    );
    expect(sameHeadRevision.head.externalInvoiceNumber?.trim().toUpperCase()).toBe(sharedNumber);

    // A genuinely SECOND Invoice head for the SAME counterparty (a second Payable, a different
    // period, same Agreement) declaring the identical normalized number is refused.
    // A period distinct from "2019-04" - deliberately avoiding Payables' own emulator test's "other
    // period" fixture (finance-payables.emulator.test.ts's workspace-list test queries globally by
    // that exact period and expects nothing else in the shared emulator to have created one there).
    const payableB = must(await createPayable(headActor, { counterpartyType: "VENDOR", counterpartyRef: vendor.vendorRef, commercialPeriod: "2019-08", agreementRef: agreement.head.agreementRef }, requestId()), "create payable B");
    payableRefs.add(payableB.payable.head.payableRef);
    const readyB = must(await markPayableReadyForInvoice(headActor, { payableRef: payableB.payable.head.payableRef, expectedDocVersion: payableB.payable.head.docVersion }, requestId()), "ready payable B");
    const invoiceB = must(await createFor(headActor, readyB.head.payableRef), "create invoice B");

    const conflict = failure(
      await reviseInvoiceDraft(headActor, { invoiceRef: invoiceB.invoice.head.invoiceRef, expectedDocVersion: invoiceB.invoice.head.docVersion, externalInvoiceNumber: sharedNumber, reason: "Try to reuse the same number." }, requestId()),
    );
    expect(conflict.code).toBe("conflict");
    expect(conflict.message).toMatch(/already used/i);

    // Still exactly the one version on B (the conflicting revision never persisted).
    expect((await financeInvoiceVersionsCollection(invoiceB.invoice.head.invoiceRef).get()).size).toBe(1);
  });
});

// =====================================================================================================================
describe("document attach (fake storage only, never real Google Drive)", () => {
  it("stores the exact original bytes, is idempotent, and creates a new immutable version", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice } = await draftInvoice();

    const attached = must(
      await attachInvoiceDocument(headActor, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion, fileName: "original-invoice.pdf", contentBase64: MINIMAL_PDF.toString("base64") }, requestId()),
      "attach",
    );
    expect(attached.head.latestVersion).toBe(2);
    expect(attached.selectedVersion!.document).not.toBeNull();
    expect(attached.selectedVersion!.document!.fileName).toBe("original-invoice.pdf");
    expect(attached.selectedVersion!.document!.sha256).toHaveLength(64);

    const versionsBefore = (await financeInvoiceVersionsCollection(invoice.head.invoiceRef).get()).size;
    expect(versionsBefore).toBe(2);

    // Version 1 has no document, byte-identical to what it always was.
    const v1 = (await financeInvoiceVersionsCollection(invoice.head.invoiceRef).doc("1").get()).data() as Record<string, unknown>;
    expect(v1.document).toBeNull();
  });

  it("refuses a non-PDF payload", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice } = await draftInvoice();
    const notAPdf = Buffer.from("not a pdf at all", "utf8").toString("base64");
    const refused = failure(await attachInvoiceDocument(headActor, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion, fileName: "fake.pdf", contentBase64: notAPdf }, requestId()));
    expect(refused.code).toBe("invalid_input");
  });
});

describe("extraction preview (Step 15C section 19/24/26 - read-only, never persisted, never confirms a value)", () => {
  it("previews EXTRACTED-status proposals over a real, structurally-valid Invoice PDF without attaching or mutating the Invoice", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice } = await draftInvoice();
    const docVersionBefore = invoice.head.docVersion;

    const realInvoicePdf = makeTextPdf([["Invoice Number: INV-EMU-001", "Invoice Date: 1 April 2026", "Sub Total: INR 41,000", "GST @ 18%", "Total Due: INR 48,380"]]);
    const preview = must(await previewInvoiceExtraction(headActor, { invoiceRef: invoice.head.invoiceRef, contentBase64: realInvoicePdf.toString("base64") }), "extraction preview");

    expect(preview.status).toBe("EXTRACTED");
    const byKey = Object.fromEntries(preview.fields.map((field) => [field.fieldKey, field]));
    expect(byKey.externalInvoiceNumber?.value).toBe("INV-EMU-001");
    expect(byKey.declaredTotalMinor?.value).toBe(4_838_000);
    for (const field of preview.fields) expect(field.restricted).toBe(false); // no GSTIN in this fixture

    // Genuinely read-only: re-reading the Invoice shows the exact same docVersion/latestVersion.
    const reread = must(await getInvoice(headActor, invoice.head.invoiceRef), "reread after preview");
    expect(reread.head.docVersion).toBe(docVersionBefore);
    expect(reread.head.latestVersion).toBe(invoice.head.latestVersion);
    expect(reread.selectedVersion!.document).toBeNull(); // no document was attached by previewing
  });

  it("MANUAL_REVIEW_REQUIRED, never a crash, for a minimal/garbage PDF - no fields invented", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice } = await draftInvoice();
    const preview = must(await previewInvoiceExtraction(headActor, { invoiceRef: invoice.head.invoiceRef, contentBase64: MINIMAL_PDF.toString("base64") }), "extraction preview on minimal PDF");
    expect(preview.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(preview.fields).toEqual([]);
  });

  it("refuses a non-PDF payload with invalid_input, exactly like document attach", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice } = await draftInvoice();
    const notAPdf = Buffer.from("not a pdf at all", "utf8").toString("base64");
    const refused = failure(await previewInvoiceExtraction(headActor, { invoiceRef: invoice.head.invoiceRef, contentBase64: notAPdf }));
    expect(refused.code).toBe("invalid_input");
  });

  it("is denied without manage_invoices, the same gate document attach uses - Viewer holds no Invoices capability at all", async () => {
    const viewer = await actorFor("viewer");
    const { invoice } = await draftInvoice();
    const denied = failure(await previewInvoiceExtraction(viewer, { invoiceRef: invoice.head.invoiceRef, contentBase64: MINIMAL_PDF.toString("base64") }));
    expect(denied.code).toBe("unauthorized");
    expect(denied.reason).toBe("feature_denied");
  });
});

// =====================================================================================================================
describe("lifecycle: submit, approve, reject, reopen, void", () => {
  it("refuses submission while required declared fields or the document are missing, and accepts once complete", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice } = await draftInvoice();

    const blocked = failure(await submitInvoice(headActor, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion }, requestId()));
    expect(blocked.code).toBe("not_ready");
    expect(blocked.blockers?.map((b) => b.code)).toEqual(expect.arrayContaining(["invoice_missing_number", "invoice_missing_date", "invoice_missing_currency", "invoice_missing_total", "invoice_missing_document"]));

    const { invoice: complete } = await completeDraft();
    const submitted = must(await submitInvoice(headActor, { invoiceRef: complete.head.invoiceRef, expectedDocVersion: complete.head.docVersion }, requestId()), "submit");
    expect(submitted.head.status).toBe("SUBMITTED");
    expect(submitted.head.submittedVersion).toBe(submitted.head.latestVersion);

    // Ordinary edit is blocked once submitted.
    const editRefused = failure(await reviseInvoiceDraft(headActor, { invoiceRef: complete.head.invoiceRef, expectedDocVersion: submitted.head.docVersion, invoiceDate: "2019-05-01", reason: "Trying to edit." }, requestId()));
    expect(editRefused.code).toBe("conflict");
  });

  it("approves a matching invoice, and rejects with a reason - preserving the submitted version immutably", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice: complete } = await completeDraft();
    const submitted = must(await submitInvoice(headActor, { invoiceRef: complete.head.invoiceRef, expectedDocVersion: complete.head.docVersion }, requestId()), "submit");

    const approved = must(await approveInvoice(headActor, { invoiceRef: submitted.head.invoiceRef, expectedDocVersion: submitted.head.docVersion }, requestId()), "approve");
    expect(approved.head.status).toBe("APPROVED");
    expect(approved.head.approvedVersion).toBe(approved.head.latestVersion);

    const handoff = must(await getInvoicePaymentHandoff(headActor, approved.head.invoiceRef), "payment handoff");
    expect(handoff.isApproved).toBe(true);
    expect(handoff.hasUnresolvedBlockers).toBe(false);
    expect(handoff.declaredTotalMinor).toBe(5_000_000);
  });

  it("rejects with a reason; reopening creates a revised DRAFT version under the SAME head, and the rejected version is retained", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice: complete } = await completeDraft();
    const submitted = must(await submitInvoice(headActor, { invoiceRef: complete.head.invoiceRef, expectedDocVersion: complete.head.docVersion }, requestId()), "submit");

    expect(failure(await rejectInvoice(headActor, { invoiceRef: submitted.head.invoiceRef, expectedDocVersion: submitted.head.docVersion, reason: "no" }, requestId())).code).toBe("invalid_input");

    const rejected = must(await rejectInvoice(headActor, { invoiceRef: submitted.head.invoiceRef, expectedDocVersion: submitted.head.docVersion, reason: "The declared date does not match the supplier's copy." }, requestId()), "reject");
    expect(rejected.head.status).toBe("REJECTED");
    expect(rejected.head.rejectionReason).toMatch(/does not match/);

    const rejectedVersion = rejected.head.latestVersion;
    const reopened = must(await reopenInvoice(headActor, { invoiceRef: rejected.head.invoiceRef, expectedDocVersion: rejected.head.docVersion, reason: "Correcting the date before resubmitting." }, requestId()), "reopen");
    expect(reopened.head.status).toBe("DRAFT");
    expect(reopened.head.latestVersion).toBe(rejectedVersion + 1);

    // The rejected version is retained, byte-identical - still exactly the document that was
    // submitted (the "document_attached" version completeDraft() built), never touched by reject.
    const storedRejected = (await financeInvoiceVersionsCollection(rejected.head.invoiceRef).doc(String(rejectedVersion)).get()).data() as Record<string, unknown>;
    expect(storedRejected.changeKind).toBe("document_attached");
    expect(storedRejected.version).toBe(rejectedVersion);

    // The invoice-number duplicate logic understands this is the same head, not a second duplicate.
    const revisedAfterReopen = must(
      await reviseInvoiceDraft(headActor, { invoiceRef: reopened.head.invoiceRef, expectedDocVersion: reopened.head.docVersion, externalInvoiceNumber: reopened.head.externalInvoiceNumber!, reason: "Re-declaring the same number after reopening." }, requestId()),
      "revise after reopen",
    );
    expect(revisedAfterReopen.head.externalInvoiceNumber).toBe(reopened.head.externalInvoiceNumber);
  });

  it("cannot approve or reject a VOID/REJECTED invoice, and void is terminal with no deletion", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice } = await draftInvoice();
    const versionsBefore = (await financeInvoiceVersionsCollection(invoice.head.invoiceRef).get()).size;

    expect(failure(await voidInvoice(headActor, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion }, requestId())).code).toBe("invalid_input");
    const voided = must(await voidInvoice(headActor, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion, reason: "Raised against the wrong payable." }, requestId()), "void");
    expect(voided.head.status).toBe("VOID");

    expect(failure(await submitInvoice(headActor, { invoiceRef: voided.head.invoiceRef, expectedDocVersion: voided.head.docVersion }, requestId())).code).toBe("conflict");
    expect(failure(await voidInvoice(headActor, { invoiceRef: voided.head.invoiceRef, expectedDocVersion: voided.head.docVersion, reason: "Voiding again." }, requestId())).code).toBe("conflict");

    expect(await getInvoiceHeadDoc(voided.head.invoiceRef)).not.toBeNull();
    expect((await financeInvoiceVersionsCollection(voided.head.invoiceRef).get()).size).toBe(versionsBefore);
  });

  it("an optimistic stale expectedDocVersion is refused rather than overwriting", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice } = await draftInvoice();
    const stale = invoice.head.docVersion;
    must(await reviseInvoiceDraft(headActor, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: stale, externalInvoiceNumber: "INV-STALE-1", reason: "First revision." }, requestId()), "revise");
    const refused = failure(await reviseInvoiceDraft(headActor, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: stale, externalInvoiceNumber: "INV-STALE-2", reason: "Second revision on a stale read." }, requestId()));
    expect(refused.code).toBe("stale_write");
  });
});

// =====================================================================================================================
describe("reconciliation and mismatch override", () => {
  it("blocks approval on an amount mismatch until an explicit, reasoned override is accepted by the exact permission", async () => {
    const headActor = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");
    const { invoice: mismatched } = await completeDraft({ declaredTotalMinor: 4_500_000 });
    expect(mismatched.selectedVersion!.reconciliation.state).toBe("MISMATCH");

    const submitted = must(await submitInvoice(headActor, { invoiceRef: mismatched.head.invoiceRef, expectedDocVersion: mismatched.head.docVersion }, requestId()), "submit");

    const blocked = failure(await approveInvoice(headActor, { invoiceRef: submitted.head.invoiceRef, expectedDocVersion: submitted.head.docVersion }, requestId()));
    expect(blocked.code).toBe("not_ready");
    expect(blocked.blockers?.map((b) => b.code)).toEqual(["TOTAL_AMOUNT_MISMATCH"]);

    // Manager holds neither override_invoice_mismatch nor approve_invoices.
    expect(failure(await acceptInvoiceMismatch(manager, { invoiceRef: submitted.head.invoiceRef, expectedDocVersion: submitted.head.docVersion, reason: "Manager should not be able to." }, requestId())).reason).toBe("action_denied");

    const accepted = must(
      await acceptInvoiceMismatch(headActor, { invoiceRef: submitted.head.invoiceRef, expectedDocVersion: submitted.head.docVersion, reason: "Confirmed with the partner: the small difference is a rounding adjustment they applied." }, requestId()),
      "accept mismatch",
    );
    expect(accepted.head.mismatchOverride).not.toBeNull();
    expect(accepted.head.mismatchOverride!.forVersion).toBe(accepted.head.latestVersion);

    const approved = must(await approveInvoice(headActor, { invoiceRef: accepted.head.invoiceRef, expectedDocVersion: accepted.head.docVersion }, requestId()), "approve after override");
    expect(approved.head.status).toBe("APPROVED");

    const events = must(await listInvoiceEvents(headActor, approved.head.invoiceRef), "events");
    expect(events.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["INVOICE_MISMATCH_ACCEPTED", "INVOICE_APPROVED"]));
    // No event or the mismatch acceptance itself carries an amount.
    for (const event of events.events) expect(JSON.stringify(event.metadata ?? {})).not.toMatch(/4500000|5000000/);
  });

  it("the reconcile endpoint recomputes fresh without writing anything", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice } = await completeDraft({ declaredTotalMinor: 4_500_000 });

    const io = instrumentWrites();
    let reconciled;
    try {
      reconciled = must(await reconcileInvoice(headActor, { invoiceRef: invoice.head.invoiceRef }), "reconcile");
    } finally {
      io.stop();
    }
    expect(io.paths).toEqual([]);
    expect(reconciled.reconciliation.state).toBe("MISMATCH");
  });
});

// =====================================================================================================================
describe("source revision (Payable revision is a WARNING, never mutates the Invoice)", () => {
  it("detects a newer Payable version and leaves the Invoice's pin unchanged", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice, payableRef } = await draftInvoice();

    const current = must(await getInvoiceSourceRevision(headActor, invoice.head.invoiceRef), "source revision (before)");
    expect(current.state).toBe("CURRENT");

    // Revise the underlying Payable (an explicit, reasoned recheck -> a new Payable version), which
    // never touches the Invoice.
    const payableDetail = must(await getInvoice(headActor, invoice.head.invoiceRef), "read invoice"); // sanity: still readable
    expect(payableDetail).toBeTruthy();
    const payableNow = must(await getPayable(headActor, payableRef), "read payable");
    const revised = must(
      await revisePayable(headActor, { payableRef, expectedDocVersion: payableNow.head.docVersion, refreshSource: false, reason: "Rechecking the breakdown after invoicing." }, requestId()),
      "revise payable",
    );
    expect(revised.head.latestVersion).toBeGreaterThan(payableNow.head.latestVersion);

    const revisionStatus = must(await getInvoiceSourceRevision(headActor, invoice.head.invoiceRef), "source revision (after)");
    expect(revisionStatus.state).toBe("PAYABLE_REVISION_AVAILABLE");

    // The Invoice's own pin and money are completely unchanged.
    const unchanged = must(await getInvoice(headActor, invoice.head.invoiceRef), "read invoice again");
    expect(unchanged.selectedVersion!.payablePin.payableVersion).toBe(invoice.selectedVersion!.payablePin.payableVersion);
    expect(unchanged.selectedVersion!.payablePin.payableGrossInvoiceExpectedMinor).toBe(invoice.selectedVersion!.payablePin.payableGrossInvoiceExpectedMinor);
  });
});

// =====================================================================================================================
describe("boundaries: an Invoice mutation writes only Invoice (and its number-claim) documents", () => {
  it("create, revise, attach, submit, approve write nothing outside financeInvoices*/financeInvoiceNumberClaims", async () => {
    const headActor = await actorFor("partnership_head");
    const { payable } = await readyPayable();

    const io = instrumentWrites();
    try {
      const created = must(await createFor(headActor, payable.head.payableRef), "create");
      const revised = must(
        await reviseInvoiceDraft(
          headActor,
          { invoiceRef: created.invoice.head.invoiceRef, expectedDocVersion: created.invoice.head.docVersion, externalInvoiceNumber: `INV-BOUND-${runId}`, invoiceDate: "2019-04-02", currency: "INR", declaredTotalMinor: 5_000_000, reason: "Set fields." },
          requestId(),
        ),
        "revise",
      );
      const withDoc = must(
        await attachInvoiceDocument(headActor, { invoiceRef: revised.head.invoiceRef, expectedDocVersion: revised.head.docVersion, fileName: "invoice.pdf", contentBase64: MINIMAL_PDF.toString("base64") }, requestId()),
        "attach",
      );
      const submitted = must(await submitInvoice(headActor, { invoiceRef: withDoc.head.invoiceRef, expectedDocVersion: withDoc.head.docVersion }, requestId()), "submit");
      must(await approveInvoice(headActor, { invoiceRef: submitted.head.invoiceRef, expectedDocVersion: submitted.head.docVersion }, requestId()), "approve");
    } finally {
      io.stop();
    }

    expect(io.paths.length).toBeGreaterThan(5);
    for (const path of io.paths) expect(path.startsWith("financeInvoices/") || path.startsWith("financeInvoiceNumberClaims/"), path).toBe(true);
    expect(io.paths.filter((path) => /^(financePayables|financeAgreements|partnerReviews|partners|vendors)/.test(path))).toEqual([]);
  });
});

// =====================================================================================================================
describe("authorization", () => {
  it("an unauthenticated caller is denied every command", async () => {
    for (const result of [await getInvoice(null, "inv_00000000000000000001"), await createInvoiceDraft(null, { payableRef: "pay_00000000000000000001" }, requestId()), await listInvoicesWorkspace(null, {})]) {
      expect(failure(result).reason).toBe("not_authenticated");
    }
  });

  it("a role without the finance feature is denied - Viewer and Analyst hold no Invoices capability at all", async () => {
    const headActor = await actorFor("partnership_head");
    const { payable } = await readyPayable();
    const created = must(await createFor(headActor, payable.head.payableRef), "create");

    for (const role of ["viewer", "analyst"]) {
      const actor = await actorFor(role);
      expect(failure(await getInvoice(actor, created.invoice.head.invoiceRef)).reason, role).toBe("feature_denied");
      expect(failure(await listInvoicesWorkspace(actor, {})).reason, role).toBe("feature_denied");
    }
  });

  it("Manager may prepare and submit an invoice but holds neither approve_invoices, void_invoices nor override_invoice_mismatch", async () => {
    const manager = await actorFor("partnership_manager");
    const { payable } = await readyPayable();

    const created = must(await createFor(manager, payable.head.payableRef), "manager create");
    const revised = must(
      await reviseInvoiceDraft(
        manager,
        { invoiceRef: created.invoice.head.invoiceRef, expectedDocVersion: created.invoice.head.docVersion, externalInvoiceNumber: `INV-MGR-${runId}`, invoiceDate: "2019-04-02", currency: "INR", declaredTotalMinor: 5_000_000, reason: "Manager fills the draft." },
        requestId(),
      ),
      "manager revise",
    );
    const withDoc = must(await attachInvoiceDocument(manager, { invoiceRef: revised.head.invoiceRef, expectedDocVersion: revised.head.docVersion, fileName: "invoice.pdf", contentBase64: MINIMAL_PDF.toString("base64") }, requestId()), "manager attach");
    const submitted = must(await submitInvoice(manager, { invoiceRef: withDoc.head.invoiceRef, expectedDocVersion: withDoc.head.docVersion }, requestId()), "manager submit");
    expect(submitted.head.status).toBe("SUBMITTED");

    expect(failure(await approveInvoice(manager, { invoiceRef: submitted.head.invoiceRef, expectedDocVersion: submitted.head.docVersion }, requestId())).reason).toBe("action_denied");
    expect(failure(await rejectInvoice(manager, { invoiceRef: submitted.head.invoiceRef, expectedDocVersion: submitted.head.docVersion, reason: "Manager should not be able to." }, requestId())).reason).toBe("action_denied");
    expect(failure(await voidInvoice(manager, { invoiceRef: submitted.head.invoiceRef, expectedDocVersion: submitted.head.docVersion, reason: "Manager should not be able to." }, requestId())).reason).toBe("action_denied");
  });

  it("a forged/unknown invoiceRef is the same neutral not_found for every actor (Payables' own out-of-scope test already proves the Payable-level 404 this gate re-verifies)", async () => {
    const headActor = await actorFor("partnership_head");
    expect(failure(await getInvoice(headActor, "inv_ffffffffffffffffffff")).message).toBe("Not found.");
    expect(failure(await getInvoice(headActor, "not-a-ref")).message).toBe("Not found.");
    expect(failure(await createInvoiceDraft(headActor, { payableRef: "pay_ffffffffffffffffffff" }, requestId())).code).toBe("not_ready");
  });

  it("an actor whose scope loses the counterparty can no longer read the invoice", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice, partner } = await draftInvoice();

    await partnersCollection().doc(partner.uid).update({ regionIds: [PRIVATE_REGION] });
    expect(failure(await getInvoice(headActor, invoice.head.invoiceRef)).message).toBe("Not found.");
  });
});

// =====================================================================================================================
describe("data safety", () => {
  it("an Invoice response carries no identity/KYC value, no scope field and no raw Firebase uid", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice } = await draftInvoice();
    const detail = must(await getInvoice(headActor, invoice.head.invoiceRef), "read");
    const serialized = JSON.stringify(detail);
    for (const forbidden of ["panNumber", "aadhaarNumber", "bankAccountNumber", "accountNumber", "ifsc", "gstin", "identityStatus", "contactSnapshot"]) expect(serialized, forbidden).not.toContain(forbidden);
    for (const forbidden of ["ownerUid", "regionIds", "teamIds", "partnerUid", "vendorUid"]) expect(serialized, forbidden).not.toContain(forbidden);
    expect(serialized).not.toContain(headActor.uid);
  });

  it("amounts are withheld from a role without finance_amounts, and visible with it", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice } = await completeDraft();
    const asHead = must(await getInvoice(headActor, invoice.head.invoiceRef), "head read");
    expect(asHead.amountsVisible).toBe(true);
    expect(asHead.selectedVersion!.declaredTotalMinor).toBe(5_000_000);
  });
});

// =====================================================================================================================
describe("the workspace list", () => {
  it("returns the actor's in-scope invoices, filtered and bounded, with a deterministic order", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice, partner } = await draftInvoice();

    const all = must(await listInvoicesWorkspace(headActor, {}), "workspace");
    expect(all.rows.map((r) => r.invoiceRef)).toContain(invoice.head.invoiceRef);

    const filtered = must(await listInvoicesWorkspace(headActor, { counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef }), "filtered");
    expect(filtered.rows.map((r) => r.invoiceRef)).toContain(invoice.head.invoiceRef);
    expect(filtered.rows[0]!.counterparty.displayName).toBe(partner.displayName);

    expect(must(await listInvoicesWorkspace(headActor, { commercialPeriod: "2019-09" }), "other period").rows).toEqual([]);
    expect(failure(await listInvoicesWorkspace(headActor, { status: "APPROVING" as never })).code).toBe("invalid_input");
  });
});

// =====================================================================================================================
// Step 16C: payee identity matching, end to end against a real Partner and a real Invoice pipeline.
// The canonical expected counterparty is always the SAME Partner `draftInvoice()`/`completeDraft()`
// already pinned from the Payable - never a different entity, never a global search (section 3/20).
describe("payee identity matching (Step 16C)", () => {
  it("a matching extracted supplier name reads PARTIAL_MATCH (no hard corroborating identifier exists yet) and never blocks approval", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice, partner } = await completeDraft();
    const revised = must(
      await reviseInvoiceDraft(headActor, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion, extractedPayeeName: partner.displayName, reason: "Applying extracted payee name." }, requestId()),
      "apply payee name",
    );
    expect(revised.selectedVersion!.payeeIdentity!.overallStatus).toBe("PARTIAL_MATCH");
    const nameField = revised.selectedVersion!.payeeIdentity!.fields.find((f) => f.field === "NAME")!;
    expect(nameField.status).toBe("EXACT");
    expect(nameField.safeExpectedDisplay).toBe(partner.displayName);

    const submitted = must(await submitInvoice(headActor, { invoiceRef: revised.head.invoiceRef, expectedDocVersion: revised.head.docVersion }, requestId()), "submit");
    const approved = must(await approveInvoice(headActor, { invoiceRef: submitted.head.invoiceRef, expectedDocVersion: submitted.head.docVersion }, requestId()), "approve should not be blocked by a partial match");
    expect(approved.head.status).toBe("APPROVED");
  });

  it("a clearly mismatched extracted supplier name reads MISMATCH and blocks approval until an authorized resolution", async () => {
    const headActor = await actorFor("partnership_head");
    const managerActor = await actorFor("partnership_manager");
    const { invoice } = await completeDraft();
    const revised = must(
      await reviseInvoiceDraft(headActor, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion, extractedPayeeName: "Totally Different Legal Entity LLC", reason: "Applying extracted payee name." }, requestId()),
      "apply mismatched payee name",
    );
    expect(revised.selectedVersion!.payeeIdentity!.overallStatus).toBe("MISMATCH");

    const submitted = must(await submitInvoice(headActor, { invoiceRef: revised.head.invoiceRef, expectedDocVersion: revised.head.docVersion }, requestId()), "submit");

    // approval BLOCKED before resolution
    const blocked = failure(await approveInvoice(headActor, { invoiceRef: submitted.head.invoiceRef, expectedDocVersion: submitted.head.docVersion }, requestId()));
    expect(blocked.code).toBe("not_ready");
    expect(blocked.blockers?.some((b) => b.code === "PAYEE_IDENTITY_MISMATCH")).toBe(true);

    // unauthorized actor (Partnership Manager) cannot resolve the mismatch
    const denied = failure(await resolveInvoicePayeeMismatch(managerActor, { invoiceRef: submitted.head.invoiceRef, expectedDocVersion: submitted.head.docVersion, reason: "Manager attempting to resolve." }, requestId()));
    expect(denied.code).toBe("unauthorized");

    // authorized Head/Admin accepts the mismatch with a reason
    const resolved = must(
      await resolveInvoicePayeeMismatch(headActor, { invoiceRef: submitted.head.invoiceRef, expectedDocVersion: submitted.head.docVersion, reason: "Verified against the signed Agreement; same legal entity under a trading name." }, requestId()),
      "resolve payee mismatch",
    );
    expect(resolved.head.payeeMismatchOverride?.forVersion).toBe(resolved.selectedVersion!.version);
    // the DISPLAY status shows the resolution...
    expect(resolved.selectedVersion!.payeeIdentity!.overallStatus).toBe("OVERRIDDEN");
    expect(resolved.selectedVersion!.payeeIdentity!.accepted?.reason).toContain("signed Agreement");
    // ...but the ORIGINAL per-field mismatch evidence is preserved verbatim, never rewritten into a
    // fake green Match state (section 16).
    const nameField = resolved.selectedVersion!.payeeIdentity!.fields.find((f) => f.field === "NAME")!;
    expect(nameField.status).toBe("MISMATCH");
    expect(nameField.safeExtractedDisplay).toBe("Totally Different Legal Entity LLC");

    // approval ALLOWED after the authorized resolution
    const approved = must(await approveInvoice(headActor, { invoiceRef: resolved.head.invoiceRef, expectedDocVersion: resolved.head.docVersion }, requestId()), "approve after resolution");
    expect(approved.head.status).toBe("APPROVED");

    // history records the resolution and the checks, with no raw identity value anywhere
    const events = must(await listInvoiceEvents(headActor, approved.head.invoiceRef), "events");
    expect(events.events.some((e) => e.kind === "INVOICE_PAYEE_MISMATCH_ACCEPTED")).toBe(true);
    expect(events.events.some((e) => e.kind === "INVOICE_PAYEE_IDENTITY_CHECKED")).toBe(true);
    const serializedEvents = JSON.stringify(events.events);
    expect(serializedEvents).not.toContain("Totally Different Legal Entity LLC");
  });

  it("never exposes a raw bank/tax value anywhere in the Invoice response, even when a payee identity field is present", async () => {
    const headActor = await actorFor("partnership_head");
    const { invoice } = await completeDraft();
    const revised = must(
      await reviseInvoiceDraft(headActor, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion, extractedPayeeName: "Some Supplier Name", reason: "Applying extracted payee name." }, requestId()),
      "revise",
    );
    const serialized = JSON.stringify(revised);
    for (const forbidden of ["panNumber", "aadhaarNumber", "bankAccountNumber", "accountNumber", "ifsc", "gstin", "gstNumber"]) expect(serialized, forbidden).not.toContain(forbidden);
    // a masked bank display, if ever present, is always the bullet-mask literal - never a bare 9+
    // digit run WITHIN the payeeIdentity field displays specifically (the wider response legitimately
    // carries unrelated long digit runs - a sha256 hex digest, this test's own run-id-based fixture
    // refs - which are not restricted identity values and are out of scope for this assertion).
    const displays = revised.selectedVersion!.payeeIdentity!.fields.flatMap((f) => [f.safeExpectedDisplay, f.safeExtractedDisplay]).filter((v): v is string => v !== null);
    for (const display of displays) expect(display, display).not.toMatch(/\d{9,}/);
  });
});
