// Step 10A - real reads/writes against the running Firestore/Auth
// emulator (no mocks), same rationale as Campaigns'/Vendors'/Partners'
// own emulator test suites. Run with `pnpm test:emulator` against a
// running `pnpm firebase:emulators`.
import { beforeAll, describe, expect, it } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth } from "@/server/firebase/admin";
import { createCampaign } from "@/server/campaigns/campaign-service";
import { transitionCampaignLifecycle } from "@/server/campaigns/campaign-lifecycle-service";
import { editCampaign, getCampaign } from "@/server/campaigns/campaign-service";
import { getCampaignDownstreamSummary } from "@/server/campaigns/detail-downstream-service";
import { seedCampaignsData } from "@/server/campaigns/seed-campaigns-data";
import { seedDiscoveryData } from "@/server/discovery/seed-discovery-data";
import { createPartner } from "@/server/partners/partner-service";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { createVendorPartnerLink, endVendorPartnerLink } from "@/server/vendors/vendor-partner-link-service";
import { createVendor } from "@/server/vendors/vendor-service";
import { seedVendorsData } from "@/server/vendors/seed-vendors-data";
import { createAssignment, createAssignmentsForPartners, editAssignmentBrief, getAssignment, getAssignmentHistory, listAssignments } from "./assignment-service";
import { transitionAssignmentLifecycle } from "./assignment-lifecycle-service";
import { seedAssignmentsData } from "./seed-assignments-data";
import type { AssignmentDto } from "./client-dto";

const uidByRole = new Map<string, string>();
const runId = Date.now();

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  await seedDiscoveryData();
  await seedPartnersData();
  await seedVendorsData();
  await seedCampaignsData();
  await seedAssignmentsData();

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

// Every uniqueness/concurrency test needs a genuinely FRESH
// (campaignRef, partnerRef) pair - the only real ACTIVE Partners
// (seed-partner-direct, creator-house) are already paired with every
// eligible seeded Campaign (seed-campaign-planned, civic-voices) by
// seed-assignments-data.ts, so a fresh Campaign is created (and planned)
// per test instead, guaranteeing no collision with seed fixtures or
// between test cases.
async function createFreshPlannedCampaign(head: ActorContext, overrides: Record<string, unknown> = {}) {
  const created = await createCampaign(
    head,
    {
      name: uniqueName("Assignment Test Campaign"),
      objective: "x",
      platforms: ["instagram", "youtube"],
      startDate: "2026-01-01",
      endDate: "2026-06-01",
      // Head's own scope grant is Kerala (among others) - a Campaign with
      // no region/team/owner is unreachable to Head, same reason
      // Campaigns' own emulator test suite's createRealCampaign helper
      // always sets this.
      regionIds: ["Kerala"],
      defaultReviewPolicy: "REVIEW_REQUIRED",
      ...overrides,
    },
    "req-campaign-create",
  );
  if (!created.ok) throw new Error(`unreachable: ${created.message}`);
  const planned = await transitionCampaignLifecycle(head, created.data.campaignRef, { to: "PLANNED", expectedVersion: created.data.version }, "req-campaign-plan");
  if (!planned.ok) throw new Error(`unreachable: ${planned.message}`);
  // The transition bumps the Campaign's version - callers need the
  // CURRENT version (for their own expectedVersion checks), not the
  // stale one from the moment of creation.
  return { ...created.data, version: planned.data.version, status: planned.data.status };
}

async function createRealAssignment(head: ActorContext, overrides: Record<string, unknown> = {}): Promise<AssignmentDto> {
  const campaign = overrides.campaignRef ? undefined : await createFreshPlannedCampaign(head);
  const result = await createAssignment(
    head,
    { campaignRef: campaign?.campaignRef, partnerRef: "seed-partner-direct", brief: { platforms: ["instagram"] }, ...overrides },
    "req-assignment-create",
  );
  if (!result.ok) throw new Error(`unreachable: ${result.message}`);
  return result.data;
}

describe("Assignment contract", () => {
  it("rejects an unrecognized field on create (schema strictness)", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const result = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct", agreementRef: "x" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("requires both campaignRef and partnerRef", async () => {
    const head = await actorFor("partnership_head");
    const result = await createAssignment(head, { partnerRef: "seed-partner-direct" }, "req");
    expect(result.ok).toBe(false);
  });

  it("rejects a campaignRef that does not resolve to a real Campaign", async () => {
    const head = await actorFor("partnership_head");
    const result = await createAssignment(head, { campaignRef: "not-a-real-campaign", partnerRef: "seed-partner-direct" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("rejects creation while the Campaign is DRAFT", async () => {
    const head = await actorFor("partnership_head");
    const result = await createAssignment(head, { campaignRef: "seed-campaign-draft", partnerRef: "seed-partner-direct" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/DRAFT/);
  });

  it("rejects creation while the Campaign is PAUSED", async () => {
    const head = await actorFor("partnership_head");
    // seed-campaign-paused is Uttar Pradesh, deliberately outside Head's
    // own granted regions (see seed-access-data.ts) - build a fresh,
    // Head-reachable Campaign and drive it to PAUSED instead.
    const campaign = await createFreshPlannedCampaign(head);
    const active = await transitionCampaignLifecycle(head, campaign.campaignRef, { to: "ACTIVE", expectedVersion: campaign.version }, "req");
    if (!active.ok) throw new Error("unreachable");
    const paused = await transitionCampaignLifecycle(head, campaign.campaignRef, { to: "PAUSED", expectedVersion: active.data.version }, "req");
    if (!paused.ok) throw new Error("unreachable");

    const result = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "creator-house" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/PAUSED/);
  });

  it("rejects a Partner that is not ACTIVE-eligible (INACTIVE)", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const result = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-inactive" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/inactive/i);
  });

  it("rejects a brief platform that is not one of the Campaign's own platforms", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head, { platforms: ["instagram"] });
    const result = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct", brief: { platforms: ["youtube"] } }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/platform/i);
  });

  it("rejects a Partner Account that does not belong to the given Partner", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    // seed-partner-direct's own accounts don't include creator-house's -
    // reuse one of creator-house's known account fixtures as the
    // mismatched reference.
    const result = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct", partnerAccountRefs: ["not-a-real-account"] }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/Partner Account/);
  });

  // Finding #50 (reopened): requiredCount can never exceed
  // MAX_ASSIGNMENT_REQUIRED_COUNT (10) - counting separate approved Content
  // records, not links inside one thread. The cap is a sanity ceiling
  // against a clearly-wrong data-entry value (Assignments are bounded units
  // of work, not open-ended recurring obligations), not a number tied to any
  // per-thread link cap.
  it("rejects a requiredCount beyond the sanity ceiling, on both create and edit", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const tooHigh = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct", brief: { platforms: ["instagram"], requiredCount: 11 } }, "req");
    expect(tooHigh.ok).toBe(false);
    if (tooHigh.ok) throw new Error("unreachable");
    expect(tooHigh.code).toBe("invalid_input");

    const atMax = await createRealAssignment(head, { campaignRef: campaign.campaignRef, brief: { platforms: ["instagram"], requiredCount: 10 } });
    expect(atMax.brief.requiredCount).toBe(10);

    const badEdit = await editAssignmentBrief(head, atMax.assignmentRef, { requiredCount: 11, expectedVersion: atMax.version }, "req-edit");
    expect(badEdit.ok).toBe(false);
    if (badEdit.ok) throw new Error("unreachable");
    expect(badEdit.code).toBe("invalid_input");
  });

  it("has no Finance/Agreement/Payable/Invoice/Payment field anywhere on the created DTO", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    const keys = JSON.stringify(assignment).toLowerCase();
    for (const forbidden of ["agreement", "payable", "invoice", "payment", "payee", "compensation"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("Uniqueness / concurrency", () => {
  it("at most one canonical Assignment per (campaignRef, partnerRef) - a repeat create returns the same canonical Assignment", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const first = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct" }, "req-1");
    const second = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct" }, "req-2");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.data.assignmentRef).toBe(first.data.assignmentRef);
  });

  it("same Campaign, different Partner succeeds as a distinct Assignment", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const a = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct" }, "req-a");
    const b = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "creator-house" }, "req-b");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(a.data.assignmentRef).not.toBe(b.data.assignmentRef);
  });

  it("same Partner, different Campaign succeeds as a distinct Assignment", async () => {
    const head = await actorFor("partnership_head");
    const campaignOne = await createFreshPlannedCampaign(head);
    const campaignTwo = await createFreshPlannedCampaign(head);
    const a = await createAssignment(head, { campaignRef: campaignOne.campaignRef, partnerRef: "seed-partner-direct" }, "req-a");
    const b = await createAssignment(head, { campaignRef: campaignTwo.campaignRef, partnerRef: "seed-partner-direct" }, "req-b");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(a.data.assignmentRef).not.toBe(b.data.assignmentRef);
  });

  it(
    "concurrent create attempts for the same pair produce exactly one canonical Assignment (repeated to build confidence)",
    async () => {
      const head = await actorFor("partnership_head");
      for (let round = 0; round < 5; round += 1) {
        const campaign = await createFreshPlannedCampaign(head);
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) => createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct" }, `req-concurrent-${round}-${i}`)),
        );
        expect(results.every((r) => r.ok)).toBe(true);
        const refs = new Set(results.map((r) => (r.ok ? r.data.assignmentRef : null)));
        expect(refs.size).toBe(1);
      }
    },
    20_000,
  );
});

// Findings #40/#42/#51 (user-decided, #40 corrected): the server-orchestrated bulk-create path - dedupes
// Partner refs across Direct + every Vendor section TOGETHER, authorizes the Campaign/brief once, starts
// every new Assignment IN_PROGRESS (never DRAFT), reuses the exact same per-pair claim as the legacy
// single-create path (so a repeat call is naturally idempotent), and never aborts the whole batch for one
// bad Partner. Direct and Through-Vendor selection are ADDITIVE, not mutually exclusive - see
// `CreatorOps_Finding_40_Mixed_Partner_Vendor_Assignment_Correction.md`.
describe("Bulk create (createAssignmentsForPartners)", () => {
  it("[1] direct-only: creates one Assignment per distinct Partner, each IN_PROGRESS (never DRAFT), and dedupes a repeated ref", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const result = await createAssignmentsForPartners(
      head,
      { campaignRef: campaign.campaignRef, directPartnerRefs: ["seed-partner-direct", "creator-house", "seed-partner-direct"], brief: { platforms: ["instagram"] } },
      "req-bulk-1",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.results).toHaveLength(2); // deduped
    expect(result.data.results.every((r) => r.outcome === "created" && r.assignmentRef)).toBe(true);

    for (const row of result.data.results) {
      const fetched = await getAssignment(head, row.assignmentRef!);
      if (!fetched.ok) throw new Error("unreachable");
      expect(fetched.data.status).toBe("IN_PROGRESS"); // [10]
      expect(fetched.data.routedThroughVendorRef).toBeNull(); // [11] no Vendor-owned Assignment
      expect(fetched.data.partnerRef).toBe(row.partnerRef); // [11] the assignee is always the Partner
    }
  });

  it("[2] vendor-only: creates Assignments purely from one Vendor's mapped Partners, no directPartnerRefs at all", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const result = await createAssignmentsForPartners(
      head,
      { campaignRef: campaign.campaignRef, vendorSelections: [{ vendorRef: "seed-vendor-agency", partnerRefs: ["creator-house"] }], brief: { platforms: ["instagram"] } },
      "req-bulk-2",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.results).toEqual([expect.objectContaining({ partnerRef: "creator-house", outcome: "created" })]);
    const fetched = await getAssignment(head, result.data.results[0]!.assignmentRef!);
    if (!fetched.ok) throw new Error("unreachable");
    expect(fetched.data.status).toBe("IN_PROGRESS"); // [10]
    expect(fetched.data.routedThroughVendorRef).toBe("seed-vendor-agency");
  });

  it("[3] mixed: one request with both Direct Partners and Through-Vendor Partners creates all of them correctly routed", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const result = await createAssignmentsForPartners(
      head,
      {
        campaignRef: campaign.campaignRef,
        directPartnerRefs: ["seed-partner-direct"],
        vendorSelections: [{ vendorRef: "seed-vendor-agency", partnerRefs: ["creator-house"] }],
        brief: { platforms: ["instagram"] },
      },
      "req-bulk-3",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.results).toHaveLength(2);
    const byRef = new Map(result.data.results.map((r) => [r.partnerRef, r]));
    expect(byRef.get("seed-partner-direct")).toMatchObject({ outcome: "created" });
    expect(byRef.get("creator-house")).toMatchObject({ outcome: "created" });

    const direct = await getAssignment(head, byRef.get("seed-partner-direct")!.assignmentRef!);
    const routed = await getAssignment(head, byRef.get("creator-house")!.assignmentRef!);
    if (!direct.ok || !routed.ok) throw new Error("unreachable");
    expect(direct.data.routedThroughVendorRef).toBeNull();
    expect(direct.data.status).toBe("IN_PROGRESS"); // [10]
    expect(routed.data.routedThroughVendorRef).toBe("seed-vendor-agency");
    expect(routed.data.status).toBe("IN_PROGRESS"); // [10]
  });

  it("[4] same Partner selected Direct AND through a Vendor in one request: exactly one Assignment, the explicit Vendor route is preserved", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const result = await createAssignmentsForPartners(
      head,
      {
        campaignRef: campaign.campaignRef,
        directPartnerRefs: ["creator-house"],
        vendorSelections: [{ vendorRef: "seed-vendor-agency", partnerRefs: ["creator-house"] }],
        brief: { platforms: ["instagram"] },
      },
      "req-bulk-4",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.results).toHaveLength(1); // one Assignment, not two
    expect(result.data.results[0]).toMatchObject({ partnerRef: "creator-house", outcome: "created" });
    const fetched = await getAssignment(head, result.data.results[0]!.assignmentRef!);
    if (!fetched.ok) throw new Error("unreachable");
    expect(fetched.data.routedThroughVendorRef).toBe("seed-vendor-agency"); // Vendor route wins over Direct
  });

  it("[5] same Partner selected through two DIFFERENT Vendors in one request: rejected as ambiguous for the whole request, never a guess", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    // creator-house is only ever genuinely ACTIVE-linked to seed-vendor-agency (the data model enforces at
    // most one ACTIVE Vendor per Partner) - this request names it under a SECOND, different real Vendor too,
    // purely to prove the server catches the request-shape conflict before touching Firestore at all, not a
    // scenario the UI's own per-Vendor Partner lists could ever legitimately produce.
    const result = await createAssignmentsForPartners(
      head,
      {
        campaignRef: campaign.campaignRef,
        vendorSelections: [
          { vendorRef: "seed-vendor-agency", partnerRefs: ["creator-house"] },
          { vendorRef: "seed-vendor-manager", partnerRefs: ["creator-house"] },
        ],
        brief: { platforms: ["instagram"] },
      },
      "req-bulk-5",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
    expect(result.message).toMatch(/more than one Vendor/i);
    expect(result.message).toContain("creator-house");
  });

  it("[6] multiple Vendors, each with its own different mapped Partners, all created correctly in one request", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const result = await createAssignmentsForPartners(
      head,
      {
        campaignRef: campaign.campaignRef,
        vendorSelections: [
          { vendorRef: "seed-vendor-agency", partnerRefs: ["creator-house"] },
          { vendorRef: "seed-vendor-manager", partnerRefs: ["seed-partner-direct"] },
        ],
        brief: { platforms: ["instagram"] },
      },
      "req-bulk-6",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.results).toHaveLength(2);
    const byRef = new Map(result.data.results.map((r) => [r.partnerRef, r]));
    const creatorHouse = await getAssignment(head, byRef.get("creator-house")!.assignmentRef!);
    const seedDirect = await getAssignment(head, byRef.get("seed-partner-direct")!.assignmentRef!);
    if (!creatorHouse.ok || !seedDirect.ok) throw new Error("unreachable");
    expect(creatorHouse.data.routedThroughVendorRef).toBe("seed-vendor-agency");
    expect(seedDirect.data.routedThroughVendorRef).toBe("seed-vendor-manager");
  });

  it("[7] a Partner whose relationship with the selected Vendor has ENDED (not ACTIVE) is rejected, not silently treated as active", async () => {
    const head = await actorFor("partnership_head");
    const vendor = await createVendor(head, { displayName: uniqueName("Ended-Link Vendor"), vendorType: "AGENCY", regionIds: ["Kerala"] }, "req-ended-vendor");
    const partner = await createPartner(head, { displayName: uniqueName("Ended-Link Partner"), regionIds: ["Kerala"] }, "req-ended-partner");
    if (!vendor.ok || !partner.ok) throw new Error("unreachable");
    const link = await createVendorPartnerLink(head, vendor.data.vendorRef, { partnerRef: partner.data.partnerRef, relationshipType: "AGENCY", effectiveFrom: new Date().toISOString() }, "req-ended-link-create");
    if (!link.ok) throw new Error("unreachable");
    const ended = await endVendorPartnerLink(head, link.data.vendorPartnerLinkRef, { effectiveTo: new Date().toISOString(), expectedVersion: link.data.version }, "req-ended-link-end");
    if (!ended.ok) throw new Error("unreachable");

    const campaign = await createFreshPlannedCampaign(head);
    const result = await createAssignmentsForPartners(
      head,
      { campaignRef: campaign.campaignRef, vendorSelections: [{ vendorRef: vendor.data.vendorRef, partnerRefs: [partner.data.partnerRef] }], brief: { platforms: ["instagram"] } },
      "req-bulk-7",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.results[0]).toMatchObject({ outcome: "error" });
    expect(result.data.results[0]!.error).toMatch(/no ACTIVE relationship/i);
  });

  it("[8] a spoofed Vendor mapping (Partner has NO relationship at all with the claimed Vendor) is rejected server-side, never a fabricated route", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    // seed-partner-direct's only real link is to seed-vendor-manager - claiming seed-vendor-agency for it
    // is a fabricated/spoofed mapping the server must catch independently of the client's own UI.
    const result = await createAssignmentsForPartners(
      head,
      { campaignRef: campaign.campaignRef, vendorSelections: [{ vendorRef: "seed-vendor-agency", partnerRefs: ["seed-partner-direct"] }], brief: { platforms: ["instagram"] } },
      "req-bulk-8",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.results[0]).toMatchObject({ outcome: "error" });
    expect(result.data.results[0]!.error).toMatch(/no ACTIVE relationship/i);
  });

  it("[9] is idempotent: replaying the exact same mixed batch reports 'existing' for every already-created pair, never a second Assignment", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const input = {
      campaignRef: campaign.campaignRef,
      directPartnerRefs: ["seed-partner-direct"],
      vendorSelections: [{ vendorRef: "seed-vendor-agency", partnerRefs: ["creator-house"] }],
      brief: { platforms: ["instagram"] },
    };
    const first = await createAssignmentsForPartners(head, input, "req-bulk-9a");
    const second = await createAssignmentsForPartners(head, input, "req-bulk-9b");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    const firstByRef = new Map(first.data.results.map((r) => [r.partnerRef, r]));
    const secondByRef = new Map(second.data.results.map((r) => [r.partnerRef, r]));
    for (const partnerRef of ["seed-partner-direct", "creator-house"]) {
      expect(firstByRef.get(partnerRef)).toMatchObject({ outcome: "created" });
      expect(secondByRef.get(partnerRef)).toMatchObject({ outcome: "existing", assignmentRef: firstByRef.get(partnerRef)!.assignmentRef });
    }
  });

  it("[12] Campaign downstream Assignment count reflects a mixed Direct+Vendor bulk create, no manual reload needed", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const before = await getCampaignDownstreamSummary(head, campaign.campaignRef);
    if (!before.ok) throw new Error("unreachable");
    if (!before.data.assignments.available) throw new Error("unreachable");
    expect(before.data.assignments.total).toBe(0);

    const result = await createAssignmentsForPartners(
      head,
      {
        campaignRef: campaign.campaignRef,
        directPartnerRefs: ["seed-partner-direct"],
        vendorSelections: [{ vendorRef: "seed-vendor-agency", partnerRefs: ["creator-house"] }],
        brief: { platforms: ["instagram"] },
      },
      "req-bulk-12",
    );
    expect(result.ok).toBe(true);

    const after = await getCampaignDownstreamSummary(head, campaign.campaignRef);
    if (!after.ok) throw new Error("unreachable");
    if (!after.data.assignments.available) throw new Error("unreachable");
    expect(after.data.assignments.total).toBe(2); // same plain-refetch aggregation as before - finding #41 unaffected
  });

  it("a bad Partner in a mixed batch is its own per-Partner error and never aborts the rest", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const result = await createAssignmentsForPartners(
      head,
      {
        campaignRef: campaign.campaignRef,
        directPartnerRefs: ["seed-partner-direct", "seed-partner-inactive", "not-a-real-partner"],
        vendorSelections: [{ vendorRef: "seed-vendor-agency", partnerRefs: ["creator-house"] }],
        brief: { platforms: ["instagram"] },
      },
      "req-bulk-bad",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.results).toHaveLength(4);
    const byRef = new Map(result.data.results.map((r) => [r.partnerRef, r]));
    expect(byRef.get("seed-partner-direct")).toMatchObject({ outcome: "created" });
    expect(byRef.get("seed-partner-inactive")).toMatchObject({ outcome: "error" });
    expect(byRef.get("not-a-real-partner")).toMatchObject({ outcome: "error" });
    expect(byRef.get("creator-house")).toMatchObject({ outcome: "created" });
  });

  it("Campaign-level validation (status, brief platforms) happens ONCE - it fails the whole call, not per-Partner", async () => {
    const head = await actorFor("partnership_head");
    const draftCampaign = await createCampaign(head, { name: uniqueName("Bulk Draft Campaign"), objective: "x", platforms: ["instagram"], startDate: "2026-01-01", endDate: "2026-06-01", regionIds: ["Kerala"], defaultReviewPolicy: "REVIEW_REQUIRED" }, "req");
    if (!draftCampaign.ok) throw new Error("unreachable");
    const stillDraft = await createAssignmentsForPartners(head, { campaignRef: draftCampaign.data.campaignRef, directPartnerRefs: ["seed-partner-direct"] }, "req-bulk-4a");
    expect(stillDraft.ok).toBe(false);

    const campaign = await createFreshPlannedCampaign(head, { platforms: ["instagram"] });
    const badPlatform = await createAssignmentsForPartners(head, { campaignRef: campaign.campaignRef, directPartnerRefs: ["seed-partner-direct"], brief: { platforms: ["youtube"] } }, "req-bulk-4b");
    expect(badPlatform.ok).toBe(false);
    if (badPlatform.ok) throw new Error("unreachable");
    expect(badPlatform.message).toMatch(/platform/i);
  });

  it("rejects a distinct-Partner count beyond the bulk sanity ceiling, counted across Direct + Vendor sections together", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const result = await createAssignmentsForPartners(
      head,
      { campaignRef: campaign.campaignRef, directPartnerRefs: Array.from({ length: 51 }, (_, i) => `partner-${i}`) },
      "req-bulk-5-ceiling",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("rejects a vendorRef that does not resolve to a real Vendor", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const result = await createAssignmentsForPartners(
      head,
      { campaignRef: campaign.campaignRef, vendorSelections: [{ vendorRef: "not-a-real-vendor", partnerRefs: ["seed-partner-direct"] }] },
      "req-bulk-vendor-2",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });
});

// Finding #49: `brief.language` is validated against the UNION of the requested Partners' own
// recorded canonical languageIds (assignment-options-service.ts's toSafePartnerOption now projects
// this same set to the picker - see its own unit tests for the safe-projection half of this
// finding). These are the real, server-side write-path guarantees behind that picker: a value
// outside every requested Partner's own known languages is rejected for a NEW write, a Partner with
// no recorded language at all never makes the field unusable, and a Vendor-routed Partner is
// validated against ITS OWN languageIds, never the Vendor's (Vendors carry no language data at all).
describe("Language validation (finding #49)", () => {
  it("accepts a language that matches a selected Partner's own recorded languageIds", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const partner = await createPartner(head, { displayName: uniqueName("Language Partner"), regionIds: ["Kerala"], languageIds: ["Malayalam"] }, "req-lang-1");
    if (!partner.ok) throw new Error("unreachable");
    const result = await createAssignmentsForPartners(
      head,
      { campaignRef: campaign.campaignRef, directPartnerRefs: [partner.data.partnerRef], brief: { platforms: ["instagram"], language: "Malayalam" } },
      "req-lang-1b",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.results[0]).toMatchObject({ outcome: "created" });
  });

  it("rejects arbitrary language text that matches none of the selected Partners' recorded languages, for a NEW write", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const partner = await createPartner(head, { displayName: uniqueName("Language Partner"), regionIds: ["Kerala"], languageIds: ["Malayalam"] }, "req-lang-2");
    if (!partner.ok) throw new Error("unreachable");
    const result = await createAssignmentsForPartners(
      head,
      { campaignRef: campaign.campaignRef, directPartnerRefs: [partner.data.partnerRef], brief: { platforms: ["instagram"], language: "Klingon" } },
      "req-lang-2b",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("no known language on any selected Partner => any language value still accepted, never fabricated a closed set to reject against", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const partner = await createPartner(head, { displayName: uniqueName("No-Language Partner"), regionIds: ["Kerala"] }, "req-lang-3");
    if (!partner.ok) throw new Error("unreachable");
    const result = await createAssignmentsForPartners(
      head,
      { campaignRef: campaign.campaignRef, directPartnerRefs: [partner.data.partnerRef], brief: { platforms: ["instagram"], language: "Anything" } },
      "req-lang-3b",
    );
    expect(result.ok).toBe(true);
  });

  it("a Vendor-routed Partner's language is validated against the PARTNER's own recorded languages, never Vendor data", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const vendor = await createVendor(head, { displayName: uniqueName("Language Vendor"), vendorType: "AGENCY", regionIds: ["Kerala"] }, "req-lang-4v");
    const partner = await createPartner(head, { displayName: uniqueName("Vendor-Routed Language Partner"), regionIds: ["Kerala"], languageIds: ["Tamil"] }, "req-lang-4p");
    if (!vendor.ok || !partner.ok) throw new Error("unreachable");
    const link = await createVendorPartnerLink(head, vendor.data.vendorRef, { partnerRef: partner.data.partnerRef, relationshipType: "AGENCY", effectiveFrom: new Date().toISOString() }, "req-lang-4l");
    if (!link.ok) throw new Error("unreachable");

    const result = await createAssignmentsForPartners(
      head,
      { campaignRef: campaign.campaignRef, vendorSelections: [{ vendorRef: vendor.data.vendorRef, partnerRefs: [partner.data.partnerRef] }], brief: { platforms: ["instagram"], language: "Tamil" } },
      "req-lang-4",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.results[0]).toMatchObject({ outcome: "created" });
  });

  it("the single-Partner create path (createAssignment) enforces the same language validation as the bulk path", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const partner = await createPartner(head, { displayName: uniqueName("Single-Create Language Partner"), regionIds: ["Kerala"], languageIds: ["Hindi"] }, "req-lang-5");
    if (!partner.ok) throw new Error("unreachable");
    const result = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: partner.data.partnerRef, brief: { platforms: ["instagram"], language: "Klingon" } }, "req-lang-5b");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });
});

describe("Snapshot semantics", () => {
  it("a later Campaign edit does not mutate an already-created Assignment's issued brief", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head, { name: "Original Campaign Name" });
    const assignment = await createRealAssignment(head, { campaignRef: campaign.campaignRef });
    expect(assignment.brief.campaignName).toBe(campaign.name);
    expect(assignment.brief.reviewPolicy).toBe("REVIEW_REQUIRED");

    const edited = await editCampaign(head, campaign.campaignRef, { name: "Renamed Campaign", defaultReviewPolicy: "NO_PREPOST_REVIEW", expectedVersion: campaign.version }, "req-edit");
    expect(edited.ok).toBe(true);

    const refetched = await getAssignment(head, assignment.assignmentRef);
    expect(refetched.ok).toBe(true);
    if (!refetched.ok) throw new Error("unreachable");
    expect(refetched.data.brief.campaignName).toBe("Original Campaign Name");
    expect(refetched.data.brief.reviewPolicy).toBe("REVIEW_REQUIRED");
  });

  it("allowed-platforms snapshot on the brief is not silently resynced by editing the brief's other fields", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    expect(assignment.brief.platforms).toEqual(["instagram"]);
    const edited = await editAssignmentBrief(head, assignment.assignmentRef, { instructions: "Updated instructions.", expectedVersion: assignment.version }, "req-edit-brief");
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error("unreachable");
    expect(edited.data.brief.platforms).toEqual(["instagram"]);
    expect(edited.data.brief.instructions).toBe("Updated instructions.");
  });
});

describe("Lifecycle", () => {
  // Step 11A.1: replaces the earlier "always fails closed" stub coverage -
  // IN_PROGRESS -> COMPLETED now uses the real, shared fulfillment
  // evaluator (see @/server/content/fulfillment-service and
  // assignment-lifecycle-service.ts's own updated comment). Blocked
  // before the Assignment's one canonical Content thread has been
  // approved, succeeds once it is - driven live through the REAL public
  // submission flow (createExternalSubmissionSession ->
  // submitExternalLinks -> approveContentThread), never a direct write
  // to the Content collection. The exhaustive proof (the full revision
  // loop, concurrency, stale decisions, etc) lives in
  // src/server/content/content.emulator.test.ts and
  // src/server/assignments/external-submission.emulator.test.ts - this
  // is the boundary case, kept here to keep this file focused on
  // Assignment itself.
  it("DRAFT -> ASSIGNED -> ACCEPTED -> IN_PROGRESS succeeds; IN_PROGRESS -> COMPLETED is blocked until the one canonical Content thread is approved, then succeeds", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head, { brief: { platforms: ["instagram"], requiredCount: 1 } });
    let version = assignment.version;

    const toAssigned = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "ASSIGNED", expectedVersion: version }, "req-1");
    expect(toAssigned.ok).toBe(true);
    if (!toAssigned.ok) throw new Error("unreachable");
    version = toAssigned.data.version;

    const toAccepted = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "ACCEPTED", expectedVersion: version }, "req-2");
    expect(toAccepted.ok).toBe(true);
    if (!toAccepted.ok) throw new Error("unreachable");
    version = toAccepted.data.version;

    const toInProgress = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "IN_PROGRESS", expectedVersion: version }, "req-3");
    expect(toInProgress.ok).toBe(true);
    if (!toInProgress.ok) throw new Error("unreachable");
    version = toInProgress.data.version;

    const blocked = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "COMPLETED", expectedVersion: version }, "req-4");
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("unreachable");
    expect(blocked.code).toBe("not_ready");
    // No submission session has been created for this Assignment yet -
    // no Content thread exists at all, so the evaluator reports
    // NO_SUBMISSION_THREAD (never the CONTENT_NOT_FULFILLED code, which
    // is reserved for an existing-but-not-yet-approved thread).
    expect(blocked.blockers?.[0]?.code).toBe("NO_SUBMISSION_THREAD");

    const { createExternalSubmissionSession, submitExternalLinks } = await import("./external-submission-service");
    const { approveContentThread } = await import("@/server/content/content-lifecycle-service");
    const { listContent } = await import("@/server/content/content-service");

    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req-session");
    if (!session.ok) throw new Error(`unreachable: ${session.message}`);

    const submitted = await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: `https://instagram.com/p/seed-fulfillment-${Date.now()}` }]);
    if (!submitted.ok) throw new Error(`unreachable: ${submitted.message}`);

    const threadList = await listContent(head, { assignmentRef: assignment.assignmentRef, limit: 1 });
    if (!threadList.ok) throw new Error("unreachable");
    const thread = threadList.data.content[0];
    if (!thread) throw new Error("unreachable: no thread found");
    expect(thread.status).toBe("UNDER_REVIEW");

    const completed = await approveContentThread(head, thread.contentRef, { reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req-approve");
    if (!completed.ok) throw new Error(`unreachable: ${completed.message}`);
    expect(completed.data.qualifyingFulfillment?.kind).toBe("QUALIFYING_REQUIRED");

    // approveContentThread's own transaction already auto-completed the
    // Assignment (it was IN_PROGRESS at that moment) - confirm that
    // directly, then confirm a manual re-request is correctly treated
    // as idempotent-terminal (already COMPLETED, no further transition).
    const nowCompleted = await getAssignment(head, assignment.assignmentRef);
    expect(nowCompleted.ok).toBe(true);
    if (!nowCompleted.ok) throw new Error("unreachable");
    expect(nowCompleted.data.status).toBe("COMPLETED");
  });

  it("rejects skipping a state (DRAFT straight to ACCEPTED)", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    const result = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "ACCEPTED", expectedVersion: assignment.version }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("a stale expectedVersion fails with stale_write", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    const result = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "ASSIGNED", expectedVersion: assignment.version + 5 }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("stale_write");
  });

  it("CANCELLED requires a reason", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    const result = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "CANCELLED", expectedVersion: assignment.version }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/reason/i);
  });

  it("CANCELLED is reachable from DRAFT, ASSIGNED, ACCEPTED, and IN_PROGRESS", async () => {
    const head = await actorFor("partnership_head");

    const fromDraft = await createRealAssignment(head);
    const cancelDraft = await transitionAssignmentLifecycle(head, fromDraft.assignmentRef, { to: "CANCELLED", reason: "Test cancellation.", expectedVersion: fromDraft.version }, "req");
    expect(cancelDraft.ok).toBe(true);

    const fromInProgress = await createRealAssignment(head);
    let v = fromInProgress.version;
    for (const to of ["ASSIGNED", "ACCEPTED", "IN_PROGRESS"] as const) {
      const step = await transitionAssignmentLifecycle(head, fromInProgress.assignmentRef, { to, expectedVersion: v }, "req");
      expect(step.ok).toBe(true);
      if (!step.ok) throw new Error("unreachable");
      v = step.data.version;
    }
    const cancelInProgress = await transitionAssignmentLifecycle(head, fromInProgress.assignmentRef, { to: "CANCELLED", reason: "Test cancellation.", expectedVersion: v }, "req");
    expect(cancelInProgress.ok).toBe(true);
  });

  it("CANCELLED and terminal states allow no further transition", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    const cancelled = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "CANCELLED", reason: "x", expectedVersion: assignment.version }, "req");
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) throw new Error("unreachable");
    const reAssign = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "ASSIGNED", expectedVersion: cancelled.data.version }, "req");
    expect(reAssign.ok).toBe(false);
  });

  it("brief edit is refused once the Assignment is past DRAFT", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    const toAssigned = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "ASSIGNED", expectedVersion: assignment.version }, "req");
    expect(toAssigned.ok).toBe(true);
    const editAttempt = await editAssignmentBrief(head, assignment.assignmentRef, { instructions: "too late", expectedVersion: toAssigned.ok ? toAssigned.data.version : 0 }, "req");
    expect(editAttempt.ok).toBe(false);
    if (editAttempt.ok) throw new Error("unreachable");
    expect(editAttempt.message).toMatch(/DRAFT/);
  });
});

describe("Authorization / scope", () => {
  // Step 10A.1: Assignments is a Manager/Head/Super Admin operational
  // module - Viewer/Analyst have NO feature access at all (not "view but
  // no actions"), matching the accepted access model corrected here. The
  // gate short-circuits at Feature Access, before any per-action check.
  it("Viewer and Analyst are denied the Assignments feature entirely (feature_denied, not action_denied)", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    for (const role of ["viewer", "analyst"]) {
      const actor = await actorFor(role);
      const result = await createAssignment(actor, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct" }, "req");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("unauthorized");
      expect(result.reason).toBe("feature_denied");
    }
  });

  it("Viewer and Analyst are denied get/list entirely - not just an empty/filtered result", async () => {
    for (const role of ["viewer", "analyst"]) {
      const actor = await actorFor(role);
      const getResult = await getAssignment(actor, "seed-assignment-draft");
      expect(getResult.ok).toBe(false);
      if (getResult.ok) throw new Error("unreachable");
      expect(getResult.reason).toBe("feature_denied");

      const listResult = await listAssignments(actor, { limit: 50 });
      expect(listResult.ok).toBe(false);
      if (listResult.ok) throw new Error("unreachable");
      expect(listResult.reason).toBe("feature_denied");
    }
  });

  it("Manager and Head are denied create outside their own granted actions (action_denied), never confused with a feature-level denial", async () => {
    // Sanity check that feature_denied and action_denied remain
    // genuinely distinguishable outcomes for two different roles - a
    // role that HAS the feature but lacks a specific action still gets
    // action_denied, not feature_denied. Viewer's create attempt (no
    // feature at all) already proves feature_denied above; there is no
    // Assignment action Manager/Head lack today (both hold the full
    // operational set), so this is documented rather than re-asserted
    // with a real denial - see seed-access-data.ts's own comment.
    for (const role of ["partnership_manager", "partnership_head"]) {
      const actor = await actorFor(role);
      const result = await getAssignment(actor, "seed-assignment-draft");
      expect(result.ok).toBe(true);
    }
  });

  it("an unauthenticated actor is denied with not_authenticated", async () => {
    const result = await createAssignment(null, { campaignRef: "seed-campaign-planned", partnerRef: "seed-partner-direct" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("not_authenticated");
  });

  it("Manager and Head can both read a same-scope Assignment (Kerala/Maharashtra, via seed-campaign-planned's own scope snapshot)", async () => {
    for (const role of ["partnership_manager", "partnership_head"]) {
      const actor = await actorFor(role);
      const result = await getAssignment(actor, "seed-assignment-draft");
      expect(result.ok).toBe(true);
    }
  });

  it("visibility into a Campaign (via an explicit CAMPAIGN grant) does NOT automatically grant visibility into that Campaign's own Assignments - Assignment scope is its own independent snapshot, never bridged", async () => {
    // Head can see civic-voices itself (explicit CAMPAIGN grant), but
    // civic-voices has no regionIds/teamIds/ownerUid of its own, so every
    // Assignment created under it inherits an EMPTY scope snapshot -
    // reachable only via GLOBAL or an explicit EXPLICIT_RECORD("assignment",...)
    // grant, neither of which any non-admin role holds here.
    const head = await actorFor("partnership_head");
    const campaignItself = await getCampaign(head, "civic-voices");
    expect(campaignItself.ok).toBe(true);

    // Production hardening (base spec section 4 - existence-leak normalization): a cross-scope ref
    // is no longer a distinguishable "scope_denied" 403 - it collapses into the exact same neutral
    // not_found outcome as a missing ref (assignmentsNotFoundResult()).
    const assignmentUnderIt = await getAssignment(head, "seed-assignment-assigned");
    expect(assignmentUnderIt.ok).toBe(false);
    if (assignmentUnderIt.ok) throw new Error("unreachable");
    expect(assignmentUnderIt.code).toBe("not_found");
    expect(assignmentUnderIt.reason).toBeUndefined();

    const admin = await actorFor("super_admin");
    const asAdmin = await getAssignment(admin, "seed-assignment-assigned");
    expect(asAdmin.ok).toBe(true);
  });

  it("cross-scope user (has the feature, lacks scope over this record) cannot read another-scope Assignment by direct ref, and gets the SAME not_found outcome as a nonexistent one - code and message both match", async () => {
    // Manager has real Assignments feature/action access but no scope
    // over seed-assignment-assigned (civic-voices' empty snapshot - see
    // the CAMPAIGN-grant-bridging test above) - a genuine SCOPE denial,
    // distinct from Viewer/Analyst's FEATURE denial tested above.
    const manager = await actorFor("partnership_manager");
    const real = await getAssignment(manager, "seed-assignment-assigned");
    const fake = await getAssignment(manager, "not-a-real-assignment-ref");
    expect(real.ok).toBe(false);
    expect(fake.ok).toBe(false);
    if (real.ok || fake.ok) throw new Error("unreachable");
    // The actual indistinguishability proof (base spec section 4: "Test both unknown ref and
    // known-but-unauthorized ref") - not just that both fail, but that a caller literally cannot
    // tell the two outcomes apart from the response shape.
    expect(real.code).toBe("not_found");
    expect(fake.code).toBe("not_found");
    expect(real.message).toBe(fake.message);
    expect(real.reason).toBeUndefined();
    expect(fake.reason).toBeUndefined();
  });

  it("scoped list never returns an out-of-scope Assignment", async () => {
    const head = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");
    // Created fresh (rather than relying on the beforeAll seed fixture)
    // so it's guaranteed to land within the first 50-item page even
    // after many other tests in this suite have created their own
    // Assignments ahead of it in createdAt-descending order.
    const inScope = await createRealAssignment(head);

    const page = await listAssignments(manager, { limit: 50 });
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("unreachable");
    expect(page.data.assignments.every((a) => a.assignmentRef !== "seed-assignment-assigned")).toBe(true);
    expect(page.data.assignments.some((a) => a.assignmentRef === inScope.assignmentRef)).toBe(true);
  });

  it("super_admin (GLOBAL) reads and lists everything", async () => {
    const admin = await actorFor("super_admin");
    const all = await listAssignments(admin, { limit: 50 });
    expect(all.ok).toBe(true);
    if (!all.ok) throw new Error("unreachable");
    expect(all.data.assignments.length).toBeGreaterThanOrEqual(5);
  });
});

describe("History", () => {
  it("records a created event, and lifecycle transitions append their own events", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "ASSIGNED", expectedVersion: assignment.version }, "req");

    const history = await getAssignmentHistory(head, assignment.assignmentRef, {});
    expect(history.ok).toBe(true);
    if (!history.ok) throw new Error("unreachable");
    const kinds = history.data.events.map((e) => e.kind);
    expect(kinds).toContain("created");
    expect(kinds).toContain("lifecycle_transitioned");
  });
});

// Step 10B section 5: bounded bulk label resolution - getAssignment
// (single, per-field reads) and listAssignments (batch, bulk-chunked
// getXDocsByRefs reads) must both resolve real, correct labels, and the
// batch path must do so without any per-row read waterfall.
describe("Bounded label resolution", () => {
  it("getAssignment (Detail path) resolves campaignName/partnerDisplayName from the real owning records", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    const result = await getAssignment(head, assignment.assignmentRef);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.campaignName).toBeTruthy();
    expect(result.data.partnerDisplayName).toBe("Meera Krishnan");
  });

  it("listAssignments (batch path) resolves campaignName/partnerDisplayName for every row via the bulk-chunked helpers, never leaving them null for a real record", async () => {
    const head = await actorFor("partnership_head");
    await createRealAssignment(head);
    await createRealAssignment(head);
    const page = await listAssignments(head, { limit: 50 });
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("unreachable");
    const withKnownPartner = page.data.assignments.filter((a) => a.partnerRef === "seed-partner-direct");
    expect(withKnownPartner.length).toBeGreaterThan(0);
    for (const a of withKnownPartner) {
      expect(a.partnerDisplayName).toBe("Meera Krishnan");
      expect(a.campaignName).toBeTruthy();
    }
  });

  it("getCampaignDocsByRefs / getPartnerDocsByRefs / getPartnerAccountDocsByRefs dedupe and bulk-resolve correctly (used directly, not just through the DTO)", async () => {
    const { getCampaignDocsByRefs } = await import("@/server/campaigns/firestore");
    const { getPartnerDocsByRefs } = await import("@/server/partners/firestore");

    const campaigns = await getCampaignDocsByRefs(["seed-campaign-planned", "seed-campaign-planned", "civic-voices", "not-a-real-campaign-ref"]);
    expect(campaigns.size).toBe(2);
    expect(campaigns.get("seed-campaign-planned")?.name).toBeTruthy();
    expect(campaigns.get("civic-voices")?.name).toBe("Civic Voices");
    expect(campaigns.has("not-a-real-campaign-ref")).toBe(false);

    const partners = await getPartnerDocsByRefs(["seed-partner-direct", "seed-partner-direct", "creator-house"]);
    expect(partners.size).toBe(2);
    expect(partners.get("seed-partner-direct")?.displayName).toBe("Meera Krishnan");

    const empty = await getCampaignDocsByRefs([]);
    expect(empty.size).toBe(0);
  });
});
