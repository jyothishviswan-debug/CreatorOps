// Step 14A - the Agreement -> Partner Reviews commercial-policy ADAPTER against the running Firestore/Auth emulator.
//
// Part 1 proves the adapter contract on real Agreement data: strict-schema output, null when nothing governs, Vendor
// Agreements never yield a Partner policy, the required count only with a supported unit, LFC/SFC only with an explicit
// rule, warning-only targets, the documented governing-version rule (status + whole-month coverage), determinism.
//
// Part 2 plugs the adapter into Partner Reviews through the test-only provider seam (setCommercialPolicyProviderForTests)
// and proves the review picks up governingAgreement + the required count, that a NEW governing Agreement version changes
// the source fingerprint and provenance, and that review generation / refresh / finalization never writes any Finance
// document. PRODUCTION REGISTRATION OF THE ADAPTER IS DEFERRED - only these tests install it.
//
// Hermetic: every Partner has a unique uid/ref; the agreement dates are in 2019 and the review evidence fixtures carry a
// private region; everything created is removed afterwards.
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
import { setCommercialPolicyProviderForTests, governingCommercialPolicySchema } from "@/server/partner-reviews/commercial-policy";
import { getFinalizedReviewHandoff } from "@/server/partner-reviews/finalized-review-handoff-service";
import { createPartnerReviewRevision, finalizePartnerReview, submitPartnerReviewForReview } from "@/server/partner-reviews/partner-review-lifecycle-service";
import { generatePartnerReviewDraft, getPartnerReview, inspectPartnerReviewFreshness, refreshPartnerReviewEvidence } from "@/server/partner-reviews/partner-review-service";
import { PARTNER_REVIEWS_COLLECTIONS, partnerReviewsCollection, partnerReviewVersionsCollection } from "@/server/partner-reviews/firestore";
import { partnersCollection } from "@/server/partners/firestore";
import { partnerDocSchema, type PartnerDoc } from "@/server/partners/types";
import { vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema, type VendorDoc } from "@/server/vendors/types";

import {
  activateAgreementVersion,
  confirmAgreementVersion,
  createAgreementDraft,
  createAgreementRevision,
  decideField,
  endAgreement,
  suspendAgreement,
  type AgreementDetailDto,
} from "./index";
import { agreementClaimId, financeAgreementClaimsCollection, financeAgreementsCollection, financeAgreementVersionsCollection } from "./firestore";
import { AgreementPolicyError, agreementCommercialPolicyProvider, getAgreementCommercialPolicy } from "./policy-adapter";
import { READY_DECISIONS, SAMPLE_TARGETS, type FieldDecisionSeed } from "./testing/agreement-service-fixtures";
import type { AgreementCounterpartyInput, FinanceAgreementsServiceResult } from "./types";

vi.setConfig({ testTimeout: 60_000 });

const runId = Date.now();
const PRIVATE_REGION = `pol-private-${runId}`;
const PERIOD = "2019-03";
const SUPPORTED_UNIT = "approved_content_thread";

const uidByRole = new Map<string, string>();
const cleanup: FirebaseFirestore.DocumentReference[] = [];
const agreementRefs: string[] = [];
const claimIds: string[] = [];
const reviewRefs = new Set<string>();
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
  setCommercialPolicyProviderForTests(null);
});

afterAll(async () => {
  const db = getAdminFirestore();
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

// ---- Fixtures ---------------------------------------------------------------------------------------------------------
async function seedPartner(): Promise<PartnerDoc> {
  counter += 1;
  const uid = `pol-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const partner = partnerDocSchema.parse({
    uid,
    partnerRef: uid,
    version: 1,
    displayName: `POL Partner ${counter}`,
    displayNameLower: `pol partner ${counter}`,
    legalName: null,
    email: `${uid}@example-partner.test`,
    phone: "+91 90000 00088",
    status: "ACTIVE",
    regionIds: ["Kerala"],
    createdAt: now,
    createdByUserRef: "pol-test",
    updatedAt: now,
    updatedByUserRef: "pol-test",
  });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  cleanup.push(ref);
  return partner;
}

async function seedVendor(): Promise<VendorDoc> {
  counter += 1;
  const uid = `pol-vendor-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const vendor = vendorDocSchema.parse({
    uid,
    vendorRef: uid,
    version: 1,
    displayName: `POL Vendor ${counter}`,
    displayNameLower: `pol vendor ${counter}`,
    vendorType: "AGENCY",
    email: `${uid}@example-vendor.test`,
    status: "ACTIVE",
    regionIds: ["Kerala"],
    createdAt: now,
    createdByUserRef: "pol-test",
    updatedAt: now,
    updatedByUserRef: "pol-test",
  });
  const ref = vendorsCollection().doc(uid);
  await ref.set(vendor);
  cleanup.push(ref);
  return vendor;
}

// One in-period Assignment (format reel) with an APPROVED thread (1 qualifying unit) for the review evidence.
async function seedEvidence(partner: PartnerDoc) {
  const uid = assignmentsCollection().doc().id;
  const now = new Date().toISOString();
  const assignment = assignmentDocSchema.parse({
    uid,
    assignmentRef: `pol-as-${uid}`,
    version: 1,
    campaignRef: `pol-camp-${runId}`,
    partnerRef: partner.partnerRef,
    partnerAccountRefs: [],
    status: "IN_PROGRESS",
    statusReason: null,
    brief: assignmentBriefSchema.parse({ dueAt: "2019-03-10", requiredCount: 2, formats: ["reel"], platforms: ["instagram"], reviewPolicy: "REVIEW_REQUIRED", campaignName: "POL Campaign" }),
    ownerUid: null,
    regionIds: [PRIVATE_REGION],
    teamIds: [],
    createdAt: "2019-01-05T08:00:00.000Z",
    createdByUserRef: "pol-test",
    updatedAt: now,
    updatedByUserRef: "pol-test",
  });
  const assignmentRef = assignmentsCollection().doc(uid);
  await assignmentRef.set(assignment);
  cleanup.push(assignmentRef);

  const threadUid = contentCollection().doc().id;
  const thread = contentDocSchema.parse({
    uid: threadUid,
    contentRef: `pol-ct-${threadUid}`,
    version: 3,
    assignmentRef: assignment.assignmentRef,
    campaignRef: assignment.campaignRef,
    partnerRef: partner.partnerRef,
    status: "APPROVED",
    statusReason: null,
    currentRevisionNumber: 1,
    reviewedRevisionNumber: 1,
    currentLinks: [{ platform: "instagram", originalUrl: `https://instagram.com/p/POL${threadUid}`, normalizedUrl: `https://instagram.com/p/pol${threadUid.toLowerCase()}`, recordedAt: "2019-03-08T10:00:00.000Z" }],
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
    createdByUserRef: "pol-test",
    updatedAt: "2019-03-08T10:00:00.000Z",
    updatedByUserRef: "pol-test",
  });
  const threadRef = contentCollection().doc(threadUid);
  await threadRef.set(thread);
  cleanup.push(threadRef);
}

// ---- Agreement helpers (real services) ------------------------------------------------------------------------------------
let reqCounter = 0;
const requestId = () => `pol-req-${runId}-${(reqCounter += 1)}`;
const partnerCp = (partner: PartnerDoc): AgreementCounterpartyInput => ({ type: "PARTNER", partnerRef: partner.partnerRef });

function must<T>(result: FinanceAgreementsServiceResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}${result.blockers ? ` ${JSON.stringify(result.blockers)}` : ""}`);
  return result.data;
}

// READY_DECISIONS with named fields replaced (or removed).
function decisionsWith(over: Record<string, FieldDecisionSeed | null>): FieldDecisionSeed[] {
  const keys = new Set(Object.keys(over));
  const kept = READY_DECISIONS.filter((seed) => !keys.has(seed.fieldKey));
  return [...kept, ...(Object.values(over).filter(Boolean) as FieldDecisionSeed[])];
}

// The default policy-bearing terms: 8 required units of a SUPPORTED unit, an explicit LFC/SFC rule, one warning-only target,
// effective 2019-01-01 .. 2019-12-31.
const POLICY_TERMS = (): Record<string, FieldDecisionSeed> => ({
  effectiveDate: { fieldKey: "effectiveDate", decision: "CORRECTED", value: "2019-01-01" },
  terminationDate: { fieldKey: "terminationDate", decision: "CORRECTED", value: "2019-12-31" },
  qualifyingUnit: { fieldKey: "qualifyingUnit", decision: "CORRECTED", value: SUPPORTED_UNIT },
  monthlyRequiredQualifyingContentCount: { fieldKey: "monthlyRequiredQualifyingContentCount", decision: "CORRECTED", value: 2 },
});

async function decideAll(actor: ActorContext, detail: AgreementDetailDto, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
  let current = detail;
  for (const seed of seeds) {
    current = must(
      await decideField(actor, { agreementRef: current.head.agreementRef, version: current.selectedVersion!.version, expectedDocVersion: current.selectedVersion!.docVersion, fieldKey: seed.fieldKey, decision: seed.decision, ...(seed.value !== undefined ? { value: seed.value } : {}) }, requestId()),
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

async function confirm(actor: ActorContext, detail: AgreementDetailDto): Promise<AgreementDetailDto> {
  return must(await confirmAgreementVersion(actor, { agreementRef: detail.head.agreementRef, version: detail.selectedVersion!.version, expectedDocVersion: detail.selectedVersion!.docVersion }, requestId()), "confirm");
}

async function activate(actor: ActorContext, detail: AgreementDetailDto): Promise<AgreementDetailDto> {
  return must(await activateAgreementVersion(actor, { agreementRef: detail.head.agreementRef, version: detail.selectedVersion!.version, expectedDocVersion: detail.head.docVersion }, requestId()), "activate");
}

// create -> decide -> accept pending -> confirm (a DRAFT that is confirmed, not yet operational).
async function confirmedAgreement(partner: PartnerDoc, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
  const manager = await actorFor("partnership_manager");
  const clientRequestId = `crid-${runId}-${(counter += 1)}-${randomUUID().slice(0, 6)}`;
  const created = must(await createAgreementDraft(manager, { clientRequestId, counterparty: partnerCp(partner) }, requestId()), "create");
  agreementRefs.push(created.agreement.head.agreementRef);
  claimIds.push(agreementClaimId(manager.uid, clientRequestId));
  return confirm(manager, await acceptPending(manager, await decideAll(manager, created.agreement, seeds)));
}

async function activeAgreement(partner: PartnerDoc, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
  return activate(await actorFor("partnership_head"), await confirmedAgreement(partner, seeds));
}

// A revision of the ACTIVE version: prefilled, then the named decisions, confirmed by the Manager, activated by the Head.
async function reviseAndActivate(detail: AgreementDetailDto, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
  const manager = await actorFor("partnership_manager");
  const head = await actorFor("partnership_head");
  const revised = must(await createAgreementRevision(head, { agreementRef: detail.head.agreementRef, expectedDocVersion: detail.head.docVersion }, requestId()), "revise");
  const confirmed = await confirm(manager, await decideAll(manager, revised, seeds));
  return activate(head, confirmed);
}

// ---- Firestore write instrumentation ---------------------------------------------------------------------------------------------
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
describe("the adapter contract on real Agreement data", () => {
  it("no Agreement (or an unknown Partner / a malformed period) => null", async () => {
    const partner = await seedPartner();
    expect(await getAgreementCommercialPolicy(partner.partnerRef, PERIOD)).toBeNull();
    expect(await getAgreementCommercialPolicy(`pol-missing-${runId}`, PERIOD)).toBeNull();
    expect(await getAgreementCommercialPolicy(partner.partnerRef, "2019-13")).toBeNull();
    expect(await getAgreementCommercialPolicy(partner.partnerRef, "March 2019")).toBeNull();
    expect(await getAgreementCommercialPolicy("", PERIOD)).toBeNull();
  });

  it("an active Partner Agreement yields the STRICT policy: identity, supported-unit requirement, explicit LFC/SFC rule and warning-only targets", async () => {
    const partner = await seedPartner();
    const active = await activeAgreement(partner, decisionsWith(POLICY_TERMS()));
    const ref = active.head.agreementRef;

    const policy = await getAgreementCommercialPolicy(partner.partnerRef, PERIOD);
    expect(policy).toEqual({
      agreementRef: ref,
      agreementVersion: 1,
      monthlyDeliverableRequirement: { requiredCount: 2, qualifyingUnit: SUPPORTED_UNIT, requirementSourceRef: `${ref}@1` },
      lfcSfcRule: { ruleRef: `${ref}@1:lfc-sfc`, byFormat: { reel: "SFC" }, affectsPayment: true },
      // targets carry NO payment flag at all (warning-only); the Agreement stored affectsPayment as the literal false
      targets: SAMPLE_TARGETS.map(({ affectsPayment, ...target }) => {
        expect(affectsPayment).toBe(false);
        return target;
      }),
    });
    // it passes the strict Partner Reviews schema (a stricter re-parse of exactly what was returned)
    expect(governingCommercialPolicySchema.safeParse(policy).success).toBe(true);
    expect(JSON.stringify(policy)).not.toContain("affectsPayment\":false");
    // the provider alias is the same function
    expect(await agreementCommercialPolicyProvider(partner.partnerRef, PERIOD)).toEqual(policy);
  });

  it("the required count is offered ONLY with a unit Partner Reviews supports; LFC/SFC only when explicit; targets only when present", async () => {
    const partner = await seedPartner();
    const unsupported = await activeAgreement(
      partner,
      decisionsWith({
        ...POLICY_TERMS(),
        qualifyingUnit: { fieldKey: "qualifyingUnit", decision: "CORRECTED", value: "reel" }, // free text Partner Reviews cannot evaluate
        lfcSfc: { fieldKey: "lfcSfc", decision: "UNAVAILABLE" },
        performanceTargets: { fieldKey: "performanceTargets", decision: "NOT_APPLICABLE" },
      }),
    );
    // the confirmed terms DO carry a count and a unit ...
    expect(unsupported.selectedVersion!.terms!.commercial).toMatchObject({ monthlyRequiredQualifyingContentCount: 2, qualifyingUnit: "reel", lfcSfc: null });
    // ... but the policy leaves the requirement out (never guessed or mapped), has no LFC/SFC rule and no targets
    expect(await getAgreementCommercialPolicy(partner.partnerRef, PERIOD)).toEqual({ agreementRef: unsupported.head.agreementRef, agreementVersion: 1 });

    const second = await seedPartner();
    const noCount = await activeAgreement(
      second,
      decisionsWith({
        ...POLICY_TERMS(),
        monthlyRequiredQualifyingContentCount: { fieldKey: "monthlyRequiredQualifyingContentCount", decision: "UNAVAILABLE" },
        qualifyingUnit: { fieldKey: "qualifyingUnit", decision: "UNAVAILABLE" },
      }),
    );
    const policy = await getAgreementCommercialPolicy(second.partnerRef, PERIOD);
    expect(policy).toMatchObject({ agreementRef: noCount.head.agreementRef, agreementVersion: 1 });
    expect(policy).not.toHaveProperty("monthlyDeliverableRequirement");
    expect(policy).toHaveProperty("lfcSfcRule");
  });

  it("a Vendor Agreement never yields a Partner policy", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const vendor = await seedVendor();
    const clientRequestId = `crid-${runId}-vendor-${randomUUID().slice(0, 6)}`;
    const created = must(await createAgreementDraft(manager, { clientRequestId, counterparty: { type: "VENDOR", vendorRef: vendor.vendorRef } }, requestId()), "create vendor agreement");
    agreementRefs.push(created.agreement.head.agreementRef);
    claimIds.push(agreementClaimId(manager.uid, clientRequestId));
    const confirmed = await confirm(manager, await acceptPending(manager, await decideAll(manager, created.agreement, decisionsWith(POLICY_TERMS()))));
    const active = await activate(head, confirmed);
    expect(active.head).toMatchObject({ status: "ACTIVE", counterparty: { type: "VENDOR" } });

    // asked with the Vendor's own ref (which is not a Partner) and for a Partner that has no Agreement of its own
    expect(await getAgreementCommercialPolicy(vendor.vendorRef, PERIOD)).toBeNull();
    expect(await getAgreementCommercialPolicy((await seedPartner()).partnerRef, PERIOD)).toBeNull();
  });

  it("the governing-version rule: whole-month coverage, DRAFT never governs, ACTIVE / SUSPENDED do, ENDED only up to its end, SUPERSEDED only before its successor", async () => {
    const head = await actorFor("partnership_head");
    const partner = await seedPartner();
    const confirmed = await confirmedAgreement(partner, decisionsWith(POLICY_TERMS()));
    const ref = confirmed.head.agreementRef;
    const at = (period: string) => getAgreementCommercialPolicy(partner.partnerRef, period);

    // a confirmed-but-not-activated DRAFT never governs
    expect(await at(PERIOD)).toBeNull();

    // ACTIVE, range 2019-01-01 .. 2019-12-31: a month is governed only when the WHOLE month is inside the range
    const active = await activate(head, confirmed);
    expect(await at("2019-01")).toMatchObject({ agreementRef: ref, agreementVersion: 1 });
    expect(await at("2019-12")).toMatchObject({ agreementRef: ref, agreementVersion: 1 });
    expect(await at("2018-12")).toBeNull();
    expect(await at("2020-01")).toBeNull();

    // SUSPENDED keeps governing (a suspension is an operational hold, not a change of terms)
    const suspended = must(await suspendAgreement(head, { agreementRef: ref, expectedDocVersion: active.head.docVersion, reason: "Audit hold" }, requestId()), "suspend");
    expect(suspended.head.status).toBe("SUSPENDED");
    expect(await at(PERIOD)).toMatchObject({ agreementRef: ref, agreementVersion: 1 });

    // ENDED: governs the months up to the date it ended (here: now, long after the range) ...
    const ended = must(await endAgreement(head, { agreementRef: ref, expectedDocVersion: suspended.head.docVersion, reason: "Contract closed" }, requestId()), "end");
    expect(ended.head.status).toBe("ENDED");
    expect(await at(PERIOD)).toMatchObject({ agreementRef: ref, agreementVersion: 1 });
    // ... and NOT the months after an early end (endedAt moved back to 2019-03-10 on the stored version)
    await financeAgreementVersionsCollection(ref).doc("1").update({ endedAt: "2019-03-10T00:00:00.000Z" });
    expect(await at("2019-02")).toMatchObject({ agreementRef: ref, agreementVersion: 1 });
    expect(await at("2019-03")).toBeNull();
    expect(await at("2019-04")).toBeNull();
  });

  it("an Agreement that starts (or is open-ended) mid-range: partial months are not governed; an open-ended range governs later months", async () => {
    const partner = await seedPartner();
    await activeAgreement(
      partner,
      decisionsWith({
        ...POLICY_TERMS(),
        effectiveDate: { fieldKey: "effectiveDate", decision: "CORRECTED", value: "2019-02-15" },
        terminationDate: { fieldKey: "terminationDate", decision: "UNAVAILABLE" },
      }),
    );
    expect(await getAgreementCommercialPolicy(partner.partnerRef, "2019-02")).toBeNull(); // starts on the 15th: no requirement for a partial month
    expect(await getAgreementCommercialPolicy(partner.partnerRef, "2019-03")).toMatchObject({ agreementVersion: 1 });
    expect(await getAgreementCommercialPolicy(partner.partnerRef, "2031-07")).toMatchObject({ agreementVersion: 1 }); // open-ended
  });

  it("revisions: the highest covering version wins; a same-dates correction supersedes v1 entirely; a forward revision leaves v1 governing the months BEFORE it (historical reviews keep their Agreement)", async () => {
    const partner = await seedPartner();
    const v1 = await activeAgreement(partner, decisionsWith(POLICY_TERMS()));
    const ref = v1.head.agreementRef;
    const at = (period: string) => getAgreementCommercialPolicy(partner.partnerRef, period);
    expect(await at(PERIOD)).toMatchObject({ agreementVersion: 1, monthlyDeliverableRequirement: { requiredCount: 2 } });

    // v2: same dates, requirement 3 => v2 governs every month v1 did; v1 is SUPERSEDED and governs nothing
    const v2 = await reviseAndActivate(v1, [{ fieldKey: "monthlyRequiredQualifyingContentCount", decision: "CORRECTED", value: 3 }]);
    expect(v2.head).toMatchObject({ activeVersion: 2 });
    expect((await financeAgreementVersionsCollection(ref).doc("1").get()).data()).toMatchObject({ status: "SUPERSEDED", supersededByVersion: 2 });
    expect(await at(PERIOD)).toMatchObject({ agreementRef: ref, agreementVersion: 2, monthlyDeliverableRequirement: { requiredCount: 3 } });

    // v3: forward revision effective 2019-07-15 => v1/v2 are not both needed: v2 (SUPERSEDED by v3) governs up to 2019-07-14
    const v3 = await reviseAndActivate(v2, [{ fieldKey: "effectiveDate", decision: "CORRECTED", value: "2019-07-15" }, { fieldKey: "monthlyRequiredQualifyingContentCount", decision: "CORRECTED", value: 5 }]);
    expect(v3.head.activeVersion).toBe(3);
    expect(await at("2019-06")).toMatchObject({ agreementVersion: 2, monthlyDeliverableRequirement: { requiredCount: 3 } });
    expect(await at("2019-07")).toBeNull(); // straddles the change: neither version covers the whole month
    expect(await at("2019-08")).toMatchObject({ agreementVersion: 3, monthlyDeliverableRequirement: { requiredCount: 5 } });
  });

  it("two DIFFERENT Agreements of one Partner governing the same month is ambiguous and FAILS LOUD (never picks one silently)", async () => {
    const partner = await seedPartner();
    await activeAgreement(partner, decisionsWith(POLICY_TERMS()));
    await activeAgreement(partner, decisionsWith(POLICY_TERMS()));
    await expect(getAgreementCommercialPolicy(partner.partnerRef, PERIOD)).rejects.toBeInstanceOf(AgreementPolicyError);
    // a month only one of them covers is unambiguous... (both cover 2019, so 2018 stays null)
    expect(await getAgreementCommercialPolicy(partner.partnerRef, "2018-06")).toBeNull();
  });

  it("an Agreement head whose stored partner uid is not the live Partner's uid is ignored (a forged / stale head governs nothing)", async () => {
    const partner = await seedPartner();
    const active = await activeAgreement(partner, decisionsWith(POLICY_TERMS()));
    expect(await getAgreementCommercialPolicy(partner.partnerRef, PERIOD)).not.toBeNull();
    await financeAgreementsCollection().doc(active.head.agreementRef).update({ partnerUid: `other-${randomUUID()}` });
    expect(await getAgreementCommercialPolicy(partner.partnerRef, PERIOD)).toBeNull();
  });

  it("deterministic: repeated calls return identical output (time-independence is pinned statically: the adapter source reads no clock)", async () => {
    const partner = await seedPartner();
    await activeAgreement(partner, decisionsWith(POLICY_TERMS()));
    const first = await getAgreementCommercialPolicy(partner.partnerRef, PERIOD);
    expect(first).not.toBeNull();
    for (let call = 0; call < 3; call += 1) expect(JSON.stringify(await getAgreementCommercialPolicy(partner.partnerRef, PERIOD))).toBe(JSON.stringify(first));
  });
});

// =====================================================================================================================
describe("Partner Reviews picks the Agreement policy up through the provider seam", () => {
  beforeEach(() => {
    setCommercialPolicyProviderForTests(agreementCommercialPolicyProvider);
  });

  const storedVersion = async (reviewRef: string, version = 1) => (await partnerReviewVersionsCollection(reviewRef).doc(String(version)).get()).data() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const track = (reviewRef: string) => reviewRefs.add(reviewRef);

  it("generate: governingAgreement + the required count + explicit LFC/SFC + warning-only targets; a new governing version changes the fingerprint and provenance; generate / refresh / submit / finalize / handoff write NOTHING to Finance", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const admin = await actorFor("super_admin");
    const partner = await seedPartner();
    await seedEvidence(partner);
    const v1 = await activeAgreement(partner, decisionsWith(POLICY_TERMS()));
    const ref = v1.head.agreementRef;

    // --- generate: the Agreement governs the month (only the review call is instrumented)
    const io = instrumentWrites();
    let reviewRef = "";
    let fingerprint1 = "";
    try {
      const generated = await generatePartnerReviewDraft(manager, { partnerRef: partner.partnerRef, periodKey: PERIOD }, requestId());
      if (!generated.ok) throw new Error(`generate: ${generated.code} ${generated.message}`);
      reviewRef = generated.data.review.head.reviewRef;
      track(reviewRef);
      const stored1 = await storedVersion(reviewRef);
      fingerprint1 = stored1.sourceFingerprint;
      const commercial1 = stored1.snapshot.commercial;
      expect(commercial1.governingAgreement).toEqual({ agreementRef: ref, agreementVersion: 1 });
      // the required count is now AVAILABLE (2 units of approved_content_thread) and evaluated against real evidence (1 approved thread)
      expect(commercial1.monthlyDeliverable).toMatchObject({ requiredCount: 2, qualifyingUnit: SUPPORTED_UNIT, actualQualifyingCount: 1, variance: -1, evaluation: "below_requirement", unavailableReason: null, requirementSource: { agreementRef: ref, agreementVersion: 1, requirementSourceRef: `${ref}@1` } });
      // an explicit rule exists, so LFC/SFC is evaluated (the reel thread is SFC)
      expect(commercial1.lfcSfc).toMatchObject({ status: "evaluated", ruleRef: `${ref}@1:lfc-sfc`, sfcCount: 1, lfcCount: 0 });
      // the target stays warning-only
      expect(commercial1.targets).toHaveLength(1);
      for (const target of commercial1.targets as Array<{ affectsPayment: boolean; targetRef: string }>) expect(target.affectsPayment).toBe(false);
      expect(generated.data.review.selectedVersion!.snapshot.commercial.governingAgreement).toMatchObject({ agreementRef: ref, agreementVersion: 1 });
    } finally {
      io.stop();
    }

    // --- upstream: Agreement v2 (requirement 3) is activated (the test's own Finance writes, not instrumented)
    const v2 = await reviseAndActivate(v1, [{ fieldKey: "monthlyRequiredQualifyingContentCount", decision: "CORRECTED", value: 3 }]);
    expect(v2.head.activeVersion).toBe(2);

    const io2 = instrumentWrites();
    try {
      const freshness = await inspectPartnerReviewFreshness(manager, reviewRef);
      if (!freshness.ok) throw new Error(`freshness: ${freshness.code}`);
      expect(freshness.data.freshness.state).not.toBe("current");

      const before = await getPartnerReview(manager, reviewRef);
      if (!before.ok) throw new Error("read review");
      const refreshed = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: before.data.selectedVersion!.docVersion }, requestId());
      if (!refreshed.ok) throw new Error(`refresh: ${refreshed.code} ${refreshed.message}`);
      const stored2 = await storedVersion(reviewRef);
      // the source fingerprint (provenance) CHANGED because the governing Agreement version changed
      expect(stored2.sourceFingerprint).not.toBe(fingerprint1);
      expect(stored2.snapshot.commercial.governingAgreement).toEqual({ agreementRef: ref, agreementVersion: 2 });
      expect(stored2.snapshot.commercial.monthlyDeliverable).toMatchObject({ requiredCount: 3, variance: -2, evaluation: "below_requirement", requirementSource: { agreementRef: ref, agreementVersion: 2, requirementSourceRef: `${ref}@2` } });
      expect(refreshed.data.selectedVersion!.sourceFingerprint).toBe(stored2.sourceFingerprint);
      // (evidence_incomplete is the fixture's own state - it has no analytics; what matters is that it is no longer stale)
      expect(refreshed.data.freshness?.state).toMatch(/^(current|evidence_incomplete)$/);

      // --- submit, finalize (Head), handoff: still no Finance write
      const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: refreshed.data.selectedVersion!.docVersion }, requestId());
      if (!submitted.ok) throw new Error(`submit: ${submitted.message}`);
      const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, requestId());
      if (!finalized.ok) throw new Error(`finalize: ${finalized.message}`);
      const handoff = await getFinalizedReviewHandoff(admin, reviewRef);
      if (!handoff.ok) throw new Error(`handoff: ${handoff.message}`);
      expect(handoff.data.governingAgreement).toEqual({ agreementRef: ref, agreementVersion: 2 });
      expect(handoff.data.paymentAffectingEvidence.monthlyDeliverable).toMatchObject({ requiredCount: 3, requirementSource: { agreementRef: ref, agreementVersion: 2 } });
      for (const target of handoff.data.warningOnlyTargets) expect(target.affectsPayment).toBe(false);
    } finally {
      io2.stop();
    }

    // Review generation / refresh / finalization wrote Partner Review documents only - nothing under any financeAgreements* / financeContract* collection
    expect(io2.paths.length).toBeGreaterThan(3);
    expect(io2.paths.filter((path) => /^(financeAgreement|financeContract)/.test(path))).toEqual([]);
    for (const path of io2.paths) expect(path.startsWith(`${PARTNER_REVIEWS_COLLECTIONS.partnerReviews}/`)).toBe(true);
    expect(io.paths.filter((path) => /^(financeAgreement|financeContract)/.test(path))).toEqual([]);
  });

  it("a revision of a FINALIZED review keeps the Agreement version it was finalized under until refreshed (currency is per version)", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const partner = await seedPartner();
    await seedEvidence(partner);
    const v1 = await activeAgreement(partner, decisionsWith(POLICY_TERMS()));
    const ref = v1.head.agreementRef;

    const generated = await generatePartnerReviewDraft(manager, { partnerRef: partner.partnerRef, periodKey: PERIOD }, requestId());
    if (!generated.ok) throw new Error(generated.message);
    const reviewRef = generated.data.review.head.reviewRef;
    track(reviewRef);
    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: generated.data.review.selectedVersion!.docVersion }, requestId());
    if (!submitted.ok) throw new Error(submitted.message);
    const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, requestId());
    if (!finalized.ok) throw new Error(finalized.message);
    const finalizedFingerprint = (await storedVersion(reviewRef)).sourceFingerprint;

    // the Agreement moves on to v2; the FINALIZED version is immutable and still names v1
    await reviseAndActivate(v1, [{ fieldKey: "monthlyRequiredQualifyingContentCount", decision: "CORRECTED", value: 4 }]);
    const afterAgreementChange = await storedVersion(reviewRef);
    expect(afterAgreementChange.sourceFingerprint).toBe(finalizedFingerprint);
    expect(afterAgreementChange.snapshot.commercial.governingAgreement).toEqual({ agreementRef: ref, agreementVersion: 1 });

    // a new review version picks the current governing Agreement up
    const freshness = await inspectPartnerReviewFreshness(manager, reviewRef);
    if (!freshness.ok) throw new Error(freshness.message);
    expect(freshness.data.freshness.state).not.toBe("current");
    const revision = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: finalized.data.head.docVersion }, requestId());
    if (!revision.ok) throw new Error(`revision: ${revision.code} ${revision.message}`);
    const version2 = await storedVersion(reviewRef, 2);
    expect(version2.snapshot.commercial.governingAgreement).toEqual({ agreementRef: ref, agreementVersion: 2 });
    expect(version2.snapshot.commercial.monthlyDeliverable).toMatchObject({ requiredCount: 4 });
    expect(version2.sourceFingerprint).not.toBe(finalizedFingerprint);
    // and the finalized version 1 is untouched
    expect((await storedVersion(reviewRef, 1)).sourceFingerprint).toBe(finalizedFingerprint);
  });

  it("with an Agreement but no supported unit / no rule, the review's requirement and LFC/SFC stay honestly unavailable - then become available when a revision states them", async () => {
    const manager = await actorFor("partnership_manager");
    const partner = await seedPartner();
    await seedEvidence(partner);
    const v1 = await activeAgreement(
      partner,
      decisionsWith({
        ...POLICY_TERMS(),
        qualifyingUnit: { fieldKey: "qualifyingUnit", decision: "CORRECTED", value: "reel" },
        lfcSfc: { fieldKey: "lfcSfc", decision: "UNAVAILABLE" },
        performanceTargets: { fieldKey: "performanceTargets", decision: "NOT_APPLICABLE" },
      }),
    );
    const ref = v1.head.agreementRef;

    const generated = await generatePartnerReviewDraft(manager, { partnerRef: partner.partnerRef, periodKey: PERIOD }, requestId());
    if (!generated.ok) throw new Error(generated.message);
    const reviewRef = generated.data.review.head.reviewRef;
    track(reviewRef);
    const commercial1 = (await storedVersion(reviewRef)).snapshot.commercial;
    // the Agreement governs (identity present) but supplies no evaluable requirement, no rule, no targets
    expect(commercial1.governingAgreement).toEqual({ agreementRef: ref, agreementVersion: 1 });
    expect(commercial1.monthlyDeliverable).toMatchObject({ requiredCount: null, evaluation: "unavailable", unavailableReason: "no_agreement_requirement" });
    expect(commercial1.lfcSfc).toMatchObject({ status: "unavailable", lfcCount: null, sfcCount: null });
    expect(commercial1.targets).toEqual([]);

    await reviseAndActivate(v1, [
      { fieldKey: "qualifyingUnit", decision: "CORRECTED", value: SUPPORTED_UNIT },
      { fieldKey: "lfcSfc", decision: "CORRECTED", value: { byFormat: { reel: "LFC" } } },
    ]);
    const detail = await getPartnerReview(manager, reviewRef);
    if (!detail.ok) throw new Error(detail.message);
    const refreshed = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: detail.data.selectedVersion!.docVersion }, requestId());
    if (!refreshed.ok) throw new Error(refreshed.message);
    const commercial2 = (await storedVersion(reviewRef)).snapshot.commercial;
    expect(commercial2.governingAgreement).toEqual({ agreementRef: ref, agreementVersion: 2 });
    expect(commercial2.monthlyDeliverable).toMatchObject({ requiredCount: 2, evaluation: "below_requirement" });
    expect(commercial2.lfcSfc).toMatchObject({ status: "evaluated", lfcCount: 1, sfcCount: 0 });
  });

  it("a Partner with no Agreement keeps the all-unavailable shape - the adapter changes nothing for a Partner without one", async () => {
    const manager = await actorFor("partnership_manager");
    const partner = await seedPartner();
    await seedEvidence(partner);
    const generated = await generatePartnerReviewDraft(manager, { partnerRef: partner.partnerRef, periodKey: PERIOD }, requestId());
    if (!generated.ok) throw new Error(generated.message);
    track(generated.data.review.head.reviewRef);
    const commercial = (await storedVersion(generated.data.review.head.reviewRef)).snapshot.commercial;
    expect(commercial.governingAgreement).toBeNull();
    expect(commercial.monthlyDeliverable).toMatchObject({ requiredCount: null, evaluation: "unavailable", unavailableReason: "no_agreement_requirement" });
    expect(commercial.lfcSfc).toMatchObject({ status: "unavailable" });
  });
});
