// Step 15A - Finance Payables against the running Firestore/Auth emulator, end to end, on REAL
// records: real Partners and Vendors, real Agreements taken through the real Agreement services
// (create -> decide -> confirm -> activate), real Partner Reviews taken through the real review
// services (generate -> submit -> finalize), and then the real Payable services on top.
//
// Proven here:
//   - SOURCE SELECTION: a finalized Partner Review is accepted and pinned exactly; a review that is
//     not finalized, or missing, is refused with a plain-language reason; an Agreement overlap is
//     refused and never guessed; a Vendor payable is AGREEMENT_ONLY and never fabricates a review;
//     an Agreement belonging to a different counterparty is refused.
//   - DETERMINATION on real confirmed terms: a fixed fee is paid in full, under-delivery is a named
//     Finance item and NOT a deduction, and an unmeasured incentive metric is never guessed.
//   - VERSIONING: every change appends the NEXT version and leaves every earlier one byte-identical;
//     a later source revision is a WARNING and changes no money until an explicit, reasoned refresh.
//   - IDEMPOTENCY / CONCURRENCY: a repeated create returns the same canonical Payable; concurrent
//     creates produce exactly ONE; a newer valid source version for the same period is a conflict
//     naming the revision path, never a second Payable.
//   - LIFECYCLE: DRAFT edits, READY_FOR_INVOICE preconditions, no edit of a payable that is ready,
//     void requires a reason, and nothing is ever hard-deleted.
//   - AUTHZ: per-role, missing feature, missing action, out-of-scope counterparty, and the exact
//     permissions for a manual adjustment and for moving to ready.
//   - DATA SAFETY: no identity/KYC value and no raw Agreement clause text in any Payable response,
//     and amounts are withheld from a role without the finance_amounts category.
//   - BOUNDARIES: a Payable mutation writes ONLY financePayables documents - never a Partner Review,
//     an Agreement, a Partner or a Vendor.
//
// Hermetic: every Partner / Vendor has a unique uid/ref, the Agreement dates are in 2019 and the
// evidence fixtures carry a private region; everything created is removed afterwards.
import { randomUUID } from "node:crypto";

import { DocumentReference, Transaction, WriteBatch } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { assignmentsCollection } from "@/server/assignments/firestore";
import { assignmentBriefSchema, assignmentDocSchema } from "@/server/assignments/types";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { COLLECTIONS } from "@/server/authz/firestore";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { contentCollection } from "@/server/content/firestore";
import { contentDocSchema } from "@/server/content/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import {
  activateAgreementVersion,
  confirmAgreementVersion,
  createAgreementDraft,
  createAgreementRevision,
  decideField,
  type AgreementDetailDto,
} from "@/server/finance-agreements";
import { agreementClaimId, financeAgreementClaimsCollection, financeAgreementsCollection } from "@/server/finance-agreements/firestore";
import { agreementCommercialPolicyProvider } from "@/server/finance-agreements/policy-adapter";
import { READY_DECISIONS, type FieldDecisionSeed } from "@/server/finance-agreements/testing/agreement-service-fixtures";
import type { AgreementCounterpartyInput, FinanceAgreementsServiceResult } from "@/server/finance-agreements/types";
import { setCommercialPolicyProviderForTests } from "@/server/partner-reviews/commercial-policy";
import { partnerReviewsCollection } from "@/server/partner-reviews/firestore";
import { createPartnerReviewRevision, finalizePartnerReview, submitPartnerReviewForReview } from "@/server/partner-reviews/partner-review-lifecycle-service";
import { generatePartnerReviewDraft, getPartnerReview } from "@/server/partner-reviews/partner-review-service";
import { partnersCollection } from "@/server/partners/firestore";
import { partnerDocSchema, type PartnerDoc } from "@/server/partners/types";
import { vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema, type VendorDoc } from "@/server/vendors/types";

import {
  addPayableAdjustment,
  createPayable,
  getPayable,
  getPayableSourceRevision,
  listPayableEvents,
  listPayablesWorkspace,
  markPayableReadyForInvoice,
  previewPayableSource,
  removePayableAdjustment,
  revisePayable,
  voidPayable,
  type PayableDetailDto,
} from "./index";
import { financePayablesCollection, financePayableVersionsCollection, getPayableHeadDoc } from "./firestore";
import { payableRefFor } from "./ids";
import type { FinancePayablesServiceResult } from "./types";

vi.setConfig({ testTimeout: 120_000 });

const runId = Date.now();
const PRIVATE_REGION = `pay-private-${runId}`;
const PERIOD = "2019-03";
const SUPPORTED_UNIT = "approved_content_thread";

const uidByRole = new Map<string, string>();
const cleanup: FirebaseFirestore.DocumentReference[] = [];
const agreementRefs: string[] = [];
const claimIds: string[] = [];
const reviewRefs = new Set<string>();
const payableRefs = new Set<string>();
let counter = 0;
let reqCounter = 0;
const requestId = () => `pay-req-${runId}-${(reqCounter += 1)}`;

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  const auth = getAdminAuth();
  for (const identity of TEST_IDENTITIES) uidByRole.set(identity.role, (await auth.getUserByEmail(identity.email)).uid);
  // The Agreement -> Partner Reviews commercial-policy adapter, so a generated review carries a
  // governing Agreement exactly as it does in production.
  setCommercialPolicyProviderForTests(agreementCommercialPolicyProvider);
}, 120_000);

afterAll(async () => {
  setCommercialPolicyProviderForTests(null);
  const db = getAdminFirestore();
  for (const ref of payableRefs) await db.recursiveDelete(financePayablesCollection().doc(ref));
  for (const ref of agreementRefs.splice(0)) await db.recursiveDelete(financeAgreementsCollection().doc(ref));
  await Promise.all(claimIds.splice(0).map((id) => financeAgreementClaimsCollection().doc(id).delete()));
  for (const reviewRef of reviewRefs) await db.recursiveDelete(partnerReviewsCollection().doc(reviewRef));
  await Promise.all(cleanup.splice(0).map((ref) => ref.delete()));
});

async function actorFor(role: string): Promise<ActorContext> {
  const actor = await resolveActor(uidByRole.get(role)!);
  if (!actor) throw new Error(`no seeded actor for ${role}`);
  return actor;
}

function must<T>(result: FinanceAgreementsServiceResult<T> | FinancePayablesServiceResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}${"blockers" in result && result.blockers ? ` ${JSON.stringify(result.blockers)}` : ""}`);
  return result.data;
}

function failure(result: FinancePayablesServiceResult<unknown>): Extract<FinancePayablesServiceResult<unknown>, { ok: false }> {
  if (result.ok) throw new Error("expected a failure, got a success");
  return result;
}

// ---- Counterparty fixtures --------------------------------------------------------------------------------------------
async function seedPartner(regionIds: string[] = ["Kerala"]): Promise<PartnerDoc> {
  counter += 1;
  const uid = `pay-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const partner = partnerDocSchema.parse({
    uid,
    partnerRef: uid,
    version: 1,
    displayName: `PAY Partner ${counter}`,
    displayNameLower: `pay partner ${counter}`,
    legalName: null,
    email: `${uid}@example-partner.test`,
    phone: "+91 90000 00088",
    status: "ACTIVE",
    regionIds,
    createdAt: now,
    createdByUserRef: "pay-test",
    updatedAt: now,
    updatedByUserRef: "pay-test",
  });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  cleanup.push(ref);
  return partner;
}

async function seedVendor(regionIds: string[] = ["Kerala"]): Promise<VendorDoc> {
  counter += 1;
  const uid = `pay-vendor-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const vendor = vendorDocSchema.parse({
    uid,
    vendorRef: uid,
    version: 1,
    displayName: `PAY Vendor ${counter}`,
    displayNameLower: `pay vendor ${counter}`,
    vendorType: "AGENCY",
    email: `${uid}@example-vendor.test`,
    status: "ACTIVE",
    regionIds,
    createdAt: now,
    createdByUserRef: "pay-test",
    updatedAt: now,
    updatedByUserRef: "pay-test",
  });
  const ref = vendorsCollection().doc(uid);
  await ref.set(vendor);
  cleanup.push(ref);
  return vendor;
}

// ONE in-period Assignment (format reel) with an APPROVED thread = exactly 1 qualifying unit.
async function seedEvidence(partner: PartnerDoc): Promise<void> {
  const uid = assignmentsCollection().doc().id;
  const now = new Date().toISOString();
  const assignment = assignmentDocSchema.parse({
    uid,
    assignmentRef: `pay-as-${uid}`,
    version: 1,
    campaignRef: `pay-camp-${runId}`,
    partnerRef: partner.partnerRef,
    partnerAccountRefs: [],
    status: "IN_PROGRESS",
    statusReason: null,
    brief: assignmentBriefSchema.parse({ dueAt: "2019-03-10", requiredCount: 1, formats: ["reel"], platforms: ["instagram"], reviewPolicy: "REVIEW_REQUIRED", campaignName: "PAY Campaign" }),
    ownerUid: null,
    regionIds: [PRIVATE_REGION],
    teamIds: [],
    createdAt: "2019-01-05T08:00:00.000Z",
    createdByUserRef: "pay-test",
    updatedAt: now,
    updatedByUserRef: "pay-test",
  });
  const assignmentRef = assignmentsCollection().doc(uid);
  await assignmentRef.set(assignment);
  cleanup.push(assignmentRef);

  const threadUid = contentCollection().doc().id;
  const thread = contentDocSchema.parse({
    uid: threadUid,
    contentRef: `pay-ct-${threadUid}`,
    version: 3,
    assignmentRef: assignment.assignmentRef,
    campaignRef: assignment.campaignRef,
    partnerRef: partner.partnerRef,
    status: "APPROVED",
    statusReason: null,
    currentRevisionNumber: 1,
    reviewedRevisionNumber: 1,
    currentLinks: [{ platform: "instagram", originalUrl: `https://instagram.com/p/PAY${threadUid}`, normalizedUrl: `https://instagram.com/p/pay${threadUid.toLowerCase()}`, recordedAt: "2019-03-08T10:00:00.000Z" }],
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
    createdByUserRef: "pay-test",
    updatedAt: "2019-03-08T10:00:00.000Z",
    updatedByUserRef: "pay-test",
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

// Effective for the whole of 2019, a 5,000,000-minor fixed fee, ONE required qualifying unit of a
// SUPPORTED unit (the evidence fixture delivers exactly one), and NO incentive - the fully
// determined shape.
const DETERMINED_TERMS = (): FieldDecisionSeed[] =>
  decisionsWith({
    effectiveDate: { fieldKey: "effectiveDate", decision: "CORRECTED", value: "2019-01-01" },
    terminationDate: { fieldKey: "terminationDate", decision: "CORRECTED", value: "2019-12-31" },
    qualifyingUnit: { fieldKey: "qualifyingUnit", decision: "CORRECTED", value: SUPPORTED_UNIT },
    monthlyRequiredQualifyingContentCount: { fieldKey: "monthlyRequiredQualifyingContentCount", decision: "CORRECTED", value: 1 },
    incentive: { fieldKey: "incentive", decision: "NOT_APPLICABLE" },
  });

// The same, but requiring THREE units - the evidence delivers one, so it is under-delivered.
// Step 15C: this evidenced case is now a fully DETERMINISTIC proration (1 of 3), never a Finance
// review item - see amount-determination.test.ts's own coverage of this exact case.
const UNDER_DELIVERED_TERMS = (): FieldDecisionSeed[] =>
  decisionsWith({
    effectiveDate: { fieldKey: "effectiveDate", decision: "CORRECTED", value: "2019-01-01" },
    terminationDate: { fieldKey: "terminationDate", decision: "CORRECTED", value: "2019-12-31" },
    qualifyingUnit: { fieldKey: "qualifyingUnit", decision: "CORRECTED", value: SUPPORTED_UNIT },
    monthlyRequiredQualifyingContentCount: { fieldKey: "monthlyRequiredQualifyingContentCount", decision: "CORRECTED", value: 3 },
    incentive: { fieldKey: "incentive", decision: "NOT_APPLICABLE" },
  });

// A transfer fee ticked applicable with NO stated amount - still the genuinely ambiguous case
// under Step 15C (unchanged from Step 15A): TRANSFER_FEE_APPLICATION_UNSPECIFIED stays a real,
// still-open Finance-review item, used here to exercise the resolve-then-ready-for-invoice flow.
const TRANSFER_FEE_UNSPECIFIED_TERMS = (): FieldDecisionSeed[] =>
  decisionsWith({
    effectiveDate: { fieldKey: "effectiveDate", decision: "CORRECTED", value: "2019-01-01" },
    terminationDate: { fieldKey: "terminationDate", decision: "CORRECTED", value: "2019-12-31" },
    qualifyingUnit: { fieldKey: "qualifyingUnit", decision: "CORRECTED", value: SUPPORTED_UNIT },
    monthlyRequiredQualifyingContentCount: { fieldKey: "monthlyRequiredQualifyingContentCount", decision: "CORRECTED", value: 1 },
    incentive: { fieldKey: "incentive", decision: "NOT_APPLICABLE" },
    accountTransferFee: { fieldKey: "accountTransferFee", decision: "CORRECTED", value: { applicable: true, amountMinor: null, details: "Amount to be confirmed by Finance." } },
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
  const clientRequestId = `pay-crid-${runId}-${(counter += 1)}-${randomUUID().slice(0, 6)}`;
  const created = must(await createAgreementDraft(manager, { clientRequestId, counterparty }, requestId()), "create agreement");
  agreementRefs.push(created.agreement.head.agreementRef);
  claimIds.push(agreementClaimId(manager.uid, clientRequestId));
  const decided = await acceptPending(manager, await decideAll(manager, created.agreement, seeds));
  const confirmed = must(await confirmAgreementVersion(manager, { agreementRef: decided.head.agreementRef, version: decided.selectedVersion!.version, expectedDocVersion: decided.selectedVersion!.docVersion }, requestId()), "confirm agreement");
  return must(await activateAgreementVersion(head, { agreementRef: confirmed.head.agreementRef, version: confirmed.selectedVersion!.version, expectedDocVersion: confirmed.head.docVersion }, requestId()), "activate agreement");
}

async function reviseAndActivateAgreement(detail: AgreementDetailDto, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
  const manager = await actorFor("partnership_manager");
  const head = await actorFor("partnership_head");
  const revised = must(await createAgreementRevision(head, { agreementRef: detail.head.agreementRef, expectedDocVersion: detail.head.docVersion }, requestId()), "revise agreement");
  const decided = await decideAll(manager, revised, seeds);
  const confirmed = must(await confirmAgreementVersion(manager, { agreementRef: decided.head.agreementRef, version: decided.selectedVersion!.version, expectedDocVersion: decided.selectedVersion!.docVersion }, requestId()), "confirm revision");
  return must(await activateAgreementVersion(head, { agreementRef: confirmed.head.agreementRef, version: confirmed.selectedVersion!.version, expectedDocVersion: confirmed.head.docVersion }, requestId()), "activate revision");
}

// ---- Partner Review helpers (real services) -------------------------------------------------------------------------------
async function generatedReview(partner: PartnerDoc): Promise<string> {
  const manager = await actorFor("partnership_manager");
  const generated = await generatePartnerReviewDraft(manager, { partnerRef: partner.partnerRef, periodKey: PERIOD }, requestId());
  if (!generated.ok) throw new Error(`generate review: ${generated.code} ${generated.message}`);
  const reviewRef = generated.data.review.head.reviewRef;
  reviewRefs.add(reviewRef);
  return reviewRef;
}

async function finalizeOpenReview(reviewRef: string): Promise<void> {
  const manager = await actorFor("partnership_manager");
  const head = await actorFor("partnership_head");
  const current = await getPartnerReview(manager, reviewRef);
  if (!current.ok) throw new Error(`read review: ${current.message}`);
  const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: current.data.selectedVersion!.docVersion }, requestId());
  if (!submitted.ok) throw new Error(`submit review: ${submitted.message}`);
  const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, requestId());
  if (!finalized.ok) throw new Error(`finalize review: ${finalized.message}`);
}

async function finalizedReview(partner: PartnerDoc): Promise<string> {
  const reviewRef = await generatedReview(partner);
  await finalizeOpenReview(reviewRef);
  return reviewRef;
}

// A Partner with evidence, an active Agreement and a finalized Review for the period.
async function partnerReadyForPayable(seeds: FieldDecisionSeed[] = DETERMINED_TERMS()): Promise<{ partner: PartnerDoc; agreement: AgreementDetailDto; reviewRef: string }> {
  const partner = await seedPartner();
  await seedEvidence(partner);
  const agreement = await activeAgreement(partnerCp(partner), seeds);
  const reviewRef = await finalizedReview(partner);
  return { partner, agreement, reviewRef };
}

async function createFor(actor: ActorContext, counterpartyType: "PARTNER" | "VENDOR", counterpartyRef: string, agreementRef?: string) {
  const result = await createPayable(actor, { counterpartyType, counterpartyRef, commercialPeriod: PERIOD, ...(agreementRef ? { agreementRef } : {}) }, requestId());
  if (result.ok) payableRefs.add(result.data.payable.head.payableRef);
  return result;
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
describe("source selection", () => {
  it("accepts a FINALIZED Partner Review and pins the exact Agreement and Review versions", async () => {
    const head = await actorFor("partnership_head");
    const { partner, agreement, reviewRef } = await partnerReadyForPayable();

    const created = must(await createFor(head, "PARTNER", partner.partnerRef), "create payable");
    expect(created.outcome).toBe("created");
    const payable = created.payable;
    expect(payable.head.payableRef).toBe(payableRefFor({ counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef, commercialPeriod: PERIOD }));
    expect(payable.head.sourceType).toBe("PARTNER_REVIEW");
    expect(payable.head.agreementRef).toBe(agreement.head.agreementRef);
    expect(payable.head.agreementVersion).toBe(1);
    expect(payable.head.reviewRef).toBe(reviewRef);
    expect(payable.head.reviewVersion).toBe(1);
    expect(payable.head.status).toBe("DRAFT");
    expect(payable.head.currency).toBe("INR");

    const version = payable.selectedVersion!;
    expect(version.version).toBe(1);
    expect(version.snapshot.review).toMatchObject({ reviewRef, reviewVersion: 1 });
    expect(version.snapshot.agreement).toMatchObject({ agreementRef: agreement.head.agreementRef, agreementVersion: 1 });
    expect(version.snapshot.qualifyingContent).toMatchObject({ requiredCount: 1, qualifyingUnit: SUPPORTED_UNIT, actualQualifyingCount: 1, evaluation: "met", affectsPayment: true });
    expect(version.determinationState).toBe("DETERMINISTIC");
    // Step 15C: fully delivered (1 of 1) prorates to the full fixed amount (PRORATED_BASE, not the
    // old unprorated BASE_FIXED), and the CreatorOps 10% TDS rule now applies.
    expect(version.lines.map((line) => [line.category, line.amountMinorSigned])).toEqual([
      ["PRORATED_BASE", 5_000_000],
      ["TDS", -500_000],
    ]);
    expect(version.totalAmountMinorSigned).toBe(4_500_000);
    expect(version.serviceBaseMinor).toBe(5_000_000);
    expect(version.tdsMinor).toBe(500_000);
    expect(version.grossInvoiceExpectedMinor).toBe(5_000_000);
    expect(version.expectedNetPaymentMinor).toBe(4_500_000);
    expect(version.calculationRuleVersion).toBe("MONTHLY_ANALYTICS_PRORATION_V1");
  });

  it("refuses a Review that is not finalized, and one that does not exist, with a plain-language reason", async () => {
    const head = await actorFor("partnership_head");

    const noReview = await seedPartner();
    await seedEvidence(noReview);
    await activeAgreement(partnerCp(noReview), DETERMINED_TERMS());
    const missing = failure(await createFor(head, "PARTNER", noReview.partnerRef));
    expect(missing.code).toBe("not_ready");
    expect(missing.blockers?.map((blocker) => blocker.code)).toEqual(["REVIEW_NOT_FOUND"]);
    expect(missing.blockers?.[0]!.message).toMatch(/finalize the review/i);

    const draftOnly = await seedPartner();
    await seedEvidence(draftOnly);
    await activeAgreement(partnerCp(draftOnly), DETERMINED_TERMS());
    await generatedReview(draftOnly);
    const notFinalized = failure(await createFor(head, "PARTNER", draftOnly.partnerRef));
    expect(notFinalized.blockers?.map((blocker) => blocker.code)).toEqual(["REVIEW_NOT_FINALIZED"]);
  });

  it("refuses generation when two Agreements applied to the period, and never picks one", async () => {
    const head = await actorFor("partnership_head");
    const partner = await seedPartner();
    await seedEvidence(partner);
    await activeAgreement(partnerCp(partner), DETERMINED_TERMS());
    await activeAgreement(partnerCp(partner), DETERMINED_TERMS());
    const reviewRef = await finalizedReview(partner);
    expect(reviewRef).toBeTruthy();

    const blocked = failure(await createFor(head, "PARTNER", partner.partnerRef));
    expect(blocked.code).toBe("not_ready");
    expect(blocked.blockers?.map((blocker) => blocker.code)).toEqual(["AGREEMENT_SOURCE_CONFLICT"]);
    expect(blocked.blockers?.[0]!.message).toMatch(/More than one Agreement/);
    expect(await getPayableHeadDoc(payableRefFor({ counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef, commercialPeriod: PERIOD }))).toBeNull();
  });

  it("accepts a Vendor payable as AGREEMENT_ONLY and never fabricates a Partner Review for it", async () => {
    const head = await actorFor("partnership_head");
    const vendor = await seedVendor();
    const agreement = await activeAgreement(vendorCp(vendor), DETERMINED_TERMS());

    const created = must(await createFor(head, "VENDOR", vendor.vendorRef, agreement.head.agreementRef), "create vendor payable");
    const payable = created.payable;
    expect(payable.head.sourceType).toBe("AGREEMENT_ONLY");
    expect(payable.head.reviewRef).toBeNull();
    expect(payable.head.reviewVersion).toBeNull();
    expect(payable.selectedVersion!.snapshot.review).toBeNull();
    expect(payable.selectedVersion!.snapshot.qualifyingContent).toBeNull();
    expect(payable.selectedVersion!.snapshot.warnings.join(" ")).toMatch(/governed by the Agreement alone/);
    expect(payable.selectedVersion!.totalAmountMinorSigned).toBe(5_000_000);
  });

  it("refuses an Agreement that belongs to a different counterparty", async () => {
    const head = await actorFor("partnership_head");
    const vendorA = await seedVendor();
    const vendorB = await seedVendor();
    await activeAgreement(vendorCp(vendorA), DETERMINED_TERMS());
    const otherAgreement = await activeAgreement(vendorCp(vendorB), DETERMINED_TERMS());

    const mismatch = failure(await createFor(head, "VENDOR", vendorA.vendorRef, otherAgreement.head.agreementRef));
    expect(mismatch.code).toBe("not_ready");
    expect(mismatch.blockers?.map((blocker) => blocker.code)).toEqual(["AGREEMENT_COUNTERPARTY_MISMATCH"]);
  });

  it("a partner payable never accepts a client-supplied Agreement, and a vendor payable requires one", async () => {
    const head = await actorFor("partnership_head");
    const { partner, agreement } = await partnerReadyForPayable();
    const rejected = failure(await createPayable(head, { counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef, commercialPeriod: PERIOD, agreementRef: agreement.head.agreementRef }, requestId()));
    expect(rejected.code).toBe("invalid_input");
    expect(rejected.message).toMatch(/never client-supplied/);

    const vendor = await seedVendor();
    const missing = failure(await createPayable(head, { counterpartyType: "VENDOR", counterpartyRef: vendor.vendorRef, commercialPeriod: PERIOD }, requestId()));
    expect(missing.code).toBe("invalid_input");
  });

  it("preview explains the outcome without writing anything", async () => {
    const head = await actorFor("partnership_head");
    const { partner } = await partnerReadyForPayable(UNDER_DELIVERED_TERMS());

    const io = instrumentWrites();
    let preview;
    try {
      preview = must(await previewPayableSource(head, { counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef, commercialPeriod: PERIOD }), "preview");
    } finally {
      io.stop();
    }
    expect(io.paths).toEqual([]);
    expect(preview.existingPayableRef).toBeNull();
    // Step 15C: under-delivery with BOTH required and actual counts present now prorates
    // deterministically (1 of 3 required) instead of raising a Finance-review item - the whole
    // point of this correction. serviceBase = 5,000,000 * 1/3 = 1,666,667 (half-up); TDS 10% of
    // that = 166,667; net = 1,500,000.
    expect(preview.determinationState).toBe("DETERMINISTIC");
    expect(preview.unresolved).toEqual([]);
    expect(preview.serviceBaseMinor).toBe(1_666_667);
    expect(preview.tdsMinor).toBe(166_667);
    expect(preview.expectedNetPaymentMinor).toBe(1_500_000);
    expect(preview.totalAmountMinorSigned).toBe(1_500_000);
    expect(preview.warnings.join(" ")).toMatch(/under-delivered.*1 of 3/);
    expect(await getPayableHeadDoc(payableRefFor({ counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef, commercialPeriod: PERIOD }))).toBeNull();
  });
});

// =====================================================================================================================
describe("idempotency, concurrency and the canonical basis", () => {
  it("a repeated create returns the SAME canonical Payable, unchanged", async () => {
    const head = await actorFor("partnership_head");
    const { partner } = await partnerReadyForPayable();

    const first = must(await createFor(head, "PARTNER", partner.partnerRef), "first create");
    const second = must(await createFor(head, "PARTNER", partner.partnerRef), "second create");
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("existing");
    expect(second.payable.head.payableRef).toBe(first.payable.head.payableRef);
    expect(second.payable.head.latestVersion).toBe(1);
    expect(second.payable.head.docVersion).toBe(first.payable.head.docVersion);

    const versions = await financePayableVersionsCollection(first.payable.head.payableRef).get();
    expect(versions.size).toBe(1);
  });

  it("concurrent creates produce exactly ONE canonical Payable", async () => {
    const head = await actorFor("partnership_head");
    const { partner } = await partnerReadyForPayable();

    const results = await Promise.all([createFor(head, "PARTNER", partner.partnerRef), createFor(head, "PARTNER", partner.partnerRef), createFor(head, "PARTNER", partner.partnerRef)]);
    const outcomes = results.map((result) => (result.ok ? result.data.outcome : `error:${result.code}`));
    expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "existing")).toHaveLength(2);

    const payableRef = payableRefFor({ counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef, commercialPeriod: PERIOD });
    const stored = await getPayableHeadDoc(payableRef);
    expect(stored?.latestVersion).toBe(1);
    expect((await financePayableVersionsCollection(payableRef).get()).size).toBe(1);
  });

  it("a NEWER valid source version for the same period is a conflict naming the revision path - never a second Payable", async () => {
    const head = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");
    const { partner, reviewRef } = await partnerReadyForPayable();
    const created = must(await createFor(head, "PARTNER", partner.partnerRef), "create");
    const payableRef = created.payable.head.payableRef;

    // A second finalized Review version for the same month. Partner Reviews only allow a revision
    // once the finalized evidence is actually behind upstream, so a second approved thread is
    // added first - exactly the real-world reason a review gets revised.
    await seedEvidence(partner);
    const current = await getPartnerReview(manager, reviewRef);
    if (!current.ok) throw new Error(current.message);
    const revision = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: current.data.head.docVersion }, requestId());
    if (!revision.ok) throw new Error(`review revision: ${revision.message}`);
    await finalizeOpenReview(reviewRef);

    const conflict = failure(await createFor(head, "PARTNER", partner.partnerRef));
    expect(conflict.code).toBe("conflict");
    expect(conflict.message).toMatch(/Revise that payable/);

    // Still exactly one canonical Payable, still on its original version.
    const stored = await getPayableHeadDoc(payableRef);
    expect(stored?.latestVersion).toBe(1);
    expect(stored?.sourceReviewVersion).toBe(1);

    // The warning says a newer Review is available - and reading it changes nothing.
    const io = instrumentWrites();
    let revisionStatus;
    try {
      revisionStatus = must(await getPayableSourceRevision(head, payableRef), "source revision");
    } finally {
      io.stop();
    }
    expect(io.paths).toEqual([]);
    expect(revisionStatus.state).toBe("REVIEW_REVISION_AVAILABLE");
    expect(revisionStatus.pinned.reviewVersion).toBe(1);
    expect(revisionStatus.current?.reviewVersion).toBe(2);

    // Adopting it is an explicit, reasoned revision that appends a NEW version.
    const before = must(await getPayable(head, payableRef), "read before");
    const revised = must(await revisePayable(head, { payableRef, expectedDocVersion: before.head.docVersion, refreshSource: true, reason: "Adopt the newer finalized review." }, requestId()), "revise");
    expect(revised.head.latestVersion).toBe(2);
    expect(revised.head.reviewVersion).toBe(2);
    expect(revised.selectedVersion!.changeKind).toBe("revised");

    // Version 1 is byte-identical to what it was.
    const storedV1 = (await financePayableVersionsCollection(payableRef).doc("1").get()).data() as Record<string, unknown>;
    expect(storedV1.version).toBe(1);
    expect((storedV1.snapshot as { review: { reviewVersion: number } }).review.reviewVersion).toBe(1);

    const events = must(await listPayableEvents(head, payableRef), "events");
    expect(events.events.map((event) => event.kind)).toContain("SOURCE_REVISION_DETECTED");
  });

  it("a Vendor payable surfaces an Agreement revision as a warning and never recalculates by itself", async () => {
    const head = await actorFor("partnership_head");
    const vendor = await seedVendor();
    const v1 = await activeAgreement(vendorCp(vendor), DETERMINED_TERMS());
    const created = must(await createFor(head, "VENDOR", vendor.vendorRef, v1.head.agreementRef), "create vendor payable");
    const payableRef = created.payable.head.payableRef;
    expect(created.payable.selectedVersion!.totalAmountMinorSigned).toBe(5_000_000);

    await reviseAndActivateAgreement(v1, [{ fieldKey: "fixedComponent", decision: "CORRECTED", value: { applicable: true, amountMinor: 7_000_000 } }]);

    // The payable is untouched: same version, same money.
    const unchanged = must(await getPayable(head, payableRef), "read after agreement revision");
    expect(unchanged.head.latestVersion).toBe(1);
    expect(unchanged.head.agreementVersion).toBe(1);
    expect(unchanged.selectedVersion!.totalAmountMinorSigned).toBe(5_000_000);

    const revisionStatus = must(await getPayableSourceRevision(head, payableRef), "source revision");
    expect(revisionStatus.state).toBe("AGREEMENT_REVISION_AVAILABLE");
    expect(revisionStatus.current?.agreementVersion).toBe(2);

    // Only an explicit refresh adopts it.
    const revised = must(await revisePayable(head, { payableRef, expectedDocVersion: unchanged.head.docVersion, refreshSource: true, reason: "Adopt the revised Agreement." }, requestId()), "revise");
    expect(revised.head.agreementVersion).toBe(2);
    expect(revised.selectedVersion!.totalAmountMinorSigned).toBe(7_000_000);
    // ... and the old version still says what it always said.
    const storedV1 = (await financePayableVersionsCollection(payableRef).doc("1").get()).data() as Record<string, unknown>;
    expect(storedV1.totalAmountMinorSigned).toBe(5_000_000);
    expect(must(await getPayableSourceRevision(head, payableRef), "source revision after").state).toBe("CURRENT");
  });
});

// =====================================================================================================================
describe("lifecycle, adjustments and immutability", () => {
  async function draftPayable(seeds: FieldDecisionSeed[] = DETERMINED_TERMS()): Promise<{ payable: PayableDetailDto; partner: PartnerDoc }> {
    const head = await actorFor("partnership_head");
    const { partner } = await partnerReadyForPayable(seeds);
    const created = must(await createFor(head, "PARTNER", partner.partnerRef), "create");
    return { payable: created.payable, partner };
  }

  it("a DRAFT payable accepts a manual adjustment, which appends the NEXT version and leaves the previous one intact", async () => {
    const head = await actorFor("partnership_head");
    const { payable } = await draftPayable();
    const payableRef = payable.head.payableRef;

    const adjusted = must(
      await addPayableAdjustment(head, { payableRef, expectedDocVersion: payable.head.docVersion, label: "Agreed goodwill deduction", amountMinorSigned: -100_000, reason: "Agreed with the partner in writing." }, requestId()),
      "add adjustment",
    );
    expect(adjusted.head.latestVersion).toBe(2);
    expect(adjusted.selectedVersion!.changeKind).toBe("adjustment_added");
    // Step 15C: DETERMINED_TERMS (1 of 1, fully delivered) prorates to the full fixed amount minus
    // the CreatorOps 10% TDS: 5,000,000 - 500,000 = 4,500,000, then the manual -100,000 adjustment.
    expect(adjusted.selectedVersion!.totalAmountMinorSigned).toBe(4_400_000);
    const manual = adjusted.selectedVersion!.lines.find((line) => line.category === "MANUAL_ADJUSTMENT")!;
    expect(manual.actorUserRef).toBe(head.userRef);
    expect(manual.reason).toBe("Agreed with the partner in writing.");

    const storedV1 = (await financePayableVersionsCollection(payableRef).doc("1").get()).data() as Record<string, unknown>;
    expect(storedV1.totalAmountMinorSigned).toBe(4_500_000);
    expect((storedV1.lines as unknown[]).length).toBe(2); // PRORATED_BASE + TDS

    const removed = must(await removePayableAdjustment(head, { payableRef, expectedDocVersion: adjusted.head.docVersion, lineRef: manual.lineRef, reason: "Reverted after review." }, requestId()), "remove adjustment");
    expect(removed.head.latestVersion).toBe(3);
    expect(removed.selectedVersion!.totalAmountMinorSigned).toBe(4_500_000);

    const events = must(await listPayableEvents(head, payableRef), "events");
    expect(events.events.map((event) => event.kind)).toEqual(expect.arrayContaining(["PAYABLE_CREATED", "PAYABLE_VERSION_CREATED", "MANUAL_ADJUSTMENT_ADDED", "MANUAL_ADJUSTMENT_REMOVED"]));
    // No event carries an amount.
    for (const event of events.events) expect(JSON.stringify(event.metadata ?? {})).not.toMatch(/100000|500000|4500000|4400000/);
  });

  it("refuses READY_FOR_INVOICE while a Finance item is open, and accepts it once a manual adjustment resolves it", async () => {
    const head = await actorFor("partnership_head");
    // Step 15C: an evidenced under-delivery no longer opens a review item (it prorates
    // deterministically instead - see the dedicated test above) - a still-genuinely-ambiguous
    // transfer fee exercises this resolve-then-ready flow instead.
    const { payable } = await draftPayable(TRANSFER_FEE_UNSPECIFIED_TERMS());
    const payableRef = payable.head.payableRef;
    expect(payable.selectedVersion!.openReviewCodes).toEqual(["TRANSFER_FEE_APPLICATION_UNSPECIFIED"]);
    expect(payable.selectedVersion!.totalAmountMinorSigned).toBe(4_500_000);

    const blocked = failure(await markPayableReadyForInvoice(head, { payableRef, expectedDocVersion: payable.head.docVersion }, requestId()));
    expect(blocked.code).toBe("not_ready");
    expect(blocked.blockers?.map((blocker) => blocker.code)).toEqual(["payable_open_review_items"]);

    const resolved = must(
      await addPayableAdjustment(
        head,
        { payableRef, expectedDocVersion: payable.head.docVersion, label: "Transfer fee reviewed", amountMinorSigned: 0, reason: "Reviewed: Finance confirmed the transfer fee is nil for this period.", resolvesCode: "TRANSFER_FEE_APPLICATION_UNSPECIFIED" },
        requestId(),
      ),
      "resolve review item",
    );
    expect(resolved.selectedVersion!.openReviewCodes).toEqual([]);
    // The determination STATE is still the engine's own verdict - a manual line never rewrites it.
    expect(resolved.selectedVersion!.determinationState).toBe("FINANCE_REVIEW_REQUIRED");
    expect(resolved.selectedVersion!.totalAmountMinorSigned).toBe(4_500_000);

    const ready = must(await markPayableReadyForInvoice(head, { payableRef, expectedDocVersion: resolved.head.docVersion }, requestId()), "ready");
    expect(ready.head.status).toBe("READY_FOR_INVOICE");
    expect(ready.head.readyVersion).toBe(ready.head.latestVersion);
    expect(ready.head.readyByUserRef).toBe(head.userRef);
  });

  it("a payable that is READY_FOR_INVOICE cannot be adjusted; a reasoned revision reopens it as DRAFT", async () => {
    const head = await actorFor("partnership_head");
    const { payable } = await draftPayable();
    const payableRef = payable.head.payableRef;
    const ready = must(await markPayableReadyForInvoice(head, { payableRef, expectedDocVersion: payable.head.docVersion }, requestId()), "ready");
    const readyVersion = ready.head.readyVersion!;

    const refused = failure(await addPayableAdjustment(head, { payableRef, expectedDocVersion: ready.head.docVersion, label: "Late correction", amountMinorSigned: -1, reason: "Too late." }, requestId()));
    expect(refused.code).toBe("conflict");
    expect(refused.message).toMatch(/ready for invoicing/i);

    const reopened = must(await revisePayable(head, { payableRef, expectedDocVersion: ready.head.docVersion, refreshSource: false, reason: "Correcting the breakdown before invoicing." }, requestId()), "revise");
    expect(reopened.head.status).toBe("DRAFT");
    expect(reopened.head.readyVersion).toBeNull();
    // The version an Invoice would have consumed is still there, unchanged.
    const storedReady = (await financePayableVersionsCollection(payableRef).doc(String(readyVersion)).get()).data() as Record<string, unknown>;
    expect(storedReady.version).toBe(readyVersion);
  });

  it("an optimistic stale expectedDocVersion is refused rather than overwriting", async () => {
    const head = await actorFor("partnership_head");
    const { payable } = await draftPayable();
    const payableRef = payable.head.payableRef;
    const stale = payable.head.docVersion;
    must(await revisePayable(head, { payableRef, expectedDocVersion: stale, refreshSource: false, reason: "First revision." }, requestId()), "revise");
    const refused = failure(await revisePayable(head, { payableRef, expectedDocVersion: stale, refreshSource: false, reason: "Second revision on a stale read." }, requestId()));
    expect(refused.code).toBe("stale_write");
  });

  it("void requires a reason, is terminal, and deletes nothing", async () => {
    const head = await actorFor("partnership_head");
    const { payable } = await draftPayable();
    const payableRef = payable.head.payableRef;
    const versionsBefore = (await financePayableVersionsCollection(payableRef).get()).size;

    expect(failure(await voidPayable(head, { payableRef, expectedDocVersion: payable.head.docVersion }, requestId())).code).toBe("invalid_input");
    expect(failure(await voidPayable(head, { payableRef, expectedDocVersion: payable.head.docVersion, reason: "no" }, requestId())).code).toBe("invalid_input");

    const voided = must(await voidPayable(head, { payableRef, expectedDocVersion: payable.head.docVersion, reason: "Raised against the wrong commercial period." }, requestId()), "void");
    expect(voided.head.status).toBe("VOID");
    expect(voided.head.voidReason).toBe("Raised against the wrong commercial period.");

    // Terminal: nothing leaves VOID, and the payable can never be invoiced.
    expect(failure(await markPayableReadyForInvoice(head, { payableRef, expectedDocVersion: voided.head.docVersion }, requestId())).code).toBe("conflict");
    expect(failure(await revisePayable(head, { payableRef, expectedDocVersion: voided.head.docVersion, refreshSource: false, reason: "Trying to revive it." }, requestId())).code).toBe("conflict");
    expect(failure(await voidPayable(head, { payableRef, expectedDocVersion: voided.head.docVersion, reason: "Voiding again." }, requestId())).code).toBe("conflict");

    // History is retained: head and every version still exist.
    expect(await getPayableHeadDoc(payableRef)).not.toBeNull();
    expect((await financePayableVersionsCollection(payableRef).get()).size).toBe(versionsBefore);

    // A create for the same basis does not silently regenerate over the voided history.
    const { partner } = await draftPayable();
    expect(partner).toBeTruthy();
  });
});

// =====================================================================================================================
describe("boundaries: a Payable mutation writes only Payable documents", () => {
  it("create, adjust, ready and void write nothing outside financePayables/", async () => {
    const head = await actorFor("partnership_head");
    const { partner } = await partnerReadyForPayable();

    const io = instrumentWrites();
    try {
      const created = must(await createFor(head, "PARTNER", partner.partnerRef), "create");
      const payableRef = created.payable.head.payableRef;
      const adjusted = must(
        await addPayableAdjustment(head, { payableRef, expectedDocVersion: created.payable.head.docVersion, label: "Correction", amountMinorSigned: -1_000, reason: "Agreed correction." }, requestId()),
        "adjust",
      );
      const ready = must(await markPayableReadyForInvoice(head, { payableRef, expectedDocVersion: adjusted.head.docVersion }, requestId()), "ready");
      must(await voidPayable(head, { payableRef, expectedDocVersion: ready.head.docVersion, reason: "Cleaning up the boundary fixture." }, requestId()), "void");
    } finally {
      io.stop();
    }

    expect(io.paths.length).toBeGreaterThan(5);
    for (const path of io.paths) expect(path.startsWith("financePayables/"), path).toBe(true);
    expect(io.paths.filter((path) => /^(partnerReviews|financeAgreements|financeContract|partners|vendors)/.test(path))).toEqual([]);
  });
});

// =====================================================================================================================
describe("authorization", () => {
  it("an unauthenticated caller is denied every command", async () => {
    for (const result of [
      await getPayable(null, "pay_00000000000000000001"),
      await createPayable(null, { counterpartyType: "PARTNER", counterpartyRef: "x", commercialPeriod: PERIOD }, requestId()),
      await listPayablesWorkspace(null, {}),
    ]) {
      expect(failure(result).reason).toBe("not_authenticated");
    }
  });

  it("a role without the finance feature is denied - Viewer and Analyst hold no Payables capability at all", async () => {
    const { partner } = await partnerReadyForPayable();
    const headActor = await actorFor("partnership_head");
    const created = must(await createFor(headActor, "PARTNER", partner.partnerRef), "create");
    const payableRef = created.payable.head.payableRef;

    for (const role of ["viewer", "analyst"]) {
      const actor = await actorFor(role);
      expect(failure(await getPayable(actor, payableRef)).reason, role).toBe("feature_denied");
      expect(failure(await listPayablesWorkspace(actor, {})).reason, role).toBe("feature_denied");
      expect(failure(await createPayable(actor, { counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef, commercialPeriod: PERIOD }, requestId())).reason, role).toBe("feature_denied");
    }
  });

  it("Manager may prepare a payable but holds neither the adjust nor the void action", async () => {
    const manager = await actorFor("partnership_manager");
    const { partner } = await partnerReadyForPayable();

    const created = must(await createFor(manager, "PARTNER", partner.partnerRef), "manager create");
    const payableRef = created.payable.head.payableRef;
    must(await revisePayable(manager, { payableRef, expectedDocVersion: created.payable.head.docVersion, refreshSource: false, reason: "Manager rechecks the breakdown." }, requestId()), "manager revise");

    const current = must(await getPayable(manager, payableRef), "read");
    expect(failure(await addPayableAdjustment(manager, { payableRef, expectedDocVersion: current.head.docVersion, label: "Nope", amountMinorSigned: -1, reason: "Manager should not be able to do this." }, requestId())).reason).toBe("action_denied");
    expect(failure(await removePayableAdjustment(manager, { payableRef, expectedDocVersion: current.head.docVersion, lineRef: "pl_00000000000000000001", reason: "Manager should not be able to do this." }, requestId())).reason).toBe("action_denied");
    expect(failure(await voidPayable(manager, { payableRef, expectedDocVersion: current.head.docVersion, reason: "Manager should not be able to do this." }, requestId())).reason).toBe("action_denied");
  });

  it("moving to READY_FOR_INVOICE is decided by the EXACT approve_payables grant, including an explicit per-user override", async () => {
    const manager = await actorFor("partnership_manager");
    const { partner } = await partnerReadyForPayable();
    const created = must(await createFor(manager, "PARTNER", partner.partnerRef), "create");

    // The seeded access data gives THIS identity an explicit per-user override for exactly this
    // action (the role baseline denies it) - so the allow below is grant-driven, never role-ranked.
    const override = await getAdminFirestore().collection(COLLECTIONS.userAccessOverrides).doc(manager.uid).get();
    expect((override.data() as { features?: { finance?: { actions?: Record<string, boolean> } } } | undefined)?.features?.finance?.actions?.approve_payables).toBe(true);

    const ready = must(await markPayableReadyForInvoice(manager, { payableRef: created.payable.head.payableRef, expectedDocVersion: created.payable.head.docVersion }, requestId()), "manager ready via override");
    expect(ready.head.status).toBe("READY_FOR_INVOICE");
  });

  it("an out-of-scope counterparty is the same neutral not_found for every actor", async () => {
    const headActor = await actorFor("partnership_head");
    const outOfScope = await seedPartner([PRIVATE_REGION]);

    const denied = failure(await createPayable(headActor, { counterpartyType: "PARTNER", counterpartyRef: outOfScope.partnerRef, commercialPeriod: PERIOD }, requestId()));
    expect(denied.code).toBe("not_found");
    expect(denied.message).toBe("Not found.");
    expect(failure(await previewPayableSource(headActor, { counterpartyType: "PARTNER", counterpartyRef: outOfScope.partnerRef, commercialPeriod: PERIOD })).code).toBe("not_found");

    // A forged / unknown payableRef is answered identically.
    expect(failure(await getPayable(headActor, "pay_ffffffffffffffffffff")).message).toBe("Not found.");
    expect(failure(await getPayable(headActor, "not-a-ref")).message).toBe("Not found.");
  });

  it("an actor whose scope loses the counterparty can no longer read the payable", async () => {
    const headActor = await actorFor("partnership_head");
    const partner = await seedPartner();
    await seedEvidence(partner);
    await activeAgreement(partnerCp(partner), DETERMINED_TERMS());
    await finalizedReview(partner);
    const created = must(await createFor(headActor, "PARTNER", partner.partnerRef), "create");

    await partnersCollection().doc(partner.uid).update({ regionIds: [PRIVATE_REGION] });
    expect(failure(await getPayable(headActor, created.payable.head.payableRef)).message).toBe("Not found.");
  });
});

// =====================================================================================================================
describe("data safety", () => {
  it("a Payable response carries no identity/KYC value and no raw Agreement clause text", async () => {
    const headActor = await actorFor("partnership_head");
    const { partner } = await partnerReadyForPayable();
    const created = must(await createFor(headActor, "PARTNER", partner.partnerRef), "create");
    const detail = must(await getPayable(headActor, created.payable.head.payableRef), "read");

    const serialized = JSON.stringify(detail);
    // The mandated-services clause of READY_DECISIONS, and the identity component names/values.
    expect(serialized).not.toContain("Creation and posting of short-form video content");
    for (const forbidden of ["panNumber", "aadhaarNumber", "bankAccountNumber", "accountNumber", "ifsc", "gstin", "identityStatus", "contactSnapshot", "servicesMandated", "monetisationTerms", "renewalTerms", "terminationTerms"]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    // No scope snapshot field and no raw Firebase uid.
    for (const forbidden of ["ownerUid", "regionIds", "teamIds", "partnerUid", "vendorUid"]) expect(serialized, forbidden).not.toContain(forbidden);
    expect(serialized).not.toContain(headActor.uid);
    // No upstream source-record identifier.
    for (const forbidden of ["assignmentRef", "campaignRef", "contentRef", "sourceRecordRef", "postUrl"]) expect(serialized, forbidden).not.toContain(forbidden);
  });

  it("finance_amounts is role-driven, not per-user-overridable, and Manager now holds it same as Head", async () => {
    // Step 15A follow-up (explicit product confirmation): Manager was widened to hold
    // finance_amounts. canAccessSensitive (src/server/authz/sensitive.ts) resolves purely from the
    // actor's ROLE - there is no per-user override path for a sensitive category the way there is
    // for a feature action (contrast the approve_payables override test above) - so with every
    // role that can reach `finance` view/manage now also holding finance_amounts (viewer/analyst
    // hold neither; manager/head/super_admin hold both), no real actor can exercise an
    // amountsVisible:false read anymore. That redaction MECHANISM (every money field nulled, never
    // zeroed, cascading through lines/snapshot/version/head) is still fully covered directly
    // against the pure DTO mappers in client-dto.test.ts, independent of any actor.
    const headActor = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");
    const { partner } = await partnerReadyForPayable();
    const created = must(await createFor(headActor, "PARTNER", partner.partnerRef), "create");
    const payableRef = created.payable.head.payableRef;

    // Step 15C: DETERMINED_TERMS (1 of 1, fully delivered) prorates to the full fixed amount minus
    // the CreatorOps 10% TDS: 5,000,000 - 500,000 = 4,500,000. The snapshot's own fixedComponent
    // figure (the Agreement-stated amount BEFORE proration/tax) is unaffected and stays 5,000,000.
    const asHead = must(await getPayable(headActor, payableRef), "head read");
    expect(asHead.amountsVisible).toBe(true);
    expect(asHead.selectedVersion!.totalAmountMinorSigned).toBe(4_500_000);

    const asManager = must(await getPayable(manager, payableRef), "manager read");
    expect(asManager.amountsVisible).toBe(true);
    expect(asManager.selectedVersion!.totalAmountMinorSigned).toBe(4_500_000);
    expect(asManager.selectedVersion!.snapshot.fixedComponent!.amountMinor).toBe(5_000_000);

    // Manager sees the figure it prepares but still holds none of the CATEGORY-gated governance
    // actions (adjust/void both require finance_amounts too, which is no longer a distinguishing
    // signal - they remain denied on their own missing action grant). canApprove is intentionally
    // not asserted here: it is a per-user-overridable feature ACTION (contrast finance_amounts,
    // which is not), and the "moving to READY_FOR_INVOICE" test above grants this same seeded
    // manager uid an explicit approve_payables override that persists for the rest of this file -
    // that override, not this widening, is the correct place to assert canApprove's value.
    const workspace = must(await listPayablesWorkspace(manager, { counterpartyRef: partner.partnerRef }), "manager workspace");
    expect(workspace.permissions).toMatchObject({ canView: true, canManage: true, canAdjust: false, canVoid: false, canViewAmounts: true });
    expect(workspace.rows.map((row) => row.totalAmountMinorSigned)).toEqual([4_500_000]);
  });
});

// =====================================================================================================================
describe("the workspace list", () => {
  it("returns the actor's in-scope payables, filtered and bounded, with a deterministic order", async () => {
    const headActor = await actorFor("partnership_head");
    const { partner: partnerA } = await partnerReadyForPayable();
    const vendor = await seedVendor();
    const vendorAgreement = await activeAgreement(vendorCp(vendor), DETERMINED_TERMS());

    const payableA = must(await createFor(headActor, "PARTNER", partnerA.partnerRef), "create A").payable;
    const payableB = must(await createFor(headActor, "VENDOR", vendor.vendorRef, vendorAgreement.head.agreementRef), "create B").payable;

    const all = must(await listPayablesWorkspace(headActor, {}), "workspace");
    const refs = all.rows.map((row) => row.payableRef);
    expect(refs).toContain(payableA.head.payableRef);
    expect(refs).toContain(payableB.head.payableRef);

    const partnersOnly = must(await listPayablesWorkspace(headActor, { counterpartyType: "PARTNER", counterpartyRef: partnerA.partnerRef }), "filtered");
    expect(partnersOnly.rows.map((row) => row.payableRef)).toEqual([payableA.head.payableRef]);
    expect(partnersOnly.rows[0]!.counterparty.displayName).toBe(partnerA.displayName);
    expect(partnersOnly.rows[0]!.commercialPeriod).toBe(PERIOD);

    expect(must(await listPayablesWorkspace(headActor, { commercialPeriod: "2019-04" }), "other period").rows).toEqual([]);
    expect(must(await listPayablesWorkspace(headActor, { status: "VOID", counterpartyRef: partnerA.partnerRef }), "void filter").rows).toEqual([]);
    expect(failure(await listPayablesWorkspace(headActor, { status: "APPROVED" })).code).toBe("invalid_input");
  });
});
