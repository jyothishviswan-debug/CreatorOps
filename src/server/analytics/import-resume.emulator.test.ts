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

  // Remediation-plan Wave B / finding #60 re-audit: the real root cause was that a commit failure's
  // error was fully discarded (a bare `catch {}`) - proving it's fixed means proving a SAFE reason
  // now actually reaches both the row's own detail and the batch's safeErrorSummary, never a raw
  // stack/Zod internal/Firestore path.
  it("a generic (non-schema) commit failure surfaces a safe, fixed system-error reason - never the raw injected error's own message", async () => {
    const analyst = await actorFor("analyst");
    const urlBad = `https://instagram.com/p/no-match-${runId}-safe-reason`;
    const identityKey = computeRowIdentityKey("campaign_content", "instagram", `url:${urlBad}`, null);
    setAnalyticsCommitFaultHookForTests((key) => key === identityKey);

    const buffer = workbookBuffer("Content", [
      ["Post URL", "Comments"],
      [urlBad, "3"],
    ]);
    const result = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename: uniqueFilename("safe-reason"), mimeType: XLSX_MIME }, "req-q-safe");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = result.data.rows?.find((r) => r.identityLabel === urlBad);
    expect(row?.classification).toBe("quarantined");
    // the fixed, safe classifySystemError() message - never the injected fault's own text
    expect(row?.commitFailureReason).toBe("Something went wrong processing this import. Try again, or contact support if it keeps happening.");
    expect(row?.commitFailureReason).not.toMatch(/Injected test fault/);
    expect(row?.commitFailureReason).not.toMatch(/setAnalyticsCommitFaultHookForTests/);
    // Wave B re-audit (found during real-browser verification): the real live Analytics UI reads
    // `row.detail`, not `row.commitFailureReason` directly - this is the one field it actually
    // renders, on the RAW response `/api/imports/execute` returns (never wrapped through
    // toGenericRows for the real analytics module path). Proving this exact field is non-null here
    // is what proves the fix is visible to a real user, not just present somewhere in the payload.
    expect(row?.detail).toBe(row?.commitFailureReason);
    // the same safe reason is also folded into the batch-level summary, not just the row detail
    expect(result.data.safeErrorSummary).toContain("Something went wrong processing this import. Try again, or contact support if it keeps happening.");
    // never a raw stack, a Firestore collection path, or the internal doc id
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toMatch(/at commitContentRow|at Object\.<anonymous>|node_modules/);
    expect(serialized).not.toMatch(/analyticsContentSourceRecords\//);
  });

  it("a genuine over-bound value that fails the STORED schema at commit time (never caught by dry-run) surfaces the specific, safe 'invalid shape' reason - not the generic system-error one", async () => {
    const analyst = await actorFor("analyst");
    const urlBad = `https://instagram.com/p/no-match-${runId}-oversized`;
    // Exceeds even the widened 4000-char rawMediaUrl bound (types.ts) - a real shape the STORED
    // schema rejects at commit, distinct from a generic/transient failure.
    const oversizedMediaUrl = `https://cdn.example.com/${"x".repeat(4100)}`;

    const buffer = workbookBuffer("Content", [
      ["Post URL", "Media URL", "Comments"],
      [urlBad, oversizedMediaUrl, "3"],
    ]);
    const result = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename: uniqueFilename("oversized"), mimeType: XLSX_MIME }, "req-q-oversized");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = result.data.rows?.find((r) => r.identityLabel === urlBad);
    expect(row?.classification).toBe("quarantined");
    expect(row?.commitFailureReason).toBe("This row's data didn't fit the record shape expected when saving (a value was likely too long or in an unexpected format). No record was written for this row.");
    // never the raw Zod issue text (e.g. "Too big: expected string to have <=4000 characters") or the offending value itself
    expect(row?.commitFailureReason).not.toMatch(/Too big|ZodError|expected string/i);
    expect(JSON.stringify(result.data)).not.toContain(oversizedMediaUrl);
    // same real-UI-visible field check as above
    expect(row?.detail).toBe(row?.commitFailureReason);
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
      // Finding #59: History's own detail fetch (not the resume response
      // itself) must carry the SAME persisted row-level detail, reflecting
      // the LATEST (post-resume) state - row A shows "unchanged" here too,
      // never a stale pre-resume "quarantined" snapshot.
      expect(detail.data.rowsTruncated).toBe(false);
      expect(detail.data.rows).not.toBeNull();
      const detailRowA = detail.data.rows?.find((r) => r.identityLabel === urlA);
      expect(detailRowA?.classification).toBe("unchanged");
      const detailRowB = detail.data.rows?.find((r) => r.identityLabel === urlB);
      expect(detailRowB?.classification).not.toBe("quarantined");
    }
  });

  // Finding #59: History previously showed only aggregate counts - a user
  // recovering a quarantined batch days later had no way to see WHICH
  // rows failed and why without re-uploading. Proves getAnalyticsImportBatchDetail
  // now carries the SAME per-row rows/detail the execute response itself carries.
  it("a fresh execute's row-level detail is independently fetchable from History afterward, matching the execute response", async () => {
    const analyst = await actorFor("analyst");
    const urlOk = `https://instagram.com/p/no-match-${runId}-history-ok`;
    const urlBad = `https://instagram.com/p/no-match-${runId}-history-bad`;
    const key = computeRowIdentityKey("campaign_content", "instagram", `url:${urlBad}`, null);
    setAnalyticsCommitFaultHookForTests((k) => k === key);

    const buffer = workbookBuffer("Content", [["Post URL"], [urlOk], [urlBad]]);
    const executed = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename: uniqueFilename("history-detail"), mimeType: XLSX_MIME }, "req-hist-1");
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    setAnalyticsCommitFaultHookForTests(null);

    const detail = await getAnalyticsImportBatchDetail(analyst, executed.data.batchRef!);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.rows).not.toBeNull();
    expect(detail.data.rows?.length).toBe(executed.data.rows?.length);
    const detailBad = detail.data.rows?.find((r) => r.identityLabel === urlBad);
    expect(detailBad?.classification).toBe("quarantined");
    expect(detailBad?.detail).toBe(executed.data.rows?.find((r) => r.identityLabel === urlBad)?.detail);
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

  // Finding #54: source-hash idempotency must never silently override the
  // caller's declared targetKind. Root cause was in import-service.ts's
  // executeAnalyticsImport - the byte-identical-replay shortcut returned
  // the ALREADY-COMPLETED batch's own data regardless of what targetKind
  // the new call declared, which would let a stale client (or a direct API
  // call) receive channel_account-labeled "success" that's actually the
  // old campaign_content batch's data, or vice versa.
  it("rejects an execute call whose targetKind mismatches an already-completed batch for the exact same file bytes", async () => {
    const analyst = await actorFor("analyst");
    const url = `https://instagram.com/p/no-match-${runId}-targetmismatch`;
    const buffer = workbookBuffer("Content", [["Post URL"], [url]]);
    const filename = uniqueFilename("target-mismatch");

    const first = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-tk1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.status).toBe("COMPLETED");
    expect(first.data.targetKind).toBe("campaign_content");

    const mismatched = await executeAnalyticsImport(
      analyst,
      { targetKind: "channel_account", channelPlatform: "instagram", fileBuffer: buffer, filename, mimeType: XLSX_MIME },
      "req-tk2",
    );
    expect(mismatched.ok).toBe(false);
    if (mismatched.ok) return;
    expect(mismatched.code).toBe("conflict");
    expect(mismatched.message).toMatch(/already imported as "campaign_content"/);

    // Re-requesting under the SAME targetKind as the original batch is
    // still a safe, genuine idempotent replay - the fix must not have
    // over-corrected into rejecting a real same-target replay too.
    const replay = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-tk3");
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.data.idempotentReplay).toBe(true);
    expect(replay.data.batchRef).toBe(first.data.batchRef);
  });

  // Finding #54 closure-audit follow-up: the test above only proves the
  // AFTER-completion mismatch guard (import-service.ts's `existingCompleted`
  // shortcut). The ledger separately claimed a concurrent-claim variant was
  // also tested - it wasn't. This exercises the OTHER guard, on the
  // claim-race loser path (`!claim.won` branch, `terminal.targetKind !==
  // input.targetKind`): two genuinely concurrent execute calls for the
  // exact same file bytes, racing under DIFFERENT targetKinds.
  it("concurrency: two simultaneous execute calls for the same file bytes under DIFFERENT targetKinds - the claim winner succeeds under its own targetKind, the loser is rejected as a concurrent mismatch, never silently joined", async () => {
    const analyst = await actorFor("analyst");
    const url = `https://instagram.com/p/no-match-${runId}-concurrent-targetmismatch`;
    const buffer = workbookBuffer("Content", [["Post URL"], [url]]);
    const filename = uniqueFilename("concurrent-target-mismatch");

    const [a, b] = await Promise.all([
      executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-ctk-a"),
      executeAnalyticsImport(analyst, { targetKind: "channel_account", channelPlatform: "instagram", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-ctk-b"),
    ]);

    // Exactly one of the two must win the claim and complete under its OWN
    // targetKind; the other must be rejected as a concurrent mismatch -
    // never both succeeding (which would mean the loser silently joined
    // the winner's batch under the wrong label), never both failing.
    const results = [
      { targetKind: "campaign_content" as const, result: a },
      { targetKind: "channel_account" as const, result: b },
    ];
    const winners = results.filter((r) => r.result.ok);
    const losers = results.filter((r) => !r.result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (!winners[0]!.result.ok) throw new Error("unreachable");
    expect(winners[0]!.result.data.targetKind).toBe(winners[0]!.targetKind);

    const loser = losers[0]!.result;
    if (loser.ok) throw new Error("unreachable");
    expect(loser.code).toBe("conflict");
    expect(loser.message).toMatch(/being imported concurrently as/);
    expect(loser.message).toContain(winners[0]!.targetKind);
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

// Finding #67: source-hash idempotency previously blocked every legitimate
// corrected/superseding import that happened to share bytes with something
// already on file, because the "already imported" shortcut matched on
// sourceHash ALONE - completely ignoring an explicit supersedesBatchRef.
// The real fix generalizes the idempotency IDENTITY from sourceHash alone
// to the compound (sourceHash, supersedesBatchRef) pair, both in the
// claim doc used for race-safety (claimOrJoinBatch) and in the
// already-completed lookup (executeAnalyticsImport). These prove each of
// the five scenarios named in the remediation plan behaves correctly.
describe("supersession & idempotency identity (finding #67)", () => {
  it("Scenario A: an exact-duplicate accidental replay (no supersedesBatchRef) is a safe no-op that returns the SAME batch, never a duplicate", async () => {
    const analyst = await actorFor("analyst");
    const url = `https://instagram.com/p/no-match-${runId}-scenario-a`;
    const buffer = workbookBuffer("Content", [["Post URL"], [url]]);
    const filename = uniqueFilename("scenario-a");

    const first = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-a1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-a2");
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.data.idempotentReplay).toBe(true);
    expect(replay.data.batchRef).toBe(first.data.batchRef);
  });

  it("Scenario C: an intentional corrected source (different bytes) supersedes the original and creates a genuinely new batch", async () => {
    const analyst = await actorFor("analyst");
    const url = `https://instagram.com/p/no-match-${runId}-scenario-c`;
    const original = await executeAnalyticsImport(
      analyst,
      { targetKind: "campaign_content", fileBuffer: workbookBuffer("Content", [["Post URL", "Comments"], [url, "1"]]), filename: uniqueFilename("scenario-c"), mimeType: XLSX_MIME },
      "req-c1",
    );
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    const corrected = await executeAnalyticsImport(
      analyst,
      {
        targetKind: "campaign_content",
        fileBuffer: workbookBuffer("Content", [["Post URL", "Comments"], [url, "5"]]),
        filename: uniqueFilename("scenario-c-corrected"),
        mimeType: XLSX_MIME,
        supersedesBatchRef: original.data.batchRef,
      },
      "req-c2",
    );
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.data.batchRef).not.toBe(original.data.batchRef);
    expect(corrected.data.idempotentReplay).toBe(false);
  });

  it("Scenario D: an intentional superseding import using the SAME bytes as the target creates a genuinely new batch, not a silent no-op replay of the original", async () => {
    const analyst = await actorFor("analyst");
    const url = `https://instagram.com/p/no-match-${runId}-scenario-d`;
    const buffer = workbookBuffer("Content", [["Post URL"], [url]]);
    const filename = uniqueFilename("scenario-d");

    const original = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-d1");
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    // Explicit re-assertion of the SAME bytes as a deliberate correction -
    // before the fix, source-hash idempotency alone would have silently
    // returned `original` again here, completely ignoring
    // supersedesBatchRef.
    const superseding = await executeAnalyticsImport(
      analyst,
      { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME, supersedesBatchRef: original.data.batchRef },
      "req-d2",
    );
    expect(superseding.ok).toBe(true);
    if (!superseding.ok) return;
    expect(superseding.data.batchRef).not.toBe(original.data.batchRef);
    expect(superseding.data.idempotentReplay).toBe(false);
  });

  it("Scenario E: a replay of the exact same superseding request (same bytes, same supersedesBatchRef) is a safe idempotent no-op, never a second superseding batch", async () => {
    const analyst = await actorFor("analyst");
    const url = `https://instagram.com/p/no-match-${runId}-scenario-e`;
    const original = await executeAnalyticsImport(
      analyst,
      { targetKind: "campaign_content", fileBuffer: workbookBuffer("Content", [["Post URL"], [url]]), filename: uniqueFilename("scenario-e"), mimeType: XLSX_MIME },
      "req-e1",
    );
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    const supersedingBuffer = workbookBuffer("Content", [["Post URL", "Comments"], [url, "9"]]);
    const supersedingFilename = uniqueFilename("scenario-e-superseding");
    const superseding = await executeAnalyticsImport(
      analyst,
      { targetKind: "campaign_content", fileBuffer: supersedingBuffer, filename: supersedingFilename, mimeType: XLSX_MIME, supersedesBatchRef: original.data.batchRef },
      "req-e2",
    );
    expect(superseding.ok).toBe(true);
    if (!superseding.ok) return;

    const replay = await executeAnalyticsImport(
      analyst,
      { targetKind: "campaign_content", fileBuffer: supersedingBuffer, filename: supersedingFilename, mimeType: XLSX_MIME, supersedesBatchRef: original.data.batchRef },
      "req-e3",
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.data.idempotentReplay).toBe(true);
    expect(replay.data.batchRef).toBe(superseding.data.batchRef);
  });

  it("rejects a supersedesBatchRef that does not exist", async () => {
    const analyst = await actorFor("analyst");
    const buffer = workbookBuffer("Content", [["Post URL"], [`https://instagram.com/p/no-match-${runId}-bad-supersedes`]]);
    const result = await executeAnalyticsImport(
      analyst,
      { targetKind: "campaign_content", fileBuffer: buffer, filename: uniqueFilename("bad-supersedes"), mimeType: XLSX_MIME, supersedesBatchRef: "not-a-real-batch" },
      "req-bad-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("rejects a supersedesBatchRef that has already been superseded by a DIFFERENT correction (stale), but a REPLAY of that same successful correction is never rejected as stale", async () => {
    const analyst = await actorFor("analyst");
    const url = `https://instagram.com/p/no-match-${runId}-stale`;
    const original = await executeAnalyticsImport(
      analyst,
      { targetKind: "campaign_content", fileBuffer: workbookBuffer("Content", [["Post URL"], [url]]), filename: uniqueFilename("stale-original"), mimeType: XLSX_MIME },
      "req-stale-1",
    );
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    const firstCorrectionBuffer = workbookBuffer("Content", [["Post URL", "Comments"], [url, "2"]]);
    const firstCorrectionFilename = uniqueFilename("stale-fix-1");
    const firstCorrection = await executeAnalyticsImport(
      analyst,
      { targetKind: "campaign_content", fileBuffer: firstCorrectionBuffer, filename: firstCorrectionFilename, mimeType: XLSX_MIME, supersedesBatchRef: original.data.batchRef },
      "req-stale-2",
    );
    expect(firstCorrection.ok).toBe(true);
    if (!firstCorrection.ok) return;

    // A SECOND, DIFFERENT attempt to supersede the SAME (now-superseded)
    // original is genuinely stale.
    const secondCorrection = await executeAnalyticsImport(
      analyst,
      {
        targetKind: "campaign_content",
        fileBuffer: workbookBuffer("Content", [["Post URL", "Comments"], [url, "3"]]),
        filename: uniqueFilename("stale-fix-2"),
        mimeType: XLSX_MIME,
        supersedesBatchRef: original.data.batchRef,
      },
      "req-stale-3",
    );
    expect(secondCorrection.ok).toBe(false);
    if (secondCorrection.ok) return;
    expect(secondCorrection.code).toBe("conflict");
    expect(secondCorrection.message).toMatch(/stale/);

    // But replaying the FIRST (already-successful) correction's exact
    // request again must still work - it is not "stale", it is the same
    // request that already won.
    const replayFirstCorrection = await executeAnalyticsImport(
      analyst,
      { targetKind: "campaign_content", fileBuffer: firstCorrectionBuffer, filename: firstCorrectionFilename, mimeType: XLSX_MIME, supersedesBatchRef: original.data.batchRef },
      "req-stale-4",
    );
    expect(replayFirstCorrection.ok).toBe(true);
    if (!replayFirstCorrection.ok) return;
    expect(replayFirstCorrection.data.idempotentReplay).toBe(true);
    expect(replayFirstCorrection.data.batchRef).toBe(firstCorrection.data.batchRef);
  });

  it("concurrency: simultaneous identical superseding requests race safely onto ONE batch, never two", async () => {
    const analyst = await actorFor("analyst");
    const url = `https://instagram.com/p/no-match-${runId}-concurrent-supersede`;
    const original = await executeAnalyticsImport(
      analyst,
      { targetKind: "campaign_content", fileBuffer: workbookBuffer("Content", [["Post URL"], [url]]), filename: uniqueFilename("concurrent-original"), mimeType: XLSX_MIME },
      "req-cc-1",
    );
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    const supersedingBuffer = workbookBuffer("Content", [["Post URL", "Comments"], [url, "7"]]);
    const supersedingFilename = uniqueFilename("concurrent-superseding");
    const [a, b] = await Promise.all([
      executeAnalyticsImport(
        analyst,
        { targetKind: "campaign_content", fileBuffer: supersedingBuffer, filename: supersedingFilename, mimeType: XLSX_MIME, supersedesBatchRef: original.data.batchRef },
        "req-cc-2a",
      ),
      executeAnalyticsImport(
        analyst,
        { targetKind: "campaign_content", fileBuffer: supersedingBuffer, filename: supersedingFilename, mimeType: XLSX_MIME, supersedesBatchRef: original.data.batchRef },
        "req-cc-2b",
      ),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data.batchRef).toBe(b.data.batchRef);
  });

  it("simultaneous exact-duplicate (non-superseding) imports of the same bytes also race safely onto ONE batch", async () => {
    const analyst = await actorFor("analyst");
    const url = `https://instagram.com/p/no-match-${runId}-concurrent-plain`;
    const buffer = workbookBuffer("Content", [["Post URL"], [url]]);
    const filename = uniqueFilename("concurrent-plain");

    const [a, b] = await Promise.all([
      executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-cp-a"),
      executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename, mimeType: XLSX_MIME }, "req-cp-b"),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data.batchRef).toBe(b.data.batchRef);
  });
});
