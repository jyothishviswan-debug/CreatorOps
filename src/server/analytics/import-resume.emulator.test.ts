// Import Center Completion (spec section 9): real Firestore-emulator
// proof of quarantine + resume - a per-row COMMIT failure (never a
// validation failure) is classified "quarantined", the batch is
// COMPLETED_WITH_ERRORS, and resumeAnalyticsImportBatch retries ONLY the
// quarantined row(s) under the SAME batchRef, without duplicating any row
// already committed. Same fixture idiom as analytics.emulator.test.ts.
import * as XLSX from "xlsx";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth } from "@/server/firebase/admin";
import { seedContentData } from "@/server/content/seed-content-data";
import { seedCampaignsData } from "@/server/campaigns/seed-campaigns-data";
import { seedAssignmentsData } from "@/server/assignments/seed-assignments-data";
import { seedDiscoveryData } from "@/server/discovery/seed-discovery-data";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { seedVendorsData } from "@/server/vendors/seed-vendors-data";

import { getAnalyticsImportBatchDetail } from "./import-history-service";
import { computeRowIdentityKey } from "./import-pipeline";
import { executeAnalyticsImport, resumeAnalyticsImportBatch, setAnalyticsCommitFaultHookForTests } from "./import-service";
import { seedAnalyticsData } from "./seed-analytics-data";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
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

afterEach(() => {
  setAnalyticsCommitFaultHookForTests(null);
});

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

function uniqueFilename(tag: string): string {
  return `import-resume-${tag}-${runId}-${Math.random().toString(36).slice(2)}.xlsx`;
}

describe("quarantine + resume (Import Center Completion, spec section 9)", () => {
  it("a per-row commit failure quarantines the row and marks the batch COMPLETED_WITH_ERRORS - never a raw crash, never a phantom success", async () => {
    const analyst = await actorFor("analyst");
    const urlOk = `https://instagram.com/p/no-match-${runId}-a-ok`;
    const urlBad = `https://instagram.com/p/no-match-${runId}-a-bad`;
    const identityKey = computeRowIdentityKey("campaign_content", "instagram", `url:${urlBad}`, null);

    setAnalyticsCommitFaultHookForTests((key) => key === identityKey);

    const buffer = workbookBuffer("Content", [
      ["Post URL", "Comments"],
      [urlOk, "1"],
      [urlBad, "3"],
    ]);
    const filename = uniqueFilename("quarantine");
    const result = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-q1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.status).toBe("COMPLETED_WITH_ERRORS");
    expect(result.data.quarantinedRows).toBe(1);
    expect(result.data.counts.quarantined).toBe(1);
    expect(result.data.rows?.find((r) => r.identityLabel === urlBad)?.classification).toBe("quarantined");
    expect(result.data.rows?.find((r) => r.identityLabel === urlOk)?.classification).toBe("unmatched");
    expect(result.data.attempts).toBe(1);
  });

  it("a batch where EVERY row quarantines is classified FAILED, but is still resumable (at least one quarantined row is what matters, not the batch-level label)", async () => {
    const analyst = await actorFor("analyst");
    const url = `https://instagram.com/p/no-match-${runId}-allbad`;
    const key = computeRowIdentityKey("campaign_content", "instagram", `url:${url}`, null);
    setAnalyticsCommitFaultHookForTests((k) => k === key);

    const buffer = workbookBuffer("Content", [["Post URL"], [url]]);
    const filename = uniqueFilename("all-quarantined");
    const created = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-af1");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.status).toBe("FAILED");
    expect(created.data.quarantinedRows).toBe(1);

    setAnalyticsCommitFaultHookForTests(null);
    const resumed = await resumeAnalyticsImportBatch(analyst, { batchRef: created.data.batchRef!, fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-af2");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.data.status).toBe("COMPLETED");
    expect(resumed.data.quarantinedRows).toBe(0);
  });

  it("resume retries only the quarantined row, under the SAME batchRef, and does not duplicate an already-committed row", async () => {
    const analyst = await actorFor("analyst");
    const urlA = `https://instagram.com/p/no-match-${runId}-b1`;
    const urlB = `https://instagram.com/p/no-match-${runId}-b2`;
    const keyB = computeRowIdentityKey("campaign_content", "instagram", `url:${urlB}`, null);

    setAnalyticsCommitFaultHookForTests((key) => key === keyB);

    const buffer = workbookBuffer("Content", [
      ["Post URL", "Comments"],
      [urlA, "1"],
      [urlB, "2"],
    ]);
    const filename = uniqueFilename("resume");
    const first = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-r1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.status).toBe("COMPLETED_WITH_ERRORS");
    expect(first.data.quarantinedRows).toBe(1);
    const batchRef = first.data.batchRef!;

    // Clear the fault - the row commits for real on resume.
    setAnalyticsCommitFaultHookForTests(null);
    const resumed = await resumeAnalyticsImportBatch(analyst, { batchRef, fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-r2");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;

    expect(resumed.data.batchRef).toBe(batchRef); // SAME batch identity retained
    expect(resumed.data.quarantinedRows).toBe(0);
    expect(resumed.data.status).toBe("COMPLETED");
    expect(resumed.data.attempts).toBe(2);
    expect(resumed.data.attemptHistory).toHaveLength(2);
    expect(resumed.data.attemptHistory[0]!.kind).toBe("EXECUTE");
    expect(resumed.data.attemptHistory[1]!.kind).toBe("RESUME");

    // Row A (already committed on attempt 1) is recognized as "unchanged"
    // on resume, not re-created/duplicated.
    const rowA = resumed.data.rows?.find((r) => r.identityLabel === urlA);
    expect(rowA?.classification).toBe("unchanged");

    const detail = await getAnalyticsImportBatchDetail(analyst, batchRef);
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.data.attempts).toBe(2);
      expect(detail.data.quarantinedRows).toBe(0);
    }
  });

  it("resume rejects a file that does not match the original batch's source hash", async () => {
    const analyst = await actorFor("analyst");
    const url = `https://instagram.com/p/no-match-${runId}-c`;
    const keyC = computeRowIdentityKey("campaign_content", "instagram", `url:${url}`, null);
    setAnalyticsCommitFaultHookForTests((key) => key === keyC);

    const buffer = workbookBuffer("Content", [["Post URL"], [url]]);
    const filename = uniqueFilename("mismatch");
    const first = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-m1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    setAnalyticsCommitFaultHookForTests(null);
    const differentBuffer = workbookBuffer("Content", [["Post URL"], [`https://instagram.com/p/totally-different-${runId}`]]);
    const resumed = await resumeAnalyticsImportBatch(analyst, { batchRef: first.data.batchRef!, fileBuffer: differentBuffer, filename, mimeType: XLSX_MIME }, "req-m2");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.code).toBe("invalid_input");
  });

  it("resume refuses a batch that has no quarantined rows (nothing to resume)", async () => {
    const analyst = await actorFor("analyst");
    const url = `https://instagram.com/p/no-match-${runId}-d`;
    const buffer = workbookBuffer("Content", [["Post URL"], [url]]);
    const filename = uniqueFilename("clean");
    const clean = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-c1");
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    expect(clean.data.status).toBe("COMPLETED");

    const resumed = await resumeAnalyticsImportBatch(analyst, { batchRef: clean.data.batchRef!, fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-c2");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.code).toBe("invalid_input");
  });

  it("resume re-authorizes: an unauthorized actor cannot resume even a real quarantined batch", async () => {
    const analyst = await actorFor("analyst");
    const url = `https://instagram.com/p/no-match-${runId}-e`;
    const key = computeRowIdentityKey("campaign_content", "instagram", `url:${url}`, null);
    setAnalyticsCommitFaultHookForTests((k) => k === key);
    const buffer = workbookBuffer("Content", [["Post URL"], [url]]);
    const filename = uniqueFilename("denied");
    const created = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-d1");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    setAnalyticsCommitFaultHookForTests(null);

    const viewer = await actorFor("viewer");
    const resumed = await resumeAnalyticsImportBatch(viewer, { batchRef: created.data.batchRef!, fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-d2");
    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.code).toBe("unauthorized");
  });
});
