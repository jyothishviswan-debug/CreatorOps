// Step 14C: the shared emulator harness of the commercial-policy certification tests (applicability against the REAL adapter, and
// Partner Reviews integration through the REAL registration path). Test support only - it lives under testing/, which the
// production static scans skip. Hermetic: every Partner / Vendor has a unique uid/ref, Agreement dates are in 2019, review
// evidence carries a private region, and everything created is removed by teardown().
import { randomUUID } from "node:crypto";

import { DocumentReference, Transaction, WriteBatch } from "firebase-admin/firestore";
import { vi } from "vitest";

import { assignmentsCollection } from "@/server/assignments/firestore";
import { assignmentBriefSchema, assignmentDocSchema } from "@/server/assignments/types";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { contentCollection } from "@/server/content/firestore";
import { contentDocSchema } from "@/server/content/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { partnerReviewsCollection } from "@/server/partner-reviews/firestore";
import { partnersCollection } from "@/server/partners/firestore";
import { partnerDocSchema, type PartnerDoc } from "@/server/partners/types";
import { vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema, type VendorDoc } from "@/server/vendors/types";

import { activateAgreementVersion, confirmAgreementVersion, createAgreementDraft, createAgreementRevision, decideField, type AgreementDetailDto } from "../index";
import { agreementClaimId, financeAgreementClaimsCollection, financeAgreementsCollection } from "../firestore";
import type { AgreementCounterpartyInput, FinanceAgreementsServiceResult } from "../types";
import { READY_DECISIONS, type FieldDecisionSeed } from "./agreement-service-fixtures";

export const SUPPORTED_UNIT = "approved_content_thread";
export const DEFAULT_PERIOD = "2019-03";
// A distinctive fixed amount / incentive: proof that no money reaches Partner Reviews searches for these tokens.
export const FIXED_AMOUNT_MINOR = 7_654_321;
export const INCENTIVE_AMOUNT_MINOR = 250_000;

export type SeedEvidenceOptions = { period?: string; count?: number; formats?: string[]; threadStatus?: "APPROVED" | "UNDER_REVIEW" };

export function createPolicyHarness(tag: string) {
  const runId = Date.now();
  const PRIVATE_REGION = `${tag}-private-${runId}`;
  const uidByRole = new Map<string, string>();
  const cleanup: FirebaseFirestore.DocumentReference[] = [];
  const agreementRefs: string[] = [];
  const claimIds: string[] = [];
  const reviewRefs = new Set<string>();
  let counter = 0;
  let reqCounter = 0;

  async function setup(): Promise<void> {
    const password = process.env.EMULATOR_TEST_USER_PASSWORD;
    if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
    await seedEmulatorTestUsers(password);
    await seedAccessControlData();
    const auth = getAdminAuth();
    for (const identity of TEST_IDENTITIES) uidByRole.set(identity.role, (await auth.getUserByEmail(identity.email)).uid);
  }

  async function teardown(): Promise<void> {
    const db = getAdminFirestore();
    for (const ref of agreementRefs.splice(0)) await db.recursiveDelete(financeAgreementsCollection().doc(ref));
    await Promise.all(claimIds.splice(0).map((id) => financeAgreementClaimsCollection().doc(id).delete()));
    for (const reviewRef of reviewRefs) await db.recursiveDelete(partnerReviewsCollection().doc(reviewRef));
    await Promise.all(cleanup.splice(0).map((ref) => ref.delete()));
  }

  async function actorFor(role: string): Promise<ActorContext> {
    const actor = await resolveActor(uidByRole.get(role)!);
    if (!actor) throw new Error(`no seeded actor for ${role}`);
    return actor;
  }

  const requestId = () => `${tag}-req-${runId}-${(reqCounter += 1)}`;
  const trackReview = (reviewRef: string) => reviewRefs.add(reviewRef);

  // ---- Fixtures ---------------------------------------------------------------------------------------------------------
  async function seedPartner(): Promise<PartnerDoc> {
    counter += 1;
    const uid = `${tag}-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
    const now = new Date().toISOString();
    const partner = partnerDocSchema.parse({
      uid,
      partnerRef: uid,
      version: 1,
      displayName: `${tag} Partner ${counter}`,
      displayNameLower: `${tag} partner ${counter}`,
      legalName: null,
      email: `${uid}@example-partner.test`,
      phone: "+91 90000 00088",
      status: "ACTIVE",
      regionIds: ["Kerala"],
      createdAt: now,
      createdByUserRef: `${tag}-test`,
      updatedAt: now,
      updatedByUserRef: `${tag}-test`,
    });
    const ref = partnersCollection().doc(uid);
    await ref.set(partner);
    cleanup.push(ref);
    return partner;
  }

  async function seedVendor(): Promise<VendorDoc> {
    counter += 1;
    const uid = `${tag}-vendor-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
    const now = new Date().toISOString();
    const vendor = vendorDocSchema.parse({
      uid,
      vendorRef: uid,
      version: 1,
      displayName: `${tag} Vendor ${counter}`,
      displayNameLower: `${tag} vendor ${counter}`,
      vendorType: "AGENCY",
      email: `${uid}@example-vendor.test`,
      status: "ACTIVE",
      regionIds: ["Kerala"],
      createdAt: now,
      createdByUserRef: `${tag}-test`,
      updatedAt: now,
      updatedByUserRef: `${tag}-test`,
    });
    const ref = vendorsCollection().doc(uid);
    await ref.set(vendor);
    cleanup.push(ref);
    return vendor;
  }

  // `count` in-period Assignments (each with one link and a thread in `threadStatus`) for the review evidence.
  async function seedEvidence(partner: PartnerDoc, options: SeedEvidenceOptions = {}): Promise<void> {
    const period = options.period ?? DEFAULT_PERIOD;
    const count = options.count ?? 1;
    const formats = options.formats ?? ["reel"];
    const threadStatus = options.threadStatus ?? "APPROVED";
    for (let index = 0; index < count; index += 1) {
      const uid = assignmentsCollection().doc().id;
      const now = new Date().toISOString();
      const assignment = assignmentDocSchema.parse({
        uid,
        assignmentRef: `${tag}-as-${uid}`,
        version: 1,
        campaignRef: `${tag}-camp-${runId}`,
        partnerRef: partner.partnerRef,
        partnerAccountRefs: [],
        status: "IN_PROGRESS",
        statusReason: null,
        brief: assignmentBriefSchema.parse({ dueAt: `${period}-10`, requiredCount: 2, formats, platforms: ["instagram"], reviewPolicy: "REVIEW_REQUIRED", campaignName: `${tag} Campaign` }),
        ownerUid: null,
        regionIds: [PRIVATE_REGION],
        teamIds: [],
        createdAt: "2019-01-05T08:00:00.000Z",
        createdByUserRef: `${tag}-test`,
        updatedAt: now,
        updatedByUserRef: `${tag}-test`,
      });
      const assignmentRef = assignmentsCollection().doc(uid);
      await assignmentRef.set(assignment);
      cleanup.push(assignmentRef);

      const threadUid = contentCollection().doc().id;
      const approved = threadStatus === "APPROVED";
      const thread = contentDocSchema.parse({
        uid: threadUid,
        contentRef: `${tag}-ct-${threadUid}`,
        version: 3,
        assignmentRef: assignment.assignmentRef,
        campaignRef: assignment.campaignRef,
        partnerRef: partner.partnerRef,
        status: threadStatus,
        statusReason: null,
        currentRevisionNumber: 1,
        reviewedRevisionNumber: approved ? 1 : null,
        currentLinks: [{ platform: "instagram", originalUrl: `https://instagram.com/p/${tag}${threadUid}`, normalizedUrl: `https://instagram.com/p/${tag}${threadUid.toLowerCase()}`, recordedAt: `${period}-08T10:00:00.000Z` }],
        qualifyingFulfillment: null,
        dueAt: null,
        openedAt: `${period}-01T00:00:00.000Z`,
        firstSubmittedAt: `${period}-08T10:00:00.000Z`,
        lastSubmittedAt: `${period}-08T10:00:00.000Z`,
        approvedAt: approved ? `${period}-09T00:00:00.000Z` : null,
        cancelledAt: null,
        ownerUid: null,
        regionIds: [PRIVATE_REGION],
        teamIds: [],
        createdAt: `${period}-01T00:00:00.000Z`,
        createdByUserRef: `${tag}-test`,
        updatedAt: `${period}-08T10:00:00.000Z`,
        updatedByUserRef: `${tag}-test`,
      });
      const threadRef = contentCollection().doc(threadUid);
      await threadRef.set(thread);
      cleanup.push(threadRef);
    }
  }

  // ---- Agreement helpers (real services) ------------------------------------------------------------------------------------
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

  // The default policy-bearing terms: 2 required units of a SUPPORTED unit, effective 2019-01-01 .. 2019-12-31 (the fixed
  // component, the incentive, the currency and the payment terms come from READY_DECISIONS and must NEVER reach Partner Reviews).
  const policyTerms = (over: Record<string, FieldDecisionSeed | null> = {}): Record<string, FieldDecisionSeed | null> => ({
    effectiveDate: { fieldKey: "effectiveDate", decision: "CORRECTED", value: "2019-01-01" },
    terminationDate: { fieldKey: "terminationDate", decision: "CORRECTED", value: "2019-12-31" },
    qualifyingUnit: { fieldKey: "qualifyingUnit", decision: "CORRECTED", value: SUPPORTED_UNIT },
    monthlyRequiredQualifyingContentCount: { fieldKey: "monthlyRequiredQualifyingContentCount", decision: "CORRECTED", value: 2 },
    fixedComponent: { fieldKey: "fixedComponent", decision: "CORRECTED", value: { applicable: true, amountMinor: FIXED_AMOUNT_MINOR } },
    ...over,
  });
  const seed = (fieldKey: FieldDecisionSeed["fieldKey"], value: unknown): FieldDecisionSeed => ({ fieldKey, decision: "CORRECTED", value });
  const decide = (fieldKey: FieldDecisionSeed["fieldKey"], decision: FieldDecisionSeed["decision"]): FieldDecisionSeed => ({ fieldKey, decision });

  async function decideAll(actor: ActorContext, detail: AgreementDetailDto, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
    let current = detail;
    for (const item of seeds) {
      current = must(
        await decideField(actor, { agreementRef: current.head.agreementRef, version: current.selectedVersion!.version, expectedDocVersion: current.selectedVersion!.docVersion, fieldKey: item.fieldKey, decision: item.decision, ...(item.value !== undefined ? { value: item.value } : {}) }, requestId()),
        `decide ${item.fieldKey}`,
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

  // A tracked (cleaned-up) DRAFT for any counterparty.
  async function createDraft(counterparty: AgreementCounterpartyInput): Promise<AgreementDetailDto> {
    const manager = await actorFor("partnership_manager");
    const clientRequestId = `crid-${runId}-${(counter += 1)}-${randomUUID().slice(0, 6)}`;
    const created = must(await createAgreementDraft(manager, { clientRequestId, counterparty }, requestId()), "create");
    agreementRefs.push(created.agreement.head.agreementRef);
    claimIds.push(agreementClaimId(manager.uid, clientRequestId));
    return created.agreement;
  }

  // create -> decide -> accept pending -> confirm (a DRAFT that is confirmed, not yet operational).
  async function confirmedAgreement(partner: PartnerDoc, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
    const manager = await actorFor("partnership_manager");
    const created = await createDraft(partnerCp(partner));
    return confirm(manager, await acceptPending(manager, await decideAll(manager, created, seeds)));
  }

  async function activeAgreement(partner: PartnerDoc, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
    return activate(await actorFor("partnership_head"), await confirmedAgreement(partner, seeds));
  }

  // A revision of the ACTIVE version: prefilled, then the named decisions, confirmed by the Manager (NOT activated).
  async function reviseAndConfirm(detail: AgreementDetailDto, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const revised = must(await createAgreementRevision(head, { agreementRef: detail.head.agreementRef, expectedDocVersion: detail.head.docVersion }, requestId()), "revise");
    return confirm(manager, await decideAll(manager, revised, seeds));
  }

  // ... and activated by the Head.
  async function reviseAndActivate(detail: AgreementDetailDto, seeds: FieldDecisionSeed[]): Promise<AgreementDetailDto> {
    return activate(await actorFor("partnership_head"), await reviseAndConfirm(detail, seeds));
  }

  // ---- Firestore write instrumentation ----------------------------------------------------------------------------------------
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

  return {
    runId,
    PRIVATE_REGION,
    setup,
    teardown,
    actorFor,
    requestId,
    trackReview,
    seedPartner,
    seedVendor,
    seedEvidence,
    partnerCp,
    must,
    decisionsWith,
    policyTerms,
    seed,
    decide,
    decideAll,
    acceptPending,
    confirm,
    activate,
    createDraft,
    confirmedAgreement,
    activeAgreement,
    reviseAndConfirm,
    reviseAndActivate,
    instrumentWrites,
    agreementRefs,
  };
}

export type PolicyHarness = ReturnType<typeof createPolicyHarness>;
