// Step 7A - real reads/writes against the running Firestore/Auth
// emulator (no mocks), same rationale as Discovery's own
// discovery.emulator.test.ts: this service layer uses Firestore
// transactions, Filter.or() composite queries, and orderBy/cursor
// pagination extensively, none of which the lightweight fake-firestore
// test double can faithfully exercise. Run with `pnpm test:emulator`
// against a running `pnpm firebase:emulators`.
import { beforeAll, describe, expect, it } from "vitest";

import { convertLead } from "@/server/discovery/conversion-service";
import {
  assignManager,
  createLead,
  recordOutreach,
  recordReview,
  saveAssetDecision,
  saveCommercial,
  saveDiscoveryAgreement,
  saveResearch,
} from "@/server/discovery/lead-service";
import { transitionLeadLifecycle } from "@/server/discovery/lifecycle-service";
import { seedDiscoveryData } from "@/server/discovery/seed-discovery-data";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth } from "@/server/firebase/admin";
import { checkForPartnerDuplicates } from "./duplicate-check";
import { getPartnerAccountDocByRef, getPartnerAccountIdentityClaim, getPartnerDocByRef } from "./firestore";
import { claimIdFor, computeNormalizedIdentity } from "./identity";
import { archivePartner, blacklistPartner, checkPartnerDependencies, restorePartner } from "./partner-lifecycle-service";
import { createPartnerAccount, editPartnerAccount, getPartnerAccount, listPartnerAccounts, setPartnerAccountStatus, setPrimaryPartnerAccount } from "./partner-account-service";
import { createPartner, editPartner, getPartner, getPartnerHistory, listPartners, setPartnerOwnerTeam, setPartnerStatus } from "./partner-service";
import { getPartnerRestrictedIdentity, savePartnerRestrictedIdentity } from "./restricted-identity-service";
import { seedPartnersData } from "./seed-partners-data";
import { partnerAccountDocSchema, partnerDocSchema } from "./types";

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

function uniqueName(prefix: string): string {
  return `${prefix} ${runId}-${Math.random().toString(36).slice(2, 8)}`;
}

// Shared by "Discovery handoff" and the identity-evolution MAINTAIN_EXISTING
// test - walks a brand-new Lead all the way through the real workflow to a
// real convertLead call, exactly the way an operator would through the UI.
async function convertFreshLeadToPartner(assetDecision: "NEW_ACCOUNT" | "MAINTAIN_EXISTING", existingPartnerAccountRef?: string) {
  const head = await actorFor("partnership_head");
  const email = `${uniqueName("handoff").replace(/\s+/g, "")}@example.com`;
  const lead = await createLead(head, { displayName: uniqueName("Handoff Lead"), source: { type: "referral" }, regionIds: ["Kerala"], email, platform: "Instagram", handle: uniqueName("handofflead").replace(/\s+/g, "") }, "req-handoff-create");
  if (!lead.ok) throw new Error("unreachable");
  let version = lead.data.version;

  const research = await saveResearch(head, lead.data.leadRef, { targetAudience: ["India 1"], expectedVersion: version }, "req-handoff-research");
  if (!research.ok) throw new Error("unreachable");
  version = research.data.version;
  const outbound = await recordOutreach(head, lead.data.leadRef, { direction: "OUTBOUND", channel: "email", summary: "hi", outcome: "sent", expectedVersion: version }, "req-handoff-out");
  if (!outbound.ok) throw new Error("unreachable");
  version = outbound.data.version;
  const inbound = await recordOutreach(head, lead.data.leadRef, { direction: "INBOUND", channel: "email", summary: "reply", outcome: "interested", meaningfulResponse: true, expectedVersion: version }, "req-handoff-in");
  if (!inbound.ok) throw new Error("unreachable");
  version = inbound.data.version;
  const evaluating = await transitionLeadLifecycle(head, lead.data.leadRef, { to: "EVALUATING", expectedVersion: version }, "req-handoff-eval");
  if (!evaluating.ok) throw new Error("unreachable");
  version = evaluating.data.version;
  const review = await recordReview(head, lead.data.leadRef, { outcome: "SHORTLIST", expectedVersion: version }, "req-handoff-review");
  if (!review.ok) throw new Error("unreachable");
  version = review.data.version;
  const commercial = await saveCommercial(head, lead.data.leadRef, { alignmentConfirmed: true, expectedVersion: version }, "req-handoff-commercial");
  if (!commercial.ok) throw new Error("unreachable");
  version = commercial.data.version;
  const agreement = await saveDiscoveryAgreement(head, lead.data.leadRef, { confirmed: true, expectedVersion: version }, "req-handoff-agreement");
  if (!agreement.ok) throw new Error("unreachable");
  version = agreement.data.version;
  const asset = await saveAssetDecision(head, lead.data.leadRef, { decision: assetDecision, existingPartnerAccountRef, expectedVersion: version }, "req-handoff-asset");
  if (!asset.ok) throw new Error("unreachable");
  version = asset.data.version;
  const manager = await assignManager(head, lead.data.leadRef, { managerUserRef: head.userRef, expectedVersion: version }, "req-handoff-manager");
  if (!manager.ok) throw new Error("unreachable");
  version = manager.data.version;

  const { saveLeadKyc } = await import("@/server/discovery/kyc-service");
  const kyc = await saveLeadKyc(
    head,
    lead.data.leadRef,
    { email, aadhaar: { number: "0000-1111-2222" }, pan: { number: "HAND01234F" }, bank: { accountHolderName: "Handoff", accountNumber: "111122223333", ifsc: "HAND0000001", bankName: "Handoff Bank", branchName: "Handoff Branch" }, gst: { applicable: false }, expectedKycVersion: 0, expectedLeadVersion: version },
    "req-handoff-kyc",
  );
  if (!kyc.ok) throw new Error("unreachable");

  const { getLeadDocByRef } = await import("@/server/discovery/firestore");
  const freshLead = await getLeadDocByRef(lead.data.leadRef);
  if (!freshLead) throw new Error("unreachable");
  version = freshLead.version;

  const ready = await transitionLeadLifecycle(head, lead.data.leadRef, { to: "CONVERSION_READY", expectedVersion: version }, "req-handoff-ready");
  if (!ready.ok) throw new Error(`unreachable: ${JSON.stringify(ready)}`);
  version = ready.data.version;

  const idempotencyKey = `handoff-${runId}-${Math.random().toString(36).slice(2, 8)}`;
  const converted = await convertLead(head, lead.data.leadRef, { idempotencyKey, expectedVersion: version }, "req-handoff-convert");
  return { head, lead: lead.data, converted };
}

describe("Partners domain (real emulator)", () => {
  describe("authorization", () => {
    it("an unauthenticated actor is denied every operation (fails closed)", async () => {
      await expect(listPartners(null, {})).resolves.toMatchObject({ ok: false, code: "unauthorized", reason: "not_authenticated" });
      await expect(createPartner(null, { displayName: "X" }, "req-x")).resolves.toMatchObject({ ok: false, code: "unauthorized", reason: "not_authenticated" });
    });

    it("role baseline is respected: a role with no Partners action grant cannot create", async () => {
      const viewer = await actorFor("viewer");
      const result = await createPartner(viewer, { displayName: uniqueName("Viewer Attempt") }, "req-viewer-create");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("unauthorized");
      expect(result.reason).toBe("action_denied");
    });

    it("same-scope actor (REGION grant) can reach a Partner in that region", async () => {
      const head = await actorFor("partnership_head"); // has REGION Kerala
      const result = await getPartner(head, "seed-partner-direct"); // regionIds: ["Kerala"]
      expect(result.ok).toBe(true);
    });

    it("cross-scope actor is denied a Partner outside every one of their scope grants", async () => {
      const viewer = await actorFor("viewer"); // SELF + REGION Kerala only
      const result = await getPartner(viewer, "seed-partner-blacklisted"); // Maharashtra, unowned
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("unauthorized");
      expect(result.reason).toBe("scope_denied");
    });

    it("PARTNER-type scope grant alone reaches a Partner outside every region/team grant - the exact fixture seed-access-data.ts's SCOPE_GRANTS was written for", async () => {
      const manager = await actorFor("partnership_manager"); // REGION Kerala/Maharashtra, TEAM kerala-programmes, PARTNER creator-house
      const result = await getPartner(manager, "creator-house"); // Karnataka - outside every manager REGION/TEAM grant
      expect(result.ok).toBe(true);

      const viewer = await actorFor("viewer"); // no PARTNER grant at all
      const denied = await getPartner(viewer, "creator-house");
      expect(denied.ok).toBe(false);
    });

    it("global scope (super_admin) reaches every Partner regardless of region/team/owner", async () => {
      const admin = await actorFor("super_admin");
      await expect(getPartner(admin, "seed-partner-blacklisted")).resolves.toMatchObject({ ok: true });
      await expect(getPartner(admin, "creator-house")).resolves.toMatchObject({ ok: true });
    });

    it("a tampered/made-up partnerRef resolves to not_found, never leaking whether a differently-scoped Partner exists", async () => {
      const viewer = await actorFor("viewer");
      const result = await getPartner(viewer, "not-a-real-partner-ref-at-all");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("not_found");
    });
  });

  describe("Partner model", () => {
    it("rejects an unrecognized field on create (schema strictness)", async () => {
      const head = await actorFor("partnership_head");
      const result = await createPartner(head, { displayName: uniqueName("Strict Test"), notARealField: "x" }, "req-strict");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("invalid_input");
    });

    it("direct create produces a Partner that parses under the canonical schema, ACTIVE by default, no Discovery provenance", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Direct Create"), regionIds: ["Kerala"] }, "req-direct-create");
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("unreachable");
      expect(created.data.status).toBe("ACTIVE");
      expect(created.data.originLeadRefs).toEqual([]);

      const doc = await getPartnerDocByRef(created.data.partnerRef);
      expect(partnerDocSchema.safeParse(doc).success).toBe(true);
    });

    it("Target Audience can be captured directly at create (multi-value), changed via ordinary edit, and filtered on (any-of) in listPartners", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Tagged Direct"), regionIds: ["Kerala"], targetAudience: ["India 2", "India 3"] }, "req-ta-create");
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("unreachable");
      expect(created.data.targetAudience).toEqual(["India 2", "India 3"]);

      const edited = await editPartner(head, created.data.partnerRef, { targetAudience: ["India 4"], expectedVersion: created.data.version }, "req-ta-edit");
      expect(edited.ok).toBe(true);
      if (!edited.ok) throw new Error("unreachable");
      expect(edited.data.targetAudience).toEqual(["India 4"]);

      const filtered = await listPartners(head, { limit: 50, targetAudience: "India 4" });
      expect(filtered.ok).toBe(true);
      if (!filtered.ok) throw new Error("unreachable");
      expect(filtered.data.partners.some((p) => p.partnerRef === created.data.partnerRef)).toBe(true);
      expect(filtered.data.partners.every((p) => p.targetAudience.includes("India 4"))).toBe(true);

      // "any of" semantics - a filter naming two values matches a Partner
      // carrying either.
      const filteredAnyOf = await listPartners(head, { limit: 50, targetAudience: ["India 4", "India 2"] });
      expect(filteredAnyOf.ok).toBe(true);
      if (!filteredAnyOf.ok) throw new Error("unreachable");
      expect(filteredAnyOf.data.partners.some((p) => p.partnerRef === created.data.partnerRef)).toBe(true);
    });

    it("the ordinary DTO never includes restricted financial identity fields", async () => {
      const head = await actorFor("partnership_head");
      const result = await getPartner(head, "creator-house");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const json = JSON.stringify(result.data);
      expect(json).not.toMatch(/pan|aadhaar|ifsc|accountNumber/i);
    });

    it("edit + stale version is rejected", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Stale Edit"), regionIds: ["Kerala"] }, "req-stale-create");
      if (!created.ok) throw new Error("unreachable");

      const first = await editPartner(head, created.data.partnerRef, { displayName: "Renamed Once", expectedVersion: created.data.version }, "req-edit-1");
      expect(first.ok).toBe(true);

      const stale = await editPartner(head, created.data.partnerRef, { displayName: "Renamed Twice", expectedVersion: created.data.version }, "req-edit-2");
      expect(stale.ok).toBe(false);
      if (stale.ok) throw new Error("unreachable");
      expect(stale.code).toBe("stale_write");
    });

    it("owner/team validation rejects a non-existent or inactive ownerUserRef", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Owner Validation"), regionIds: ["Kerala"] }, "req-owner-create");
      if (!created.ok) throw new Error("unreachable");

      const result = await setPartnerOwnerTeam(head, created.data.partnerRef, { ownerUserRef: "not-a-real-user-ref", teamIds: [], expectedVersion: created.data.version }, "req-owner-invalid");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("invalid_input");
    });

    it("owner/team validation accepts a real active user and it's readable back afterward", async () => {
      const head = await actorFor("partnership_head");
      const manager = await actorFor("partnership_manager");
      const created = await createPartner(head, { displayName: uniqueName("Owner Assign"), regionIds: ["Kerala"] }, "req-owner-create-2");
      if (!created.ok) throw new Error("unreachable");

      const result = await setPartnerOwnerTeam(head, created.data.partnerRef, { ownerUserRef: manager.userRef, teamIds: ["kerala-programmes"], expectedVersion: created.data.version }, "req-owner-valid");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.data.ownerRef).toBe(manager.userRef);
      expect(result.data.teamIds).toEqual(["kerala-programmes"]);
    });

    it("scoped list never leaks a Partner outside the actor's own scope", async () => {
      const viewer = await actorFor("viewer"); // SELF + REGION Kerala only
      const result = await listPartners(viewer, { limit: 50 });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.data.partners.every((p) => p.partnerRef !== "seed-partner-blacklisted")).toBe(true); // Maharashtra, unowned
      expect(result.data.partners.every((p) => p.partnerRef !== "creator-house")).toBe(true); // Karnataka, no PARTNER grant for viewer
    });

    it("cursor pagination is deterministic - two pages never repeat or skip a record", async () => {
      const admin = await actorFor("super_admin");
      const page1 = await listPartners(admin, { limit: 2 });
      expect(page1.ok).toBe(true);
      if (!page1.ok || !page1.data.nextCursor) throw new Error("expected a first page with a cursor");

      const page2 = await listPartners(admin, { limit: 2, cursor: page1.data.nextCursor });
      expect(page2.ok).toBe(true);
      if (!page2.ok) throw new Error("unreachable");

      const page1Refs = new Set(page1.data.partners.map((p) => p.partnerRef));
      const overlap = page2.data.partners.filter((p) => page1Refs.has(p.partnerRef));
      expect(overlap).toEqual([]);
    });
  });

  describe("lifecycle", () => {
    it("ACTIVE <-> INACTIVE toggles both ways", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Toggle"), regionIds: ["Kerala"] }, "req-toggle-create");
      if (!created.ok) throw new Error("unreachable");

      const toInactive = await setPartnerStatus(head, created.data.partnerRef, { status: "INACTIVE", expectedVersion: created.data.version }, "req-toggle-1");
      expect(toInactive.ok).toBe(true);
      if (!toInactive.ok) throw new Error("unreachable");
      expect(toInactive.data.status).toBe("INACTIVE");

      const toActive = await setPartnerStatus(head, created.data.partnerRef, { status: "ACTIVE", expectedVersion: toInactive.data.version }, "req-toggle-2");
      expect(toActive.ok).toBe(true);
      if (!toActive.ok) throw new Error("unreachable");
      expect(toActive.data.status).toBe("ACTIVE");
    });

    it("blacklist requires the manage_partner_governance action, a reason, and is refused for a role without it", async () => {
      const viewer = await actorFor("viewer");
      const result = await blacklistPartner(viewer, "seed-partner-direct", { reason: "test", expectedVersion: 1 }, "req-bl-denied");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("action_denied");
    });

    it("blacklist is authorized/reasoned and preserves history (restore returns to the exact prior status)", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Blacklist Flow"), regionIds: ["Kerala"] }, "req-bl-create");
      if (!created.ok) throw new Error("unreachable");
      const toInactive = await setPartnerStatus(head, created.data.partnerRef, { status: "INACTIVE", expectedVersion: created.data.version }, "req-bl-inactive");
      if (!toInactive.ok) throw new Error("unreachable");

      const blacklisted = await blacklistPartner(head, created.data.partnerRef, { reason: "Policy violation.", expectedVersion: toInactive.data.version }, "req-bl-do");
      expect(blacklisted.ok).toBe(true);
      if (!blacklisted.ok) throw new Error("unreachable");
      expect(blacklisted.data.status).toBe("BLACKLISTED");
      expect(blacklisted.data.previousStatus).toBe("INACTIVE"); // history-preserving - restores to INACTIVE, not a fixed "ACTIVE"
      expect(blacklisted.data.statusReason).toBe("Policy violation.");

      const restored = await restorePartner(head, created.data.partnerRef, { expectedVersion: blacklisted.data.version }, "req-bl-restore");
      expect(restored.ok).toBe(true);
      if (!restored.ok) throw new Error("unreachable");
      expect(restored.data.status).toBe("INACTIVE");
      expect(restored.data.previousStatus).toBeNull();
      expect(restored.data.statusReason).toBeNull();

      const history = await getPartnerHistory(head, created.data.partnerRef, {});
      expect(history.ok).toBe(true);
      if (!history.ok) throw new Error("unreachable");
      const kinds = history.data.events.map((e) => e.kind);
      expect(kinds).toContain("blacklisted");
      expect(kinds).toContain("restored"); // the blacklisted event is never erased, only appended past
    });

    it("archive is authorized/reasoned, and a second archive over an already-archived Partner is refused", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Archive Flow"), regionIds: ["Kerala"] }, "req-arc-create");
      if (!created.ok) throw new Error("unreachable");

      const archived = await archivePartner(head, created.data.partnerRef, { reason: "Programme ended.", expectedVersion: created.data.version }, "req-arc-do");
      expect(archived.ok).toBe(true);
      if (!archived.ok) throw new Error("unreachable");
      expect(archived.data.status).toBe("ARCHIVED");
      expect(archived.data.previousStatus).toBe("ACTIVE");

      const secondAttempt = await archivePartner(head, created.data.partnerRef, { reason: "Again.", expectedVersion: archived.data.version }, "req-arc-again");
      expect(secondAttempt.ok).toBe(false);
      if (secondAttempt.ok) throw new Error("unreachable");
      expect(secondAttempt.code).toBe("invalid_input");
    });

    it("dependency check blocks archive/blacklist while the Partner has an active Partner Account", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Dependency Blocked"), regionIds: ["Kerala"] }, "req-dep-create");
      if (!created.ok) throw new Error("unreachable");
      const account = await createPartnerAccount(head, created.data.partnerRef, { platform: "Instagram", handle: uniqueName("depaccount").replace(/\s+/g, "") }, "req-dep-account");
      if (!account.ok) throw new Error("unreachable");

      const deps = await checkPartnerDependencies({ uid: created.data.partnerRef, partnerRef: created.data.partnerRef });
      // checkPartnerDependencies takes a { uid, partnerRef } shape matching PartnerDoc's own fields - uid is unused internally beyond typing, only partnerRef is queried against.
      expect(deps.status).toBe("blocked");

      const attempt = await archivePartner(head, created.data.partnerRef, { reason: "x", expectedVersion: created.data.version }, "req-dep-archive");
      expect(attempt.ok).toBe(false);
      if (attempt.ok) throw new Error("unreachable");
      expect(attempt.code).toBe("not_ready");

      // Inactivating the account clears the dependency, and archive then succeeds.
      const inactivated = await setPartnerAccountStatus(head, account.data.partnerAccountRef, { status: "INACTIVE", expectedVersion: account.data.version }, "req-dep-inactivate");
      if (!inactivated.ok) throw new Error("unreachable");
      const nowArchivable = await archivePartner(head, created.data.partnerRef, { reason: "x", expectedVersion: created.data.version }, "req-dep-archive-2");
      expect(nowArchivable.ok).toBe(true);
    });

    it("stale lifecycle mutation is rejected", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Stale Lifecycle"), regionIds: ["Kerala"] }, "req-stalelc-create");
      if (!created.ok) throw new Error("unreachable");

      const first = await setPartnerStatus(head, created.data.partnerRef, { status: "INACTIVE", expectedVersion: created.data.version }, "req-stalelc-1");
      expect(first.ok).toBe(true);

      const stale = await setPartnerStatus(head, created.data.partnerRef, { status: "ACTIVE", expectedVersion: created.data.version }, "req-stalelc-2");
      expect(stale.ok).toBe(false);
      if (stale.ok) throw new Error("unreachable");
      expect(stale.code).toBe("stale_write");
    });
  });

  describe("Partner Accounts", () => {
    it("multiple accounts per Partner, including two on the same platform with different normalized identities - the seeded creator-house fixture", async () => {
      const head = await actorFor("partnership_head");
      const list = await listPartnerAccounts(head, "creator-house");
      expect(list.ok).toBe(true);
      if (!list.ok) throw new Error("unreachable");
      expect(list.data.length).toBeGreaterThanOrEqual(3);
      const instagramAccounts = list.data.filter((a) => a.platform === "Instagram");
      expect(instagramAccounts.length).toBeGreaterThanOrEqual(2);
      const identities = new Set(instagramAccounts.map((a) => a.normalizedIdentity));
      expect(identities.size).toBe(instagramAccounts.length); // every same-platform account has its own distinct identity
    });

    it("a stable platform account id is preferred over handle/profileUrl at creation", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Stable ID"), regionIds: ["Kerala"] }, "req-stableid-create");
      if (!created.ok) throw new Error("unreachable");
      const account = await createPartnerAccount(
        head,
        created.data.partnerRef,
        { platform: "YouTube", platformAccountId: `UC${runId}stable`, handle: "willBeIgnoredForIdentity", profileUrl: "https://youtube.com/@willBeIgnoredToo" },
        "req-stableid-account",
      );
      expect(account.ok).toBe(true);
      if (!account.ok) throw new Error("unreachable");
      expect(account.data.normalizedIdentity).toBe(computeNormalizedIdentity({ platform: "YouTube", platformAccountId: `UC${runId}stable` }));
    });

    it("normalized identity collision is rejected on create", async () => {
      const head = await actorFor("partnership_head");
      const partnerA = await createPartner(head, { displayName: uniqueName("Collision A"), regionIds: ["Kerala"] }, "req-coll-a");
      const partnerB = await createPartner(head, { displayName: uniqueName("Collision B"), regionIds: ["Kerala"] }, "req-coll-b");
      if (!partnerA.ok || !partnerB.ok) throw new Error("unreachable");

      const sharedHandle = `collide${runId}`;
      const first = await createPartnerAccount(head, partnerA.data.partnerRef, { platform: "Instagram", handle: sharedHandle }, "req-coll-1");
      expect(first.ok).toBe(true);

      const second = await createPartnerAccount(head, partnerB.data.partnerRef, { platform: "Instagram", handle: sharedHandle }, "req-coll-2");
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("unreachable");
      expect(second.code).toBe("conflict");
    });

    it("concurrent identity claims cannot both succeed - only one of two simultaneous creates wins", async () => {
      const head = await actorFor("partnership_head");
      const partnerA = await createPartner(head, { displayName: uniqueName("Concurrent A"), regionIds: ["Kerala"] }, "req-conc-a");
      const partnerB = await createPartner(head, { displayName: uniqueName("Concurrent B"), regionIds: ["Kerala"] }, "req-conc-b");
      if (!partnerA.ok || !partnerB.ok) throw new Error("unreachable");

      const sharedHandle = `concurrent${runId}`;
      const [resultA, resultB] = await Promise.all([
        createPartnerAccount(head, partnerA.data.partnerRef, { platform: "Instagram", handle: sharedHandle }, "req-conc-1"),
        createPartnerAccount(head, partnerB.data.partnerRef, { platform: "Instagram", handle: sharedHandle }, "req-conc-2"),
      ]);
      const outcomes = [resultA.ok, resultB.ok];
      expect(outcomes.filter(Boolean).length).toBe(1); // exactly one wins, never both, never neither

      const claim = await getPartnerAccountIdentityClaim(claimIdFor(computeNormalizedIdentity({ platform: "Instagram", handle: sharedHandle })!));
      expect(claim).toBeTruthy();
    });

    it("partnerAccountRef - the durable canonical identity - never changes across any edit, identity-evolving or not", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Durable Ref"), regionIds: ["Kerala"] }, "req-durableref-create");
      if (!created.ok) throw new Error("unreachable");
      const account = await createPartnerAccount(head, created.data.partnerRef, { platform: "Instagram", handle: `durable${runId}` }, "req-durableref-account");
      if (!account.ok) throw new Error("unreachable");
      const ref = account.data.partnerAccountRef;

      const renamed = await editPartnerAccount(head, ref, { handle: `durable-renamed${runId}`, expectedVersion: account.data.version }, "req-durableref-edit");
      expect(renamed.ok).toBe(true);
      if (!renamed.ok) throw new Error("unreachable");
      expect(renamed.data.partnerAccountRef).toBe(ref);
    });
  });

  describe("Partner Account identity evolution (Step 7A.1)", () => {
    it("a display-name-only edit leaves normalizedIdentity unchanged", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Display Name Only"), regionIds: ["Kerala"] }, "req-dnonly-create");
      if (!created.ok) throw new Error("unreachable");
      const account = await createPartnerAccount(head, created.data.partnerRef, { platform: "Instagram", handle: `dnonly${runId}` }, "req-dnonly-account");
      if (!account.ok) throw new Error("unreachable");

      const edited = await editPartnerAccount(head, account.data.partnerAccountRef, { displayName: "A Nicer Display Name", expectedVersion: account.data.version }, "req-dnonly-edit");
      expect(edited.ok).toBe(true);
      if (!edited.ok) throw new Error("unreachable");
      expect(edited.data.displayName).toBe("A Nicer Display Name");
      expect(edited.data.normalizedIdentity).toBe(account.data.normalizedIdentity);

      // No account_identity_changed event for a pure display-name edit.
      const history = await getPartnerHistory(head, created.data.partnerRef, {});
      if (!history.ok) throw new Error("unreachable");
      expect(history.data.events.some((e) => e.kind === "account_identity_changed")).toBe(false);
    });

    it("a handle-only rename moves the claim from the old handle to the new one - old claim is released, new claim collides immediately", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Handle Rename"), regionIds: ["Kerala"] }, "req-handlerename-create");
      if (!created.ok) throw new Error("unreachable");
      const oldHandle = `oldhandle${runId}`;
      const newHandle = `newhandle${runId}`;
      const account = await createPartnerAccount(head, created.data.partnerRef, { platform: "Instagram", handle: oldHandle }, "req-handlerename-account");
      if (!account.ok) throw new Error("unreachable");
      const oldIdentity = account.data.normalizedIdentity;

      const edited = await editPartnerAccount(head, account.data.partnerAccountRef, { handle: newHandle, expectedVersion: account.data.version }, "req-handlerename-edit");
      expect(edited.ok).toBe(true);
      if (!edited.ok) throw new Error("unreachable");
      const newIdentity = edited.data.normalizedIdentity;
      expect(newIdentity).not.toBe(oldIdentity);
      expect(newIdentity).toBe(computeNormalizedIdentity({ platform: "Instagram", handle: newHandle }));

      // Old claim released - a lookup by the old handle no longer identifies this account.
      const oldClaim = await getPartnerAccountIdentityClaim(claimIdFor(oldIdentity));
      expect(oldClaim).toBeNull();
      const oldLookup = await checkForPartnerDuplicates({ accountIdentity: { platform: "Instagram", handle: oldHandle } });
      expect(oldLookup.status).toBe("none");

      // New claim exists and immediately collides against a duplicate create attempt.
      const newClaim = await getPartnerAccountIdentityClaim(claimIdFor(newIdentity));
      expect(newClaim?.partnerAccountUid).toBeTruthy();
      const newLookup = await checkForPartnerDuplicates({ accountIdentity: { platform: "Instagram", handle: newHandle } });
      expect(newLookup.status).toBe("confirmed");

      // Domain history still records that the change happened.
      const history = await getPartnerHistory(head, created.data.partnerRef, {});
      if (!history.ok) throw new Error("unreachable");
      const event = history.data.events.find((e) => e.kind === "account_identity_changed");
      expect(event).toBeTruthy();
      expect(event?.metadata).toMatchObject({ oldNormalizedIdentity: oldIdentity, newNormalizedIdentity: newIdentity });
    });

    it("a profile-URL fallback change moves the claim correctly", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("URL Fallback Change"), regionIds: ["Kerala"] }, "req-urlchange-create");
      if (!created.ok) throw new Error("unreachable");
      const account = await createPartnerAccount(head, created.data.partnerRef, { platform: "Instagram", profileUrl: `https://instagram.com/urlfallback${runId}` }, "req-urlchange-account");
      if (!account.ok) throw new Error("unreachable");
      const oldIdentity = account.data.normalizedIdentity;

      const newUrl = `https://instagram.com/urlfallback${runId}-changed`;
      const edited = await editPartnerAccount(head, account.data.partnerAccountRef, { profileUrl: newUrl, expectedVersion: account.data.version }, "req-urlchange-edit");
      expect(edited.ok).toBe(true);
      if (!edited.ok) throw new Error("unreachable");
      expect(edited.data.normalizedIdentity).not.toBe(oldIdentity);
      expect(edited.data.normalizedIdentity).toBe(computeNormalizedIdentity({ platform: "Instagram", profileUrl: newUrl }));

      expect(await getPartnerAccountIdentityClaim(claimIdFor(oldIdentity))).toBeNull();
      expect((await getPartnerAccountIdentityClaim(claimIdFor(edited.data.normalizedIdentity)))?.partnerAccountUid).toBeTruthy();
    });

    it("a stable-ID account's handle rename leaves normalizedIdentity unchanged (the ID still wins priority)", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Stable ID Rename"), regionIds: ["Kerala"] }, "req-stableidrename-create");
      if (!created.ok) throw new Error("unreachable");
      const account = await createPartnerAccount(head, created.data.partnerRef, { platform: "YouTube", platformAccountId: `UCstable${runId}`, handle: "originalhandle" }, "req-stableidrename-account");
      if (!account.ok) throw new Error("unreachable");
      const identity = account.data.normalizedIdentity;

      const edited = await editPartnerAccount(head, account.data.partnerAccountRef, { handle: "brandnewhandle", expectedVersion: account.data.version }, "req-stableidrename-edit");
      expect(edited.ok).toBe(true);
      if (!edited.ok) throw new Error("unreachable");
      expect(edited.data.handle).toBe("brandnewhandle");
      expect(edited.data.normalizedIdentity).toBe(identity); // unchanged - the stable id still wins priority
    });

    it("a fallback identity can upgrade to a stable platform id, keeping the same partnerAccountRef", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Upgrade To Stable"), regionIds: ["Kerala"] }, "req-upgrade-create");
      if (!created.ok) throw new Error("unreachable");
      const account = await createPartnerAccount(head, created.data.partnerRef, { platform: "YouTube", handle: `upgrademe${runId}` }, "req-upgrade-account");
      if (!account.ok) throw new Error("unreachable");
      const fallbackIdentity = account.data.normalizedIdentity;
      const ref = account.data.partnerAccountRef;

      const stableId = `UCupgraded${runId}`;
      const edited = await editPartnerAccount(head, ref, { platformAccountId: stableId, expectedVersion: account.data.version }, "req-upgrade-edit");
      expect(edited.ok).toBe(true);
      if (!edited.ok) throw new Error("unreachable");
      expect(edited.data.partnerAccountRef).toBe(ref); // same canonical account
      expect(edited.data.platformAccountId).toBe(stableId);
      const upgradedIdentity = edited.data.normalizedIdentity;
      expect(upgradedIdentity).toBe(computeNormalizedIdentity({ platform: "YouTube", platformAccountId: stableId }));
      expect(upgradedIdentity).not.toBe(fallbackIdentity);

      expect(await getPartnerAccountIdentityClaim(claimIdFor(fallbackIdentity))).toBeNull(); // old fallback claim released
      expect((await getPartnerAccountIdentityClaim(claimIdFor(upgradedIdentity)))?.partnerAccountUid).toBeTruthy();
    });

    it("an ordinary attempt to replace one stable platform id with a different one is rejected", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Reject ID Swap"), regionIds: ["Kerala"] }, "req-idswap-create");
      if (!created.ok) throw new Error("unreachable");
      const account = await createPartnerAccount(head, created.data.partnerRef, { platform: "YouTube", platformAccountId: `UCoriginal${runId}` }, "req-idswap-account");
      if (!account.ok) throw new Error("unreachable");

      const attempt = await editPartnerAccount(head, account.data.partnerAccountRef, { platformAccountId: `UCdifferent${runId}`, expectedVersion: account.data.version }, "req-idswap-edit");
      expect(attempt.ok).toBe(false);
      if (attempt.ok) throw new Error("unreachable");
      expect(attempt.code).toBe("invalid_input");

      // Clearing an already-set stable id is rejected the same way.
      const clearAttempt = await editPartnerAccount(head, account.data.partnerAccountRef, { platformAccountId: null, expectedVersion: account.data.version }, "req-idswap-clear");
      expect(clearAttempt.ok).toBe(false);
      if (clearAttempt.ok) throw new Error("unreachable");
      expect(clearAttempt.code).toBe("invalid_input");

      // The account is untouched by either rejected attempt.
      const stillOriginal = await getPartnerAccountDocByRef(account.data.partnerAccountRef);
      expect(stillOriginal?.platformAccountId).toBe(`UCoriginal${runId}`);
      expect(stillOriginal?.version).toBe(account.data.version);
    });

    it("a collision on the new identity rejects the edit and preserves the old account and old claim untouched", async () => {
      const head = await actorFor("partnership_head");
      const partnerA = await createPartner(head, { displayName: uniqueName("Collision Edit A"), regionIds: ["Kerala"] }, "req-collideedit-a");
      const partnerB = await createPartner(head, { displayName: uniqueName("Collision Edit B"), regionIds: ["Kerala"] }, "req-collideedit-b");
      if (!partnerA.ok || !partnerB.ok) throw new Error("unreachable");

      const takenHandle = `taken${runId}`;
      const taken = await createPartnerAccount(head, partnerA.data.partnerRef, { platform: "Instagram", handle: takenHandle }, "req-collideedit-taken");
      if (!taken.ok) throw new Error("unreachable");
      const mine = await createPartnerAccount(head, partnerB.data.partnerRef, { platform: "Instagram", handle: `mine${runId}` }, "req-collideedit-mine");
      if (!mine.ok) throw new Error("unreachable");
      const myOldIdentity = mine.data.normalizedIdentity;

      const attempt = await editPartnerAccount(head, mine.data.partnerAccountRef, { handle: takenHandle, expectedVersion: mine.data.version }, "req-collideedit-attempt");
      expect(attempt.ok).toBe(false);
      if (attempt.ok) throw new Error("unreachable");
      expect(attempt.code).toBe("conflict");

      // My own account and its old claim are completely untouched.
      const stillMine = await getPartnerAccountDocByRef(mine.data.partnerAccountRef);
      expect(stillMine?.normalizedIdentity).toBe(myOldIdentity);
      expect(stillMine?.version).toBe(mine.data.version);
      expect((await getPartnerAccountIdentityClaim(claimIdFor(myOldIdentity)))?.partnerAccountUid).toBe(stillMine?.uid);

      // The other account's claim is untouched too.
      const stillTaken = await getPartnerAccountDocByRef(taken.data.partnerAccountRef);
      expect(stillTaken?.normalizedIdentity).toBe(taken.data.normalizedIdentity);
    });

    it("a stale edit is rejected before any identity migration happens", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Stale Identity Edit"), regionIds: ["Kerala"] }, "req-staleid-create");
      if (!created.ok) throw new Error("unreachable");
      const account = await createPartnerAccount(head, created.data.partnerRef, { platform: "Instagram", handle: `staleid${runId}` }, "req-staleid-account");
      if (!account.ok) throw new Error("unreachable");
      const originalIdentity = account.data.normalizedIdentity;

      // Bump the version out from under the stale attempt with an unrelated edit first.
      const unrelated = await editPartnerAccount(head, account.data.partnerAccountRef, { displayName: "Bump Version", expectedVersion: account.data.version }, "req-staleid-bump");
      if (!unrelated.ok) throw new Error("unreachable");

      const staleAttempt = await editPartnerAccount(head, account.data.partnerAccountRef, { handle: `staleid-renamed${runId}`, expectedVersion: account.data.version }, "req-staleid-stale");
      expect(staleAttempt.ok).toBe(false);
      if (staleAttempt.ok) throw new Error("unreachable");
      expect(staleAttempt.code).toBe("stale_write");

      // Identity never migrated - old claim still stands, no new claim was created.
      const stillOriginal = await getPartnerAccountDocByRef(account.data.partnerAccountRef);
      expect(stillOriginal?.normalizedIdentity).toBe(originalIdentity);
      const attemptedNewIdentity = computeNormalizedIdentity({ platform: "Instagram", handle: `staleid-renamed${runId}` })!;
      expect(await getPartnerAccountIdentityClaim(claimIdFor(attemptedNewIdentity))).toBeNull();
    });

    it("a new claim from a rename blocks a concurrent duplicate create for the same target identity - exactly one owner", async () => {
      const head = await actorFor("partnership_head");
      const renamingPartner = await createPartner(head, { displayName: uniqueName("Concurrent Rename A"), regionIds: ["Kerala"] }, "req-concrename-a");
      const creatingPartner = await createPartner(head, { displayName: uniqueName("Concurrent Rename B"), regionIds: ["Kerala"] }, "req-concrename-b");
      if (!renamingPartner.ok || !creatingPartner.ok) throw new Error("unreachable");

      const targetHandle = `racetarget${runId}`;
      const renamingAccount = await createPartnerAccount(head, renamingPartner.data.partnerRef, { platform: "Instagram", handle: `racestart${runId}` }, "req-concrename-start");
      if (!renamingAccount.ok) throw new Error("unreachable");

      const [renameResult, createResult] = await Promise.all([
        editPartnerAccount(head, renamingAccount.data.partnerAccountRef, { handle: targetHandle, expectedVersion: renamingAccount.data.version }, "req-concrename-rename"),
        createPartnerAccount(head, creatingPartner.data.partnerRef, { platform: "Instagram", handle: targetHandle }, "req-concrename-create"),
      ]);

      const outcomes = [renameResult.ok, createResult.ok];
      expect(outcomes.filter(Boolean).length).toBe(1); // exactly one of the two wins the target identity

      // Exactly one claim exists for the target identity regardless of
      // which of the two concurrent calls won it - the claim doc itself
      // is the single source of truth for ownership.
      const targetIdentity = computeNormalizedIdentity({ platform: "Instagram", handle: targetHandle })!;
      const claim = await getPartnerAccountIdentityClaim(claimIdFor(targetIdentity));
      expect(claim).toBeTruthy();
    });

    it("a MAINTAIN_EXISTING conversion reassigns an existing Partner Account to the new Partner - it still parses under the canonical schema and its claim is untouched (normalizedIdentity never changes on reassignment)", async () => {
      const head = await actorFor("partnership_head");

      // A real, directly-created Partner + Account to be reassigned.
      const originalOwner = await createPartner(head, { displayName: uniqueName("Original Account Owner"), regionIds: ["Kerala"] }, "req-maintain-owner");
      if (!originalOwner.ok) throw new Error("unreachable");
      const existingAccount = await createPartnerAccount(head, originalOwner.data.partnerRef, { platform: "Instagram", handle: `maintainexisting${runId}` }, "req-maintain-account");
      if (!existingAccount.ok) throw new Error("unreachable");
      const originalIdentity = existingAccount.data.normalizedIdentity;

      const { lead, converted } = await convertFreshLeadToPartner("MAINTAIN_EXISTING", existingAccount.data.partnerAccountRef);
      expect(converted.ok).toBe(true);
      if (!converted.ok) throw new Error("unreachable");
      expect(converted.data.partnerAccountRef).toBe(existingAccount.data.partnerAccountRef);

      const reassigned = await getPartnerAccountDocByRef(existingAccount.data.partnerAccountRef);
      expect(reassigned).toBeTruthy();
      expect(partnerAccountDocSchema.safeParse(reassigned).success).toBe(true);
      expect(reassigned?.partnerRef).toBe(converted.data.partnerRef); // reassigned to the NEW Partner
      expect(reassigned?.partnerRef).not.toBe(originalOwner.data.partnerRef);
      expect(reassigned?.normalizedIdentity).toBe(originalIdentity); // unchanged by the reassignment

      const claim = await getPartnerAccountIdentityClaim(claimIdFor(originalIdentity));
      expect(claim?.partnerAccountRef).toBe(existingAccount.data.partnerAccountRef); // still points at the same account

      expect(lead.leadRef).toBeTruthy();
    });

    it("at most one active primary account per Partner - creating a second primary demotes the first, transactionally", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Primary Invariant"), regionIds: ["Kerala"] }, "req-primary-create");
      if (!created.ok) throw new Error("unreachable");

      const first = await createPartnerAccount(head, created.data.partnerRef, { platform: "Instagram", handle: `primary1-${runId}`, primary: true }, "req-primary-1");
      if (!first.ok) throw new Error("unreachable");
      expect(first.data.primary).toBe(true);

      const second = await createPartnerAccount(head, created.data.partnerRef, { platform: "YouTube", handle: `primary2-${runId}`, primary: true }, "req-primary-2");
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("unreachable");
      expect(second.data.primary).toBe(true);

      const refreshedFirst = await getPartnerAccount(head, first.data.partnerAccountRef);
      expect(refreshedFirst.ok).toBe(true);
      if (!refreshedFirst.ok) throw new Error("unreachable");
      expect(refreshedFirst.data.primary).toBe(false); // demoted

      const allAccounts = await listPartnerAccounts(head, created.data.partnerRef);
      if (!allAccounts.ok) throw new Error("unreachable");
      expect(allAccounts.data.filter((a) => a.primary).length).toBe(1);
    });

    it("setPrimaryPartnerAccount is transactional: switching primary demotes the previous one atomically", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Set Primary"), regionIds: ["Kerala"] }, "req-setprimary-create");
      if (!created.ok) throw new Error("unreachable");
      const first = await createPartnerAccount(head, created.data.partnerRef, { platform: "Instagram", handle: `sp1-${runId}`, primary: true }, "req-setprimary-1");
      const second = await createPartnerAccount(head, created.data.partnerRef, { platform: "YouTube", handle: `sp2-${runId}` }, "req-setprimary-2");
      if (!first.ok || !second.ok) throw new Error("unreachable");

      const switched = await setPrimaryPartnerAccount(head, second.data.partnerAccountRef, { expectedVersion: second.data.version }, "req-setprimary-switch");
      expect(switched.ok).toBe(true);
      if (!switched.ok) throw new Error("unreachable");
      expect(switched.data.primary).toBe(true);

      const refreshedFirst = await getPartnerAccount(head, first.data.partnerAccountRef);
      if (!refreshedFirst.ok) throw new Error("unreachable");
      expect(refreshedFirst.data.primary).toBe(false);
    });

    it("only an ACTIVE account can be set primary", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Inactive Primary Attempt"), regionIds: ["Kerala"] }, "req-inactprim-create");
      if (!created.ok) throw new Error("unreachable");
      const account = await createPartnerAccount(head, created.data.partnerRef, { platform: "Instagram", handle: `inactprim-${runId}` }, "req-inactprim-account");
      if (!account.ok) throw new Error("unreachable");
      const inactivated = await setPartnerAccountStatus(head, account.data.partnerAccountRef, { status: "INACTIVE", expectedVersion: account.data.version }, "req-inactprim-off");
      if (!inactivated.ok) throw new Error("unreachable");

      const attempt = await setPrimaryPartnerAccount(head, account.data.partnerAccountRef, { expectedVersion: inactivated.data.version }, "req-inactprim-set");
      expect(attempt.ok).toBe(false);
      if (attempt.ok) throw new Error("unreachable");
      expect(attempt.code).toBe("invalid_input");
    });

    it("inactivating the current primary account clears its own primary flag, and never silently auto-promotes a replacement", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("Inactive Clears Primary"), regionIds: ["Kerala"] }, "req-clearprim-create");
      if (!created.ok) throw new Error("unreachable");
      const primaryAccount = await createPartnerAccount(head, created.data.partnerRef, { platform: "Instagram", handle: `clearprim-p-${runId}`, primary: true }, "req-clearprim-1");
      const otherAccount = await createPartnerAccount(head, created.data.partnerRef, { platform: "YouTube", handle: `clearprim-o-${runId}` }, "req-clearprim-2");
      if (!primaryAccount.ok || !otherAccount.ok) throw new Error("unreachable");

      const inactivated = await setPartnerAccountStatus(head, primaryAccount.data.partnerAccountRef, { status: "INACTIVE", expectedVersion: primaryAccount.data.version }, "req-clearprim-off");
      expect(inactivated.ok).toBe(true);
      if (!inactivated.ok) throw new Error("unreachable");
      expect(inactivated.data.primary).toBe(false); // cleared, not left true-and-inactive

      const refreshedOther = await getPartnerAccount(head, otherAccount.data.partnerAccountRef);
      if (!refreshedOther.ok) throw new Error("unreachable");
      expect(refreshedOther.data.primary).toBe(false); // never auto-promoted - Partner deliberately left with no primary
    });

    it("editing an account never moves it to a different Partner (no casual transfer surface exists)", async () => {
      const head = await actorFor("partnership_head");
      const created = await createPartner(head, { displayName: uniqueName("No Transfer"), regionIds: ["Kerala"] }, "req-notransfer-create");
      if (!created.ok) throw new Error("unreachable");
      const account = await createPartnerAccount(head, created.data.partnerRef, { platform: "Instagram", handle: `notransfer-${runId}` }, "req-notransfer-account");
      if (!account.ok) throw new Error("unreachable");

      // editPartnerAccountInputSchema has no partnerRef field at all - an
      // attempt to smuggle one in is rejected outright by .strict(), never
      // silently ignored (which could otherwise be mistaken for "accepted
      // but no-op").
      const attempt = await editPartnerAccount(head, account.data.partnerAccountRef, { handle: "still-same-partner", partnerRef: "someone-elses-partner", expectedVersion: account.data.version } as never, "req-notransfer-edit");
      expect(attempt.ok).toBe(false);
      if (attempt.ok) throw new Error("unreachable");
      expect(attempt.code).toBe("invalid_input");

      const stillOwned = await getPartnerAccountDocByRef(account.data.partnerAccountRef);
      expect(stillOwned?.partnerRef).toBe(created.data.partnerRef);
    });
  });

  describe("Discovery handoff", () => {
    it("NEW_ACCOUNT still creates no fake account, and the resulting Partner parses under the canonical schema with Discovery provenance retained", async () => {
      const { lead, converted } = await convertFreshLeadToPartner("NEW_ACCOUNT");
      expect(converted.ok).toBe(true);
      if (!converted.ok) throw new Error("unreachable");
      expect(converted.data.partnerAccountRef).toBeNull();
      expect(converted.data.pendingPartnerAccountSetup).toBe(true);

      const partnerDoc = await getPartnerDocByRef(converted.data.partnerRef);
      expect(partnerDoc).toBeTruthy();
      expect(partnerDocSchema.safeParse(partnerDoc).success).toBe(true);
      expect(partnerDoc?.originLeadRefs).toContain(lead.leadRef);
      expect(partnerDoc?.sourceDiscovery?.leadRef).toBe(lead.leadRef);
      expect(partnerDoc?.pendingPartnerAccountSetup).toBe(true);
      // Carried over verbatim from the origin Lead's own Research
      // evidence (convertFreshLeadToPartner always sets ["India 1"]) -
      // never left blank when Discovery already captured it.
      expect(partnerDoc?.targetAudience).toEqual(["India 1"]);
    });

    it("pending account setup can later be resolved by creating a real Partner Account", async () => {
      const { converted } = await convertFreshLeadToPartner("NEW_ACCOUNT");
      if (!converted.ok) throw new Error("unreachable");
      const head = await actorFor("partnership_head");

      const beforeAccount = await getPartner(head, converted.data.partnerRef);
      if (!beforeAccount.ok) throw new Error("unreachable");
      expect(beforeAccount.data.pendingPartnerAccountSetup).toBe(true);

      const account = await createPartnerAccount(head, converted.data.partnerRef, { platform: "Instagram", handle: uniqueName("resolved-pending").replace(/\s+/g, "") }, "req-resolve-pending");
      expect(account.ok).toBe(true);
      expect(partnerAccountDocSchema.safeParse(await getPartnerAccountDocByRef((account as { ok: true; data: { partnerAccountRef: string } }).data.partnerAccountRef)).success).toBe(true);

      const afterAccount = await getPartner(head, converted.data.partnerRef);
      if (!afterAccount.ok) throw new Error("unreachable");
      expect(afterAccount.data.pendingPartnerAccountSetup).toBe(false); // cleared atomically by the same account creation
    });

    it("a conversion retry still returns the same Partner, never creating a second one", async () => {
      const { head, lead, converted } = await convertFreshLeadToPartner("NEW_ACCOUNT");
      if (!converted.ok) throw new Error("unreachable");

      const retry = await convertLead(head, lead.leadRef, { idempotencyKey: "a-totally-different-key", expectedVersion: 999 }, "req-retry-convert");
      expect(retry.ok).toBe(true);
      if (!retry.ok) throw new Error("unreachable");
      expect(retry.data.partnerRef).toBe(converted.data.partnerRef);
    });
  });

  describe("restricted identity", () => {
    it("sensitive access is denied for a role without the payment_details category, even with the action granted", async () => {
      // partnership_manager has Partners feature+actions but is not
      // granted the payment_details sensitive category (only
      // partnership_head/super_admin are, per seed-access-data.ts).
      const manager = await actorFor("partnership_manager");
      const result = await getPartnerRestrictedIdentity(manager, "creator-house");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("unauthorized");
      expect(result.reason).toBe("sensitive_denied");
    });

    it("an actor with both the action and the sensitive category can read and save restricted identity", async () => {
      const head = await actorFor("partnership_head");
      const existing = await getPartnerRestrictedIdentity(head, "creator-house");
      expect(existing.ok).toBe(true);
      if (!existing.ok) throw new Error("unreachable");
      expect(existing.data?.pan?.number).toBe("ABCDE0000F");

      const created = await createPartner(head, { displayName: uniqueName("Restricted Identity"), regionIds: ["Kerala"] }, "req-ri-create");
      if (!created.ok) throw new Error("unreachable");
      const saved = await savePartnerRestrictedIdentity(head, created.data.partnerRef, { pan: { number: "ZZZZZ9999Z" }, expectedVersion: 0 }, "req-ri-save");
      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error("unreachable");
      expect(saved.data.pan?.number).toBe("ZZZZZ9999Z");
    });

    it("the ordinary Partner DTO and its history log never contain PAN/Aadhaar/bank/tax values", async () => {
      const head = await actorFor("partnership_head");
      const partnerResult = await getPartner(head, "creator-house");
      expect(partnerResult.ok).toBe(true);
      if (!partnerResult.ok) throw new Error("unreachable");
      expect(JSON.stringify(partnerResult.data)).not.toMatch(/ABCDE0000F|0000-0000-0000|TEST0000001/);

      const history = await getPartnerHistory(head, "creator-house", {});
      expect(history.ok).toBe(true);
      if (!history.ok) throw new Error("unreachable");
      expect(JSON.stringify(history.data)).not.toMatch(/ABCDE0000F|0000-0000-0000|TEST0000001/);
    });

    it("an unauthorized actor cannot infer whether restricted identity data exists - same not-found/denied shape as any other Partner read", async () => {
      const viewer = await actorFor("viewer"); // no Partners action grant at all
      const deniedReal = await getPartnerRestrictedIdentity(viewer, "creator-house"); // has restricted data
      const deniedFake = await getPartnerRestrictedIdentity(viewer, "not-a-real-partner-ref"); // has none
      expect(deniedReal.ok).toBe(false);
      expect(deniedFake.ok).toBe(false);
      if (deniedReal.ok || deniedFake.ok) throw new Error("unreachable");
      // Both fail at the SAME gate (action_denied, before even attempting
      // to resolve the partnerRef) - a real record and a made-up one are
      // indistinguishable to a denied actor.
      expect(deniedReal.reason).toBe(deniedFake.reason);
      expect(deniedReal.code).toBe(deniedFake.code);
    });
  });

  describe("duplicate check", () => {
    it("finds the seeded Partner by email (advisory, confidence-graded, never a global lock)", async () => {
      const result = await checkForPartnerDuplicates({ email: "creator-house@example-partner.test" });
      expect(result.status).toBe("confirmed");
      expect(result.matches.some((m) => m.ref === "creator-house" && m.type === "email")).toBe(true);
    });

    it("finds the seeded Partner Account by account identity via the concurrency-safe claim lookup", async () => {
      const result = await checkForPartnerDuplicates({ accountIdentity: { platform: "Instagram", handle: "creatorhouse" } });
      expect(result.status).toBe("confirmed");
      expect(result.matches.some((m) => m.ref === "creator-house" && m.type === "accountIdentity")).toBe(true);
    });

    it("reports none for genuinely unique evidence", async () => {
      const result = await checkForPartnerDuplicates({ email: `${uniqueName("nomatch").replace(/\s+/g, "")}@example.com` });
      expect(result.status).toBe("none");
    });
  });
});
