import type { ActorContext } from "@/server/authz/types";

import { createReportSnapshotDoc, getReportSnapshotDoc, listReportSnapshotDocsByActor } from "./firestore";
import { generateSnapshotRef } from "./ids";
import { runReport } from "./report-service";
import { DEFAULT_SNAPSHOT_LIST_PAGE_SIZE, MAX_SNAPSHOT_LIST_PAGE_SIZE, finalizeReportInputSchema, reportsInvalidInputResult, reportsNotFoundResult, reportsUnauthorizedResult, snapshotRefSchema, type FinalizeReportInput, type ReportSnapshotDoc, type ReportsServiceResult } from "./types";

// Step 19A section 15: the smallest immutable finalized-snapshot model the spec requires. A live run
// (report-service.ts's runReport) is always ephemeral - nothing about it is persisted unless the
// actor explicitly finalizes it here. A finalized snapshot then pins the exact definition version,
// the full safe result, and safe audit metadata (actor/report id+version/time/filters/output id/
// outcome - section 21), and is never rewritten or deleted once written (firestore.ts only exposes a
// create).
export async function finalizeReport(actor: ActorContext | null, rawInput: unknown): Promise<ReportsServiceResult<ReportSnapshotDoc>> {
  const parsed = finalizeReportInputSchema.safeParse(rawInput);
  if (!parsed.success) return reportsInvalidInputResult("Invalid finalize request.");
  const input: FinalizeReportInput = parsed.data;

  // The full (non-viewer-safe) run - finalizing requires exactly the same run_reports
  // ActionPermission as a regular run; see report-service.ts's runReport.
  const runResult = await runReport(actor, input.reportId, input.filters, {});
  if (!runResult.ok) return runResult;
  if (!actor) return reportsUnauthorizedResult("not_authenticated");

  const result = runResult.data;
  const snapshotRef = generateSnapshotRef();
  const doc: ReportSnapshotDoc = {
    snapshotRef,
    reportId: result.reportId,
    definitionVersion: result.definitionVersion,
    generatedAt: result.generatedAt,
    evidenceCutoff: result.evidenceCutoff,
    appliedFilters: result.appliedFilters,
    scopeSummary: result.scopeSummary,
    provenance: result.provenance,
    limitations: result.limitations,
    truncated: result.truncated,
    rowCount: result.rowCount,
    maxRows: result.maxRows,
    result: { metrics: result.metrics, rows: result.rows, sections: result.sections },
    createdAt: new Date().toISOString(),
    createdByUserRef: actor.userRef,
  };
  await createReportSnapshotDoc(doc);
  return { ok: true, data: doc };
}

export async function getFinalizedSnapshot(actor: ActorContext | null, rawSnapshotRef: unknown): Promise<ReportsServiceResult<ReportSnapshotDoc>> {
  if (!actor) return reportsUnauthorizedResult("not_authenticated");
  const parsedRef = snapshotRefSchema.safeParse(rawSnapshotRef);
  if (!parsedRef.success) return reportsNotFoundResult();

  const doc = await getReportSnapshotDoc(parsedRef.data);
  if (!doc) return reportsNotFoundResult();
  // A snapshot is visible only to the actor who finalized it - Reports owns no broader record-scope
  // model of its own for a snapshot (section 3: Reports owns no canonical business truth), so this
  // stays the narrowest possible rule rather than inventing one. A snapshot belonging to another
  // actor is indistinguishable from a non-existent one (neutral not_found, same discipline as every
  // other module's own scope-denied response).
  if (doc.createdByUserRef !== actor.userRef) return reportsNotFoundResult();
  return { ok: true, data: doc };
}

export async function listMyFinalizedSnapshots(actor: ActorContext | null, rawLimit: unknown): Promise<ReportsServiceResult<ReportSnapshotDoc[]>> {
  if (!actor) return reportsUnauthorizedResult("not_authenticated");
  let limit = DEFAULT_SNAPSHOT_LIST_PAGE_SIZE;
  if (rawLimit !== undefined) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SNAPSHOT_LIST_PAGE_SIZE) return reportsInvalidInputResult(`limit must be an integer between 1 and ${MAX_SNAPSHOT_LIST_PAGE_SIZE}.`);
    limit = n;
  }
  const docs = await listReportSnapshotDocsByActor(actor.userRef, limit);
  return { ok: true, data: docs };
}
