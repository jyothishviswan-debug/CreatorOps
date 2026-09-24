// Step 14B.1 - AGREEMENT-LED COUNTERPARTY ONBOARDING against the running Firestore/Auth emulator (no mocks of the owning modules).
// Proves, through the REAL services, gates and grants:
//   - a new Partner / Vendor is created ONLY through the owning services (owning schema, `created` event carrying createdVia), never by a Finance
//     write; Instagram, YouTube and Instagram + YouTube create ONE Partner and one canonical Account per platform; the Agreement links to it;
//   - the step ledger: a failure at ANY point (before / after each owning call) returns a recoverable outcome, and the SAME request resumes it
//     without ever creating a second Partner / Vendor / Account / Agreement; a crash between the owning create and the ledger write is recovered by
//     adopting the record the actor created; a colliding Account identity is a strong duplicate signal;
//   - the deliberate duplicate decision (candidate shown, use existing, create new, strong duplicate needs acknowledgement + reason, a strong match
//     outside the actor's access blocks with only a neutral flag) and Finance permission alone never bypassing the owning create right;
//   - Vendor onboarding (never a represented-Partner link), USE_EXISTING through the ledger, the status read, the lease, and no restricted identity
//     value or Payable / Invoice / Payment written anywhere.
//
// Hermetic: private per-run regions, unique names / emails / phones / handles, past dates only; everything created is swept at teardown.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { getPartnerAccountIdentityClaim, getPartnerDocByRef, partnerAccountsCollection, partnerEventsCollection, partnersCollection } from "@/server/partners/firestore";
import { claimIdFor } from "@/server/partners/identity";
import { createPartnerAccount } from "@/server/partners/partner-account-service";
import { partnerAccountDocSchema, partnerDocSchema } from "@/server/partners/types";
import { getVendorDocByRef, listVendorPartnerLinkDocsForVendor, vendorEventsCollection, vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema } from "@/server/vendors/types";

import {
  createCounterpartyFromOnboarding,
  getAgreementDetail,
  getOnboardingStatus,
  listAgreementEvents,
  type OnboardingOutcomeDto,
  type OnboardingRequest,
} from "./index";
import { financeAgreementClaimsCollection, financeAgreementEventsCollection, financeAgreementsCollection, financeAgreementVersionsCollection } from "./firestore";
import { onboardingLedgerDocSchema, onboardingLedgerId } from "./onboarding-ledger";
import { setOnboardingFaultHookForTests } from "./onboarding-service";
import { blockerCodes, createOnboardingHarness, failed, must, type OnboardingHarness } from "@/server/testing/finance-onboarding-harness";

vi.setConfig({ testTimeout: 90_000 });

let h: OnboardingHarness;
let creator: ActorContext; // manager: finance manage_agreements + the owning create / account rights, region-scoped
let head: ActorContext;
let noCreate: ActorContext; // manage_agreements but an override removes partners:create / vendors:create
let noAccounts: ActorContext; // manage_agreements + create, but an override removes manage_partner_accounts
let viewer: ActorContext;

beforeAll(async () => {
  h = await createOnboardingHarness("onb");
  creator = await h.actor("partnership_manager");
  head = await h.actor("partnership_head");
  noCreate = await h.actor("partnership_manager", { override: { partners: { actions: { create: false } }, vendors: { actions: { create: false } } } });
  noAccounts = await h.actor("partnership_manager", { override: { partners: { actions: { manage_partner_accounts: false } } } });
  viewer = await h.seededActor("viewer");
}, 120_000);

afterAll(async () => {
  setOnboardingFaultHookForTests(null);
  await h.teardown();
});

// ---- helpers -------------------------------------------------------------------------------------------------------------------
// The OWNING services answer their own result shape ({ok, data} | {ok:false, code, message}).
function mustOwning<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}`);
  return result.data;
}

type PartnerRequestOver = { name?: string; email?: string; phone?: string; regions?: string[]; accounts?: OnboardingRequest["accounts"]; decision?: OnboardingRequest["duplicateDecision"]; clientRequestId?: string };

function partnerRequest(over: PartnerRequestOver = {}): OnboardingRequest {
  return {
    clientRequestId: over.clientRequestId ?? h.uniqueClientRequestId(),
    type: "PARTNER",
    reviewedProfile: { displayName: over.name ?? h.uniqueName("New Partner"), email: over.email ?? h.uniqueEmail(), phone: over.phone ?? h.uniquePhone(), regionIds: over.regions ?? [h.R_IN] },
    accounts: over.accounts ?? [],
    duplicateDecision: over.decision ?? { kind: "CREATE_NEW", acknowledgedDuplicates: false },
  };
}

function vendorRequest(over: PartnerRequestOver = {}): OnboardingRequest {
  return {
    clientRequestId: over.clientRequestId ?? h.uniqueClientRequestId(),
    type: "VENDOR",
    reviewedProfile: { displayName: over.name ?? h.uniqueName("New Vendor"), email: over.email ?? h.uniqueEmail(), phone: over.phone ?? h.uniquePhone(), regionIds: over.regions ?? [h.R_IN], vendorType: "AGENCY" },
    duplicateDecision: over.decision ?? { kind: "CREATE_NEW", acknowledgedDuplicates: false },
  };
}

let requestSeq = 0;
async function run(actor: ActorContext, request: OnboardingRequest, deps?: Parameters<typeof createCounterpartyFromOnboarding>[3]) {
  h.trackRequest(actor, request.clientRequestId);
  return createCounterpartyFromOnboarding(actor, request, `req-onb-${h.runId}-${(requestSeq += 1)}`, deps);
}

async function completed(actor: ActorContext, request: OnboardingRequest): Promise<OnboardingOutcomeDto> {
  const outcome = must(await run(actor, request), "onboarding");
  expect(outcome.outcome, JSON.stringify(outcome)).toBe("COMPLETED");
  h.trackAgreement(outcome.agreementRef!);
  return outcome;
}

const ig = (handle = h?.uniqueHandle("ig")) => ({ platform: "Instagram", handle, displayName: "Asha on Instagram" });

async function partnersNamed(name: string) {
  return (await partnersCollection().where("displayNameLower", "==", name.toLowerCase()).get()).docs.map((doc) => partnerDocSchema.parse(doc.data()));
}
async function accountsOf(partnerRef: string) {
  return (await partnerAccountsCollection().where("partnerRef", "==", partnerRef).get()).docs.map((doc) => partnerAccountDocSchema.parse(doc.data()));
}
async function agreementsOfPartner(partnerUid: string) {
  return (await financeAgreementsCollection().where("partnerUid", "==", partnerUid).get()).docs;
}
async function vendorsNamed(name: string) {
  return (await vendorsCollection().where("displayNameLower", "==", name.toLowerCase()).get()).docs.map((doc) => vendorDocSchema.parse(doc.data()));
}
async function ledgerOf(actor: ActorContext, clientRequestId: string) {
  const snapshot = await financeAgreementClaimsCollection().doc(onboardingLedgerId(actor.uid, clientRequestId)).get();
  return snapshot.exists ? onboardingLedgerDocSchema.parse(snapshot.data()) : null;
}
async function createdEvent(kind: "partner" | "vendor", uid: string) {
  const events = await (kind === "partner" ? partnerEventsCollection(uid) : vendorEventsCollection(uid)).get();
  return events.docs.map((doc) => doc.data()).filter((event) => event.kind === "created");
}

// =====================================================================================================================
describe("a new Partner from an Agreement: created through the OWNING services", () => {
  it("Instagram: Partner + one canonical Account + Agreement draft, with provenance everywhere and nothing else written", async () => {
    const request = partnerRequest({ name: h.uniqueName("IG Partner"), accounts: [ig()] });
    const outcome = await completed(creator, request);

    expect(outcome).toMatchObject({ outcome: "COMPLETED", mode: "CREATE_NEW", createdVia: "FINANCE_AGREEMENT_ONBOARDING", failedStep: null, retryable: false, code: null, replayed: false });
    expect(outcome.completedSteps).toEqual(["VALIDATED", "COUNTERPARTY_CREATED", "ACCOUNTS_CREATED", "AGREEMENT_DRAFT_CREATED"]);
    expect(outcome.counterparty).toMatchObject({ type: "PARTNER", created: true, displayName: request.reviewedProfile.displayName });
    expect(outcome.accounts).toHaveLength(1);

    // the record is the OWNING module's: owning schema, created by THIS actor, normalized contact values, the requested region
    const partner = await getPartnerDocByRef(outcome.counterparty!.ref);
    expect(partnerDocSchema.safeParse(partner).success).toBe(true);
    expect(partner).toMatchObject({ status: "ACTIVE", createdByUserRef: creator.userRef, regionIds: [h.R_IN], email: request.reviewedProfile.email!.toLowerCase(), phone: request.reviewedProfile.phone!.replace(/[^\d+]/g, ""), pendingPartnerAccountSetup: false });
    expect(JSON.stringify(partner)).not.toContain("createdVia"); // provenance is on the event, never a second identity source

    // the owning `created` event carries the provenance and a ledger-correlated request id
    const created = await createdEvent("partner", partner!.uid);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actorUserRef: creator.userRef, metadata: { displayName: request.reviewedProfile.displayName, direct: true, createdVia: "FINANCE_AGREEMENT_ONBOARDING" } });
    expect(created[0]!.requestId).toMatch(/^onb:[0-9a-f]{24}:counterparty$/);

    // one canonical Account by the OWNING normalizer (platform + handle), primary, with its identity claim and provenance event
    const accounts = await accountsOf(partner!.partnerRef);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ platform: "Instagram", handle: request.accounts![0]!.handle, primary: true, status: "ACTIVE", displayName: "Asha on Instagram", createdByUserRef: creator.userRef });
    expect(accounts[0]!.normalizedIdentity).toBe(`instagram:handle:${request.accounts![0]!.handle!.toLowerCase()}`);
    expect((await getPartnerAccountIdentityClaim(claimIdFor(accounts[0]!.normalizedIdentity)))?.partnerAccountRef).toBe(accounts[0]!.partnerAccountRef);
    const accountEvents = (await partnerEventsCollection(partner!.uid).get()).docs.map((doc) => doc.data()).filter((event) => event.kind === "account_created");
    expect(accountEvents).toHaveLength(1);
    expect(accountEvents[0]!.metadata).toMatchObject({ platform: "Instagram", primary: true, createdVia: "FINANCE_AGREEMENT_ONBOARDING" });

    // the Agreement links to the created Partner and its Account; platform context derived server-side
    const detail = must(await getAgreementDetail(creator, outcome.agreementRef), "detail");
    expect(detail.head.status).toBe("DRAFT");
    expect(detail.head.counterparty).toMatchObject({ type: "PARTNER", ref: partner!.partnerRef, partnerAccountRefs: [accounts[0]!.partnerAccountRef], platformScope: ["instagram"] });
    // Finance-side provenance on the created event: marker + mode + opaque ledger ref, never a value
    const events = must(await listAgreementEvents(creator, outcome.agreementRef), "events");
    const finance = events.events.find((event) => event.kind === "created")!;
    expect(finance.metadata).toMatchObject({ counterpartyType: "PARTNER", createdVia: "FINANCE_AGREEMENT_ONBOARDING", onboardingMode: "NEW_COUNTERPARTY", onboardingRef: outcome.onboardingRef, accountCount: 1, platformCount: 1 });

    // the ledger records refs, step states and the display name only
    const ledger = (await ledgerOf(creator, request.clientRequestId))!;
    expect(ledger).toMatchObject({ status: "COMPLETED", attempts: 1, lease: null, failure: null, mode: "CREATE_NEW", counterpartyType: "PARTNER" });
    expect(ledger.steps.agreement?.agreementRef).toBe(outcome.agreementRef);
    const ledgerText = JSON.stringify(ledger);
    for (const value of [request.reviewedProfile.email!, request.reviewedProfile.email!.toLowerCase(), request.reviewedProfile.phone!, request.accounts![0]!.handle!]) expect(ledgerText).not.toContain(value);
    // (the record's display name is display data the outcome DTO shows, so the ledger keeps it; no contact value, handle or link)
    expect(ledger.steps.counterparty?.displayName).toBe(request.reviewedProfile.displayName);
  });

  it("YouTube: a platform-id Account is the canonical identity (id > link > handle by the owning rule)", async () => {
    const channelId = `UC${h.runId}yt`;
    const outcome = await completed(creator, partnerRequest({ accounts: [{ platform: "YouTube", platformAccountId: channelId, profileUrl: `https://youtube.com/channel/${channelId}`, displayName: "Asha TV" }] }));
    const partner = (await getPartnerDocByRef(outcome.counterparty!.ref))!;
    const [account] = await accountsOf(partner.partnerRef);
    expect(account).toMatchObject({ platform: "YouTube", platformAccountId: channelId, primary: true });
    expect(account!.normalizedIdentity).toBe(`youtube:id:${channelId.toLowerCase()}`);
    const detail = must(await getAgreementDetail(creator, outcome.agreementRef), "detail");
    expect(detail.head.counterparty).toMatchObject({ platformScope: ["youtube"] });
  });

  it("Instagram + YouTube create ONE Partner with TWO canonical Accounts, and one Agreement whose platform scope names both", async () => {
    const name = h.uniqueName("IGYT Partner");
    const outcome = await completed(creator, partnerRequest({ name, accounts: [ig(), { platform: "youtube", profileUrl: `https://youtube.com/@yt${h.runId}${h.uniqueHandle("y")}` }] }));

    expect(await partnersNamed(name)).toHaveLength(1);
    const partner = (await getPartnerDocByRef(outcome.counterparty!.ref))!;
    const accounts = (await accountsOf(partner.partnerRef)).sort((a, b) => a.platform.localeCompare(b.platform));
    expect(accounts.map((account) => account.platform)).toEqual(["Instagram", "YouTube"]);
    expect(accounts.filter((account) => account.primary)).toHaveLength(1);
    expect(accounts.find((account) => account.platform === "Instagram")!.primary).toBe(true);
    expect(outcome.accounts.map((account) => account.platform).sort()).toEqual(["instagram", "youtube"]);

    const detail = must(await getAgreementDetail(creator, outcome.agreementRef), "detail");
    expect(detail.head.counterparty).toMatchObject({ type: "PARTNER", ref: partner.partnerRef, platformScope: ["instagram", "youtube"] });
    expect(detail.head.counterparty.type === "PARTNER" && detail.head.counterparty.partnerAccountRefs.sort()).toEqual(accounts.map((account) => account.partnerAccountRef).sort());
    expect(await agreementsOfPartner(partner.uid)).toHaveLength(1);
  });

  it("with no Accounts the Partner and the Agreement are still created (a Partner-level Agreement)", async () => {
    const outcome = await completed(creator, partnerRequest());
    expect(outcome.accounts).toEqual([]);
    expect(outcome.completedSteps).toContain("ACCOUNTS_CREATED");
    const detail = must(await getAgreementDetail(creator, outcome.agreementRef), "detail");
    expect(detail.head.counterparty).toMatchObject({ type: "PARTNER", partnerAccountRefs: [], platformScope: [] });
  });

  it("the SAME request again is an idempotent replay: nothing is written, no second Partner / Account / Agreement", async () => {
    const name = h.uniqueName("Replay Partner");
    const request = partnerRequest({ name, accounts: [ig()] });
    const first = await completed(creator, request);
    const again = must(await run(creator, request), "replay");
    expect(again).toMatchObject({ outcome: "COMPLETED", replayed: true, agreementRef: first.agreementRef, onboardingRef: first.onboardingRef });
    expect(again.counterparty).toEqual(first.counterparty);
    expect(await partnersNamed(name)).toHaveLength(1);
    const partner = (await getPartnerDocByRef(first.counterparty!.ref))!;
    expect(await accountsOf(partner.partnerRef)).toHaveLength(1);
    expect(await agreementsOfPartner(partner.uid)).toHaveLength(1);
    expect((await ledgerOf(creator, request.clientRequestId))!.attempts).toBe(1);
  });

  it("two concurrent copies of the same request (a double submit) create exactly ONE Partner, Account and Agreement: the loser is told it is in progress or replays the winner", async () => {
    const name = h.uniqueName("Double Submit");
    const request = partnerRequest({ name, accounts: [ig(), { platform: "YouTube", handle: h.uniqueHandle("dsyt") }] });
    const results = await Promise.all([run(creator, request), run(creator, request), run(creator, request)]);
    const outcomes = results.map((result) => must(result, "concurrent"));
    for (const outcome of outcomes) expect(["COMPLETED", "IN_PROGRESS"]).toContain(outcome.outcome);
    expect(outcomes.filter((outcome) => outcome.outcome === "COMPLETED" && !outcome.replayed).length).toBeLessThanOrEqual(1);

    // whatever the interleaving, a further identical request converges on the one completed onboarding
    const settled = must(await run(creator, request), "settled");
    expect(settled.outcome).toBe("COMPLETED");
    h.trackAgreement(settled.agreementRef!);
    const partners = await partnersNamed(name);
    expect(partners).toHaveLength(1);
    expect(await accountsOf(partners[0]!.partnerRef)).toHaveLength(2);
    expect(await agreementsOfPartner(partners[0]!.uid)).toHaveLength(1);
    expect(await createdEvent("partner", partners[0]!.uid)).toHaveLength(1);
  });

  it("the same clientRequestId with a DIFFERENT payload is a conflict, never a silent second onboarding; another actor's ledger is separate", async () => {
    const request = partnerRequest({ accounts: [ig()] });
    await completed(creator, request);
    const changed = { ...request, reviewedProfile: { ...request.reviewedProfile, displayName: `${request.reviewedProfile.displayName} Changed` } };
    expect(failed(await run(creator, changed))).toMatchObject({ code: "conflict" });
    expect(await ledgerOf(head, request.clientRequestId)).toBeNull();
  });
});

// =====================================================================================================================
describe("resumable step ledger: an interruption at ANY point creates no duplicates and resumes", () => {
  const POINTS: Array<{ point: string; failedStep: OnboardingOutcomeDto["failedStep"]; completedSteps: OnboardingOutcomeDto["completedSteps"] }> = [
    { point: "before_counterparty_create", failedStep: "COUNTERPARTY_CREATED", completedSteps: ["VALIDATED"] },
    { point: "after_counterparty_create", failedStep: "COUNTERPARTY_CREATED", completedSteps: ["VALIDATED"] },
    { point: "before_account_create:0", failedStep: "ACCOUNTS_CREATED", completedSteps: ["VALIDATED", "COUNTERPARTY_CREATED"] },
    { point: "after_account_create:0", failedStep: "ACCOUNTS_CREATED", completedSteps: ["VALIDATED", "COUNTERPARTY_CREATED"] },
    { point: "before_account_create:1", failedStep: "ACCOUNTS_CREATED", completedSteps: ["VALIDATED", "COUNTERPARTY_CREATED"] },
    { point: "after_account_create:1", failedStep: "ACCOUNTS_CREATED", completedSteps: ["VALIDATED", "COUNTERPARTY_CREATED"] },
    { point: "before_agreement_draft", failedStep: "AGREEMENT_DRAFT_CREATED", completedSteps: ["VALIDATED", "COUNTERPARTY_CREATED", "ACCOUNTS_CREATED"] },
    { point: "after_agreement_draft", failedStep: "AGREEMENT_DRAFT_CREATED", completedSteps: ["VALIDATED", "COUNTERPARTY_CREATED", "ACCOUNTS_CREATED"] },
  ];

  for (const { point, failedStep, completedSteps } of POINTS) {
    it(`interrupted at ${point}: a recoverable outcome, then the same request completes with exactly one Partner, two Accounts and one Agreement`, async () => {
      const name = h.uniqueName(`Retry ${point.replace(/[^a-z0-9]/gi, "")}`);
      const request = partnerRequest({ name, accounts: [ig(), { platform: "YouTube", handle: h.uniqueHandle("yt") }] });
      let fired = false;
      setOnboardingFaultHookForTests((at) => {
        if (at === point && !fired) {
          fired = true;
          throw new Error("simulated interruption");
        }
      });
      const first = must(await run(creator, request), "first attempt");
      setOnboardingFaultHookForTests(null);

      expect(fired).toBe(true);
      expect(first).toMatchObject({ outcome: "FAILED", failedStep, retryable: true, code: "unexpected_error", completedSteps, duplicateSignal: false });
      expect(first.message).toBeTruthy();
      expect(JSON.stringify(first)).not.toContain("simulated interruption");

      // the status read reports the same recoverable state without touching anything
      const status = must(await getOnboardingStatus(creator, { clientRequestId: request.clientRequestId }), "status");
      expect(status).toMatchObject({ outcome: "FAILED", failedStep, retryable: true });

      const second = must(await run(creator, request), "second attempt");
      expect(second).toMatchObject({ outcome: "COMPLETED", failedStep: null, retryable: false });
      expect(second.completedSteps).toEqual(["VALIDATED", "COUNTERPARTY_CREATED", "ACCOUNTS_CREATED", "AGREEMENT_DRAFT_CREATED"]);
      h.trackAgreement(second.agreementRef!);

      // NO duplicate anywhere
      const partners = await partnersNamed(name);
      expect(partners).toHaveLength(1);
      expect(second.counterparty!.ref).toBe(partners[0]!.partnerRef);
      expect((await createdEvent("partner", partners[0]!.uid))).toHaveLength(1);
      expect(await accountsOf(partners[0]!.partnerRef)).toHaveLength(2);
      expect(second.accounts).toHaveLength(2);
      const agreements = await agreementsOfPartner(partners[0]!.uid);
      expect(agreements).toHaveLength(1);
      expect(agreements[0]!.id).toBe(second.agreementRef);
      const ledger = (await ledgerOf(creator, request.clientRequestId))!;
      expect(ledger).toMatchObject({ status: "COMPLETED", attempts: 2, lease: null, failure: null });

      // exactly one `created` provenance event on the Agreement (the replayed draft keeps the original)
      const events = (await financeAgreementEventsCollection(second.agreementRef!).get()).docs.map((doc) => doc.data()).filter((event) => event.kind === "created");
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({ createdVia: "FINANCE_AGREEMENT_ONBOARDING", onboardingMode: "NEW_COUNTERPARTY" });
    });
  }

  it("an owning failure that is not an interruption (an Account collision that appears mid-run) is a strong duplicate signal, not retryable, and still creates nothing twice", async () => {
    const name = h.uniqueName("Race Partner");
    const handle = h.uniqueHandle("race");
    const request = partnerRequest({ name, accounts: [{ platform: "Instagram", handle }] });
    const other = await h.seedPartner();
    let injected = false;
    setOnboardingFaultHookForTests(async (at) => {
      if (at === "before_account_create:0" && !injected) {
        injected = true;
        // another Partner claims the same Account identity between validation and the Account step
        mustOwning(await createPartnerAccount(head, other.partnerRef, { platform: "Instagram", handle }, `req-race-${h.runId}`), "race account");
      }
    });
    const first = must(await run(creator, request), "first");
    setOnboardingFaultHookForTests(null);

    expect(first).toMatchObject({ outcome: "FAILED", failedStep: "ACCOUNTS_CREATED", code: "account_identity_collision", duplicateSignal: true, retryable: false, completedSteps: ["VALIDATED", "COUNTERPARTY_CREATED"] });
    expect(first.message).toMatch(/already belongs to another Partner/);
    expect(first.agreementRef).toBeNull();

    // the same request reports the same failure - never a second Partner, never an Agreement
    const again = must(await run(creator, request), "again");
    expect(again).toMatchObject({ outcome: "FAILED", code: "account_identity_collision", duplicateSignal: true });
    const partners = await partnersNamed(name);
    expect(partners).toHaveLength(1);
    expect(await agreementsOfPartner(partners[0]!.uid)).toHaveLength(0);
    expect(await accountsOf(partners[0]!.partnerRef)).toHaveLength(0);
    // the claim still belongs to the OTHER Partner
    const claim = await getPartnerAccountIdentityClaim(claimIdFor(`instagram:handle:${handle.toLowerCase()}`));
    expect((await accountsOf(other.partnerRef)).map((account) => account.partnerAccountRef)).toContain(claim?.partnerAccountRef);
  });

  it("a live lease held by another runner answers IN_PROGRESS without running anything; once it expires the request resumes", async () => {
    const name = h.uniqueName("Lease Partner");
    const request = partnerRequest({ name, accounts: [ig()] });
    let fired = false;
    setOnboardingFaultHookForTests((at) => {
      if (at === "before_agreement_draft" && !fired) {
        fired = true;
        throw new Error("simulated interruption");
      }
    });
    must(await run(creator, request), "first");
    setOnboardingFaultHookForTests(null);

    const ledgerRef = financeAgreementClaimsCollection().doc(onboardingLedgerId(creator.uid, request.clientRequestId));
    const before = onboardingLedgerDocSchema.parse((await ledgerRef.get()).data());
    await ledgerRef.update({ lease: { token: "another-runner", expiresAt: new Date(Date.now() + 60_000).toISOString() } });

    const busy = must(await run(creator, request), "busy");
    expect(busy).toMatchObject({ outcome: "IN_PROGRESS", code: "onboarding_in_progress", retryable: true, agreementRef: null });
    expect(onboardingLedgerDocSchema.parse((await ledgerRef.get()).data()).attempts).toBe(before.attempts);
    expect(await agreementsOfPartner((await partnersNamed(name))[0]!.uid)).toHaveLength(0);

    await ledgerRef.update({ lease: { token: "another-runner", expiresAt: new Date(Date.now() - 1_000).toISOString() } });
    const resumed = must(await run(creator, request), "resumed");
    expect(resumed.outcome).toBe("COMPLETED");
    h.trackAgreement(resumed.agreementRef!);
    expect(await partnersNamed(name)).toHaveLength(1);
  });
});

// =====================================================================================================================
describe("duplicates: shown, use existing, deliberate create new", () => {
  it("USE_EXISTING continues with a record the duplicate check returned: no new Partner or Account, the Agreement links to it (through the ledger)", async () => {
    const existing = await h.seedPartner({ email: h.uniqueEmail().toLowerCase() });
    const account = mustOwning(await createPartnerAccount(head, existing.partnerRef, { platform: "Instagram", handle: h.uniqueHandle("ex") }, `req-ex-${h.runId}`), "existing account");
    const before = (await partnersCollection().where("createdByUserRef", "==", creator.userRef).get()).size;

    const request = partnerRequest({ email: existing.email!, name: existing.displayName, decision: { kind: "USE_EXISTING", ref: existing.partnerRef, partnerAccountRefs: [account.partnerAccountRef] } });
    const outcome = await completed(creator, request);

    expect(outcome).toMatchObject({ mode: "USE_EXISTING", counterparty: { ref: existing.partnerRef, created: false }, accounts: [], retryable: false });
    expect(outcome.completedSteps).toEqual(["VALIDATED", "COUNTERPARTY_CREATED", "ACCOUNTS_CREATED", "AGREEMENT_DRAFT_CREATED"]);
    expect((await partnersCollection().where("createdByUserRef", "==", creator.userRef).get()).size).toBe(before);
    expect(await createdEvent("partner", existing.uid)).toHaveLength(0);
    const detail = must(await getAgreementDetail(creator, outcome.agreementRef), "detail");
    expect(detail.head.counterparty).toMatchObject({ type: "PARTNER", ref: existing.partnerRef, partnerAccountRefs: [account.partnerAccountRef], platformScope: ["instagram"] });
    const events = must(await listAgreementEvents(creator, outcome.agreementRef), "events");
    expect(events.events.find((event) => event.kind === "created")!.metadata).toMatchObject({ createdVia: "FINANCE_AGREEMENT_ONBOARDING", onboardingMode: "EXISTING_COUNTERPARTY" });
    // replay
    expect(must(await run(creator, request), "replay")).toMatchObject({ outcome: "COMPLETED", replayed: true, agreementRef: outcome.agreementRef });
  });

  it("USE_EXISTING must name a record the duplicate check itself returned for THIS actor: a made-up ref, an unrelated visible record and a hidden one are all refused, nothing written", async () => {
    const unrelated = await h.seedPartner();
    const hidden = await h.seedPartner({ regionIds: [h.R_OUT], email: h.uniqueEmail().toLowerCase() });
    for (const ref of ["ref-does-not-exist", unrelated.partnerRef, hidden.partnerRef]) {
      const request = partnerRequest({ email: hidden.email!, decision: { kind: "USE_EXISTING", ref } });
      const result = failed(await run(creator, request));
      expect(result, ref).toMatchObject({ code: "not_ready" });
      expect(blockerCodes(result), ref).toEqual(["use_existing_not_a_candidate"]);
      expect(JSON.stringify(result)).not.toContain(hidden.displayName);
      expect(await ledgerOf(creator, request.clientRequestId), ref).toBeNull();
    }
  });

  it("CREATE_NEW against a STRONG in-scope duplicate needs acknowledgement AND a reason; then it creates a second, distinct Partner deliberately", async () => {
    const existing = await h.seedPartner({ email: h.uniqueEmail().toLowerCase() });
    const name = h.uniqueName("Deliberate New");
    const base = { name, email: existing.email! };

    const noAck = failed(await run(creator, partnerRequest({ ...base, decision: { kind: "CREATE_NEW", acknowledgedDuplicates: false } })));
    expect(blockerCodes(noAck)).toEqual(["duplicate_acknowledgement_required"]);
    const noReason = failed(await run(creator, partnerRequest({ ...base, decision: { kind: "CREATE_NEW", acknowledgedDuplicates: true } })));
    expect(blockerCodes(noReason)).toEqual(["duplicate_reason_required"]);
    expect(await partnersNamed(name)).toHaveLength(0);

    const request = partnerRequest({ ...base, decision: { kind: "CREATE_NEW", acknowledgedDuplicates: true, reason: "A different person who shares the studio inbox" } });
    const outcome = await completed(creator, request);
    expect(outcome.counterparty).toMatchObject({ created: true });
    expect(outcome.counterparty!.ref).not.toBe(existing.partnerRef);
    expect(await partnersNamed(name)).toHaveLength(1);
    // the ledger records only THAT a reason was given; the reason itself is part of the Agreement's audit event (the deliberate decision)
    expect((await ledgerOf(creator, request.clientRequestId))!.duplicateDecision).toEqual({ kind: "CREATE_NEW", acknowledgedDuplicates: true, reasonRecorded: true });
    expect(JSON.stringify(await ledgerOf(creator, request.clientRequestId))).not.toContain("shares the studio inbox");
    const events = must(await listAgreementEvents(creator, outcome.agreementRef), "events");
    expect(events.events.find((event) => event.kind === "created")!.metadata).toMatchObject({ createdVia: "FINANCE_AGREEMENT_ONBOARDING", onboardingMode: "NEW_COUNTERPARTY", duplicatesAcknowledged: true, reason: "A different person who shares the studio inbox" });
  });

  it("a SUPPORTING-only duplicate (an exact name match alone) never needs acknowledgement - and is never a strong duplicate", async () => {
    const existing = await h.seedPartner({ email: h.uniqueEmail().toLowerCase() });
    const outcome = await completed(creator, partnerRequest({ name: existing.displayName, decision: { kind: "CREATE_NEW", acknowledgedDuplicates: false } }));
    expect(outcome.counterparty!.ref).not.toBe(existing.partnerRef);
    expect(await partnersNamed(existing.displayName)).toHaveLength(2);
  });

  it("an Account identity that already belongs to a Partner blocks creating it again (before anything is written), even with an acknowledgement", async () => {
    const handle = h.uniqueHandle("dupacct");
    const first = await completed(creator, partnerRequest({ accounts: [{ platform: "Instagram", handle }] }));
    const request = partnerRequest({ accounts: [{ platform: "instagram", handle: `@${handle.toUpperCase()}` }], decision: { kind: "CREATE_NEW", acknowledgedDuplicates: true, reason: "Same page, new contract" } });
    const result = failed(await run(creator, request));
    expect(blockerCodes(result)).toEqual(["account_identity_collision"]);
    expect(await ledgerOf(creator, request.clientRequestId)).toBeNull();
    expect(await partnersNamed(request.reviewedProfile.displayName)).toHaveLength(0);
    // ... while the same Partner is a candidate (Account-identity evidence) and can be used deliberately: the accounts serve the check only
    const use = await completed(creator, { ...request, clientRequestId: h.uniqueClientRequestId(), duplicateDecision: { kind: "USE_EXISTING", ref: first.counterparty!.ref } });
    expect(use).toMatchObject({ mode: "USE_EXISTING", accounts: [], counterparty: { ref: first.counterparty!.ref, created: false } });
    expect(await accountsOf(first.counterparty!.ref)).toHaveLength(1);
  });

  it("a STRONG match OUTSIDE the actor's access blocks creating new with only the neutral typed code - nothing about that record is disclosed, nothing is written", async () => {
    const hidden = await h.seedPartner({ regionIds: [h.R_OUT], email: h.uniqueEmail().toLowerCase(), name: h.uniqueName("Hidden Talent Agency") });
    const request = partnerRequest({ email: hidden.email!, decision: { kind: "CREATE_NEW", acknowledgedDuplicates: true, reason: "I am sure it is a different one" } });
    const result = failed(await run(creator, request));
    expect(result).toMatchObject({ code: "not_ready" });
    expect(blockerCodes(result)).toEqual(["strong_match_outside_access"]);
    const text = JSON.stringify(result);
    for (const leaked of [hidden.partnerRef, hidden.uid, hidden.displayName, hidden.email!, h.R_OUT]) expect(text).not.toContain(leaked);
    expect(await ledgerOf(creator, request.clientRequestId)).toBeNull();
    expect(await partnersNamed(request.reviewedProfile.displayName)).toHaveLength(0);
  });

  it("if the duplicate lookup cannot run, creating new needs an acknowledgement and a reason (unknown is never treated as none)", async () => {
    const throwing = async () => {
      throw new Error("lookup down");
    };
    const deps = { duplicates: { checkPartners: throwing, checkVendors: throwing, findPartnersByName: throwing, loadPartners: throwing, loadVendors: throwing, loadGrants: async () => [] } } as unknown as Parameters<typeof createCounterpartyFromOnboarding>[3];
    const noAck = failed(await run(creator, partnerRequest(), deps));
    expect(blockerCodes(noAck)).toEqual(["duplicate_acknowledgement_required"]);
    expect(noAck.message).toMatch(/could not be completed/);
    const request = partnerRequest({ decision: { kind: "CREATE_NEW", acknowledgedDuplicates: true, reason: "Checked by hand with the team" } });
    h.trackRequest(creator, request.clientRequestId);
    const outcome = must(await createCounterpartyFromOnboarding(creator, request, `req-unknown-${h.runId}`, deps), "acknowledged");
    expect(outcome.outcome).toBe("COMPLETED");
    h.trackAgreement(outcome.agreementRef!);
  });
});

// =====================================================================================================================
describe("Finance permission alone never bypasses the owning create right", () => {
  it("manage_agreements WITHOUT partners:create: a typed refusal before anything is written - but the actor may still use an existing Partner", async () => {
    const name = h.uniqueName("No Create Partner");
    const request = partnerRequest({ name, accounts: [ig()] });
    const result = failed(await run(noCreate, request));
    expect(result).toMatchObject({ code: "not_ready" });
    expect(blockerCodes(result)).toEqual(["counterparty_create_not_permitted"]);
    expect(result.message).toMatch(/do not have permission to create a new Partner/);
    expect(await ledgerOf(noCreate, request.clientRequestId)).toBeNull();
    expect(await partnersNamed(name)).toHaveLength(0);

    // review / use existing remains possible
    const existing = await h.seedPartner({ email: h.uniqueEmail().toLowerCase() });
    const used = await completed(noCreate, partnerRequest({ email: existing.email!, decision: { kind: "USE_EXISTING", ref: existing.partnerRef } }));
    expect(used.counterparty).toMatchObject({ ref: existing.partnerRef, created: false });
  });

  it("the same for a Vendor: vendors:create is required", async () => {
    const name = h.uniqueName("No Create Vendor");
    const result = failed(await run(noCreate, vendorRequest({ name })));
    expect(blockerCodes(result)).toEqual(["counterparty_create_not_permitted"]);
    expect(await vendorsNamed(name)).toHaveLength(0);
  });

  it("Partner Accounts need partners:manage_partner_accounts: refused BEFORE the Partner is created (no half-created record); without accounts the same actor succeeds", async () => {
    const name = h.uniqueName("No Account Right");
    const request = partnerRequest({ name, accounts: [ig()] });
    const result = failed(await run(noAccounts, request));
    expect(blockerCodes(result)).toEqual(["account_management_not_permitted"]);
    expect(await partnersNamed(name)).toHaveLength(0);
    expect(await ledgerOf(noAccounts, request.clientRequestId)).toBeNull();
    const outcome = await completed(noAccounts, partnerRequest({ name, accounts: [] }));
    expect(outcome.accounts).toEqual([]);
  });

  it("a right removed between attempts is honoured on resume: the resumed request is refused with the typed code and creates nothing", async () => {
    const actor = await h.actor("partnership_manager");
    const request = partnerRequest({ name: h.uniqueName("Revoked Mid Way"), accounts: [] });
    let fired = false;
    setOnboardingFaultHookForTests((at) => {
      if (at === "before_counterparty_create" && !fired) {
        fired = true;
        throw new Error("simulated interruption");
      }
    });
    expect(must(await run(actor, request), "first")).toMatchObject({ outcome: "FAILED" });
    setOnboardingFaultHookForTests(null);
    await getAdminFirestore().collection("userAccessOverrides").doc(actor.uid).set({ uid: actor.uid, version: 1, features: { partners: { actions: { create: false } } } });
    const resumed = failed(await run(actor, request));
    expect(blockerCodes(resumed)).toEqual(["counterparty_create_not_permitted"]);
    expect(await partnersNamed(request.reviewedProfile.displayName)).toHaveLength(0);
    await getAdminFirestore().collection("userAccessOverrides").doc(actor.uid).delete();
  });

  it("Viewer (no finance grant) and an unauthenticated caller are denied outright", async () => {
    expect(failed(await run(viewer, partnerRequest()))).toMatchObject({ code: "unauthorized", reason: "feature_denied" });
    expect(failed(await createCounterpartyFromOnboarding(null, partnerRequest(), "req-x"))).toMatchObject({ code: "unauthorized", reason: "not_authenticated" });
    expect(failed(await getOnboardingStatus(viewer, { clientRequestId: "onb-req-12345678" }))).toMatchObject({ code: "unauthorized" });
  });

  it("the new record must be visible to its creator: a region outside the actor's scope is refused, a mix with one in-scope region is accepted", async () => {
    const outside = partnerRequest({ regions: [h.R_OUT] });
    expect(failed(await run(creator, outside))).toMatchObject({ code: "invalid_input" });
    expect(failed(await run(creator, outside)).message).toMatch(/region you have access to/);
    expect(await ledgerOf(creator, outside.clientRequestId)).toBeNull();
    expect(await partnersNamed(outside.reviewedProfile.displayName)).toHaveLength(0);
    const mixed = await completed(creator, partnerRequest({ regions: [h.R_OUT, h.R_IN] }));
    expect((await getPartnerDocByRef(mixed.counterparty!.ref))!.regionIds.sort()).toEqual([h.R_IN, h.R_OUT].sort());
    // a Head with scope only in R_IN likewise cannot create into a region it cannot see
    expect(failed(await run(head, partnerRequest({ regions: [h.R_OUT] })))).toMatchObject({ code: "invalid_input" });
  });

  it("strict input: an unknown key (uid, scope, owner, provenance) is invalid_input and nothing is written", async () => {
    const request = { ...partnerRequest(), ownerUserRef: "someone" } as unknown as OnboardingRequest;
    expect(failed(await run(creator, request))).toMatchObject({ code: "invalid_input" });
    expect(await ledgerOf(creator, request.clientRequestId)).toBeNull();
  });
});

// =====================================================================================================================
describe("a new Vendor from an Agreement", () => {
  it("creates the Vendor through the owning service (createdVia on its event), links the Agreement, and NEVER creates a represented-Partner link", async () => {
    const request = vendorRequest({ name: h.uniqueName("Vendor Co") });
    const outcome = await completed(creator, request);
    expect(outcome).toMatchObject({ mode: "CREATE_NEW", counterpartyType: "VENDOR", accounts: [], counterparty: { type: "VENDOR", created: true } });
    expect(outcome.completedSteps).toEqual(["VALIDATED", "COUNTERPARTY_CREATED", "ACCOUNTS_CREATED", "AGREEMENT_DRAFT_CREATED"]);

    const vendor = (await getVendorDocByRef(outcome.counterparty!.ref))!;
    expect(vendorDocSchema.safeParse(vendor).success).toBe(true);
    expect(vendor).toMatchObject({ vendorType: "AGENCY", status: "ACTIVE", createdByUserRef: creator.userRef, regionIds: [h.R_IN], email: request.reviewedProfile.email!.toLowerCase() });
    const created = await createdEvent("vendor", vendor.uid);
    expect(created).toHaveLength(1);
    expect(created[0]!.metadata).toMatchObject({ displayName: request.reviewedProfile.displayName, vendorType: "AGENCY", createdVia: "FINANCE_AGREEMENT_ONBOARDING" });

    const detail = must(await getAgreementDetail(creator, outcome.agreementRef), "detail");
    expect(detail.head.counterparty).toEqual({ type: "VENDOR", ref: vendor.vendorRef, partnerAccountRefs: [], platformScope: [] });
    // no represented-Partner relationship of any kind
    expect(await listVendorPartnerLinkDocsForVendor(vendor.vendorRef)).toEqual([]);
    const events = must(await listAgreementEvents(creator, outcome.agreementRef), "events");
    expect(events.events.find((event) => event.kind === "created")!.metadata).toMatchObject({ counterpartyType: "VENDOR", createdVia: "FINANCE_AGREEMENT_ONBOARDING", onboardingMode: "NEW_COUNTERPARTY" });
  });

  for (const point of ["before_counterparty_create", "after_counterparty_create", "before_agreement_draft", "after_agreement_draft"]) {
    it(`retry after an interruption at ${point} creates no second Vendor and no second Agreement`, async () => {
      const name = h.uniqueName(`Vendor Retry ${point.replace(/[^a-z0-9]/gi, "")}`);
      const request = vendorRequest({ name });
      let fired = false;
      setOnboardingFaultHookForTests((at) => {
        if (at === point && !fired) {
          fired = true;
          throw new Error("simulated interruption");
        }
      });
      const first = must(await run(creator, request), "first");
      setOnboardingFaultHookForTests(null);
      expect(first).toMatchObject({ outcome: "FAILED", retryable: true, code: "unexpected_error" });
      const second = await completed(creator, request);
      const vendors = await vendorsNamed(name);
      expect(vendors).toHaveLength(1);
      expect(second.counterparty!.ref).toBe(vendors[0]!.vendorRef);
      expect(await createdEvent("vendor", vendors[0]!.uid)).toHaveLength(1);
      const agreements = (await financeAgreementsCollection().where("vendorUid", "==", vendors[0]!.uid).get()).docs;
      expect(agreements).toHaveLength(1);
      expect(await listVendorPartnerLinkDocsForVendor(vendors[0]!.vendorRef)).toEqual([]);
    });
  }

  it("shows a duplicate warning (email = STRONG, needs acknowledgement + reason), lets you use the existing Vendor, and lets you deliberately create a new one", async () => {
    const existing = await h.seedVendor({ email: h.uniqueEmail().toLowerCase() });
    const name = h.uniqueName("Vendor Twin");

    expect(blockerCodes(failed(await run(creator, vendorRequest({ name, email: existing.email!, decision: { kind: "CREATE_NEW", acknowledgedDuplicates: false } }))))).toEqual(["duplicate_acknowledgement_required"]);
    expect(blockerCodes(failed(await run(creator, vendorRequest({ name, email: existing.email!, decision: { kind: "CREATE_NEW", acknowledgedDuplicates: true } }))))).toEqual(["duplicate_reason_required"]);
    expect(await vendorsNamed(name)).toHaveLength(0);

    const used = await completed(creator, vendorRequest({ name, email: existing.email!, decision: { kind: "USE_EXISTING", ref: existing.vendorRef } }));
    expect(used.counterparty).toMatchObject({ type: "VENDOR", ref: existing.vendorRef, created: false });
    expect(await vendorsNamed(name)).toHaveLength(0);
    expect(await createdEvent("vendor", existing.uid)).toHaveLength(0);
    expect(await listVendorPartnerLinkDocsForVendor(existing.vendorRef)).toEqual([]);

    const fresh = await completed(creator, vendorRequest({ name, email: existing.email!, decision: { kind: "CREATE_NEW", acknowledgedDuplicates: true, reason: "Separate legal entity with a shared mailbox" } }));
    expect(fresh.counterparty).toMatchObject({ created: true });
    expect(fresh.counterparty!.ref).not.toBe(existing.vendorRef);
    expect(await vendorsNamed(name)).toHaveLength(1);
  });

  it("an exact name match alone (the Vendor module's own low-confidence signal) is SUPPORTING: creating a new Vendor needs no acknowledgement", async () => {
    const existing = await h.seedVendor({ email: h.uniqueEmail().toLowerCase() });
    const outcome = await completed(creator, vendorRequest({ name: existing.displayName }));
    expect(outcome.counterparty!.ref).not.toBe(existing.vendorRef);
  });

  it("a STRONG Vendor match outside the actor's access blocks with only the neutral code", async () => {
    const hidden = await h.seedVendor({ regionIds: [h.R_OUT], email: h.uniqueEmail().toLowerCase(), name: h.uniqueName("Hidden Vendor Co") });
    const result = failed(await run(creator, vendorRequest({ email: hidden.email!, decision: { kind: "CREATE_NEW", acknowledgedDuplicates: true, reason: "Certain it is different" } })));
    expect(blockerCodes(result)).toEqual(["strong_match_outside_access"]);
    for (const leaked of [hidden.vendorRef, hidden.displayName, hidden.email!, h.R_OUT]) expect(JSON.stringify(result)).not.toContain(leaked);
  });

  it("a Vendor request with accounts or without a vendor type is invalid input", async () => {
    const withAccounts = { ...vendorRequest(), accounts: [{ platform: "Instagram", handle: "a" }] } as OnboardingRequest;
    expect(failed(await run(creator, withAccounts))).toMatchObject({ code: "invalid_input" });
    const noType = vendorRequest();
    delete (noType.reviewedProfile as { vendorType?: string }).vendorType;
    expect(failed(await run(creator, noType))).toMatchObject({ code: "invalid_input" });
  });
});

// =====================================================================================================================
describe("status read, and Finance stores no identity data", () => {
  it("getOnboardingStatus reads the same outcome by clientRequestId or onboardingRef, only for the actor who started it", async () => {
    const request = partnerRequest({ accounts: [ig()] });
    const outcome = await completed(creator, request);
    const byClient = must(await getOnboardingStatus(creator, { clientRequestId: request.clientRequestId }), "by client id");
    const byRef = must(await getOnboardingStatus(creator, { onboardingRef: outcome.onboardingRef }), "by ref");
    expect(byClient).toEqual({ ...outcome, replayed: false });
    expect(byRef).toEqual(byClient);
    // another actor cannot read it (the same neutral not_found as an unknown one), and the input is strict
    expect(failed(await getOnboardingStatus(head, { onboardingRef: outcome.onboardingRef }))).toMatchObject({ code: "not_found" });
    expect(failed(await getOnboardingStatus(creator, { clientRequestId: "onb-never-started-1" }))).toMatchObject({ code: "not_found" });
    expect(failed(await getOnboardingStatus(creator, {}))).toMatchObject({ code: "invalid_input" });
    expect(failed(await getOnboardingStatus(creator, { onboardingRef: outcome.onboardingRef, clientRequestId: request.clientRequestId }))).toMatchObject({ code: "invalid_input" });
    expect(failed(await getOnboardingStatus(creator, { onboardingRef: "not-a-ref" }))).toMatchObject({ code: "invalid_input" });
  });

  it("no restricted identity value or evidence is written anywhere by an onboarding, no unrestricted identity shape appears in any Finance document, and there is no Payable / Invoice / Payment collection", async () => {
    const outcome = await completed(creator, partnerRequest({ accounts: [ig(), { platform: "YouTube", handle: h.uniqueHandle("yt") }] }));
    const partner = (await getPartnerDocByRef(outcome.counterparty!.ref))!;

    // no restricted identity document exists for the new Partner (KYC is collected later, in the owning module)
    const restricted = await getAdminFirestore().collection("restrictedFinancialIdentities").where("subjectRef", "==", partner.partnerRef).get();
    expect(restricted.size).toBe(0);

    // walk every Finance document of this onboarding: no PAN / GSTIN / IFSC / Aadhaar shape, no identity-value key
    const docs: unknown[] = [];
    docs.push((await financeAgreementsCollection().doc(outcome.agreementRef!).get()).data());
    for (const version of (await financeAgreementVersionsCollection(outcome.agreementRef!).get()).docs) docs.push(version.data());
    for (const event of (await financeAgreementEventsCollection(outcome.agreementRef!).get()).docs) docs.push(event.data());
    docs.push((await financeAgreementClaimsCollection().doc(outcome.onboardingRef).get()).data());
    const text = JSON.stringify(docs);
    expect(text).not.toMatch(/\b[A-Z]{5}\d{4}[A-Z]\b/);
    expect(text).not.toMatch(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/);
    expect(text).not.toMatch(/\b[A-Z]{4}0[A-Z0-9]{6}\b/);
    // Random ids (UUID refs, hex claim/agreement refs) can hold three numeric 4-digit groups by chance, which is not an Aadhaar: scrub
    // the id shapes first, then look for a 12-digit identifier in what is left (VALUES, not refs).
    const withoutIds = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "uuid").replace(/\b[a-z]{2,4}_[0-9a-f]{12,64}\b/gi, "ref").replace(/\b[0-9a-f]{20,64}\b/gi, "hex");
    expect(withoutIds).not.toMatch(/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/);
    expect(text).not.toMatch(/"(panNumber|aadhaarNumber|accountNumber|ifsc|gstin|gstNumber|accountHolderName)"/);

    // Step 15A: `financePayables` is now a legitimate Finance root owned by its own module, and other emulator test files
    // (which run in parallel against the one emulator) may first-write it during this test. Step 16A: `financeInvoices` and
    // `financeInvoiceNumberClaims` join it the same way, owned by the Invoices module. Step 17A: `financePayments`,
    // `financePaymentReferenceClaims` and `financePaymentSettlements` join it the same way, owned by the Payments module
    // (Step 17C found and closed this gap - it was never added when Step 17A landed). Onboarding itself still writes none
    // of these - that is what the instrumented `docs` walk above proves.
    const collections = (await getAdminFirestore().listCollections()).map((collection) => collection.id);
    const LEGITIMATE_FINANCE_ROOTS = new Set(["financePayables", "financeInvoices", "financeInvoiceNumberClaims", "financePayments", "financePaymentReferenceClaims", "financePaymentSettlements"]);
    expect(collections.filter((id) => /payable|invoice|payment|settlement/i.test(id) && !LEGITIMATE_FINANCE_ROOTS.has(id))).toEqual([]);
  });
});
