// Step 14C section 3 - the Partner / Vendor DEPENDENCY GUARD against the running Firestore/Auth emulator (real services, no mocks).
//
// A Partner / Vendor with an ACTIVE or SUSPENDED Agreement cannot be ARCHIVED (or, for a Partner, BLACKLISTED); the Agreement is
// never auto-ended; DRAFT / ENDED / superseded-history Agreements do not block; the reversible INACTIVE deactivation, restore and
// every other transition are unaffected; a failed / unrecognisable lookup blocks (unknown blocks). The guard is wired through the
// PRODUCTION composition point (registerServerProviders) - the owning modules never import Finance.
//
// Hermetic: every Partner / Vendor is created through the owning service with a unique name; Agreements, claims and the seeded
// Partner / Vendor documents are removed afterwards. The registry is EMPTY except where a test registers into it, and is cleared
// afterwards.
import { randomUUID } from "node:crypto";

import { Query } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { FINANCE_PARTNER_GUARD_ID, FINANCE_VENDOR_GUARD_ID } from "@/server/composition/finance-dependency-guard";
import { registerServerProviders } from "@/server/composition/register-providers";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { archivePartner, blacklistPartner, restorePartner } from "@/server/partners/partner-lifecycle-service";
import { getPartnerDocByRef, partnersCollection } from "@/server/partners/firestore";
import { createPartner, editPartner, setPartnerStatus } from "@/server/partners/partner-service";
import { checkCounterpartyDependencyGuards, clearCounterpartyDependencyGuardsForTests, listCounterpartyDependencyGuardIds, registerCounterpartyDependencyGuard } from "@/server/shared/counterparty-dependency-guards";
import { getVendorDocByRef, vendorsCollection } from "@/server/vendors/firestore";
import { archiveVendor, restoreVendor } from "@/server/vendors/vendor-lifecycle-service";
import { createVendor, editVendor, setVendorStatus } from "@/server/vendors/vendor-service";

import { activateAgreementVersion, confirmAgreementVersion, createAgreementDraft, createAgreementRevision, decideField, endAgreement, resumeAgreement, suspendAgreement, type AgreementDetailDto } from "./index";
import { agreementClaimId, financeAgreementClaimsCollection, financeAgreementsCollection, financeAgreementEventsCollection } from "./firestore";
import { READY_DECISIONS, type FieldDecisionSeed } from "./testing/agreement-service-fixtures";
import type { AgreementCounterpartyInput, FinanceAgreementsServiceResult } from "./types";

vi.setConfig({ testTimeout: 60_000 });

const runId = Date.now();
const uidByRole = new Map<string, string>();
const agreementRefs: string[] = [];
const claimIds: string[] = [];
const strayDocs: FirebaseFirestore.DocumentReference[] = [];
const createdPartnerRefs: string[] = [];
const createdVendorRefs: string[] = [];
let counter = 0;
let reqCounter = 0;
const requestId = () => `dg-req-${runId}-${(reqCounter += 1)}`;
const unique = (prefix: string) => `${prefix} ${runId}-${randomUUID().slice(0, 6)}`;

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  const auth = getAdminAuth();
  for (const identity of TEST_IDENTITIES) uidByRole.set(identity.role, (await auth.getUserByEmail(identity.email)).uid);
  // The production composition path: the same call src/instrumentation.ts makes at server start.
  clearCounterpartyDependencyGuardsForTests();
  registerServerProviders();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  clearCounterpartyDependencyGuardsForTests();
  const db = getAdminFirestore();
  for (const ref of agreementRefs.splice(0)) await db.recursiveDelete(financeAgreementsCollection().doc(ref));
  await Promise.all(claimIds.splice(0).map((id) => financeAgreementClaimsCollection().doc(id).delete()));
  await Promise.all(strayDocs.splice(0).map((ref) => ref.delete()));
  for (const partnerRef of createdPartnerRefs.splice(0)) {
    const doc = await getPartnerDocByRef(partnerRef);
    if (doc) await db.recursiveDelete(partnersCollection().doc(doc.uid));
  }
  for (const vendorRef of createdVendorRefs.splice(0)) {
    const doc = await getVendorDocByRef(vendorRef);
    if (doc) await db.recursiveDelete(vendorsCollection().doc(doc.uid));
  }
});

async function actorFor(role: string): Promise<ActorContext> {
  const actor = await resolveActor(uidByRole.get(role)!);
  if (!actor) throw new Error(`no seeded actor for ${role}`);
  return actor;
}

// ---- Fixtures (real owning services) ----------------------------------------------------------------------------------------
async function newPartner() {
  const head = await actorFor("partnership_head");
  const created = await createPartner(head, { displayName: unique("DG Partner"), regionIds: ["Kerala"] }, requestId());
  if (!created.ok) throw new Error(`createPartner: ${created.message}`);
  createdPartnerRefs.push(created.data.partnerRef);
  return created.data;
}

async function newVendor() {
  const head = await actorFor("partnership_head");
  const created = await createVendor(head, { displayName: unique("DG Vendor"), vendorType: "AGENCY", regionIds: ["Kerala"] }, requestId());
  if (!created.ok) throw new Error(`createVendor: ${created.message}`);
  createdVendorRefs.push(created.data.vendorRef);
  return created.data;
}

function must<T>(result: FinanceAgreementsServiceResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}${result.blockers ? ` ${JSON.stringify(result.blockers)}` : ""}`);
  return result.data;
}

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

// create only: an unconfirmed DRAFT.
async function draftAgreement(counterparty: AgreementCounterpartyInput): Promise<AgreementDetailDto> {
  const manager = await actorFor("partnership_manager");
  const clientRequestId = `dgcrid-${runId}-${(counter += 1)}-${randomUUID().slice(0, 6)}`;
  const created = must(await createAgreementDraft(manager, { clientRequestId, counterparty }, requestId()), "create");
  agreementRefs.push(created.agreement.head.agreementRef);
  claimIds.push(agreementClaimId(manager.uid, clientRequestId));
  return created.agreement;
}

// create -> decide -> accept pending -> confirm (a confirmed DRAFT, not yet operational).
async function confirmedAgreement(counterparty: AgreementCounterpartyInput): Promise<AgreementDetailDto> {
  const manager = await actorFor("partnership_manager");
  return confirm(manager, await acceptPending(manager, await decideAll(manager, await draftAgreement(counterparty), READY_DECISIONS)));
}

async function activeAgreement(counterparty: AgreementCounterpartyInput): Promise<AgreementDetailDto> {
  return activate(await actorFor("partnership_head"), await confirmedAgreement(counterparty));
}

async function endIt(detail: AgreementDetailDto): Promise<AgreementDetailDto> {
  return must(await endAgreement(await actorFor("partnership_head"), { agreementRef: detail.head.agreementRef, expectedDocVersion: detail.head.docVersion, reason: "Contract closed" }, requestId()), "end");
}

async function suspendIt(detail: AgreementDetailDto): Promise<AgreementDetailDto> {
  return must(await suspendAgreement(await actorFor("partnership_head"), { agreementRef: detail.head.agreementRef, expectedDocVersion: detail.head.docVersion, reason: "Audit hold" }, requestId()), "suspend");
}

const partnerCp = (partner: { partnerRef: string }): AgreementCounterpartyInput => ({ type: "PARTNER", partnerRef: partner.partnerRef });
const vendorCp = (vendor: { vendorRef: string }): AgreementCounterpartyInput => ({ type: "VENDOR", vendorRef: vendor.vendorRef });

async function headOf(agreementRef: string) {
  return (await financeAgreementsCollection().doc(agreementRef).get()).data() as { status: string; docVersion: number; activeVersion: number | null };
}
async function eventKinds(agreementRef: string): Promise<string[]> {
  return (await financeAgreementEventsCollection(agreementRef).get()).docs.map((doc) => String(doc.data().kind));
}

// Archive / blacklist through the real lifecycle services; returns the failure (or null when it went through).
async function tryArchivePartner(partner: { partnerRef: string; version: number }) {
  return archivePartner(await actorFor("partnership_head"), partner.partnerRef, { reason: "Guard test", expectedVersion: partner.version }, requestId());
}
async function tryBlacklistPartner(partner: { partnerRef: string; version: number }) {
  return blacklistPartner(await actorFor("partnership_head"), partner.partnerRef, { reason: "Guard test", expectedVersion: partner.version }, requestId());
}
async function tryArchiveVendor(vendor: { vendorRef: string; version: number }) {
  return archiveVendor(await actorFor("partnership_head"), vendor.vendorRef, { reason: "Guard test", expectedVersion: vendor.version }, requestId());
}

function expectBlocked(result: { ok: boolean; code?: string; blockers?: Array<{ code: string; message: string }> }, pattern: RegExp) {
  expect(result.ok).toBe(false);
  expect(result.code).toBe("not_ready");
  expect((result.blockers ?? []).map((blocker) => blocker.message).join(" | ")).toMatch(pattern);
}

// =====================================================================================================================
describe("composition: the guard is registered through registerServerProviders() (idempotent), never by the owning modules", () => {
  it("registers exactly the Finance Partner + Vendor guards, and a repeated call replaces rather than duplicates", () => {
    expect(listCounterpartyDependencyGuardIds()).toEqual([FINANCE_PARTNER_GUARD_ID, FINANCE_VENDOR_GUARD_ID].sort());
    registerServerProviders();
    registerServerProviders();
    expect(listCounterpartyDependencyGuardIds()).toEqual([FINANCE_PARTNER_GUARD_ID, FINANCE_VENDOR_GUARD_ID].sort());
  });

  it("with the registry EMPTY the owning modules behave exactly as before (even with an ACTIVE Agreement) - proof they neither import nor depend on Finance", async () => {
    const partner = await newPartner();
    await activeAgreement(partnerCp(partner));
    clearCounterpartyDependencyGuardsForTests();
    try {
      const archived = await tryArchivePartner(partner);
      expect(archived.ok).toBe(true);
    } finally {
      registerServerProviders();
    }
  });
});

// =====================================================================================================================
describe("Partner: ARCHIVE and BLACKLIST are blocked while an Agreement is ACTIVE or SUSPENDED", () => {
  it("an ACTIVE Agreement blocks archive AND blacklist with the Finance reason; the Partner and the Agreement are untouched (never auto-ended)", async () => {
    const partner = await newPartner();
    const active = await activeAgreement(partnerCp(partner));
    const ref = active.head.agreementRef;
    const eventsBefore = (await eventKinds(ref)).sort();

    const archive = await tryArchivePartner(partner);
    expectBlocked(archive, /This Partner has an active Agreement\. End or supersede the Agreement in Finance before archiving\./);
    expect((archive as { message: string }).message).toBe("This Partner cannot be archived yet.");
    const blacklist = await tryBlacklistPartner(partner);
    expectBlocked(blacklist, /This Partner has an active Agreement\. End or supersede the Agreement in Finance before blacklisting\./);
    expect((blacklist as { message: string }).message).toBe("This Partner cannot be blacklisted yet.");

    // Partner unchanged ...
    const stored = await getPartnerDocByRef(partner.partnerRef);
    expect(stored?.status).toBe("ACTIVE");
    expect(stored?.version).toBe(partner.version);
    // ... and the Agreement is exactly as it was: still ACTIVE, same docVersion, no event appended (nothing auto-ended / auto-suspended).
    expect(await headOf(ref)).toMatchObject({ status: "ACTIVE", docVersion: active.head.docVersion, activeVersion: 1 });
    expect((await eventKinds(ref)).sort()).toEqual(eventsBefore);
  });

  it("a SUSPENDED Agreement blocks archive AND blacklist too", async () => {
    const partner = await newPartner();
    const suspended = await suspendIt(await activeAgreement(partnerCp(partner)));
    expect(suspended.head.status).toBe("SUSPENDED");
    expectBlocked(await tryArchivePartner(partner), /has a suspended Agreement\. End or supersede the Agreement in Finance before archiving\./);
    expectBlocked(await tryBlacklistPartner(partner), /has a suspended Agreement\. End or supersede the Agreement in Finance before blacklisting\./);
    expect(await headOf(suspended.head.agreementRef)).toMatchObject({ status: "SUSPENDED", docVersion: suspended.head.docVersion });
  });

  it("resuming a suspended Agreement keeps blocking; ending it (the deliberate Finance action) releases the block - then archive succeeds, and restore works", async () => {
    const partner = await newPartner();
    const suspended = await suspendIt(await activeAgreement(partnerCp(partner)));
    const resumed = must(await resumeAgreement(await actorFor("partnership_head"), { agreementRef: suspended.head.agreementRef, expectedDocVersion: suspended.head.docVersion }, requestId()), "resume");
    expectBlocked(await tryArchivePartner(partner), /active Agreement/);

    const ended = await endIt(resumed);
    expect(ended.head.status).toBe("ENDED");
    const archived = await tryArchivePartner(partner);
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("unreachable");
    expect(archived.data.status).toBe("ARCHIVED");

    // restore is never guarded: it returns the Partner to its previous status and leaves the ENDED Agreement alone.
    const restored = await restorePartner(await actorFor("partnership_head"), partner.partnerRef, { expectedVersion: archived.data.version }, requestId());
    expect(restored.ok).toBe(true);
    expect(await headOf(ended.head.agreementRef)).toMatchObject({ status: "ENDED" });
  });

  it("a DRAFT-only or confirmed-not-yet-active Agreement does NOT block (nothing operational to orphan)", async () => {
    const draftOnly = await newPartner();
    await draftAgreement(partnerCp(draftOnly));
    expect((await tryArchivePartner(draftOnly)).ok).toBe(true);

    const confirmedOnly = await newPartner();
    const confirmed = await confirmedAgreement(partnerCp(confirmedOnly));
    expect(confirmed.head.status).toBe("DRAFT");
    expect((await tryBlacklistPartner(confirmedOnly)).ok).toBe(true);
  });

  it("an ENDED Agreement does not block; neither does a history of SUPERSEDED versions once the latest version has ended", async () => {
    const endedOnly = await newPartner();
    await endIt(await activeAgreement(partnerCp(endedOnly)));
    expect((await tryArchivePartner(endedOnly)).ok).toBe(true);

    // v1 ACTIVE -> revise -> v2 activated (v1 SUPERSEDED): still governed (blocks) ...
    const superseded = await newPartner();
    const v1 = await activeAgreement(partnerCp(superseded));
    const head = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");
    const revised = must(await createAgreementRevision(head, { agreementRef: v1.head.agreementRef, expectedDocVersion: v1.head.docVersion }, requestId()), "revise");
    const v2 = await activate(head, await confirm(manager, await acceptPending(manager, revised)));
    expect(v2.head).toMatchObject({ status: "ACTIVE", activeVersion: 2 });
    expectBlocked(await tryArchivePartner(superseded), /active Agreement/);
    // ... then v2 ends: only ENDED + SUPERSEDED history remains, which never blocks.
    await endIt(v2);
    expect((await tryBlacklistPartner(superseded)).ok).toBe(true);
  });

  it("only THIS Partner's Agreements count: another Partner's ACTIVE Agreement, and a Vendor's, never block", async () => {
    const other = await newPartner();
    await activeAgreement(partnerCp(other));
    const vendor = await newVendor();
    await activeAgreement(vendorCp(vendor));
    const clean = await newPartner();
    expect((await tryArchivePartner(clean)).ok).toBe(true);
  });
});

// =====================================================================================================================
describe("Vendor: ARCHIVE is blocked while an Agreement is ACTIVE or SUSPENDED", () => {
  it("ACTIVE blocks (Finance reason, Agreement untouched); SUSPENDED blocks; ENDED releases; restore works", async () => {
    const vendor = await newVendor();
    const active = await activeAgreement(vendorCp(vendor));
    const blocked = await tryArchiveVendor(vendor);
    expectBlocked(blocked, /This Vendor has an active Agreement\. End or supersede the Agreement in Finance before archiving\./);
    expect((blocked as { message: string }).message).toBe("This Vendor cannot be archived yet.");
    expect(await headOf(active.head.agreementRef)).toMatchObject({ status: "ACTIVE", docVersion: active.head.docVersion });

    const suspended = await suspendIt(active);
    expectBlocked(await tryArchiveVendor(vendor), /has a suspended Agreement\./);

    const ended = await endIt(suspended);
    const archived = await tryArchiveVendor(vendor);
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("unreachable");
    const restored = await restoreVendor(await actorFor("partnership_head"), vendor.vendorRef, { expectedVersion: archived.data.version }, requestId());
    expect(restored.ok).toBe(true);
    expect(await headOf(ended.head.agreementRef)).toMatchObject({ status: "ENDED" });
  });

  it("a DRAFT-only or confirmed-not-active Agreement does not block; another Vendor's ACTIVE Agreement does not block", async () => {
    const draftOnly = await newVendor();
    await draftAgreement(vendorCp(draftOnly));
    expect((await tryArchiveVendor(draftOnly)).ok).toBe(true);

    const confirmedOnly = await newVendor();
    await confirmedAgreement(vendorCp(confirmedOnly));
    expect((await tryArchiveVendor(confirmedOnly)).ok).toBe(true);

    const other = await newVendor();
    await activeAgreement(vendorCp(other));
    const clean = await newVendor();
    expect((await tryArchiveVendor(clean)).ok).toBe(true);
  });
});

// =====================================================================================================================
describe("INACTIVE (reversible deactivation), edits and restore are NOT guarded", () => {
  it("a Partner with an ACTIVE Agreement can be set INACTIVE and back to ACTIVE, and edited - the Agreement stays ACTIVE", async () => {
    const partner = await newPartner();
    const active = await activeAgreement(partnerCp(partner));
    const head = await actorFor("partnership_head");

    const inactive = await setPartnerStatus(head, partner.partnerRef, { status: "INACTIVE", expectedVersion: partner.version }, requestId());
    expect(inactive.ok).toBe(true);
    if (!inactive.ok) throw new Error("unreachable");
    const back = await setPartnerStatus(head, partner.partnerRef, { status: "ACTIVE", expectedVersion: inactive.data.version }, requestId());
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error("unreachable");
    const edited = await editPartner(head, partner.partnerRef, { legalName: "DG Partner Legal Pvt Ltd", expectedVersion: back.data.version }, requestId());
    expect(edited.ok).toBe(true);
    expect(await headOf(active.head.agreementRef)).toMatchObject({ status: "ACTIVE", docVersion: active.head.docVersion });
  });

  it("an INACTIVE Partner with an ACTIVE Agreement is still blocked from ARCHIVE (the guard follows the Agreement, not the Partner's status)", async () => {
    const partner = await newPartner();
    await activeAgreement(partnerCp(partner));
    const head = await actorFor("partnership_head");
    const inactive = await setPartnerStatus(head, partner.partnerRef, { status: "INACTIVE", expectedVersion: partner.version }, requestId());
    if (!inactive.ok) throw new Error("unreachable");
    expectBlocked(await tryArchivePartner({ partnerRef: partner.partnerRef, version: inactive.data.version }), /active Agreement/);
  });

  it("a Vendor with an ACTIVE Agreement can be set INACTIVE and back, and edited", async () => {
    const vendor = await newVendor();
    await activeAgreement(vendorCp(vendor));
    const head = await actorFor("partnership_head");
    const inactive = await setVendorStatus(head, vendor.vendorRef, { status: "INACTIVE", expectedVersion: vendor.version }, requestId());
    expect(inactive.ok).toBe(true);
    if (!inactive.ok) throw new Error("unreachable");
    const back = await setVendorStatus(head, vendor.vendorRef, { status: "ACTIVE", expectedVersion: inactive.data.version }, requestId());
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error("unreachable");
    expect((await editVendor(head, vendor.vendorRef, { legalName: "DG Vendor Legal", expectedVersion: back.data.version }, requestId())).ok).toBe(true);
  });

  it("restore is never guarded, even while a guard that blocks EVERYTHING is registered", async () => {
    const partner = await newPartner();
    const archived = await tryArchivePartner(partner);
    if (!archived.ok) throw new Error("unreachable");
    registerCounterpartyDependencyGuard({ id: "test.block-everything", counterpartyType: "PARTNER", check: async () => ({ status: "blocked", reason: "always blocked" }) });
    try {
      const restored = await restorePartner(await actorFor("partnership_head"), partner.partnerRef, { expectedVersion: archived.data.version }, requestId());
      expect(restored.ok).toBe(true);
      if (!restored.ok) throw new Error("unreachable");
      // ... while a fresh archive IS refused by the extra guard (proving it is live), reported alongside nothing else.
      expectBlocked(await tryArchivePartner({ partnerRef: partner.partnerRef, version: restored.data.version }), /always blocked/);
    } finally {
      clearCounterpartyDependencyGuardsForTests();
      registerServerProviders();
    }
  });
});

// =====================================================================================================================
describe("unknown blocks: a failed or unrecognisable lookup never reads as safe", () => {
  it("a failing Agreement query blocks Partner archive/blacklist and Vendor archive with an unknown-lookup reason (nothing changes)", async () => {
    const partner = await newPartner();
    const vendor = await newVendor();
    const original = Query.prototype.get;
    let injected = 0;
    vi.spyOn(Query.prototype, "get").mockImplementation(function (this: Query, ...args: []) {
      const collectionId = (this as unknown as { _queryOptions?: { collectionId?: string } })._queryOptions?.collectionId;
      if (collectionId === "financeAgreements") {
        injected += 1;
        return Promise.reject(new Error("simulated Firestore outage"));
      }
      return original.apply(this, args);
    });

    expectBlocked(await tryArchivePartner(partner), /Agreement lookup failed - cannot confirm this Partner has no active Agreement\./);
    expectBlocked(await tryBlacklistPartner(partner), /Agreement lookup failed/);
    expectBlocked(await tryArchiveVendor(vendor), /Agreement lookup failed - cannot confirm this Vendor has no active Agreement\./);
    expect(injected).toBe(3); // the guard really ran its query each time (the block was not incidental)
    vi.restoreAllMocks();

    expect((await checkCounterpartyDependencyGuards("PARTNER", partner.partnerRef, { action: "archive" })).status).toBe("clear");
    expect((await tryArchivePartner(partner)).ok).toBe(true);
  });

  it("a guard that throws blocks (unknown), with a generic reason that leaks nothing", async () => {
    const vendor = await newVendor();
    registerCounterpartyDependencyGuard({ id: "test.throws", counterpartyType: "VENDOR", check: async () => { throw new Error("secret internal detail"); } });
    try {
      const result = await tryArchiveVendor(vendor);
      expectBlocked(result, /dependency lookup failed/i);
      expect(JSON.stringify(result)).not.toMatch(/secret internal detail/);
    } finally {
      clearCounterpartyDependencyGuardsForTests();
      registerServerProviders();
    }
  });

  it("an Agreement head with an unrecognisable status, or more Agreements than can be scanned, is unknown (blocks) - never clear", async () => {
    const strange = await newPartner();
    const strangeRef = financeAgreementsCollection().doc(`dg-strange-${runId}`);
    await strangeRef.set({ agreementRef: strangeRef.id, counterparty: { type: "PARTNER", partnerRef: strange.partnerRef }, status: "MYSTERY" });
    strayDocs.push(strangeRef);
    expectBlocked(await tryArchivePartner(strange), /Agreement lookup failed/);

    const crowded = await newPartner();
    const db = getAdminFirestore();
    const batch = db.batch();
    for (let i = 0; i < 51; i += 1) {
      const ref = financeAgreementsCollection().doc(`dg-crowd-${runId}-${i}`);
      batch.set(ref, { agreementRef: ref.id, counterparty: { type: "PARTNER", partnerRef: crowded.partnerRef }, status: "ENDED" });
      strayDocs.push(ref);
    }
    await batch.commit();
    expectBlocked(await tryArchivePartner(crowded), /too many Agreements to verify/);
  });

  it("the raw stored status decides: an ACTIVE head that no longer parses still blocks", async () => {
    const partner = await newPartner();
    const ref = financeAgreementsCollection().doc(`dg-legacy-${runId}`);
    await ref.set({ counterparty: { type: "PARTNER", partnerRef: partner.partnerRef }, status: "ACTIVE" });
    strayDocs.push(ref);
    expectBlocked(await tryArchivePartner(partner), /active Agreement/);
  });
});
