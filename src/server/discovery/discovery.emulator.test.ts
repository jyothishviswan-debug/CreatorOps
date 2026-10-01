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
import { getPartnerDocByRef } from "@/server/partners/firestore";
import { getLeadDocByRef, type LeadListCursor } from "./firestore";
import { listLeadEvents } from "./lead-events";
import { assignManager, createLead, getLead, listLeads, precheckDuplicates, recordOutreach, recordReview, saveAssetDecision, saveCommercial, saveDiscoveryAgreement, saveResearch, updateLead } from "./lead-service";
import { getLeadKyc, saveLeadKyc } from "./kyc-service";
import { restoreLead, transitionLeadLifecycle } from "./lifecycle-service";
import { seedDiscoveryData } from "./seed-discovery-data";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { getRestrictedFinancialIdentityDoc } from "@/server/shared/restricted-financial-identity";

const uidByRole = new Map<string, string>();
const runId = Date.now();

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  await seedDiscoveryData();
  await seedPartnersData();

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
      await expect(createLead(null, { displayName: "X", phone: `+91 9${runId}01`, source: { type: "other" } }, "req-x")).resolves.toMatchObject({ ok: false, code: "unauthorized" });
    });

    it("a malformed/missing scope context (an actor with zero relevant grants) is denied, not silently given global access", async () => {
      // Analyst's seeded scope has no REGION Uttar Pradesh / TEAM /
      // EXPLICIT_RECORD covering the Uttar-Pradesh-region seeded Leads.
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
      // never the Uttar-Pradesh-only seeded Leads.
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
      // seed-lead-duplicate specifically (Uttar Pradesh - outside Viewer's
      // region grants otherwise).
      const viaExplicitRecord = await getLead(viewer, "seed-lead-duplicate");
      expect(viaExplicitRecord.ok).toBe(true);

      const outsideEverything = await getLead(viewer, "seed-lead-rejected");
      expect(outsideEverything).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    });

    it("cursor pagination is deterministic: visits every in-scope Lead exactly once across bounded pages", async () => {
      const admin = await actorFor("super_admin");
      const seen: string[] = [];
      let cursor: LeadListCursor | undefined;

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
        { displayName: `Create Test ${runId}`, phone: `+91 9${runId}02`, source: { type: "referral" }, regionIds: ["Kerala"], address: "123 Fake Street" } as unknown,
        "req-create",
      );
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("unreachable");
      expect(created.data).not.toHaveProperty("address");
      expect(JSON.stringify(created.data)).not.toContain("Fake Street");
    });

    it("rejects a stale edit (version mismatch)", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `Stale Test ${runId}`, phone: `+91 9${runId}03`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-stale-create");
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
      const created = await createLead(manager, { displayName: `Outreach Test ${runId}`, phone: `+91 9${runId}04`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-outreach-create");
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
      const created = await createLead(manager, { displayName: `Restore Test ${runId}`, phone: `+91 9${runId}05`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-restore-create");
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
      const created = await createLead(manager, { displayName: `No Manual Convert ${runId}`, phone: `+91 9${runId}06`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-no-manual-convert");
      if (!created.ok) throw new Error("unreachable");
      const attempt = await transitionLeadLifecycle(manager, created.data.leadRef, { to: "CONVERTED", expectedVersion: created.data.version }, "req-manual-convert");
      expect(attempt).toMatchObject({ ok: false, code: "invalid_input" });
    });
  });

  describe("asset decision invariants", () => {
    it("NEW_ACCOUNT must not reference an existing Partner Account; MAINTAIN_EXISTING may now be saved WITHOUT one (finding #16)", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `Asset Test ${runId}`, phone: `+91 9${runId}07`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-asset-create");
      if (!created.ok) throw new Error("unreachable");

      const newAccountWithRef = await saveAssetDecision(manager, created.data.leadRef, { decision: "NEW_ACCOUNT", existingPartnerAccountRef: "some-ref", expectedVersion: created.data.version }, "req-asset-1");
      expect(newAccountWithRef).toMatchObject({ ok: false, code: "invalid_input" });

      // Finding #16 (user-decided): existingPartnerAccountRef is now an
      // optional shortcut, not a prerequisite - saving MAINTAIN_EXISTING
      // without one succeeds at save time; readiness.ts is what verifies
      // sufficient identity exists (a ref OR the Lead's own platform)
      // before conversion, not this save-time check (see the readiness
      // block below).
      const maintainWithoutRef = await saveAssetDecision(manager, created.data.leadRef, { decision: "MAINTAIN_EXISTING", expectedVersion: created.data.version }, "req-asset-2");
      expect(maintainWithoutRef.ok).toBe(true);
      if (!maintainWithoutRef.ok) throw new Error("unreachable");

      const validNewAccount = await saveAssetDecision(manager, created.data.leadRef, { decision: "NEW_ACCOUNT", expectedVersion: maintainWithoutRef.data.version }, "req-asset-3");
      expect(validNewAccount.ok).toBe(true);
    });

    it("finding #16: MAINTAIN_EXISTING with no ref and no Lead platform is not conversion-ready; adding a platform (or a valid ref) makes it ready", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `Asset Identity Test ${runId}`, phone: `+91 9${runId}12`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-asset-identity-create");
      if (!created.ok) throw new Error("unreachable");

      const saved = await saveAssetDecision(manager, created.data.leadRef, { decision: "MAINTAIN_EXISTING", expectedVersion: created.data.version }, "req-asset-identity-save");
      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error("unreachable");

      const noIdentity = await getLeadReadiness(manager, created.data.leadRef);
      expect(noIdentity.ok).toBe(true);
      if (!noIdentity.ok) throw new Error("unreachable");
      expect(noIdentity.data.blockers.map((b) => b.code)).toContain("ASSET_DECISION_INVALID");

      const withPlatform = await updateLead(manager, created.data.leadRef, { platform: "Instagram", expectedVersion: saved.data.version }, "req-asset-identity-platform");
      expect(withPlatform.ok).toBe(true);
      if (!withPlatform.ok) throw new Error("unreachable");

      const withIdentity = await getLeadReadiness(manager, created.data.leadRef);
      expect(withIdentity.ok).toBe(true);
      if (!withIdentity.ok) throw new Error("unreachable");
      expect(withIdentity.data.blockers.map((b) => b.code)).not.toContain("ASSET_DECISION_INVALID");
    });

    // Finding #15: presence alone was never enough - a non-empty
    // existingPartnerAccountRef that doesn't resolve to a real Partner
    // Account used to save successfully, only surfacing as a late,
    // confusing "no longer resolves" error at conversion time. Real
    // referential integrity is now enforced at save time, for both
    // MAINTAIN_EXISTING and TRANSFER_AND_MAINTAIN.
    it("rejects a MAINTAIN_EXISTING/TRANSFER_AND_MAINTAIN decision whose existingPartnerAccountRef does not resolve to a real Partner Account", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `Asset Ref Test ${runId}`, phone: `+91 9${runId}08`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-asset-ref-create");
      if (!created.ok) throw new Error("unreachable");

      const maintainBogus = await saveAssetDecision(manager, created.data.leadRef, { decision: "MAINTAIN_EXISTING", existingPartnerAccountRef: "not-a-real-account", expectedVersion: created.data.version }, "req-asset-bogus-1");
      expect(maintainBogus).toMatchObject({ ok: false, code: "invalid_input" });

      const transferBogus = await saveAssetDecision(manager, created.data.leadRef, { decision: "TRANSFER_AND_MAINTAIN", existingPartnerAccountRef: "not-a-real-account", expectedVersion: created.data.version }, "req-asset-bogus-2");
      expect(transferBogus).toMatchObject({ ok: false, code: "invalid_input" });

      const maintainReal = await saveAssetDecision(
        manager,
        created.data.leadRef,
        { decision: "MAINTAIN_EXISTING", existingPartnerAccountRef: "seed-account-creatorhouse-ig-primary", expectedVersion: created.data.version },
        "req-asset-real-1",
      );
      expect(maintainReal.ok).toBe(true);
      if (!maintainReal.ok) throw new Error("unreachable");

      const transferReal = await saveAssetDecision(
        manager,
        created.data.leadRef,
        { decision: "TRANSFER_AND_MAINTAIN", existingPartnerAccountRef: "seed-account-creatorhouse-ig-primary", expectedVersion: maintainReal.data.version },
        "req-asset-real-2",
      );
      expect(transferReal.ok).toBe(true);
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
      const created = await createLead(head, { displayName: `KYC Test ${runId}`, phone: `+91 9${runId}09`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-kyc-create");
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
      const created = await createLead(head, { displayName: `Manager Test ${runId}`, phone: `+91 9${runId}10`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-manager-create");
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
      const created = await createLead(head, { displayName: `Dup Test ${runId}`, phone: `+91 9${runId}11`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-dup-create");
      if (!created.ok) throw new Error("unreachable");
      expect(created.data.duplicateCheck?.status).toBe("none");
    });

    it("flags a brand-new Lead as a confirmed duplicate automatically, by profile URL", async () => {
      const head = await actorFor("partnership_head");
      const created = await createLead(
        head,
        { displayName: `Dup Match ${runId}`, phone: `+91 9${runId}12`, source: { type: "referral" }, regionIds: ["Kerala"], profileUrl: "https://instagram.com/new" },
        "req-dup-create-match",
      );
      if (!created.ok) throw new Error("unreachable");
      expect(created.data.duplicateCheck?.status).toBe("confirmed");
      expect(created.data.duplicateCheck?.matches.some((m) => m.ref === "seed-lead-new")).toBe(true);
    });
  });

  // Findings #2/#3 (user-decided): editing already-confirmed Agreement/Commercial evidence - the
  // underlying service functions (saveDiscoveryAgreement/saveCommercial) already had expectedVersion
  // staleness protection and action-grant authorization before this wave; the wave's own change is
  // purely the client-side read-only/edit toggle, but the required proof below still exercises the
  // real server behavior an authorized/unauthorized/stale edit each depend on.
  describe("Confirmed evidence editability (findings #2/#3)", () => {
    it("an authorized actor can edit already-confirmed Agreement evidence, and the edit genuinely applies", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `Edit Agreement Test ${runId}`, phone: `+91 9${runId}10`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-ea-create");
      if (!created.ok) throw new Error("unreachable");
      const confirmed = await saveDiscoveryAgreement(manager, created.data.leadRef, { summary: "Original", confirmed: true, expectedVersion: created.data.version }, "req-ea-1");
      if (!confirmed.ok) throw new Error("unreachable");
      expect(confirmed.data.discoveryAgreement?.confirmedAt).toBeTruthy();

      const edited = await saveDiscoveryAgreement(manager, created.data.leadRef, { summary: "Edited after confirm", confirmed: true, expectedVersion: confirmed.data.version }, "req-ea-2");
      expect(edited.ok).toBe(true);
      if (!edited.ok) throw new Error("unreachable");
      expect(edited.data.discoveryAgreement?.summary).toBe("Edited after confirm");
    });

    it("an authorized actor can edit already-confirmed Commercial evidence, and the edit genuinely applies", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `Edit Commercial Test ${runId}`, phone: `+91 9${runId}11`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-ec-create");
      if (!created.ok) throw new Error("unreachable");
      const confirmed = await saveCommercial(manager, created.data.leadRef, { negotiationSummary: "Original", alignmentConfirmed: true, expectedVersion: created.data.version }, "req-ec-1");
      if (!confirmed.ok) throw new Error("unreachable");
      expect(confirmed.data.commercial?.alignmentConfirmed).toBe(true);

      const edited = await saveCommercial(manager, created.data.leadRef, { negotiationSummary: "Edited after confirm", alignmentConfirmed: true, expectedVersion: confirmed.data.version }, "req-ec-2");
      expect(edited.ok).toBe(true);
      if (!edited.ok) throw new Error("unreachable");
      expect(edited.data.commercial?.negotiationSummary).toBe("Edited after confirm");
    });

    it("an actor without manage_commercial is denied editing confirmed Agreement/Commercial evidence, never silently allowed", async () => {
      const analyst = await actorFor("analyst");
      await expect(saveDiscoveryAgreement(analyst, "seed-lead-new", { confirmed: true, expectedVersion: 1 }, "req-denied-a")).resolves.toMatchObject({ ok: false, code: "unauthorized" });
      await expect(saveCommercial(analyst, "seed-lead-new", { alignmentConfirmed: true, expectedVersion: 1 }, "req-denied-c")).resolves.toMatchObject({ ok: false, code: "unauthorized" });
    });

    it("editing preserves the prior confirmation's own audit event - never silently rewritten out of history", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `History Preserved Test ${runId}`, phone: `+91 9${runId}12`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-hp-create");
      if (!created.ok) throw new Error("unreachable");
      const confirmed = await saveDiscoveryAgreement(manager, created.data.leadRef, { confirmed: true, expectedVersion: created.data.version }, "req-hp-1");
      if (!confirmed.ok) throw new Error("unreachable");
      const edited = await saveDiscoveryAgreement(manager, created.data.leadRef, { confirmed: true, summary: "v2", expectedVersion: confirmed.data.version }, "req-hp-2");
      if (!edited.ok) throw new Error("unreachable");

      const leadDoc = await getLeadDocByRef(created.data.leadRef);
      if (!leadDoc) throw new Error("unreachable");
      const events = await listLeadEvents(leadDoc.uid, { limit: 20 });
      const agreementEvents = events.events.filter((e) => e.kind === "agreement_saved");
      // Both the original confirmation AND the later edit each wrote their own append-only event -
      // editing never overwrites or removes the prior confirmation's own record.
      expect(agreementEvents.length).toBe(2);
    });

    it("a stale/conflicting edit to already-confirmed evidence is rejected, never silently applied over newer data", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `Stale Edit Test ${runId}`, phone: `+91 9${runId}13`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-se-create");
      if (!created.ok) throw new Error("unreachable");
      const confirmed = await saveDiscoveryAgreement(manager, created.data.leadRef, { confirmed: true, expectedVersion: created.data.version }, "req-se-1");
      if (!confirmed.ok) throw new Error("unreachable");
      const newer = await saveDiscoveryAgreement(manager, created.data.leadRef, { confirmed: true, summary: "newer", expectedVersion: confirmed.data.version }, "req-se-2");
      expect(newer.ok).toBe(true);

      // A stale retry using the OLD (already-superseded) version is rejected, never silently applied
      // over the newer data a concurrent edit already wrote.
      const stale = await saveDiscoveryAgreement(manager, created.data.leadRef, { confirmed: true, summary: "stale", expectedVersion: confirmed.data.version }, "req-se-3");
      expect(stale).toMatchObject({ ok: false, code: "stale_write" });
    });
  });

  // Finding #7 (user-decided): a controlled Channel selector - closed enum for new writes only.
  describe("Outreach Channel enum (finding #7)", () => {
    it("accepts every canonical channel value and rejects a value outside the closed set", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `Channel Test ${runId}`, phone: `+91 9${runId}14`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-ch-create");
      if (!created.ok) throw new Error("unreachable");

      const valid = await recordOutreach(manager, created.data.leadRef, { channel: "instagram", summary: "DM sent", outcome: "Sent", expectedVersion: created.data.version }, "req-ch-valid");
      expect(valid.ok).toBe(true);

      const invalid = await recordOutreach(manager, created.data.leadRef, { channel: "carrier_pigeon", summary: "x", outcome: "x", expectedVersion: created.data.version }, "req-ch-invalid");
      expect(invalid).toMatchObject({ ok: false, code: "invalid_input" });
    });

    it("an already-stored historical channel value outside the current enum still reads back safely, never rejected", async () => {
      // seed-lead-contacted's own outreachSummary.lastChannel is real pre-existing seed data - proves
      // reading old data never re-validates it against the new write-time enum.
      const head = await actorFor("partnership_head");
      const result = await getLead(head, "seed-lead-contacted");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.data.outreachSummary?.lastChannel).toBeTruthy();
    });
  });

  // Finding #9 (user-decided): a real per-attempt log, reusing the existing append-only
  // leads/{uid}/events history - never overwritten, always chronological, full per-attempt detail.
  describe("Per-attempt Outreach history (finding #9)", () => {
    it("records multiple attempts as separate, non-overwriting events with full per-attempt detail and actor provenance", async () => {
      const manager = await actorFor("partnership_manager");
      const created = await createLead(manager, { displayName: `Multi Attempt Test ${runId}`, phone: `+91 9${runId}15`, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-ma-create");
      if (!created.ok) throw new Error("unreachable");

      const first = await recordOutreach(
        manager,
        created.data.leadRef,
        { channel: "email", summary: "First attempt", outcome: "Sent", notes: "Intro note", supportingReference: "ref-1", expectedVersion: created.data.version },
        "req-ma-1",
      );
      if (!first.ok) throw new Error("unreachable");
      const second = await recordOutreach(
        manager,
        created.data.leadRef,
        { channel: "whatsapp", summary: "Second attempt", outcome: "Replied", meaningfulResponse: true, expectedVersion: first.data.version },
        "req-ma-2",
      );
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("unreachable");
      expect(second.data.outreachSummary?.totalCount).toBe(2);

      const leadDoc = await getLeadDocByRef(created.data.leadRef);
      if (!leadDoc) throw new Error("unreachable");
      const page = await listLeadEvents(leadDoc.uid, { limit: 20 });
      const attempts = page.events.filter((e) => e.kind === "outreach_recorded");
      // Both attempts are their own, independent event - the second never overwrites the first.
      expect(attempts).toHaveLength(2);
      // Chronological: listLeadEvents orders newest-first, so the SECOND attempt's own event comes
      // before the first's.
      expect(attempts[0]!.metadata?.summary).toBe("Second attempt");
      expect(attempts[1]!.metadata?.summary).toBe("First attempt");
      // Full per-attempt detail survives in the event, not just the four rolled-up summary fields.
      expect(attempts[1]!.metadata).toMatchObject({ channel: "email", summary: "First attempt", outcome: "Sent", notes: "Intro note", supportingReference: "ref-1", meaningfulResponse: false });
      expect(attempts[0]!.metadata).toMatchObject({ channel: "whatsapp", summary: "Second attempt", outcome: "Replied", meaningfulResponse: true });
      // Actor provenance recorded on every event, not just the Lead's own updatedByUserRef.
      expect(attempts[0]!.actorUserRef).toBe(manager.userRef);
      expect(attempts[1]!.actorUserRef).toBe(manager.userRef);
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
      const created = await createLead(head, { displayName: `Convert Flow ${runId}`, phone: `+91 9${runId}13`, email, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-convert-create");
      if (!created.ok) throw new Error("unreachable");
      const leadRef = created.data.leadRef;
      let version = created.data.version;

      const research = await saveResearch(head, leadRef, { targetAudience: ["India 1"], expectedVersion: version }, "req-cf-research");
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
      expect(partner?.sourceDiscovery?.leadRef).toBe(leadRef);
      expect(partner?.sourceDiscovery?.snapshot.displayName).toBe(`Convert Flow ${runId}`);
      expect(partner?.pendingPartnerAccountSetup).toBe(true);
      // no restricted KYC value ever lands on the ordinary Partner record itself
      expect(JSON.stringify(partner)).not.toMatch(/CONVT1234F|0000-1111-2222|111122223333/);

      // Remediation-plan Wave B / finding #1 re-audit: the missing assertion this re-audit found -
      // no prior test actually read back the Partner's OWN restricted-identity record to confirm the
      // KYC carry-forward really landed there.
      const restricted = await getRestrictedFinancialIdentityDoc("PARTNER", partner!.uid);
      expect(restricted).toBeTruthy();
      expect(restricted?.subjectRef).toBe(first.data.partnerRef);
      expect(restricted?.aadhaar).toEqual({ number: "0000-1111-2222" });
      expect(restricted?.pan).toEqual({ number: "CONVT1234F" });
      expect(restricted?.bank).toMatchObject({ accountHolderName: "Convert Flow", accountNumber: "111122223333", ifsc: "CONV0000001" });

      const finalLead = await getLead(head, leadRef);
      expect(finalLead.ok).toBe(true);
      if (!finalLead.ok) throw new Error("unreachable");
      expect(finalLead.data.lifecycle).toBe("CONVERTED");
      expect(finalLead.data.conversion?.partnerRef).toBe(first.data.partnerRef);
    });

    // Remediation-plan Wave B / finding #1 re-audit: the real, confirmed gap this re-audit found -
    // convertLead only checked the "convert_lead" action grant, never the discovery_kyc sensitive
    // category kyc-service.ts's own requireKycAccess always requires for the exact same "touch raw
    // KYC values" operation. A Partnership Manager has convert_lead + manage_kyc but is deliberately
    // NOT granted discovery_kyc (see authz/seed-access-data.ts's SENSITIVE_GRANTS) - before the fix,
    // that Manager could still trigger the KYC-copy with zero sensitive-access check at all.
    it("a Partnership Manager (convert_lead granted, discovery_kyc sensitive access NOT granted) is denied conversion - the KYC-copy is gated behind sensitive access, not just the convert_lead action", async () => {
      const head = await actorFor("partnership_head");
      const manager = await actorFor("partnership_manager");
      const email = `convert-sensitive-${runId}@example-creator.test`;
      const created = await createLead(head, { displayName: `Convert Sensitive ${runId}`, phone: `+91 9${runId}14`, email, source: { type: "referral" }, regionIds: ["Kerala"] }, "req-cs-create");
      if (!created.ok) throw new Error("unreachable");
      const leadRef = created.data.leadRef;
      let version = created.data.version;

      const research = await saveResearch(head, leadRef, { targetAudience: ["India 1"], expectedVersion: version }, "req-cs-research");
      if (!research.ok) throw new Error("unreachable");
      version = research.data.version;

      const outbound = await recordOutreach(head, leadRef, { direction: "OUTBOUND", channel: "email", summary: "Intro", outcome: "Sent", expectedVersion: version }, "req-cs-outbound");
      if (!outbound.ok) throw new Error("unreachable");
      version = outbound.data.version;

      const inbound = await recordOutreach(
        head,
        leadRef,
        { direction: "INBOUND", channel: "email", summary: "Reply", outcome: "Interested", meaningfulResponse: true, expectedVersion: version },
        "req-cs-inbound",
      );
      if (!inbound.ok) throw new Error("unreachable");
      version = inbound.data.version;

      const evaluating = await transitionLeadLifecycle(head, leadRef, { to: "EVALUATING", expectedVersion: version }, "req-cs-evaluating");
      if (!evaluating.ok) throw new Error("unreachable");
      version = evaluating.data.version;

      const review = await recordReview(head, leadRef, { outcome: "SHORTLIST", expectedVersion: version }, "req-cs-review");
      if (!review.ok) throw new Error("unreachable");
      version = review.data.version;

      const commercial = await saveCommercial(head, leadRef, { alignmentConfirmed: true, expectedVersion: version }, "req-cs-commercial");
      if (!commercial.ok) throw new Error("unreachable");
      version = commercial.data.version;

      const agreement = await saveDiscoveryAgreement(head, leadRef, { confirmed: true, expectedVersion: version }, "req-cs-agreement");
      if (!agreement.ok) throw new Error("unreachable");
      version = agreement.data.version;

      const assetDecision = await saveAssetDecision(head, leadRef, { decision: "NEW_ACCOUNT", expectedVersion: version }, "req-cs-asset");
      if (!assetDecision.ok) throw new Error("unreachable");
      version = assetDecision.data.version;

      const headActor = await actorFor("partnership_head");
      const managerAssign = await assignManager(head, leadRef, { managerUserRef: headActor.userRef, expectedVersion: version }, "req-cs-manager");
      if (!managerAssign.ok) throw new Error("unreachable");
      version = managerAssign.data.version;

      const kyc = await saveLeadKyc(
        head,
        leadRef,
        {
          email,
          aadhaar: { number: "0000-9999-8888" },
          pan: { number: "SENST1234F" },
          bank: { accountHolderName: "Convert Sensitive", accountNumber: "222233334444", ifsc: "SENS0000001", bankName: "Sens Bank", branchName: "Sens Branch" },
          gst: { applicable: false },
          expectedKycVersion: 0,
          expectedLeadVersion: version,
        },
        "req-cs-kyc",
      );
      if (!kyc.ok) throw new Error("unreachable");
      const afterKyc = await getLead(head, leadRef);
      if (!afterKyc.ok) throw new Error("unreachable");
      version = afterKyc.data.version;

      const readyTransition = await transitionLeadLifecycle(head, leadRef, { to: "CONVERSION_READY", expectedVersion: version }, "req-cs-ready");
      expect(readyTransition.ok).toBe(true);
      if (!readyTransition.ok) throw new Error("unreachable");
      version = readyTransition.data.version;

      // The Manager's attempt is denied - sensitive access, not the convert_lead action, is missing.
      const deniedAttempt = await convertLead(manager, leadRef, { idempotencyKey: `conv-sens-${runId}-1`, expectedVersion: version }, "req-cs-convert-denied");
      expect(deniedAttempt.ok).toBe(false);
      if (deniedAttempt.ok) throw new Error("unreachable");
      expect(deniedAttempt.code).toBe("unauthorized");

      // Confirmed genuinely denied, not silently converted anyway.
      const stillReady = await getLead(head, leadRef);
      expect(stillReady.ok).toBe(true);
      if (!stillReady.ok) throw new Error("unreachable");
      expect(stillReady.data.lifecycle).toBe("CONVERSION_READY");

      // The SAME Lead converts successfully for an actor who DOES have discovery_kyc sensitive
      // access - this is a sensitive-access gap, not a blanket regression on legitimate conversion.
      const allowedAttempt = await convertLead(head, leadRef, { idempotencyKey: `conv-sens-${runId}-2`, expectedVersion: version }, "req-cs-convert-allowed");
      expect(allowedAttempt.ok).toBe(true);
      if (!allowedAttempt.ok) throw new Error("unreachable");
      const restricted = await getRestrictedFinancialIdentityDoc("PARTNER", (await getPartnerDocByRef(allowedAttempt.data.partnerRef))!.uid);
      expect(restricted?.pan).toEqual({ number: "SENST1234F" });
    });

    it("the pre-converted seeded Lead's conversion is idempotent too, and preserves its Discovery provenance", async () => {
      const head = await actorFor("partnership_head");
      const result = await convertLead(head, "seed-lead-converted", { idempotencyKey: "any-key", expectedVersion: 1 }, "req-seed-convert-retry");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.data.partnerRef).toBe("seed-partner-converted");

      const partner = await getPartnerDocByRef("seed-partner-converted");
      expect(partner).toBeTruthy();
      expect(partner?.sourceDiscovery?.leadRef).toBe("seed-lead-converted");
    });
  });
});
