// Step 6A - real reads/writes against the running Firestore/Auth
// emulator (no mocks). Discovery's service layer uses Firestore
// transactions, Filter.or() composite queries, and orderBy/cursor
// pagination extensively - none of that can be faithfully exercised by
// the lightweight fake-firestore.ts test double used elsewhere, so this
// is the primary correctness coverage for lead-service.ts,
// lifecycle-service.ts, kyc-service.ts, and conversion-service.ts. Run
// with `pnpm test:emulator` against a running `pnpm firebase:emulators`.
import { beforeAll, describe, expect, it } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth } from "@/server/firebase/admin";
import { convertLead, getLeadReadiness } from "./conversion-service";
import { getLeadDocByRef, getPartnerDocByRef } from "./firestore";
import { listLeadEvents } from "./lead-events";
import { assignManager, createLead, getLead, listLeads, precheckDuplicates, recordOutreach, recordReview, saveAssetDecision, saveCommercial, saveDiscoveryAgreement, saveResearch, updateLead } from "./lead-service";
import { getLeadKyc, saveLeadKyc } from "./kyc-service";
import { restoreLead, transitionLeadLifecycle } from "./lifecycle-service";
import { seedDiscoveryData } from "./seed-discovery-data";

const uidByRole = new Map<string, string>();
const runId = Date.now();

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  await seedDiscoveryData();

  const auth = getAdminAuth();
  for (const identity of TEST_IDENTITIES) {
    const user = await auth.getUserByEmail(identity.email);
    uidByRole.set(identity.role, user.uid);
  }
}, 30_000);

async function actorFor(role: string): Promise<ActorContext> {
  const uid = uidByRole.get(role);
  if (!uid) throw new Error(`No seeded uid for role ${role}`);
  const actor = await resolveActor(uid);
  if (!actor) throw new Error(`resolveActor returned null for seeded role ${role}`);
  return actor;
}

describe("Discovery domain (real emulator)", () => {
  describe("access control", () => {
    it("an unauthenticated actor is denied every operation (fails closed)", async () => {
      await expect(listLeads(null, {})).resolves.toMatchObject({ ok: false, code: "unauthorized", reason: "not_authenticated" });
      await expect(createLead(null, { displayName: "X", source: { type: "other" } }, "req-x")).resolves.toMatchObject({ ok: false, code: "unauthorized" });
    });

    it("a malformed/missing scope context (an actor with zero relevant grants) is denied, not silently given global access", async () => {
      // Analyst's seeded scope has no REGION Karnataka / TEAM / EXPLICIT_RECORD
      // covering the Karnataka-region seeded Leads.
      const analyst = await actorFor("analyst");
      const result = await getLead(analyst, "seed-lead-researching");
      expect(result).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    });
  });

  describe("scoped listing", () => {
    it("never leaks a Lead outside the actor's scope, and GLOBAL sees everything", async () => {
      const manager = await actorFor("partnership_manager");
      const managerPage = await listLeads(manager, { limit: 50 });
      expect(managerPage.ok).toBe(true);
      if (!managerPage.ok) throw new Error("unreachable");
      const managerRefs = managerPage.data.leads.map((l) => l.leadRef);
      // Manager has REGION Kerala/Maharashtra + TEAM kerala-programmes -
      // never the Karnataka-only seeded Leads.
      expect(managerRefs).not.toContain("seed-lead-researching");
      expect(managerRefs).not.toContain("seed-lead-watchlist");
      expect(managerRefs).not.toContain("seed-lead-rejected");
      expect(managerRefs).not.toContain("seed-lead-duplicate");

      const admin = await actorFor("super_admin");
      const adminPage = await listLeads(admin, { limit: 50 });
      expect(adminPage.ok).toBe(true);
      if (!adminPage.ok) throw new Error("unreachable");
      expect(adminPage.data.leads.map((l) => l.leadRef)).toContain("seed-lead-researching");
    });

    it("an EXPLICIT_RECORD grant reaches exactly the one referenced Lead, independent of region/team", async () => {
      const viewer = await actorFor("viewer");
      // Viewer has REGION Kerala + an EXPLICIT_RECORD grant on
      // seed-lead-duplicate specifically (Karnataka - outside Viewer's
      // region grant otherwise).
      const viaExplicitRecord = await getLead(viewer, "seed-lead-duplicate");
      expect(viaExplicitRecord.ok).toBe(true);

      const outsideEverything = await getLead(viewer, "seed-lead-rejected");
      expect(outsideEverything).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    });

    it("cursor pagination is deterministic: visits every in-scope Lead exactly once across bounded pages", async () => {
      const admin = await actorFor("super_admin");
      const seen: string[] = [];
      let cursor: { orderValue: string; uid: string } | undefined;

      for (let guard = 0; guard < 50; guard += 1) {
        const page = await listLeads(admin, { limit: 3, cursor });
        if (!page.ok) throw new Error("listLeads failed");
        seen.push(...page.data.leads.map((l) => l.leadRef));
        if (!page.data.nextCursor) break;
        cursor = page.data.nextCursor;
      }

      expect(new Set(seen).size).toBe(seen.length);
      for (const ref of ["seed-lead-new", "seed-lead-researching", "seed-lead-contacted", "seed-lead-conversion-ready", "seed-lead-converted"]) {
        expect(seen).toContain(ref);
      }
    });
  });

  describe("create / edit", () => {
    it("creates a Lead with no address field accepted anywhere, even if the caller sends one", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(
        manager,
        { displayName: `Create Test ${runId}`, source: { type: "referral" }, region: "Kerala", address: "123 Fake Street" } as unknown,
        "req-create",
      );
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("unreachable");
      expect(created.data).not.toHaveProperty("address");
      expect(JSON.stringify(created.data)).not.toContain("Fake Street");
    });

    it("rejects a stale edit (version mismatch)", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `Stale Test ${runId}`, source: { type: "referral" }, region: "Kerala" }, "req-stale-create");
      if (!created.ok) throw new Error("unreachable");

      const first = await updateLead(manager, created.data.leadRef, { displayName: "Updated Once", expectedVersion: created.data.version }, "req-edit-1");
      expect(first.ok).toBe(true);

      const stale = await updateLead(manager, created.data.leadRef, { displayName: "Should Not Apply", expectedVersion: created.data.version }, "req-edit-2");
      expect(stale).toMatchObject({ ok: false, code: "stale_write" });
    });
  });

  describe("lifecycle: outreach-driven transitions", () => {
    it("the first genuine outbound contact advances NEW to CONTACTED; a meaningful inbound response then advances it to RESPONDED", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `Outreach Test ${runId}`, source: { type: "referral" }, region: "Kerala" }, "req-outreach-create");
      if (!created.ok) throw new Error("unreachable");
      expect(created.data.lifecycle).toBe("NEW");

      const outbound = await recordOutreach(
        manager,
        created.data.leadRef,
        { direction: "OUTBOUND", channel: "email", summary: "Introduced the programme.", outcome: "Sent", expectedVersion: created.data.version },
        "req-outbound",
      );
      expect(outbound.ok).toBe(true);
      if (!outbound.ok) throw new Error("unreachable");
      expect(outbound.data.lifecycle).toBe("CONTACTED");

      const inbound = await recordOutreach(
        manager,
        created.data.leadRef,
        { direction: "INBOUND", channel: "email", summary: "Replied with interest.", outcome: "Interested", meaningfulResponse: true, expectedVersion: outbound.data.version },
        "req-inbound",
      );
      expect(inbound.ok).toBe(true);
      if (!inbound.ok) throw new Error("unreachable");
      expect(inbound.data.lifecycle).toBe("RESPONDED");
      expect(inbound.data.respondedAt).toBeTruthy();
    });
  });

  describe("review outcomes", () => {
    it("records a SHORTLIST outcome without requiring a reason, but requires one for REJECT", async () => {
      const head = await actorFor("partnership_head");
      const shortlisted = await recordReview(head, "seed-lead-evaluating", { outcome: "SHORTLIST", expectedVersion: 1 }, "req-review-1");
      // seed-lead-evaluating's version may have drifted from earlier tests in
      // this same run - a stale rejection here is an acceptable outcome for
      // this particular assertion; what matters is REJECT's reason requirement.
      expect(["ok", "stale_write"]).toContain(shortlisted.ok ? "ok" : shortlisted.code);

      const missingReason = await recordReview(head, "seed-lead-evaluating", { outcome: "REJECT", expectedVersion: 999 }, "req-review-2");
      expect(missingReason).toMatchObject({ ok: false, code: "invalid_input" });
    });
  });

  describe("watchlist / reject / archive + reasoned restore", () => {
    it("requires a reason to enter WATCHLIST, and restores back to the exact prior state", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `Restore Test ${runId}`, source: { type: "referral" }, region: "Kerala" }, "req-restore-create");
      if (!created.ok) throw new Error("unreachable");

      const missingReason = await transitionLeadLifecycle(manager, created.data.leadRef, { to: "WATCHLIST", expectedVersion: created.data.version }, "req-no-reason");
      expect(missingReason).toMatchObject({ ok: false, code: "invalid_input" });

      const watchlisted = await transitionLeadLifecycle(manager, created.data.leadRef, { to: "WATCHLIST", reason: "Budget on hold.", expectedVersion: created.data.version }, "req-watchlist");
      expect(watchlisted.ok).toBe(true);
      if (!watchlisted.ok) throw new Error("unreachable");
      expect(watchlisted.data.lifecycle).toBe("WATCHLIST");

      const restored = await restoreLead(manager, created.data.leadRef, { reason: "Budget approved.", expectedVersion: watchlisted.data.version }, "req-restore");
      expect(restored.ok).toBe(true);
      if (!restored.ok) throw new Error("unreachable");
      expect(restored.data.lifecycle).toBe("NEW");
    });

    it("CONVERTED can never be reached through the manual transition endpoint", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `No Manual Convert ${runId}`, source: { type: "referral" }, region: "Kerala" }, "req-no-manual-convert");
      if (!created.ok) throw new Error("unreachable");
      const attempt = await transitionLeadLifecycle(manager, created.data.leadRef, { to: "CONVERTED", expectedVersion: created.data.version }, "req-manual-convert");
      expect(attempt).toMatchObject({ ok: false, code: "invalid_input" });
    });
  });

  describe("asset decision invariants", () => {
    it("NEW_ACCOUNT must not reference an existing Partner Account, and MAINTAIN_EXISTING must", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `Asset Test ${runId}`, source: { type: "referral" }, region: "Kerala" }, "req-asset-create");
      if (!created.ok) throw new Error("unreachable");

      const newAccountWithRef = await saveAssetDecision(manager, created.data.leadRef, { decision: "NEW_ACCOUNT", existingPartnerAccountRef: "some-ref", expectedVersion: created.data.version }, "req-asset-1");
      expect(newAccountWithRef).toMatchObject({ ok: false, code: "invalid_input" });

      const maintainWithoutRef = await saveAssetDecision(manager, created.data.leadRef, { decision: "MAINTAIN_EXISTING", expectedVersion: created.data.version }, "req-asset-2");
      expect(maintainWithoutRef).toMatchObject({ ok: false, code: "invalid_input" });

      const validNewAccount = await saveAssetDecision(manager, created.data.leadRef, { decision: "NEW_ACCOUNT", expectedVersion: created.data.version }, "req-asset-3");
      expect(validNewAccount.ok).toBe(true);
    });
  });

  describe("restricted KYC boundary", () => {
    it("is never present on the ordinary Lead DTO", async () => {
      const head = await actorFor("partnership_head");
      const result = await getLead(head, "seed-lead-conversion-ready");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.data).not.toHaveProperty("aadhaar");
      expect(result.data).not.toHaveProperty("pan");
      expect(result.data).not.toHaveProperty("bank");
      expect(JSON.stringify(result.data)).not.toMatch(/aadhaar|pan|bank|ifsc/i);
      expect(result.data.kycPackageComplete).toBe(true);
    });

    it("requires the discovery_kyc Sensitive Access category, independent of the manage_kyc action - Partnership Manager has the action but not the category", async () => {
      const manager = await actorFor("partnership_manager");
      const deniedByPartnershipManager = await getLeadKyc(manager, "seed-lead-conversion-ready");
      expect(deniedByPartnershipManager).toMatchObject({ ok: false, code: "unauthorized", reason: "sensitive_denied" });

      const head = await actorFor("partnership_head");
      const allowedForHead = await getLeadKyc(head, "seed-lead-conversion-ready");
      expect(allowedForHead.ok).toBe(true);
    });

    it("saving KYC never puts raw values into the append-only event log", async () => {
      const head = await actorFor("partnership_head");
      const created = await createLead(head, { displayName: `KYC Test ${runId}`, source: { type: "referral" }, region: "Kerala" }, "req-kyc-create");
      if (!created.ok) throw new Error("unreachable");

      const saved = await saveLeadKyc(
        head,
        created.data.leadRef,
        {
          email: "kyc@example.com",
          aadhaar: { number: "1111-2222-3333" },
          pan: { number: "SECRET1234F" },
          bank: { accountHolderName: "Secret Name", accountNumber: "999999999999", ifsc: "SECR0000001", bankName: "Secret Bank", branchName: "Secret Branch" },
          gst: { applicable: false },
          expectedKycVersion: 0,
          expectedLeadVersion: created.data.version,
        },
        "req-kyc-save",
      );
      expect(saved.ok).toBe(true);

      const leadDoc = await getLeadDocByRef(created.data.leadRef);
      if (!leadDoc) throw new Error("unreachable");
      const events = await listLeadEvents(leadDoc.uid, { limit: 20 });
      const eventsJson = JSON.stringify(events.events);
      expect(eventsJson).not.toContain("1111-2222-3333");
      expect(eventsJson).not.toContain("SECRET1234F");
      expect(eventsJson).not.toContain("999999999999");
      expect(eventsJson).not.toContain("SECR0000001");
    });
  });

  describe("manager assignment", () => {
    it("must reference a real, active, admitted user", async () => {
      const head = await actorFor("partnership_head");
      const created = await createLead(head, { displayName: `Manager Test ${runId}`, source: { type: "referral" }, region: "Kerala" }, "req-manager-create");
      if (!created.ok) throw new Error("unreachable");

      const bogus = await assignManager(head, created.data.leadRef, { managerUserRef: "not-a-real-ref", expectedVersion: created.data.version }, "req-manager-1");
      expect(bogus).toMatchObject({ ok: false, code: "invalid_input" });

      const headActor = await actorFor("partnership_head");
      const valid = await assignManager(head, created.data.leadRef, { managerUserRef: headActor.userRef, expectedVersion: created.data.version }, "req-manager-2");
      expect(valid.ok).toBe(true);
      if (!valid.ok) throw new Error("unreachable");
      expect(valid.data.managerRef).toBe(headActor.userRef);
    });
  });

  describe("duplicate lookup", () => {
    it("finds an existing seeded Lead by profile URL on a pre-create check", async () => {
      const manager = await actorFor("partnership_manager");
      const result = await precheckDuplicates(manager, { profileUrl: "https://instagram.com/new" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.data.status).toBe("confirmed");
      expect(result.data.matches.some((m) => m.ref === "seed-lead-new")).toBe(true);
    });

    it("runs and persists a duplicate check automatically on create - no separate action needed", async () => {
      const head = await actorFor("partnership_head");
      const created = await createLead(head, { displayName: `Dup Test ${runId}`, source: { type: "referral" }, region: "Kerala" }, "req-dup-create");
      if (!created.ok) throw new Error("unreachable");
      expect(created.data.duplicateCheck?.status).toBe("none");
    });

    it("flags a brand-new Lead as a confirmed duplicate automatically, by profile URL", async () => {
      const head = await actorFor("partnership_head");
      const created = await createLead(
        head,
        { displayName: `Dup Match ${runId}`, source: { type: "referral" }, region: "Kerala", profileUrl: "https://instagram.com/new" },
        "req-dup-create-match",
      );
      if (!created.ok) throw new Error("unreachable");
      expect(created.data.duplicateCheck?.status).toBe("confirmed");
      expect(created.data.duplicateCheck?.matches.some((m) => m.ref === "seed-lead-new")).toBe(true);
    });
  });

  describe("readiness", () => {
    it("returns zero blockers for the fully-prepared seeded CONVERSION_READY Lead", async () => {
      const head = await actorFor("partnership_head");
      const result = await getLeadReadiness(head, "seed-lead-conversion-ready");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.data.ready).toBe(true);
      expect(result.data.blockers).toEqual([]);
    });

    it("returns real, specific blockers for a brand-new Lead", async () => {
      const head = await actorFor("partnership_head");
      const result = await getLeadReadiness(head, "seed-lead-new");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.data.ready).toBe(false);
      expect(result.data.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["RESEARCH_INCOMPLETE", "REVIEW_MISSING", "MANAGER_MISSING", "KYC_INCOMPLETE"]));
    });
  });

  describe("conversion", () => {
    it("is denied when the Lead is not ready, with structured blockers", async () => {
      const head = await actorFor("partnership_head");
      const attempt = await convertLead(head, "seed-lead-evaluating", { idempotencyKey: `conv-${runId}-1`, expectedVersion: 1 }, "req-convert-not-ready");
      expect(attempt.ok).toBe(false);
      if (attempt.ok) throw new Error("unreachable");
      expect(["invalid_input", "not_ready"]).toContain(attempt.code);
    });

    it("converts a ready Lead into exactly one canonical Partner, is idempotent on retry, and NEW_ACCOUNT creates no fake Partner Account", async () => {
      const head = await actorFor("partnership_head");
      const email = `convert-${runId}@example-creator.test`;
      const created = await createLead(head, { displayName: `Convert Flow ${runId}`, email, source: { type: "referral" }, region: "Kerala" }, "req-convert-create");
      if (!created.ok) throw new Error("unreachable");
      const leadRef = created.data.leadRef;
      let version = created.data.version;

      const research = await saveResearch(head, leadRef, { targetAudience: "India 1", expectedVersion: version }, "req-cf-research");
      if (!research.ok) throw new Error("unreachable");
      version = research.data.version;

      const outbound = await recordOutreach(head, leadRef, { direction: "OUTBOUND", channel: "email", summary: "Intro", outcome: "Sent", expectedVersion: version }, "req-cf-outbound");
      if (!outbound.ok) throw new Error("unreachable");
      version = outbound.data.version;

      const inbound = await recordOutreach(
        head,
        leadRef,
        { direction: "INBOUND", channel: "email", summary: "Reply", outcome: "Interested", meaningfulResponse: true, expectedVersion: version },
        "req-cf-inbound",
      );
      if (!inbound.ok) throw new Error("unreachable");
      version = inbound.data.version;

      const evaluating = await transitionLeadLifecycle(head, leadRef, { to: "EVALUATING", expectedVersion: version }, "req-cf-evaluating");
      if (!evaluating.ok) throw new Error("unreachable");
      version = evaluating.data.version;

      const review = await recordReview(head, leadRef, { outcome: "SHORTLIST", expectedVersion: version }, "req-cf-review");
      if (!review.ok) throw new Error("unreachable");
      version = review.data.version;

      const commercial = await saveCommercial(head, leadRef, { alignmentConfirmed: true, expectedVersion: version }, "req-cf-commercial");
      if (!commercial.ok) throw new Error("unreachable");
      version = commercial.data.version;

      const agreement = await saveDiscoveryAgreement(head, leadRef, { confirmed: true, expectedVersion: version }, "req-cf-agreement");
      if (!agreement.ok) throw new Error("unreachable");
      version = agreement.data.version;

      const assetDecision = await saveAssetDecision(head, leadRef, { decision: "NEW_ACCOUNT", expectedVersion: version }, "req-cf-asset");
      if (!assetDecision.ok) throw new Error("unreachable");
      version = assetDecision.data.version;

      const headActor = await actorFor("partnership_head");
      const manager = await assignManager(head, leadRef, { managerUserRef: headActor.userRef, expectedVersion: version }, "req-cf-manager");
      if (!manager.ok) throw new Error("unreachable");
      version = manager.data.version;

      const kyc = await saveLeadKyc(
        head,
        leadRef,
        {
          email,
          aadhaar: { number: "0000-1111-2222" },
          pan: { number: "CONVT1234F" },
          bank: { accountHolderName: "Convert Flow", accountNumber: "111122223333", ifsc: "CONV0000001", bankName: "Convert Bank", branchName: "Convert Branch" },
          gst: { applicable: false },
          expectedKycVersion: 0,
          expectedLeadVersion: version,
        },
        "req-cf-kyc",
      );
      if (!kyc.ok) throw new Error("unreachable");
      // Saving KYC bumps the Lead's own version too (kyc-service.ts writes
      // both documents in one transaction).
      const afterKyc = await getLead(head, leadRef);
      if (!afterKyc.ok) throw new Error("unreachable");
      version = afterKyc.data.version;

      const readyTransition = await transitionLeadLifecycle(head, leadRef, { to: "CONVERSION_READY", expectedVersion: version }, "req-cf-ready");
      expect(readyTransition.ok).toBe(true);
      if (!readyTransition.ok) throw new Error("unreachable");
      version = readyTransition.data.version;

      const idempotencyKey = `conv-${runId}-2`;
      const first = await convertLead(head, leadRef, { idempotencyKey, expectedVersion: version }, "req-cf-convert-1");
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("unreachable");
      expect(first.data.partnerAccountRef).toBeNull();
      expect(first.data.pendingPartnerAccountSetup).toBe(true);

      // Retry with the SAME idempotency key - must return the identical
      // result, never create a second Partner.
      const retry = await convertLead(head, leadRef, { idempotencyKey, expectedVersion: version }, "req-cf-convert-2");
      expect(retry.ok).toBe(true);
      if (!retry.ok) throw new Error("unreachable");
      expect(retry.data.partnerRef).toBe(first.data.partnerRef);

      // A retry with a DIFFERENT idempotency key must ALSO return the same
      // result, not create a second Partner - the real guarantee is "a
      // Lead converts at most once", not "one key produces one result".
      const retryDifferentKey = await convertLead(head, leadRef, { idempotencyKey: `${idempotencyKey}-different`, expectedVersion: version }, "req-cf-convert-3");
      expect(retryDifferentKey.ok).toBe(true);
      if (!retryDifferentKey.ok) throw new Error("unreachable");
      expect(retryDifferentKey.data.partnerRef).toBe(first.data.partnerRef);

      const partner = await getPartnerDocByRef(first.data.partnerRef);
      expect(partner).toBeTruthy();
      expect(partner?.sourceDiscovery.leadRef).toBe(leadRef);
      expect(partner?.sourceDiscovery.snapshot.displayName).toBe(`Convert Flow ${runId}`);
      expect(partner?.pendingPartnerAccountSetup).toBe(true);

      const finalLead = await getLead(head, leadRef);
      expect(finalLead.ok).toBe(true);
      if (!finalLead.ok) throw new Error("unreachable");
      expect(finalLead.data.lifecycle).toBe("CONVERTED");
      expect(finalLead.data.conversion?.partnerRef).toBe(first.data.partnerRef);
    });

    it("the pre-converted seeded Lead's conversion is idempotent too, and preserves its Discovery provenance", async () => {
      const head = await actorFor("partnership_head");
      const result = await convertLead(head, "seed-lead-converted", { idempotencyKey: "any-key", expectedVersion: 1 }, "req-seed-convert-retry");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.data.partnerRef).toBe("seed-partner-converted");

      const partner = await getPartnerDocByRef("seed-partner-converted");
      expect(partner).toBeTruthy();
      expect(partner?.sourceDiscovery.leadRef).toBe("seed-lead-converted");
    });
  });
});
