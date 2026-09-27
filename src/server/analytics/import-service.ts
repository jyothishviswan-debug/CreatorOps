import { randomUUID } from "node:crypto";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { classifyServiceErrorCode, classifySystemError } from "@/server/imports/error-taxonomy";
import { ImportAdapterError, registerImportTarget } from "@/server/imports/target-registry";

import { requireAnalyticsManageAccess, requireImportsModuleAccess } from "./analytics-gate";
import {
  analyticsChannelSourceRecordsCollection,
  analyticsContentSourceRecordsCollection,
  analyticsImportBatchClaimId,
  analyticsImportBatchClaimsCollection,
  analyticsImportBatchesCollection,
  analyticsRowIdentityDocId,
  findAnalyticsImportBatchSupersededBy,
  getAnalyticsImportBatchByRef,
  getAnalyticsImportBatchByUid,
  getCompletedAnalyticsImportBatchBySourceHash,
  sha256HexBuffer,
} from "./firestore";
import { AnalyticsImportRejectedError, runAnalyticsImportPipeline, summarizeRowOutcome, type AnalyticsImportPipelineInput, type PipelineRowOutcome } from "./import-pipeline";
import {
  ANALYTICS_ROW_CLASSIFICATIONS,
  ANALYTICS_TARGET_KINDS,
  analyticsChannelSourceRecordDocSchema,
  analyticsContentSourceRecordDocSchema,
  analyticsImportBatchClaimDocSchema,
  analyticsImportBatchDocSchema,
  analyticsInvalidInputResult,
  analyticsNotFoundResult,
  analyticsUnauthorizedResult,
  analyticsConflictResult,
  type AnalyticsBatchStatus,
  type AnalyticsChannelSourceRecordDoc,
  type AnalyticsContentSourceRecordDoc,
  type AnalyticsImportAttempt,
  type AnalyticsImportBatchDoc,
  type AnalyticsImportRowSummaryDto,
  type AnalyticsReportingPeriod,
  type AnalyticsRowClassification,
  type AnalyticsServiceResult,
  type AnalyticsSheetInventoryEntry,
  type AnalyticsTargetKind,
} from "./types";

// Import Center Completion (spec section 3/5): row-level detail sent to
// the browser for the File/Sheet Preview and Review steps is always
// bounded - never the full row set, even though the pipeline itself
// processes every row server-side.
const MAX_ROW_DETAIL_ROWS = 500;

// Step 12A section 7-10: dryRunAnalyticsImport / executeAnalyticsImport -
// both call the exact same runAnalyticsImportPipeline function
// (import-pipeline.ts). Dry-run performs every pipeline step, including
// matching, but never writes anything - not the batch header, not a
// claim, not a single source record. "DRY_RUN_ONLY" is a valid,
// type-level batch status (analyticsBatchStatusSchema) kept for forward-
// compatibility (a future feature that persists an inspectable dry-run
// preview), but this implementation never produces it - dry-run
// deliberately creates zero documents at all, matching the task's own
// explicit "assert the collections are genuinely untouched" requirement.
// Same honest, documented-unreachable treatment as the "ready" row
// classification and Content-AMBIGUOUS matching outcome elsewhere in
// this domain.

export type AnalyticsImportRawInput = {
  targetKind: unknown;
  fileBuffer: Buffer;
  filename: unknown;
  mimeType: unknown;
  reportingPeriod?: AnalyticsReportingPeriod | null;
  channelPlatform?: string | null;
  supersedesBatchRef?: string | null;
};

export type AnalyticsImportResultDto = {
  batchRef: string | null;
  targetKind: AnalyticsTargetKind;
  totalRows: number;
  counts: Record<AnalyticsRowClassification, number>;
  sourceSheetInventory: AnalyticsSheetInventoryEntry[];
  safeErrorSummary: string[];
  status: AnalyticsBatchStatus | null;
  idempotentReplay: boolean;
  // Import Center Completion (spec section 5/9/10): bounded row-level
  // detail for Review (dry-run) and Results (execute), plus resume/
  // quarantine provenance.
  rows: AnalyticsImportRowSummaryDto[];
  rowsTruncated: boolean;
  quarantinedRows: number;
  attempts: number;
  attemptHistory: AnalyticsImportAttempt[];
};

function validateInput(rawInput: AnalyticsImportRawInput): AnalyticsServiceResult<AnalyticsImportPipelineInput> {
  if (typeof rawInput.targetKind !== "string" || !(ANALYTICS_TARGET_KINDS as readonly string[]).includes(rawInput.targetKind)) {
    return analyticsInvalidInputResult('targetKind must be "campaign_content" or "channel_account".');
  }
  if (!Buffer.isBuffer(rawInput.fileBuffer)) return analyticsInvalidInputResult("Missing file.");
  if (typeof rawInput.filename !== "string" || rawInput.filename.length === 0) return analyticsInvalidInputResult("Missing filename.");
  if (typeof rawInput.mimeType !== "string" || rawInput.mimeType.length === 0) return analyticsInvalidInputResult("Missing MIME type.");

  const targetKind = rawInput.targetKind as AnalyticsTargetKind;
  if (targetKind === "channel_account" && !rawInput.channelPlatform) {
    return analyticsInvalidInputResult("channelPlatform is required for a channel_account import.");
  }

  return {
    ok: true,
    data: {
      targetKind,
      fileBuffer: rawInput.fileBuffer,
      filename: rawInput.filename,
      mimeType: rawInput.mimeType,
      reportingPeriod: rawInput.reportingPeriod ?? null,
      channelPlatform: rawInput.channelPlatform ?? null,
    },
  };
}

async function readOnlyExistingRowLookup(targetKind: AnalyticsTargetKind, rowIdentityKeyRaw: string): Promise<{ exists: true; batchRef: string } | { exists: false }> {
  const docId = analyticsRowIdentityDocId(rowIdentityKeyRaw);
  const collection = targetKind === "campaign_content" ? analyticsContentSourceRecordsCollection() : analyticsChannelSourceRecordsCollection();
  const snap = await collection.doc(docId).get();
  if (!snap.exists) return { exists: false };
  const data = snap.data() as { batchRef?: string } | undefined;
  return data?.batchRef ? { exists: true, batchRef: data.batchRef } : { exists: false };
}

function foldCounts(counts: Record<AnalyticsRowClassification, number>) {
  const matchedRows = counts.matched + counts.warning + counts.ready;
  const unmatchedRows = counts.unmatched;
  const ambiguousRows = counts.ambiguous;
  const invalidRows = counts.invalid + counts.missing_dependency;
  const duplicateUnchangedRows = counts.duplicate + counts.unchanged;
  return { matchedRows, unmatchedRows, ambiguousRows, invalidRows, duplicateUnchangedRows };
}

// ---- Dry run --------------------------------------------------------------

export async function dryRunAnalyticsImport(actor: ActorContext | null, rawInput: AnalyticsImportRawInput, requestId: string): Promise<AnalyticsServiceResult<AnalyticsImportResultDto>> {
  void requestId; // dry-run performs no mutation and writes no audit event - kept for signature parity with executeAnalyticsImport
  const moduleGate = await requireImportsModuleAccess(actor);
  if (!moduleGate.ok) return analyticsUnauthorizedResult(moduleGate.reason);
  const targetGate = await requireAnalyticsManageAccess(actor);
  if (!targetGate.ok) return analyticsUnauthorizedResult(targetGate.reason);

  const validated = validateInput(rawInput);
  if (!validated.ok) return validated;

  try {
    const sourceHash = sha256HexBuffer(validated.data.fileBuffer);
    const existingBatch = await getCompletedAnalyticsImportBatchBySourceHash(sourceHash);
    const previewBatchRef = existingBatch?.batchRef ?? `dry-run-preview:${randomUUID()}`;

    const result = await runAnalyticsImportPipeline(validated.data, (key) => readOnlyExistingRowLookup(validated.data.targetKind, key), previewBatchRef);

    return {
      ok: true,
      data: {
        batchRef: null,
        targetKind: validated.data.targetKind,
        totalRows: result.totalRows,
        counts: result.counts,
        sourceSheetInventory: result.sourceSheetInventory,
        safeErrorSummary: result.safeErrorSummary,
        status: null,
        idempotentReplay: false,
        rows: result.rows.slice(0, MAX_ROW_DETAIL_ROWS).map(summarizeRowOutcome),
        rowsTruncated: result.rows.length > MAX_ROW_DETAIL_ROWS,
        quarantinedRows: 0,
        attempts: 0,
        attemptHistory: [],
      },
    };
  } catch (error) {
    if (error instanceof AnalyticsImportRejectedError) return analyticsInvalidInputResult(error.message);
    throw error;
  }
}

// ---- Execute ----------------------------------------------------------

type ClaimResult = { won: true; batchUid: string; batchRef: string } | { won: false; batchUid: string; batchRef: string };

async function claimOrJoinBatch(sourceHash: string, targetKind: AnalyticsTargetKind, filename: string, mimeType: string, extension: string, actorUserRef: string, supersedesBatchRef: string | null, reportingPeriod: AnalyticsReportingPeriod | null): Promise<ClaimResult> {
  const db = getAdminFirestore();
  const claimRef = analyticsImportBatchClaimsCollection().doc(analyticsImportBatchClaimId(sourceHash));

  return db.runTransaction<ClaimResult>(async (tx) => {
    const claimSnap = await tx.get(claimRef);
    if (claimSnap.exists) {
      const claim = analyticsImportBatchClaimDocSchema.safeParse(claimSnap.data());
      if (claim.success) return { won: false, batchUid: claim.data.batchUid, batchRef: claim.data.batchRef };
    }

    const now = new Date().toISOString();
    const batchUid = analyticsImportBatchesCollection().doc().id;
    const batchRef = randomUUID();

    const batchDoc: AnalyticsImportBatchDoc = analyticsImportBatchDocSchema.parse({
      uid: batchUid,
      batchRef,
      targetKind,
      sourceFilename: filename,
      sourceMimeType: mimeType,
      sourceExtension: extension,
      sourceHash,
      supersedesBatchRef,
      reportingPeriod,
      actorUserRef,
      createdAt: now,
      startedAt: now,
      completedAt: null,
      status: "PENDING",
      totalRows: 0,
      actionableRows: 0,
      matchedRows: 0,
      unmatchedRows: 0,
      ambiguousRows: 0,
      invalidRows: 0,
      duplicateUnchangedRows: 0,
      failedRows: 0,
      sourceSheetInventory: [],
      safeErrorSummary: [],
    });

    tx.set(analyticsImportBatchesCollection().doc(batchUid), batchDoc);
    tx.set(claimRef, analyticsImportBatchClaimDocSchema.parse({ sourceHash, batchUid, batchRef, claimedAt: now }));

    return { won: true, batchUid, batchRef };
  });
}

const TERMINAL_STATUSES = new Set(["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED"]);

async function waitForTerminalBatch(batchUid: string): Promise<AnalyticsImportBatchDoc | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const doc = await getAnalyticsImportBatchByUid(batchUid);
    if (doc && TERMINAL_STATUSES.has(doc.status)) return doc;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function batchToDto(doc: AnalyticsImportBatchDoc, idempotentReplay: boolean, rows: AnalyticsImportRowSummaryDto[] = []): AnalyticsImportResultDto {
  const counts = Object.fromEntries(ANALYTICS_ROW_CLASSIFICATIONS.map((c) => [c, 0])) as Record<AnalyticsRowClassification, number>;
  counts.matched = doc.matchedRows;
  counts.unmatched = doc.unmatchedRows;
  counts.ambiguous = doc.ambiguousRows;
  counts.invalid = doc.invalidRows;
  counts.duplicate = doc.duplicateUnchangedRows;
  counts.quarantined = doc.quarantinedRows;
  return {
    batchRef: doc.batchRef,
    targetKind: doc.targetKind,
    totalRows: doc.totalRows,
    counts,
    sourceSheetInventory: doc.sourceSheetInventory,
    safeErrorSummary: doc.safeErrorSummary,
    status: doc.status,
    idempotentReplay,
    rows: rows.slice(0, MAX_ROW_DETAIL_ROWS),
    rowsTruncated: rows.length > MAX_ROW_DETAIL_ROWS,
    quarantinedRows: doc.quarantinedRows,
    attempts: doc.attempts,
    attemptHistory: doc.attemptHistory,
  };
}

// Test-only fault seam (same idiom as onboarding-service.ts's
// setOnboardingFaultHookForTests): lets an emulator test deterministically
// force a per-row COMMIT failure (never a validation failure) so
// quarantine/resume behavior can be proven end-to-end without depending
// on a real, unreproducible Firestore transaction failure.
let commitFaultHook: ((rowIdentityKeyRaw: string) => boolean) | null = null;
export function setAnalyticsCommitFaultHookForTests(hook: ((rowIdentityKeyRaw: string) => boolean) | null): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) throw new Error("setAnalyticsCommitFaultHookForTests may only be called from a test run.");
  commitFaultHook = hook;
}

async function commitContentRow(row: PipelineRowOutcome, batchRef: string): Promise<{ classification: AnalyticsRowClassification; failed: boolean }> {
  if (!row.content || !row.rowIdentityKeyRaw) return { classification: row.classification, failed: false };
  if (row.classification === "duplicate" || row.classification === "unchanged") return { classification: row.classification, failed: false };

  const docId = analyticsRowIdentityDocId(row.rowIdentityKeyRaw);
  const db = getAdminFirestore();
  const docRef = analyticsContentSourceRecordsCollection().doc(docId);

  try {
    if (commitFaultHook?.(row.rowIdentityKeyRaw)) throw new Error("Injected test fault (setAnalyticsCommitFaultHookForTests).");
    const finalClassification = await db.runTransaction<AnalyticsRowClassification>(async (tx) => {
      const snap = await tx.get(docRef);
      if (snap.exists) {
        const existing = snap.data() as AnalyticsContentSourceRecordDoc;
        return existing.batchRef === batchRef ? "unchanged" : "duplicate";
      }
      const now = new Date().toISOString();
      const doc: AnalyticsContentSourceRecordDoc = analyticsContentSourceRecordDocSchema.parse({ ...row.content, uid: docId, sourceRef: randomUUID(), batchRef, createdAt: now, correctionRevision: 1 });
      tx.set(docRef, doc);
      return row.classification;
    });
    return { classification: finalClassification, failed: false };
  } catch {
    // Import Center Completion (spec section 9): a per-row COMMIT failure
    // (the row classified/validated fine; the write itself failed) is
    // "quarantined", not silently left at its prior classification - it
    // is now visibly retryable via resumeAnalyticsImportBatch.
    return { classification: "quarantined", failed: true };
  }
}

async function commitChannelRow(row: PipelineRowOutcome, batchRef: string): Promise<{ classification: AnalyticsRowClassification; failed: boolean }> {
  if (!row.channel || !row.rowIdentityKeyRaw) return { classification: row.classification, failed: false };
  if (row.classification === "duplicate" || row.classification === "unchanged") return { classification: row.classification, failed: false };

  const docId = analyticsRowIdentityDocId(row.rowIdentityKeyRaw);
  const db = getAdminFirestore();
  const docRef = analyticsChannelSourceRecordsCollection().doc(docId);

  try {
    if (commitFaultHook?.(row.rowIdentityKeyRaw)) throw new Error("Injected test fault (setAnalyticsCommitFaultHookForTests).");
    const finalClassification = await db.runTransaction<AnalyticsRowClassification>(async (tx) => {
      const snap = await tx.get(docRef);
      if (snap.exists) {
        const existing = snap.data() as AnalyticsChannelSourceRecordDoc;
        return existing.batchRef === batchRef ? "unchanged" : "duplicate";
      }
      const now = new Date().toISOString();
      const doc: AnalyticsChannelSourceRecordDoc = analyticsChannelSourceRecordDocSchema.parse({ ...row.channel, uid: docId, sourceRef: randomUUID(), batchRef, createdAt: now, correctionRevision: 1 });
      tx.set(docRef, doc);
      return row.classification;
    });
    return { classification: finalClassification, failed: false };
  } catch {
    return { classification: "quarantined", failed: true };
  }
}

export async function executeAnalyticsImport(actor: ActorContext | null, rawInput: AnalyticsImportRawInput, requestId: string): Promise<AnalyticsServiceResult<AnalyticsImportResultDto>> {
  void requestId; // no per-batch audit event yet - the batch header itself is the durable provenance record
  const moduleGate = await requireImportsModuleAccess(actor);
  if (!moduleGate.ok) return analyticsUnauthorizedResult(moduleGate.reason);
  const targetGate = await requireAnalyticsManageAccess(actor);
  if (!targetGate.ok) return analyticsUnauthorizedResult(targetGate.reason);

  const validated = validateInput(rawInput);
  if (!validated.ok) return validated;
  const input = validated.data;

  const supersedesBatchRef = rawInput.supersedesBatchRef ?? null;
  if (supersedesBatchRef) {
    const target = await getAnalyticsImportBatchByRef(supersedesBatchRef);
    if (!target) return analyticsInvalidInputResult(`supersedesBatchRef "${supersedesBatchRef}" does not exist.`);
    // Stale-correction guard - reject if some OTHER batch already
    // supersedes this exact target (i.e. `target` is no longer the
    // current latest revision in its own correction lineage).
    const alreadySuperseded = await findAnalyticsImportBatchSupersededBy(supersedesBatchRef);
    if (alreadySuperseded) {
      return analyticsConflictResult(`Batch "${supersedesBatchRef}" has already been superseded by a newer revision - this correction is stale.`);
    }
  }

  const sourceHash = sha256HexBuffer(input.fileBuffer);

  // Batch-level idempotency - an identical re-upload of the exact same
  // file content is a no-op that returns the already-committed result,
  // never a duplicate batch/rows.
  const existingCompleted = await getCompletedAnalyticsImportBatchBySourceHash(sourceHash);
  if (existingCompleted) return { ok: true, data: batchToDto(existingCompleted, true) };

  const extension = input.filename.slice(input.filename.lastIndexOf(".") + 1).toLowerCase();

  let claim: ClaimResult;
  try {
    claim = await claimOrJoinBatch(sourceHash, input.targetKind, input.filename, input.mimeType, extension, actor!.userRef, supersedesBatchRef, input.reportingPeriod ?? null);
  } catch {
    return { ok: false, code: "internal", message: "Failed to claim an import batch." };
  }

  if (!claim.won) {
    // A concurrent/replayed execute call for the exact same file content
    // already won the race - wait for it to finish and return ITS
    // result, rather than creating a second batch/duplicating rows.
    const terminal = await waitForTerminalBatch(claim.batchUid);
    if (!terminal) return analyticsConflictResult("An import for this exact file is already in progress. Try again shortly.");
    return { ok: true, data: batchToDto(terminal, true) };
  }

  const initialBatch = await getAnalyticsImportBatchByUid(claim.batchUid);
  const createdAt = initialBatch?.createdAt ?? new Date().toISOString();
  const startedAt = initialBatch?.startedAt ?? createdAt;

  try {
    const result = await runAnalyticsImportPipeline(input, (key) => readOnlyExistingRowLookup(input.targetKind, key), claim.batchRef);

    let failedRows = 0;
    for (const row of result.rows) {
      if (row.recordKind === "content") {
        const outcome = await commitContentRow(row, claim.batchRef);
        row.classification = outcome.classification;
        if (outcome.failed) failedRows += 1;
      } else if (row.recordKind === "channel") {
        const outcome = await commitChannelRow(row, claim.batchRef);
        row.classification = outcome.classification;
        if (outcome.failed) failedRows += 1;
      }
    }

    const finalCounts = Object.fromEntries(ANALYTICS_ROW_CLASSIFICATIONS.map((c) => [c, 0])) as Record<AnalyticsRowClassification, number>;
    for (const row of result.rows) finalCounts[row.classification] += 1;
    const quarantinedRows = finalCounts.quarantined;

    const folded = foldCounts(finalCounts);
    const successCount = result.totalRows - folded.invalidRows - failedRows;
    const status: AnalyticsBatchStatus = result.totalRows === 0 || successCount === result.totalRows ? "COMPLETED" : successCount <= 0 ? "FAILED" : "COMPLETED_WITH_ERRORS";

    const now = new Date().toISOString();
    const finalBatchDoc: AnalyticsImportBatchDoc = analyticsImportBatchDocSchema.parse({
      uid: claim.batchUid,
      batchRef: claim.batchRef,
      targetKind: input.targetKind,
      sourceFilename: input.filename,
      sourceMimeType: input.mimeType,
      sourceExtension: extension,
      sourceHash,
      supersedesBatchRef,
      reportingPeriod: input.reportingPeriod ?? null,
      actorUserRef: actor!.userRef,
      createdAt,
      startedAt,
      completedAt: now,
      status,
      totalRows: result.totalRows,
      actionableRows: result.totalRows - folded.invalidRows,
      matchedRows: folded.matchedRows,
      unmatchedRows: folded.unmatchedRows,
      ambiguousRows: folded.ambiguousRows,
      invalidRows: folded.invalidRows,
      duplicateUnchangedRows: folded.duplicateUnchangedRows,
      failedRows,
      quarantinedRows,
      attempts: 1,
      attemptHistory: [{ attemptNumber: 1, kind: "EXECUTE", at: now, status, totalRows: result.totalRows, quarantinedRows }],
      sourceSheetInventory: result.sourceSheetInventory,
      safeErrorSummary: result.safeErrorSummary,
    });
    await analyticsImportBatchesCollection().doc(claim.batchUid).set(finalBatchDoc);

    return { ok: true, data: { ...batchToDto(finalBatchDoc, false, result.rows.map(summarizeRowOutcome)), counts: finalCounts } };
  } catch (error) {
    const now = new Date().toISOString();
    const message = error instanceof AnalyticsImportRejectedError ? error.message : "The import could not be processed.";
    const failedDoc: AnalyticsImportBatchDoc = analyticsImportBatchDocSchema.parse({
      uid: claim.batchUid,
      batchRef: claim.batchRef,
      targetKind: input.targetKind,
      sourceFilename: input.filename,
      sourceMimeType: input.mimeType,
      sourceExtension: extension,
      sourceHash,
      supersedesBatchRef,
      reportingPeriod: input.reportingPeriod ?? null,
      actorUserRef: actor!.userRef,
      createdAt,
      startedAt,
      completedAt: now,
      status: "FAILED",
      totalRows: 0,
      actionableRows: 0,
      matchedRows: 0,
      unmatchedRows: 0,
      ambiguousRows: 0,
      invalidRows: 0,
      duplicateUnchangedRows: 0,
      failedRows: 0,
      sourceSheetInventory: [],
      safeErrorSummary: [message],
    });
    await analyticsImportBatchesCollection().doc(claim.batchUid).set(failedDoc);
    if (error instanceof AnalyticsImportRejectedError) return { ok: true, data: batchToDto(failedDoc, false) };
    throw error;
  }
}

// ---- Resume (Import Center Completion, spec section 9) --------------------
// Retries ONLY the rows that were quarantined by a prior execute/resume
// attempt against this exact batch - never a new batch, never a
// duplicated row. The actor re-uploads the EXACT same source file (the
// sourceHash must match the original batch's) so the pipeline can
// deterministically recompute the exact same rows; rows already
// committed under this batchRef are recognized as "unchanged" by the
// SAME checkExistingRow lookup execute always uses (their commit is then
// skipped, exactly as in a normal execute), so resume can safely reuse
// runAnalyticsImportPipeline / commitContentRow / commitChannelRow
// unchanged - there is no second, resume-specific commit path.
export type AnalyticsResumeRawInput = {
  batchRef: unknown;
  fileBuffer: Buffer;
  filename: unknown;
  mimeType: unknown;
  channelPlatform?: string | null;
};

export async function resumeAnalyticsImportBatch(actor: ActorContext | null, rawInput: AnalyticsResumeRawInput, requestId: string): Promise<AnalyticsServiceResult<AnalyticsImportResultDto>> {
  void requestId;
  const moduleGate = await requireImportsModuleAccess(actor);
  if (!moduleGate.ok) return analyticsUnauthorizedResult(moduleGate.reason);
  const targetGate = await requireAnalyticsManageAccess(actor);
  if (!targetGate.ok) return analyticsUnauthorizedResult(targetGate.reason);

  if (typeof rawInput.batchRef !== "string" || rawInput.batchRef.length === 0) return analyticsInvalidInputResult("Missing batchRef to resume.");
  if (!Buffer.isBuffer(rawInput.fileBuffer)) return analyticsInvalidInputResult("Missing file.");
  if (typeof rawInput.filename !== "string" || rawInput.filename.length === 0) return analyticsInvalidInputResult("Missing filename.");
  if (typeof rawInput.mimeType !== "string" || rawInput.mimeType.length === 0) return analyticsInvalidInputResult("Missing MIME type.");

  const original = await getAnalyticsImportBatchByRef(rawInput.batchRef);
  if (!original) return analyticsNotFoundResult("Import batch not found.");
  // A batch with EVERY row quarantined is classified FAILED (zero rows
  // succeeded), not COMPLETED_WITH_ERRORS - both are resumable as long as
  // there is at least one quarantined row; only a batch with none
  // (nothing to retry) or a still-running batch is refused.
  if ((original.status !== "COMPLETED_WITH_ERRORS" && original.status !== "FAILED") || original.quarantinedRows <= 0) {
    return analyticsInvalidInputResult("This batch has no quarantined rows to resume - only a COMPLETED_WITH_ERRORS or FAILED batch with at least one quarantined row can be resumed.");
  }

  const sourceHash = sha256HexBuffer(rawInput.fileBuffer);
  if (sourceHash !== original.sourceHash) {
    return analyticsInvalidInputResult("The file you uploaded does not match the original import's file - resume requires re-uploading the exact same source file.");
  }
  if (original.targetKind === "channel_account" && !rawInput.channelPlatform) {
    return analyticsInvalidInputResult("channelPlatform is required to resume a channel_account import.");
  }

  const input: AnalyticsImportPipelineInput = {
    targetKind: original.targetKind,
    fileBuffer: rawInput.fileBuffer,
    filename: rawInput.filename,
    mimeType: rawInput.mimeType,
    reportingPeriod: original.reportingPeriod,
    channelPlatform: rawInput.channelPlatform ?? null,
  };

  let result;
  try {
    result = await runAnalyticsImportPipeline(input, (key) => readOnlyExistingRowLookup(original.targetKind, key), original.batchRef);
  } catch (error) {
    if (error instanceof AnalyticsImportRejectedError) return analyticsInvalidInputResult(error.message);
    throw error;
  }

  let failedRows = 0;
  for (const row of result.rows) {
    if (row.recordKind === "content") {
      const outcome = await commitContentRow(row, original.batchRef);
      row.classification = outcome.classification;
      if (outcome.failed) failedRows += 1;
    } else if (row.recordKind === "channel") {
      const outcome = await commitChannelRow(row, original.batchRef);
      row.classification = outcome.classification;
      if (outcome.failed) failedRows += 1;
    }
  }

  const finalCounts = Object.fromEntries(ANALYTICS_ROW_CLASSIFICATIONS.map((c) => [c, 0])) as Record<AnalyticsRowClassification, number>;
  for (const row of result.rows) finalCounts[row.classification] += 1;
  const quarantinedRows = finalCounts.quarantined;

  const folded = foldCounts(finalCounts);
  const successCount = result.totalRows - folded.invalidRows - failedRows;
  const status: AnalyticsBatchStatus = result.totalRows === 0 || successCount === result.totalRows ? "COMPLETED" : successCount <= 0 ? "FAILED" : "COMPLETED_WITH_ERRORS";

  const now = new Date().toISOString();
  const attemptNumber = original.attempts + 1;
  const updatedDoc: AnalyticsImportBatchDoc = analyticsImportBatchDocSchema.parse({
    ...original,
    completedAt: now,
    status,
    totalRows: result.totalRows,
    actionableRows: result.totalRows - folded.invalidRows,
    matchedRows: folded.matchedRows,
    unmatchedRows: folded.unmatchedRows,
    ambiguousRows: folded.ambiguousRows,
    invalidRows: folded.invalidRows,
    duplicateUnchangedRows: folded.duplicateUnchangedRows,
    failedRows,
    quarantinedRows,
    attempts: attemptNumber,
    attemptHistory: [...original.attemptHistory, { attemptNumber, kind: "RESUME" as const, at: now, status, totalRows: result.totalRows, quarantinedRows }],
    sourceSheetInventory: result.sourceSheetInventory,
    safeErrorSummary: result.safeErrorSummary,
  });
  await analyticsImportBatchesCollection().doc(original.uid).set(updatedDoc);

  return { ok: true, data: { ...batchToDto(updatedDoc, false, result.rows.map(summarizeRowOutcome)), counts: finalCounts } };
}

// ---- Import Center target registration ---------------------------------
// Registers Analytics under the generic Import Center target registry
// (see @/server/imports/target-registry.ts). Called once, from a module
// side-effect import in the API route wiring (see
// src/app/api/imports/dry-run/route.ts) - idempotent to call more than
// once (re-registering simply overwrites the same entry).
function toGenericRows(rows: AnalyticsImportRowSummaryDto[]) {
  return rows.map((row) => ({
    sheetName: row.sheetName,
    sourceRowNumber: row.sourceRowNumber,
    classification: row.classification,
    outcome: row.outcome,
    identityLabel: row.identityLabel,
    detail: row.conflictingBatchRef ? `Conflicts with batch ${row.conflictingBatchRef}` : null,
  }));
}

export function registerAnalyticsImportTarget(): void {
  registerImportTarget({
    kind: "analytics",
    label: "Analytics",
    dryRun: async (actor, file, options, requestId) => {
      const result = await dryRunAnalyticsImport(actor, { ...(options as object), fileBuffer: file.buffer, filename: file.filename, mimeType: file.mimeType } as AnalyticsImportRawInput, requestId);
      if (!result.ok) throw new ImportAdapterError(classifyServiceErrorCode(result.code, result.message));
      return {
        batchRef: result.data.batchRef,
        totalRows: result.data.totalRows,
        counts: result.data.counts,
        safeErrorSummary: result.data.safeErrorSummary,
        sourceSheetInventory: result.data.sourceSheetInventory,
        rows: toGenericRows(result.data.rows),
        rowsTruncated: result.data.rowsTruncated,
      };
    },
    execute: async (actor, file, options, requestId) => {
      const result = await executeAnalyticsImport(actor, { ...(options as object), fileBuffer: file.buffer, filename: file.filename, mimeType: file.mimeType } as AnalyticsImportRawInput, requestId);
      if (!result.ok) throw new ImportAdapterError(classifyServiceErrorCode(result.code, result.message));
      if (!result.data.batchRef) throw new ImportAdapterError(classifySystemError());
      return {
        batchRef: result.data.batchRef,
        totalRows: result.data.totalRows,
        counts: result.data.counts,
        safeErrorSummary: result.data.safeErrorSummary,
        sourceSheetInventory: result.data.sourceSheetInventory,
        rows: toGenericRows(result.data.rows),
        rowsTruncated: result.data.rowsTruncated,
        status: result.data.status ?? "COMPLETED",
      };
    },
  });
}
