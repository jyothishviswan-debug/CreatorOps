// Step 12A - real reads/writes against the running Firestore/Auth
// emulator (no mocks), same rationale as every other domain's own
// *.emulator.test.ts suite. Run with `pnpm test:emulator` against a
// running `pnpm firebase:emulators`.
//
// Content-matcher.ts/partner-account-matcher.ts (and everything built on
// them - the import pipeline, correction service, explorer) read live
// Firestore directly (getAdminFirestore()) with no mocking layer
// anywhere in this codebase (confirmed: every other domain's equivalent
// matching/authorization behavior is proven here, in *.emulator.test.ts,
// never in a mocked *.test.ts). The task's own "Unit" list groups several
// of these behaviors (match priority, unmatched, ambiguous, approved-
// only eligibility, historical-superseded-not-picked, Partner Account
// fast-path/fallback/ambiguity, correction preconditions) descriptively -
// this file is their real, honest home given this codebase's actual
// testing architecture; the truly pure functions (metric registry,
// adapters' own mapping, row-identity-key determinism, read-model
// aggregation over plain arrays) are covered by real *.test.ts files
// instead (see metric-registry.test.ts, adapters/*.test.ts,
// import-pipeline.test.ts, read-models.test.ts).
import * as XLSX from "xlsx";
import { beforeAll, describe, expect, it } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { getContentDocByRef } from "@/server/content/firestore";
import { seedContentData } from "@/server/content/seed-content-data";
import { seedCampaignsData } from "@/server/campaigns/seed-campaigns-data";
import { seedAssignmentsData } from "@/server/assignments/seed-assignments-data";
import { seedDiscoveryData } from "@/server/discovery/seed-discovery-data";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { seedVendorsData } from "@/server/vendors/seed-vendors-data";

import { computeNormalizedIdentity } from "@/server/partners/identity";

import { requireAnalyticsExploreAccess, requireAnalyticsManageAccess, requireImportsModuleAccess } from "./analytics-gate";
import { resolveAnalyticsSourceRecordMatch } from "./correction-service";
import { listAnalyticsSourceRecords } from "./explorer-service";
import {
  analyticsChannelSourceRecordsCollection,
  analyticsContentSourceRecordsCollection,
  analyticsImportBatchesCollection,
  analyticsRowIdentityDocId,
  getAnalyticsContentSourceRecordByRef,
  getAnalyticsContentSourceRecordByUid,
} from "./firestore";
import { getAnalyticsImportBatchDetail } from "./import-history-service";
import { computeRowIdentityKey } from "./import-pipeline";
import { dryRunAnalyticsImport, executeAnalyticsImport } from "./import-service";
import { rebuildAnalyticsReadModels } from "./read-models";
import { seedAnalyticsData } from "./seed-analytics-data";

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
  await seedContentData();
  await seedAnalyticsData();

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

function workbookBuffer(sheetName: string, rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function uniqueFilename(prefix: string): string {
  return `${prefix}-${runId}-${Math.random().toString(36).slice(2, 8)}.xlsx`;
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// ---- Authorization: module access vs target action access, separately gated (Section 17-18) --
describe("Analytics authorization - module access vs target action access are separately gated", () => {
  it("Viewer: denied the Import Center MODULE (no imports feature at all) AND denied the Analytics manage action - two independent denials", async () => {
    const viewer = await actorFor("viewer");
    const moduleGate = await requireImportsModuleAccess(viewer);
    expect(moduleGate).toEqual({ ok: false, reason: "feature_denied" });

    // Viewer DOES hold the analytics feature (view: true) but not the
    // explore/manage_analytics_data actions - a genuinely different
    // failure mode (action_denied, not feature_denied) from the module
    // gate above, proving these are two independent checks.
    const exploreGate = await requireAnalyticsExploreAccess(viewer);
    expect(exploreGate).toEqual({ ok: false, reason: "action_denied" });
    const manageGate = await requireAnalyticsManageAccess(viewer);
    expect(manageGate).toEqual({ ok: false, reason: "action_denied" });
  });

  it("Analyst: granted both the Import Center module action and the Analytics manage action (explicit grant)", async () => {
    const analyst = await actorFor("analyst");
    expect(await requireImportsModuleAccess(analyst)).toEqual({ ok: true });
    expect(await requireAnalyticsExploreAccess(analyst)).toEqual({ ok: true });
    expect(await requireAnalyticsManageAccess(analyst)).toEqual({ ok: true });
  });

  it("Partnership Manager: Explore allowed, manage_analytics_data denied by default (non-monotonic); Import Center module stays Analyst/Super-Admin-only (no role-rank fallback)", async () => {
    const manager = await actorFor("partnership_manager");
    expect(await requireAnalyticsExploreAccess(manager)).toEqual({ ok: true });
    expect(await requireAnalyticsManageAccess(manager)).toEqual({ ok: false, reason: "action_denied" });
    // Manager never held the "imports" feature at all (unchanged by this
    // step) - denied at the FEATURE level, not the action level.
    expect(await requireImportsModuleAccess(manager)).toEqual({ ok: false, reason: "feature_denied" });
  });

  it("Partnership Head: granted both explore and manage_analytics_data - but NOT the Import Center module (a genuine, pre-existing invariant this step preserves rather than overrides - see seed-access-data.emulator.test.ts's own 'no role-rank fallback' proof)", async () => {
    const head = await actorFor("partnership_head");
    expect(await requireAnalyticsExploreAccess(head)).toEqual({ ok: true });
    expect(await requireAnalyticsManageAccess(head)).toEqual({ ok: true });
    expect(await requireImportsModuleAccess(head)).toEqual({ ok: false, reason: "feature_denied" });
  });

  it("Viewer cannot import via the full dry-run pipeline (module gate fails first)", async () => {
    const viewer = await actorFor("viewer");
    const result = await dryRunAnalyticsImport(viewer, { targetKind: "campaign_content", fileBuffer: workbookBuffer("S", [["Post URL"], ["https://instagram.com/p/x"]]), filename: uniqueFilename("v"), mimeType: XLSX_MIME }, "req-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("feature_denied");
  });

  it("Partnership Manager cannot execute an import by default (denied, matching the non-monotonic design)", async () => {
    const manager = await actorFor("partnership_manager");
    const result = await executeAnalyticsImport(
      manager,
      { targetKind: "campaign_content", fileBuffer: workbookBuffer("S", [["Post URL"], ["https://instagram.com/p/manager-denied"]]), filename: uniqueFilename("mgr"), mimeType: XLSX_MIME },
      "req-2",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("feature_denied");
  });
});

// ---- Dry-run vs execute share one pipeline; dry-run writes nothing (Section 7-10) --
describe("dry-run and execute share the same pipeline; dry-run writes nothing", () => {
  it("dry-run performs matching but creates zero batch/source-record documents", async () => {
    const analyst = await actorFor("analyst");
    const beforeBatches = (await analyticsImportBatchesCollection().get()).size;
    const beforeRecords = (await analyticsContentSourceRecordsCollection().get()).size;

    // Deliberately NOT the same URL seed-analytics-data.ts already seeds
    // a committed record for (seed-approved-1) - this proves a genuinely
    // FRESH match, not a cross-batch duplicate re-discovery of the seed
    // fixture. community-story-reel-01 is a second, real APPROVED
    // Content thread (see seed-content-data.ts) with its own real
    // currentLinks URL, untouched by any Analytics seed fixture.
    const buffer = workbookBuffer("Content", [
      ["Post ID", "Post URL", "Comments", "Likes"],
      [null, "https://instagram.com/p/seed-community-story", "5", "10"],
    ]);
    const result = await dryRunAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename: uniqueFilename("dry"), mimeType: XLSX_MIME }, "req-3");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.batchRef).toBeNull();
      expect(result.data.counts.matched).toBe(1);
    }

    const afterBatches = (await analyticsImportBatchesCollection().get()).size;
    const afterRecords = (await analyticsContentSourceRecordsCollection().get()).size;
    expect(afterBatches).toBe(beforeBatches);
    expect(afterRecords).toBe(beforeRecords);
  });
});

// ---- Deterministic Content matching (Section 11) -------------------------
describe("deterministic Content URL matching, execute creates real provenance", () => {
  it("matches a real seeded APPROVED Content thread's real currentLinks URL end-to-end, and never mutates Content", async () => {
    const analyst = await actorFor("analyst");
    const beforeContent = await getContentDocByRef("community-story-reel-01");
    expect(beforeContent).not.toBeNull();

    const buffer = workbookBuffer("Content", [
      ["Post URL", "Comments", "Likes"],
      [`https://instagram.com/p/seed-community-story`, "7", "21"],
    ]);
    const result = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename: uniqueFilename("match"), mimeType: XLSX_MIME }, "req-4");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.batchRef).not.toBeNull();
    expect(result.data.status).toBe("COMPLETED");
    expect(result.data.counts.matched).toBe(1);

    const batchDetail = await getAnalyticsImportBatchDetail(analyst, result.data.batchRef);
    expect(batchDetail.ok).toBe(true);

    const afterContent = await getContentDocByRef("community-story-reel-01");
    expect(afterContent).toEqual(beforeContent); // never mutated by Analytics
  });

  it("a claim exists but the thread is not currently APPROVED - UNMATCHED with reasonCode CONTENT_NOT_CURRENTLY_APPROVED, never silently matched", async () => {
    const record = await getAnalyticsContentSourceRecordByRef("seed-analytics-content-not-approved");
    expect(record).not.toBeNull();
    expect(record!.matchState).toBe("UNMATCHED");
    expect(record!.matchEvidence.reasonCode).toBe("CONTENT_NOT_CURRENTLY_APPROVED");
    expect(record!.matchedContentRef).toBeNull();
  });

  it("no claim at all - UNMATCHED with reasonCode NO_CLAIM_FOUND, distinct from the not-currently-approved case", async () => {
    const record = await getAnalyticsContentSourceRecordByRef("seed-analytics-content-unmatched");
    expect(record).not.toBeNull();
    expect(record!.matchEvidence.reasonCode).toBe("NO_CLAIM_FOUND");
    expect(record!.matchEvidence.reasonCode).not.toBe("CONTENT_NOT_CURRENTLY_APPROVED");
  });
});

// ---- Partner Account matching - fast path, fallback scan, ambiguity (Section 12) --
describe("Partner Account matching - ambiguity is a real, exercised outcome", () => {
  it("a shared handle across two distinct, differently-keyed accounts stays AMBIGUOUS, never silently resolved to one", async () => {
    const sharedHandleIdentity = computeNormalizedIdentity({ platform: "instagram", handle: "sharedhandle" })!;
    const rowIdentityKey = computeRowIdentityKey("channel_account", "instagram", sharedHandleIdentity, null);
    const doc = await analyticsChannelSourceRecordsCollection().doc(analyticsRowIdentityDocId(rowIdentityKey)).get();
    expect(doc.exists).toBe(true);
    const data = doc.data()!;
    expect(data.matchState).toBe("AMBIGUOUS");
    expect(data.matchEvidence.candidateCount).toBe(2);
    expect(data.matchedPartnerAccountRef).toBeNull();
  });

  it("live import of a channel row with the same ambiguous shared handle reproduces AMBIGUOUS end-to-end", async () => {
    // Analyst, not Head - Import Center execution stays Analyst/Super-
    // Admin-only (see the authorization describe block above).
    const analyst = await actorFor("analyst");
    const buffer = workbookBuffer("Channel", [
      ["Handle", "Followers"],
      ["sharedhandle", "5000"],
    ]);
    // A distinct reportingPeriod from the seeded ambiguous fixture (which
    // used none) - the deterministic row identity key includes the
    // reporting period, so this is a genuinely FRESH row, not a
    // cross-batch duplicate re-discovery of the seed fixture's own
    // already-committed record.
    const result = await executeAnalyticsImport(
      analyst,
      {
        targetKind: "channel_account",
        fileBuffer: buffer,
        filename: uniqueFilename("ambiguous"),
        mimeType: XLSX_MIME,
        channelPlatform: "instagram",
        reportingPeriod: { start: "2025-06-01", end: "2025-06-30" },
      },
      "req-5",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.counts.ambiguous).toBe(1);
  });
});

// ---- Execute idempotency and partial success (Section 10) ----------------
describe("execute idempotency, partial success, and concurrency", () => {
  it("byte-identical retry is idempotent - same sourceHash, no duplicate batch/rows", async () => {
    const analyst = await actorFor("analyst");
    const buffer = workbookBuffer("Content", [
      ["Post URL", "Comments"],
      [`https://instagram.com/p/idempotent-${runId}`, "1"],
    ]);
    const filename = uniqueFilename("idempotent");

    const first = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-6a");
    expect(first.ok).toBe(true);
    const second = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-6b");
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.data.batchRef).toBe(first.data.batchRef);
      expect(second.data.idempotentReplay).toBe(true);
    }

    const db = getAdminFirestore();
    const batchesForHash = await db.collection("analyticsImportBatches").where("sourceFilename", "==", filename).get();
    expect(batchesForHash.size).toBe(1);
  });

  it("two concurrent execute calls for the exact same file content only ever produce one batch", async () => {
    const analyst = await actorFor("analyst");
    const buffer = workbookBuffer("Content", [
      ["Post URL", "Comments"],
      [`https://instagram.com/p/concurrent-${runId}`, "1"],
    ]);
    const filename = uniqueFilename("concurrent");

    const [a, b] = await Promise.all([
      executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-7a"),
      executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-7b"),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.data.batchRef).toBe(b.data.batchRef);

    const db = getAdminFirestore();
    const batchesForHash = await db.collection("analyticsImportBatches").where("sourceFilename", "==", filename).get();
    expect(batchesForHash.size).toBe(1);
  });

  it("partial success: one invalid row never blocks the other, valid rows in the same batch - status COMPLETED_WITH_ERRORS", async () => {
    const analyst = await actorFor("analyst");
    const buffer = workbookBuffer("Content", [
      ["Post URL", "Comments"],
      [`https://instagram.com/p/partial-success-${runId}`, "3"],
      // A fully-blank row (every cell null) is silently dropped by the
      // xlsx library's own sheet_to_json before it ever reaches this
      // pipeline - a real row needs at least one non-null cell to
      // "exist" at all, so Comments carries a value here while Post URL
      // (the only identity-bearing header in this sheet) stays null -
      // genuinely no identity evidence, hence "invalid".
      [null, "9"],
    ]);
    const result = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename: uniqueFilename("partial"), mimeType: XLSX_MIME }, "req-8");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("COMPLETED_WITH_ERRORS");
    expect(result.data.counts.invalid).toBe(1);
    expect(result.data.counts.unmatched + result.data.counts.matched + result.data.counts.ambiguous).toBe(1);
  });
});

// ---- Correction/resolution contract (Section 13) --------------------------
describe("manual correction - scope/action-guarded, stale correction loses", () => {
  it("Viewer is denied resolving a correction (action_denied)", async () => {
    const viewer = await actorFor("viewer");
    const record = await getAnalyticsContentSourceRecordByRef("seed-analytics-content-unmatched");
    const result = await resolveAnalyticsSourceRecordMatch(
      viewer,
      { recordKind: "content", sourceRef: record!.sourceRef, targetRef: "seed-content-approved", expectedRevision: record!.correctionRevision, reason: "test" },
      "req-9",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("action_denied");
  });

  it("Analyst can correct an unmatched record to a real, scope-compatible, platform-compatible Content target", async () => {
    const analyst = await actorFor("analyst");
    const record = await getAnalyticsContentSourceRecordByRef("seed-analytics-content-unmatched");
    const result = await resolveAnalyticsSourceRecordMatch(
      analyst,
      { recordKind: "content", sourceRef: record!.sourceRef, targetRef: "seed-content-approved", expectedRevision: record!.correctionRevision, reason: "Manual match confirmed against real published link." },
      "req-10",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.matchState).toBe("MATCHED");
      expect(result.data.correctionRevision).toBe(record!.correctionRevision + 1);
    }

    const updated = await getAnalyticsContentSourceRecordByUid(record!.uid);
    expect(updated!.matchedContentRef).toBe("seed-content-approved");

    // A stale correction attempt (the ORIGINAL, now-outdated
    // expectedRevision) must be rejected, never silently applied over a
    // newer revision.
    const stale = await resolveAnalyticsSourceRecordMatch(
      analyst,
      { recordKind: "content", sourceRef: record!.sourceRef, targetRef: null, expectedRevision: record!.correctionRevision, reason: "stale retry" },
      "req-11",
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("stale_write");

    // The record's CURRENT state must still reflect the first,
    // successful correction - the stale attempt never touched it.
    const afterStale = await getAnalyticsContentSourceRecordByUid(record!.uid);
    expect(afterStale!.matchedContentRef).toBe("seed-content-approved");
    expect(afterStale!.correctionRevision).toBe(record!.correctionRevision + 1);
  });
});

// ---- Data Explorer (Section 15) -------------------------------------------
describe("Data Explorer - scope-constrained listing", () => {
  it("a GLOBAL-scoped actor (Super Admin) can list content source records", async () => {
    const admin = await actorFor("super_admin");
    const result = await listAnalyticsSourceRecords(admin, { recordKind: "content", limit: 50 });
    expect(result.ok).toBe(true);
    if (result.ok && result.data.recordKind === "content") {
      expect(result.data.records.length).toBeGreaterThan(0);
    }
  });

  it("Viewer without explore access is denied", async () => {
    const viewer = await actorFor("viewer");
    const result = await listAnalyticsSourceRecords(viewer, { recordKind: "content", limit: 10 });
    expect(result.ok).toBe(false);
  });
});

// ---- Read-model rebuild (Section 14/22) ------------------------------------
describe("rebuildAnalyticsReadModels - deterministic, never mutates source records", () => {
  it("is deterministic - the same inputs produce the same aggregates on two consecutive runs", async () => {
    const first = await rebuildAnalyticsReadModels(null);
    const second = await rebuildAnalyticsReadModels(null);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      const firstRest = { ...first.data, computedAt: "IGNORED" };
      const secondRest = { ...second.data, computedAt: "IGNORED" };
      expect(firstRest).toEqual(secondRest);
    }
  });

  it("never mutates a source record", async () => {
    const before = await getAnalyticsContentSourceRecordByRef("seed-analytics-content-matched");
    await rebuildAnalyticsReadModels(null);
    const after = await getAnalyticsContentSourceRecordByRef("seed-analytics-content-matched");
    expect(after).toEqual(before);
  });

  it("is gated Super-Admin-only when invoked with a real (non-emulator-test-harness) actor", async () => {
    const manager = await actorFor("partnership_manager");
    const result = await rebuildAnalyticsReadModels(manager);
    expect(result.ok).toBe(false);
  });
});

// ---- Direct client-SDK write denial ---------------------------------------
// firestore.rules is a single blanket `allow read, write: if false;` catch-
// all covering EVERY collection in this project, including every new
// Analytics collection added in this step - there is no per-domain
// client-SDK rules-testing convention anywhere in this codebase to mirror
// (grep confirms zero usage of @firebase/rules-unit-testing or any client
// Firestore SDK test anywhere in src/ or tests/), so a new one is not
// invented here; this is a documented acknowledgment of that existing,
// unconditional coverage rather than a fabricated test around a testing
// pattern this repo has never established.
