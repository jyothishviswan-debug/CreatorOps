// Step 8A - real reads/writes against the running Firestore/Auth
// emulator (no mocks), same rationale as Partners' own
// partners.emulator.test.ts: this service layer uses Firestore
// transactions, Filter.or() composite queries, and orderBy/cursor
// pagination extensively. Run with `pnpm test:emulator` against a
// running `pnpm firebase:emulators`.
import { beforeAll, describe, expect, it } from "vitest";

import { convertLead } from "@/server/discovery/conversion-service";
import { assignManager, createLead, getLead, recordOutreach, recordReview, saveAssetDecision, saveCommercial, saveDiscoveryAgreement, saveResearch } from "@/server/discovery/lead-service";
import { saveLeadKyc } from "@/server/discovery/kyc-service";
import { transitionLeadLifecycle } from "@/server/discovery/lifecycle-service";
import { seedDiscoveryData } from "@/server/discovery/seed-discovery-data";
import { getPartnerDocByRef } from "@/server/partners/firestore";
import { createPartner } from "@/server/partners/partner-service";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { partnerDocSchema } from "@/server/partners/types";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth } from "@/server/firebase/admin";
import { checkForVendorDuplicates } from "./duplicate-check";
import { getVendorDocByRef, getVendorPartnerLinkDocByRef } from "./firestore";
import { archiveVendor, checkVendorDependencies, restoreVendor } from "./vendor-lifecycle-service";
import {
  createVendorPartnerLink,
  editVendorPartnerLink,
  endVendorPartnerLink,
  listLinksForVendor,
  listVendorLinksForPartner,
  restoreVendorPartnerLink,
} from "./vendor-partner-link-service";
import { createVendor, editVendor, getVendor, getVendorHistory, listVendors, setVendorOwnerTeam, setVendorStatus } from "./vendor-service";
import { getVendorRestrictedIdentity, saveVendorRestrictedIdentity } from "./restricted-identity-service";
import { seedVendorsData } from "./seed-vendors-data";
import { vendorDocSchema, vendorPartnerLinkDocSchema } from "./types";

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

// Company policy caps a Partner to at most one ACTIVE Vendor at a time
// (see vendorPartnerLinkDocSchema's own comment) - reusing a seeded
// Partner like "seed-partner-direct" across many independent link-
// creation tests would make them fight over that one slot. A fresh
// Partner, created for real through the trusted service, is free of any
// other Vendor relationship by construction.
async function createVendorAndPartnerPair(head: ActorContext) {
  const vendor = await createVendor(head, { displayName: uniqueName("Rel Vendor"), vendorType: "AGENCY", regionIds: ["Kerala"] }, "req-rel-vendor");
  if (!vendor.ok) throw new Error("unreachable");
  // regionIds: Kerala is one of partnership_head's own granted regions -
  // without it, a freshly created Partner would have empty regionIds and
  // be genuinely out of Head's own scope (Head has no SELF/GLOBAL grant),
  // making listVendorLinksForPartner (a real Partner-scope check) deny
  // even its own creator.
  const partner = await createPartner(head, { displayName: uniqueName("Rel Partner"), regionIds: ["Kerala"] }, "req-rel-partner");
  if (!partner.ok) throw new Error("unreachable");
  return { vendor: vendor.data, partner: partner.data };
}

describe("Vendor model", () => {
  it("rejects an unrecognized field on create (schema strictness)", async () => {
    const head = await actorFor("partnership_head");
    const result = await createVendor(head, { displayName: uniqueName("Strict Test"), vendorType: "AGENCY", notARealField: "x" }, "req-strict");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("direct create produces a Vendor that parses under the canonical schema, ACTIVE by default", async () => {
    const head = await actorFor("partnership_head");
    const created = await createVendor(head, { displayName: uniqueName("Direct Create"), vendorType: "MANAGEMENT_COMPANY", regionIds: ["Kerala"] }, "req-direct-create");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    expect(created.data.status).toBe("ACTIVE");

    const doc = await getVendorDocByRef(created.data.vendorRef);
    expect(vendorDocSchema.safeParse(doc).success).toBe(true);
  });

  it("the ordinary DTO never includes restricted financial identity fields", async () => {
    const head = await actorFor("partnership_head");
    const result = await getVendor(head, "seed-vendor-agency");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const json = JSON.stringify(result.data);
    expect(json).not.toMatch(/pan|ifsc|accountNumber/i);
  });

  it("edit + stale version is rejected", async () => {
    const head = await actorFor("partnership_head");
    const created = await createVendor(head, { displayName: uniqueName("Stale Edit"), vendorType: "AGENCY", regionIds: ["Kerala"] }, "req-stale-create");
    if (!created.ok) throw new Error("unreachable");

    const first = await editVendor(head, created.data.vendorRef, { displayName: "Renamed Once", expectedVersion: created.data.version }, "req-edit-1");
    expect(first.ok).toBe(true);

    const stale = await editVendor(head, created.data.vendorRef, { displayName: "Renamed Twice", expectedVersion: created.data.version }, "req-edit-2");
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("unreachable");
    expect(stale.code).toBe("stale_write");
  });

  it("owner/team validation rejects a non-existent or inactive ownerUserRef, and accepts a real active user", async () => {
    const head = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");
    const created = await createVendor(head, { displayName: uniqueName("Owner Validation"), vendorType: "AGENCY", regionIds: ["Kerala"] }, "req-owner-create");
    if (!created.ok) throw new Error("unreachable");

    const bad = await setVendorOwnerTeam(head, created.data.vendorRef, { ownerUserRef: "not-a-real-user-ref", teamIds: [], expectedVersion: created.data.version }, "req-owner-invalid");
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.code).toBe("invalid_input");

    const good = await setVendorOwnerTeam(head, created.data.vendorRef, { ownerUserRef: manager.userRef, teamIds: ["kerala-programmes"], expectedVersion: created.data.version }, "req-owner-valid");
    expect(good.ok).toBe(true);
    if (!good.ok) throw new Error("unreachable");
    expect(good.data.ownerRef).toBe(manager.userRef);
  });

  it("scoped list never leaks a Vendor outside the actor's own scope, and direct-ref access to a cross-scope Vendor is denied safely", async () => {
    const manager = await actorFor("partnership_manager"); // Kerala/Maharashtra/South/West only - no Karnataka
    const listed = await listVendors(manager, { limit: 50 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.data.vendors.every((v) => v.vendorRef !== "seed-vendor-agency")).toBe(true); // Karnataka - deliberately carved out of Manager's own region expansion
    expect(listed.data.vendors.every((v) => v.vendorRef !== "seed-vendor-manager")).toBe(true); // Uttar Pradesh - no Manager grant covers it

    const direct = await getVendor(manager, "seed-vendor-agency");
    expect(direct.ok).toBe(false);
    if (direct.ok) throw new Error("unreachable");
    expect(direct.code).toBe("unauthorized");
    expect(direct.reason).toBe("scope_denied");
    // Same-scope Vendor (Kerala) IS reachable, proving this is a real
    // scope check, not a blanket denial.
    const sameScope = await getVendor(manager, "seed-vendor-inactive");
    expect(sameScope.ok).toBe(true);
  });

  it("a tampered/made-up vendorRef is denied as not_found, never leaking whether a differently-scoped Vendor exists", async () => {
    const manager = await actorFor("partnership_manager");
    const result = await getVendor(manager, "not-a-real-vendor-ref-at-all");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("not_found");
  });

  it("cursor pagination is deterministic - two pages never repeat or skip a record", async () => {
    const admin = await actorFor("super_admin");
    const page1 = await listVendors(admin, { limit: 2 });
    expect(page1.ok).toBe(true);
    if (!page1.ok || !page1.data.nextCursor) throw new Error("expected a first page with a cursor");

    const page2 = await listVendors(admin, { limit: 2, cursor: page1.data.nextCursor });
    expect(page2.ok).toBe(true);
    if (!page2.ok) throw new Error("unreachable");

    const page1Refs = new Set(page1.data.vendors.map((v) => v.vendorRef));
    const overlap = page2.data.vendors.filter((v) => page1Refs.has(v.vendorRef));
    expect(overlap).toEqual([]);
  });

  it("history records real events and resolves actor display names, never restricted values", async () => {
    const head = await actorFor("partnership_head");
    // Seed data is written directly to Firestore (never through the
    // service layer - same idiom as Partners' own seed-partners-data.ts),
    // so a seeded Vendor legitimately starts with zero events. Create one
    // through the real service instead to exercise a real event trail.
    const created = await createVendor(head, { displayName: uniqueName("History Check"), vendorType: "AGENCY", regionIds: ["Kerala"] }, "req-history-create");
    if (!created.ok) throw new Error("unreachable");
    await editVendor(head, created.data.vendorRef, { displayName: "History Check Renamed", expectedVersion: created.data.version }, "req-history-edit");

    const history = await getVendorHistory(head, created.data.vendorRef, {});
    expect(history.ok).toBe(true);
    if (!history.ok) throw new Error("unreachable");
    expect(history.data.events.length).toBeGreaterThan(0);
    expect(history.data.events.some((e) => e.kind === "created")).toBe(true);
    expect(history.data.events.some((e) => e.kind === "edited")).toBe(true);
    expect(history.data.events.every((e) => e.actorDisplayName)).toBe(true);
    const json = JSON.stringify(history.data.events);
    expect(json).not.toMatch(/pan|ifsc|accountNumber|gst.*number/i);
  });
});

describe("Vendor lifecycle", () => {
  it("ACTIVE <-> INACTIVE toggles freely, without a reason", async () => {
    const head = await actorFor("partnership_head");
    const created = await createVendor(head, { displayName: uniqueName("Toggle"), vendorType: "AGENCY", regionIds: ["Kerala"] }, "req-toggle-create");
    if (!created.ok) throw new Error("unreachable");

    const inactive = await setVendorStatus(head, created.data.vendorRef, { status: "INACTIVE", expectedVersion: created.data.version }, "req-toggle-1");
    expect(inactive.ok).toBe(true);
    if (!inactive.ok) throw new Error("unreachable");
    expect(inactive.data.status).toBe("INACTIVE");

    const active = await setVendorStatus(head, created.data.vendorRef, { status: "ACTIVE", expectedVersion: inactive.data.version }, "req-toggle-2");
    expect(active.ok).toBe(true);
  });

  it("stale lifecycle transition is rejected", async () => {
    const head = await actorFor("partnership_head");
    const created = await createVendor(head, { displayName: uniqueName("Stale Lifecycle"), vendorType: "AGENCY", regionIds: ["Kerala"] }, "req-stale-lc-create");
    if (!created.ok) throw new Error("unreachable");

    const first = await setVendorStatus(head, created.data.vendorRef, { status: "INACTIVE", expectedVersion: created.data.version }, "req-stale-lc-1");
    expect(first.ok).toBe(true);

    const stale = await setVendorStatus(head, created.data.vendorRef, { status: "ACTIVE", expectedVersion: created.data.version }, "req-stale-lc-2");
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("unreachable");
    expect(stale.code).toBe("stale_write");
  });

  it("archive requires a reason, is blocked by an active relationship dependency, and never cascades to the linked Partner", async () => {
    const head = await actorFor("partnership_head");
    const vendor = await createVendor(head, { displayName: uniqueName("Blocked Archive"), vendorType: "AGENCY", regionIds: ["Kerala"] }, "req-blocked-create");
    if (!vendor.ok) throw new Error("unreachable");
    const partner = await createPartner(head, { displayName: uniqueName("Blocked Archive Partner") }, "req-blocked-partner");
    if (!partner.ok) throw new Error("unreachable");

    const link = await createVendorPartnerLink(head, vendor.data.vendorRef, { partnerRef: partner.data.partnerRef, relationshipType: "AGENCY", effectiveFrom: new Date().toISOString() }, "req-blocked-link");
    expect(link.ok).toBe(true);

    const deps = await checkVendorDependencies({ uid: vendor.data.vendorRef, vendorRef: vendor.data.vendorRef });
    expect(deps.status).toBe("blocked");

    const blocked = await archiveVendor(head, vendor.data.vendorRef, { reason: "Testing dependency block.", expectedVersion: vendor.data.version }, "req-blocked-archive");
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("unreachable");
    expect(blocked.code).toBe("not_ready");
    expect(blocked.blockers?.length).toBeGreaterThan(0);

    // Archive never cascades to the Partner - it remains completely
    // untouched by the (blocked, but let's also prove it for a
    // successful archive below) attempt.
    const partnerBefore = await getPartnerDocByRef(partner.data.partnerRef);
    expect(partnerBefore?.status).toBe("ACTIVE");

    if (!link.ok) throw new Error("unreachable");
    const ended = await endVendorPartnerLink(head, link.data.vendorPartnerLinkRef, { effectiveTo: new Date().toISOString(), expectedVersion: link.data.version }, "req-blocked-end");
    expect(ended.ok).toBe(true);

    const archived = await archiveVendor(head, vendor.data.vendorRef, { reason: "Business concluded.", expectedVersion: vendor.data.version }, "req-blocked-archive-2");
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("unreachable");
    expect(archived.data.status).toBe("ARCHIVED");
    expect(archived.data.previousStatus).toBe("ACTIVE");

    const partnerAfter = await getPartnerDocByRef(partner.data.partnerRef);
    expect(partnerAfter?.status).toBe("ACTIVE");
    expect(partnerAfter?.version).toBe(partnerBefore?.version); // literally untouched
  });

  it("restore returns to the exact previousStatus, history-preserving, no dependency check needed", async () => {
    const head = await actorFor("partnership_head");
    const vendor = await createVendor(head, { displayName: uniqueName("Restore Me"), vendorType: "AGENCY", regionIds: ["Kerala"] }, "req-restore-create");
    if (!vendor.ok) throw new Error("unreachable");

    const inactive = await setVendorStatus(head, vendor.data.vendorRef, { status: "INACTIVE", expectedVersion: vendor.data.version }, "req-restore-inactive");
    if (!inactive.ok) throw new Error("unreachable");

    const archived = await archiveVendor(head, vendor.data.vendorRef, { reason: "Pausing.", expectedVersion: inactive.data.version }, "req-restore-archive");
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("unreachable");
    expect(archived.data.previousStatus).toBe("INACTIVE");

    const restored = await restoreVendor(head, vendor.data.vendorRef, { expectedVersion: archived.data.version }, "req-restore-restore");
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error("unreachable");
    expect(restored.data.status).toBe("INACTIVE"); // exact previousStatus, never a fixed "back to ACTIVE"
    expect(restored.data.previousStatus).toBeNull();

    const history = await getVendorHistory(head, vendor.data.vendorRef, {});
    if (!history.ok) throw new Error("unreachable");
    expect(history.data.events.some((e) => e.kind === "archived")).toBe(true); // never erased
    expect(history.data.events.some((e) => e.kind === "restored")).toBe(true);
  });

  it("Partnership Manager can transition lifecycle and manage relationships but cannot archive/restore (governance is Head-only)", async () => {
    const manager = await actorFor("partnership_manager");
    const vendor = await createVendor(manager, { displayName: uniqueName("Manager Scope"), vendorType: "AGENCY", regionIds: ["Kerala"] }, "req-mgr-create");
    expect(vendor.ok).toBe(true);
    if (!vendor.ok) throw new Error("unreachable");

    const toggled = await setVendorStatus(manager, vendor.data.vendorRef, { status: "INACTIVE", expectedVersion: vendor.data.version }, "req-mgr-toggle");
    expect(toggled.ok).toBe(true);
    if (!toggled.ok) throw new Error("unreachable");

    const archived = await archiveVendor(manager, vendor.data.vendorRef, { reason: "x", expectedVersion: toggled.data.version }, "req-mgr-archive");
    expect(archived.ok).toBe(false);
    if (archived.ok) throw new Error("unreachable");
    expect(archived.code).toBe("unauthorized");
    expect(archived.reason).toBe("action_denied");
  });
});

describe("Vendor <-> Partner relationships", () => {
  it("is a real M:N shape on the Vendor side - one Vendor can have many simultaneously-ACTIVE Partners, readable from either side", async () => {
    const head = await actorFor("partnership_head");
    const vendorLinks = await listLinksForVendor(head, "seed-vendor-agency");
    expect(vendorLinks.ok).toBe(true);
    if (!vendorLinks.ok) throw new Error("unreachable");
    const distinctPartners = new Set(vendorLinks.data.map((l) => l.partnerRef));
    expect(distinctPartners.size).toBeGreaterThanOrEqual(2); // multiple Partners per Vendor - the Vendor side is unrestricted
    expect(vendorLinks.data.filter((l) => l.status === "ACTIVE").length).toBeGreaterThanOrEqual(2); // more than one can be ACTIVE at once

    const partnerLinks = await listVendorLinksForPartner(head, "creator-house");
    expect(partnerLinks.ok).toBe(true);
    if (!partnerLinks.ok) throw new Error("unreachable");
    expect(partnerLinks.data.every((l) => l.status === "ACTIVE" || l.status === "ENDED")).toBe(true);
    for (const link of partnerLinks.data) {
      expect(typeof link.vendor.displayName).toBe("string");
      expect(link.vendor.displayName.length).toBeGreaterThan(0);
    }
  });

  it("the Partner side is policy-limited to at most one ACTIVE Vendor at a time", async () => {
    const head = await actorFor("partnership_head");
    const { vendor: vendorA, partner } = await createVendorAndPartnerPair(head);
    const first = await createVendorPartnerLink(head, vendorA.vendorRef, { partnerRef: partner.partnerRef, relationshipType: "AGENCY", effectiveFrom: new Date().toISOString() }, "req-onevendor-first");
    expect(first.ok).toBe(true);

    const vendorB = await createVendor(head, { displayName: uniqueName("Second Vendor For Same Partner"), vendorType: "MANAGEMENT_COMPANY", regionIds: ["Kerala"] }, "req-onevendor-vendorb");
    if (!vendorB.ok) throw new Error("unreachable");

    // A second ACTIVE link for the SAME Partner, from a DIFFERENT Vendor,
    // is rejected - company policy, not a scope/validation edge case.
    const second = await createVendorPartnerLink(head, vendorB.data.vendorRef, { partnerRef: partner.partnerRef, relationshipType: "MANAGEMENT", effectiveFrom: new Date().toISOString() }, "req-onevendor-second");
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe("conflict");
    expect(second.message).toContain(vendorA.displayName); // names the CURRENT vendor, so the operator knows who to end first

    // Ending the first relationship frees the Partner for a new one.
    if (!first.ok) throw new Error("unreachable");
    const ended = await endVendorPartnerLink(head, first.data.vendorPartnerLinkRef, { effectiveTo: new Date().toISOString(), expectedVersion: first.data.version }, "req-onevendor-end");
    expect(ended.ok).toBe(true);

    const third = await createVendorPartnerLink(head, vendorB.data.vendorRef, { partnerRef: partner.partnerRef, relationshipType: "MANAGEMENT", effectiveFrom: new Date().toISOString() }, "req-onevendor-third");
    expect(third.ok).toBe(true);
  });

  it("creating a link validates effective dates - effectiveTo before effectiveFrom is rejected", async () => {
    const head = await actorFor("partnership_head");
    const { vendor, partner } = await createVendorAndPartnerPair(head);
    const result = await createVendorPartnerLink(
      head,
      vendor.vendorRef,
      { partnerRef: partner.partnerRef, relationshipType: "AGENCY", effectiveFrom: "2026-06-01T00:00:00.000Z", effectiveTo: "2026-01-01T00:00:00.000Z" },
      "req-bad-dates",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("ending a relationship preserves the row (never hard-deleted) and sets status/effectiveTo, restore reopens it", async () => {
    const head = await actorFor("partnership_head");
    const { vendor, partner } = await createVendorAndPartnerPair(head);
    const link = await createVendorPartnerLink(head, vendor.vendorRef, { partnerRef: partner.partnerRef, relationshipType: "MANAGEMENT", effectiveFrom: new Date().toISOString() }, "req-end-create");
    if (!link.ok) throw new Error("unreachable");

    const ended = await endVendorPartnerLink(head, link.data.vendorPartnerLinkRef, { effectiveTo: new Date().toISOString(), expectedVersion: link.data.version }, "req-end-end");
    expect(ended.ok).toBe(true);
    if (!ended.ok) throw new Error("unreachable");
    expect(ended.data.status).toBe("ENDED");
    expect(ended.data.effectiveTo).not.toBeNull();

    // Still there - never hard-deleted.
    const stillExists = await getVendorPartnerLinkDocByRef(link.data.vendorPartnerLinkRef);
    expect(stillExists).not.toBeNull();
    expect(vendorPartnerLinkDocSchema.safeParse(stillExists).success).toBe(true);

    const restored = await restoreVendorPartnerLink(head, link.data.vendorPartnerLinkRef, { expectedVersion: ended.data.version }, "req-end-restore");
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error("unreachable");
    expect(restored.data.status).toBe("ACTIVE");
    expect(restored.data.effectiveTo).toBeNull();
  });

  it("editing safe metadata never touches vendorRef/partnerRef, and a stale version is rejected", async () => {
    const head = await actorFor("partnership_head");
    const { vendor, partner } = await createVendorAndPartnerPair(head);
    const link = await createVendorPartnerLink(head, vendor.vendorRef, { partnerRef: partner.partnerRef, relationshipType: "OTHER", effectiveFrom: new Date().toISOString() }, "req-edit-link-create");
    if (!link.ok) throw new Error("unreachable");

    const edited = await editVendorPartnerLink(head, link.data.vendorPartnerLinkRef, { relationshipType: "REPRESENTATION", expectedVersion: link.data.version }, "req-edit-link-1");
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error("unreachable");
    expect(edited.data.relationshipType).toBe("REPRESENTATION");
    expect(edited.data.vendorRef).toBe(vendor.vendorRef);
    expect(edited.data.partnerRef).toBe(partner.partnerRef);

    const stale = await editVendorPartnerLink(head, link.data.vendorPartnerLinkRef, { relationshipType: "PAYEE", expectedVersion: link.data.version }, "req-edit-link-2");
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("unreachable");
    expect(stale.code).toBe("stale_write");
  });
});

describe("Vendor <-> Partner one-active-Vendor invariant (Step 8B.1 REVISED)", () => {
  it("a same-Vendor create retry is idempotent - returns the existing active link rather than erroring or creating a duplicate", async () => {
    const head = await actorFor("partnership_head");
    const { vendor, partner } = await createVendorAndPartnerPair(head);
    const first = await createVendorPartnerLink(head, vendor.vendorRef, { partnerRef: partner.partnerRef, relationshipType: "AGENCY", effectiveFrom: new Date().toISOString() }, "req-idem-1");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");

    const retry = await createVendorPartnerLink(head, vendor.vendorRef, { partnerRef: partner.partnerRef, relationshipType: "AGENCY", effectiveFrom: new Date().toISOString() }, "req-idem-2");
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error("unreachable");
    expect(retry.data.vendorPartnerLinkRef).toBe(first.data.vendorPartnerLinkRef); // same row, not a new one

    const links = await listLinksForVendor(head, vendor.vendorRef);
    if (!links.ok) throw new Error("unreachable");
    expect(links.data.filter((l) => l.partnerRef === partner.partnerRef).length).toBe(1); // no duplicate was created
  });

  it("restoring an ended link succeeds only when the Partner currently has no other active Vendor - rejected with conflict otherwise", async () => {
    const head = await actorFor("partnership_head");
    const { vendor: vendorA, partner } = await createVendorAndPartnerPair(head);
    const linkA = await createVendorPartnerLink(head, vendorA.vendorRef, { partnerRef: partner.partnerRef, relationshipType: "AGENCY", effectiveFrom: new Date().toISOString() }, "req-restoreconf-1");
    if (!linkA.ok) throw new Error("unreachable");
    const endedA = await endVendorPartnerLink(head, linkA.data.vendorPartnerLinkRef, { effectiveTo: new Date().toISOString(), expectedVersion: linkA.data.version }, "req-restoreconf-end");
    if (!endedA.ok) throw new Error("unreachable");

    const vendorB = await createVendor(head, { displayName: uniqueName("Restore Conflict Vendor B"), vendorType: "MANAGEMENT_COMPANY", regionIds: ["Kerala"] }, "req-restoreconf-vb");
    if (!vendorB.ok) throw new Error("unreachable");
    const linkB = await createVendorPartnerLink(head, vendorB.data.vendorRef, { partnerRef: partner.partnerRef, relationshipType: "MANAGEMENT", effectiveFrom: new Date().toISOString() }, "req-restoreconf-2");
    expect(linkB.ok).toBe(true);

    // vendorB is now the Partner's one active Vendor - restoring the
    // earlier ended vendorA link must be rejected, never silently
    // creating a second active relationship.
    const restoreBlocked = await restoreVendorPartnerLink(head, linkA.data.vendorPartnerLinkRef, { expectedVersion: endedA.data.version }, "req-restoreconf-restore-1");
    expect(restoreBlocked.ok).toBe(false);
    if (restoreBlocked.ok) throw new Error("unreachable");
    expect(restoreBlocked.code).toBe("conflict");

    // Ending vendorB's link frees the Partner up again - the SAME earlier
    // ended link can now be restored cleanly.
    if (!linkB.ok) throw new Error("unreachable");
    const endedB = await endVendorPartnerLink(head, linkB.data.vendorPartnerLinkRef, { effectiveTo: new Date().toISOString(), expectedVersion: linkB.data.version }, "req-restoreconf-endb");
    expect(endedB.ok).toBe(true);

    const restoreOk = await restoreVendorPartnerLink(head, linkA.data.vendorPartnerLinkRef, { expectedVersion: endedA.data.version }, "req-restoreconf-restore-2");
    expect(restoreOk.ok).toBe(true);
    if (!restoreOk.ok) throw new Error("unreachable");
    expect(restoreOk.data.status).toBe("ACTIVE");
  });

  it("two concurrent creates against different Vendors for the same Partner never both succeed - exactly one wins, race-safely, across repeated attempts", async () => {
    const head = await actorFor("partnership_head");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const partner = await createPartner(head, { displayName: uniqueName(`Race Partner ${attempt}`), regionIds: ["Kerala"] }, `req-race-partner-${attempt}`);
      if (!partner.ok) throw new Error("unreachable");
      const vendorX = await createVendor(head, { displayName: uniqueName(`Race Vendor X ${attempt}`), vendorType: "AGENCY", regionIds: ["Kerala"] }, `req-race-vx-${attempt}`);
      const vendorY = await createVendor(head, { displayName: uniqueName(`Race Vendor Y ${attempt}`), vendorType: "MANAGEMENT_COMPANY", regionIds: ["Kerala"] }, `req-race-vy-${attempt}`);
      if (!vendorX.ok || !vendorY.ok) throw new Error("unreachable");

      const [resultX, resultY] = await Promise.all([
        createVendorPartnerLink(head, vendorX.data.vendorRef, { partnerRef: partner.data.partnerRef, relationshipType: "AGENCY", effectiveFrom: new Date().toISOString() }, `req-race-x-${attempt}`),
        createVendorPartnerLink(head, vendorY.data.vendorRef, { partnerRef: partner.data.partnerRef, relationshipType: "MANAGEMENT", effectiveFrom: new Date().toISOString() }, `req-race-y-${attempt}`),
      ]);

      const outcomes = [resultX, resultY];
      const wins = outcomes.filter((r) => r.ok);
      const conflicts = outcomes.filter((r) => !r.ok && r.code === "conflict");
      expect(wins.length).toBe(1); // exactly one winner, never zero, never both
      expect(conflicts.length).toBe(1);

      // The Partner's own link list agrees - exactly one ACTIVE link.
      const partnerLinks = await listVendorLinksForPartner(head, partner.data.partnerRef);
      if (!partnerLinks.ok) throw new Error("unreachable");
      expect(partnerLinks.data.filter((l) => l.status === "ACTIVE").length).toBe(1);
    }
  }, 20_000);

  it("switching Vendor never corrupts the Partner record, and the previous Vendor's history/effective dates stay exactly as recorded", async () => {
    const head = await actorFor("partnership_head");
    const { vendor: vendorA, partner } = await createVendorAndPartnerPair(head);
    const partnerBefore = await getPartnerDocByRef(partner.partnerRef);

    const effectiveFromA = "2025-01-01T00:00:00.000Z";
    const linkA = await createVendorPartnerLink(head, vendorA.vendorRef, { partnerRef: partner.partnerRef, relationshipType: "AGENCY", effectiveFrom: effectiveFromA }, "req-switch-1");
    if (!linkA.ok) throw new Error("unreachable");

    const effectiveToA = "2025-06-01T00:00:00.000Z";
    const endedA = await endVendorPartnerLink(head, linkA.data.vendorPartnerLinkRef, { effectiveTo: effectiveToA, expectedVersion: linkA.data.version }, "req-switch-end");
    expect(endedA.ok).toBe(true);

    const vendorB = await createVendor(head, { displayName: uniqueName("Switch Vendor B"), vendorType: "MANAGEMENT_COMPANY", regionIds: ["Kerala"] }, "req-switch-vb");
    if (!vendorB.ok) throw new Error("unreachable");
    const linkB = await createVendorPartnerLink(head, vendorB.data.vendorRef, { partnerRef: partner.partnerRef, relationshipType: "MANAGEMENT", effectiveFrom: "2025-06-01T00:00:00.000Z" }, "req-switch-2");
    expect(linkB.ok).toBe(true);

    // The Partner document itself was never touched by any of this.
    const partnerAfter = await getPartnerDocByRef(partner.partnerRef);
    expect(partnerAfter?.version).toBe(partnerBefore?.version);

    // vendorA's own historical record is exactly what was recorded -
    // never rewritten to look continuous with vendorB's period.
    const linkADoc = await getVendorPartnerLinkDocByRef(linkA.data.vendorPartnerLinkRef);
    expect(linkADoc?.status).toBe("ENDED");
    expect(linkADoc?.effectiveFrom).toBe(effectiveFromA);
    expect(linkADoc?.effectiveTo).toBe(effectiveToA);

    // Both rows remain readable side by side - a distinct history record,
    // not an in-place overwrite.
    const allLinks = await listVendorLinksForPartner(head, partner.partnerRef);
    if (!allLinks.ok) throw new Error("unreachable");
    expect(allLinks.data.some((l) => l.vendorRef === vendorA.vendorRef && l.status === "ENDED")).toBe(true);
    expect(allLinks.data.some((l) => l.vendorRef === vendorB.data.vendorRef && l.status === "ACTIVE")).toBe(true);
  });
});

describe("Scope: Partner-side relationship query never bridges into a Vendor's unrelated portfolio", () => {
  it("Partnership Manager sees creator-house's own Vendor links (Partner-scope), even though the Vendors themselves are cross-scope for Manager directly", async () => {
    const manager = await actorFor("partnership_manager"); // no Karnataka region grant
    const directAgency = await getVendor(manager, "seed-vendor-agency");
    expect(directAgency.ok).toBe(false); // confirmed cross-scope above too

    const viaPartner = await listVendorLinksForPartner(manager, "creator-house"); // creator-house IS Manager-visible via its PARTNER grant
    expect(viaPartner.ok).toBe(true);
    if (!viaPartner.ok) throw new Error("unreachable");
    expect(viaPartner.data.some((l) => l.vendorRef === "seed-vendor-agency")).toBe(true);
    // Only a safe label, never the full Vendor - no raw ids, no other fields.
    const row = viaPartner.data.find((l) => l.vendorRef === "seed-vendor-agency")!;
    expect(Object.keys(row.vendor).sort()).toEqual(["displayName", "status", "vendorRef", "vendorType"].sort());
    // Step 8B.1 REVISED section 8: canOpenVendor is server-derived from
    // Manager's OWN Vendor scope, not from Partner visibility - Manager
    // can see this row (Partner scope) but seed-vendor-agency is
    // Karnataka/cross-scope for Manager directly, so "Open Vendor" must
    // not be offered.
    expect(row.canOpenVendor).toBe(false);

    // A Head actor with real Vendor scope over Karnataka sees the SAME
    // row with canOpenVendor true - proving the field genuinely reflects
    // direct Vendor access, not a blanket false.
    const head = await actorFor("partnership_head");
    const viaPartnerAsHead = await listVendorLinksForPartner(head, "creator-house");
    if (!viaPartnerAsHead.ok) throw new Error("unreachable");
    const headRow = viaPartnerAsHead.data.find((l) => l.vendorRef === "seed-vendor-agency")!;
    expect(headRow.canOpenVendor).toBe(true);
  });

  it("the reverse bridge is also blocked: seeing a Vendor's own link list never grants Partner-side access to an out-of-scope linked Partner", async () => {
    const manager = await actorFor("partnership_manager");
    // seed-vendor-inactive (Kerala) IS in Manager's Vendor scope...
    const links = await listLinksForVendor(manager, "seed-vendor-inactive");
    expect(links.ok).toBe(true);
    if (!links.ok) throw new Error("unreachable");
    expect(links.data.some((l) => l.partnerRef === "seed-partner-inactive")).toBe(true);

    // ...but seed-partner-inactive (Tamil Nadu) is NOT in Manager's
    // Partner scope, and seeing the link's opaque partnerRef above must
    // never have granted access to it.
    const partnerDetail = await listVendorLinksForPartner(manager, "seed-partner-inactive");
    expect(partnerDetail.ok).toBe(false);
    if (partnerDetail.ok) throw new Error("unreachable");
    expect(partnerDetail.code).toBe("unauthorized");
  });

  it("direct Vendor scope is required even for a Vendor linked to an in-scope Partner - PARTNER-type scope never substitutes for Vendor scope", async () => {
    const manager = await actorFor("partnership_manager");
    // creator-house is Manager-visible via its own PARTNER grant, and
    // seed-vendor-agency (Karnataka) is creator-house's real active
    // Vendor - but that link must never grant Manager direct Vendor
    // access to seed-vendor-agency itself.
    const result = await getVendor(manager, "seed-vendor-agency");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("scope_denied");
  });
});

describe("Restricted Vendor identity", () => {
  it("is denied without the vendor_payment_details sensitive category, even with the manage action", async () => {
    const manager = await actorFor("partnership_manager"); // has the action, not the sensitive category
    const result = await getVendorRestrictedIdentity(manager, "seed-vendor-agency");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("sensitive_denied");
  });

  it("is allowed with both the action and the sensitive category, and returns the safe fields only", async () => {
    const head = await actorFor("partnership_head");
    const result = await getVendorRestrictedIdentity(head, "seed-vendor-agency");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data?.pan?.number).toBe("ABCDE1111F");
    expect(result.data).not.toHaveProperty("uid");
  });

  it("an unauthorized actor cannot infer whether restricted data exists - denial looks identical for a Vendor with and without a restricted record", async () => {
    const manager = await actorFor("partnership_manager");
    const withRecord = await getVendorRestrictedIdentity(manager, "seed-vendor-agency"); // has a restricted doc
    const withoutRecord = await getVendorRestrictedIdentity(manager, "seed-vendor-inactive"); // has none
    expect(withRecord.ok).toBe(false);
    expect(withoutRecord.ok).toBe(false);
    if (withRecord.ok || withoutRecord.ok) throw new Error("unreachable");
    expect(withRecord.code).toBe(withoutRecord.code);
    expect(withRecord.reason).toBe(withoutRecord.reason);
  });

  it("a real GST collision against another Vendor is safely detected without leaking the other Vendor's own values", async () => {
    const head = await actorFor("partnership_head");
    const vendor = await createVendor(head, { displayName: uniqueName("GST Collider"), vendorType: "AGENCY", regionIds: ["Kerala"] }, "req-gst-create");
    if (!vendor.ok) throw new Error("unreachable");

    const collision = await saveVendorRestrictedIdentity(head, vendor.data.vendorRef, { gst: { applicable: true, number: "29ABCDE1111F1Z5" }, expectedVersion: 0 }, "req-gst-save");
    expect(collision.ok).toBe(false);
    if (collision.ok) throw new Error("unreachable");
    expect(collision.code).toBe("conflict");
    expect(collision.message).not.toContain("Northline"); // never leaks the other Vendor's identity
  });

  it("ordinary Vendor DTO and history never contain restricted values, regardless of actor", async () => {
    const head = await actorFor("partnership_head");
    const vendor = await getVendor(head, "seed-vendor-agency");
    const history = await getVendorHistory(head, "seed-vendor-agency", {});
    expect(vendor.ok && history.ok).toBe(true);
    const combined = JSON.stringify([vendor, history]);
    expect(combined).not.toMatch(/ABCDE1111F|29ABCDE1111F1Z5|000000000002/);
  });
});

describe("Duplicate check", () => {
  // The "unknown/error" failure path is covered as a pure unit test
  // (mocked Firestore) in ./duplicate-check.test.ts, same precedent as
  // Discovery's own duplicate-check.test.ts - deliberately simulating a
  // Firestore failure doesn't belong in a real emulator integration
  // suite.

  it("confirmed on an exact email match, advisory only - never a uniqueness lock", async () => {
    const head = await actorFor("partnership_head");
    const email = `${uniqueName("dupe").replace(/\s+/g, "")}@example-vendor.test`;
    const first = await createVendor(head, { displayName: uniqueName("First"), vendorType: "AGENCY", email }, "req-dupe-1");
    expect(first.ok).toBe(true);

    const check = await checkForVendorDuplicates({ email });
    expect(check.status).toBe("confirmed");
    expect(check.matches.some((m) => m.type === "email" && m.confidence === "high")).toBe(true);

    // Advisory only - a second Vendor with the same email is NOT blocked.
    const second = await createVendor(head, { displayName: uniqueName("Second"), vendorType: "AGENCY", email }, "req-dupe-2");
    expect(second.ok).toBe(true);
  });
});

describe("Regression", () => {
  it("no Vendor is ever created as a side effect of a real, full Discovery conversion", async () => {
    const head = await actorFor("partnership_head");
    const admin = await actorFor("super_admin");

    const before = await listVendors(admin, { limit: 100 });
    if (!before.ok) throw new Error("unreachable");
    const vendorRefsBefore = new Set(before.data.vendors.map((v) => v.vendorRef));

    const lead = await createLead(head, { displayName: uniqueName("No Vendor Lead"), source: { type: "referral" }, regionIds: ["Kerala"], email: `${uniqueName("novendor").replace(/\s+/g, "")}@example.com` }, "req-no-vendor-create");
    if (!lead.ok) throw new Error("unreachable");
    let version = lead.data.version;
    const research = await saveResearch(head, lead.data.leadRef, { targetAudience: "India 1", expectedVersion: version }, "req-nv-research");
    if (!research.ok) throw new Error("unreachable");
    version = research.data.version;
    const outbound = await recordOutreach(head, lead.data.leadRef, { direction: "OUTBOUND", channel: "email", summary: "hi", outcome: "sent", expectedVersion: version }, "req-nv-out1");
    if (!outbound.ok) throw new Error("unreachable");
    version = outbound.data.version;
    const inbound = await recordOutreach(head, lead.data.leadRef, { direction: "INBOUND", channel: "email", summary: "reply", outcome: "interested", meaningfulResponse: true, expectedVersion: version }, "req-nv-out2");
    if (!inbound.ok) throw new Error("unreachable");
    version = inbound.data.version;
    const evaluating = await transitionLeadLifecycle(head, lead.data.leadRef, { to: "EVALUATING", expectedVersion: version }, "req-nv-eval");
    if (!evaluating.ok) throw new Error("unreachable");
    version = evaluating.data.version;
    const review = await recordReview(head, lead.data.leadRef, { outcome: "SHORTLIST", expectedVersion: version }, "req-nv-review");
    if (!review.ok) throw new Error("unreachable");
    version = review.data.version;
    const commercial = await saveCommercial(head, lead.data.leadRef, { alignmentConfirmed: true, expectedVersion: version }, "req-nv-commercial");
    if (!commercial.ok) throw new Error("unreachable");
    version = commercial.data.version;
    const agreement = await saveDiscoveryAgreement(head, lead.data.leadRef, { confirmed: true, expectedVersion: version }, "req-nv-agreement");
    if (!agreement.ok) throw new Error("unreachable");
    version = agreement.data.version;
    const asset = await saveAssetDecision(head, lead.data.leadRef, { decision: "NEW_ACCOUNT", expectedVersion: version }, "req-nv-asset");
    if (!asset.ok) throw new Error("unreachable");
    version = asset.data.version;
    const manager = await assignManager(head, lead.data.leadRef, { managerUserRef: head.userRef, expectedVersion: version }, "req-nv-manager");
    if (!manager.ok) throw new Error("unreachable");
    version = manager.data.version;
    const kyc = await saveLeadKyc(
      head,
      lead.data.leadRef,
      {
        email: "kyc-novendor@example.com",
        aadhaar: { number: "0000-2222-3333", evidenceRef: "ref://a" },
        pan: { number: "NOVEN1234F", evidenceRef: "ref://p" },
        bank: { accountHolderName: "No Vendor Flow", accountNumber: "333322221111", ifsc: "NOVE0000001", bankName: "No Vendor Bank", branchName: "No Vendor Branch", proofRef: "ref://b" },
        gst: { applicable: false },
        expectedKycVersion: 0,
        expectedLeadVersion: version,
      },
      "req-nv-kyc",
    );
    if (!kyc.ok) throw new Error("unreachable");
    const leadAfterKyc = await getLead(head, lead.data.leadRef);
    if (!leadAfterKyc.ok) throw new Error("unreachable");
    version = leadAfterKyc.data.version;
    const ready = await transitionLeadLifecycle(head, lead.data.leadRef, { to: "CONVERSION_READY", expectedVersion: version }, "req-nv-ready");
    if (!ready.ok) throw new Error("unreachable");
    version = ready.data.version;

    const converted = await convertLead(head, lead.data.leadRef, { idempotencyKey: `nv-${runId}`, expectedVersion: version }, "req-nv-convert");
    expect(converted.ok).toBe(true);

    const after = await listVendors(admin, { limit: 100 });
    if (!after.ok) throw new Error("unreachable");
    const vendorRefsAfter = new Set(after.data.vendors.map((v) => v.vendorRef));
    expect(vendorRefsAfter).toEqual(vendorRefsBefore); // not one new Vendor
  });

  it("Partner schema is unaffected - no polymorphic Partner regression", async () => {
    const doc = await getPartnerDocByRef("creator-house");
    expect(doc).toBeTruthy();
    expect(partnerDocSchema.safeParse(doc).success).toBe(true);
    // Never gained a vendor-shaped field.
    expect(doc).not.toHaveProperty("vendorType");
    expect(doc).not.toHaveProperty("vendorRef");
  });
});
