import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { classifyImportReasonCode, classifyServiceErrorCode, classifySystemError } from "@/server/imports/error-taxonomy";
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
  getCompletedAnalyticsImportBatchesBySourceHash,
  setAnalyticsImportBatchRowDetail,
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
  MAX_ROW_DETAIL_ROWS,
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
  // Finding #67: a plain re-upload claims by sourceHash alone (unchanged -
  // this is what makes an accidental byte-identical replay a safe no-op).
  // An EXPLICIT supersession claims by the COMPOUND (sourceHash,
  // supersedesBatchRef) identity instead, so the exact same bytes can
  // still get a genuinely new batch when the caller explicitly declares a
  // new supersession intent (Scenario D: "intentional superseding import
  // using the same bytes", e.g. re-asserting a correction) - while a
  // REPLAY of that exact same superseding request (same bytes, same
  // supersedesBatchRef) still races safely onto the SAME claim, never a
  // duplicate.
  const claimKey = supersedesBatchRef ? `${sourceHash}:supersedes:${supersedesBatchRef}` : sourceHash;
  const claimRef = analyticsImportBatchClaimsCollection().doc(analyticsImportBatchClaimId(claimKey));

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

// Remediation-plan Wave B / finding #60 re-audit: the real root cause the "1000 -> 4000" rawMediaUrl
// widening never actually touched - a per-row commit failure's real error was fully discarded (a
// bare `catch {}`, not even bound to a variable), leaving the batch's own safeErrorSummary and every
// row's Detail column with nothing at all, no matter WHY the write failed. Reuses the ONE existing,
// already-safe import error-classification surface (@/server/imports/error-taxonomy) rather than
// inventing a parallel one - a schema-validation failure at commit time (the row's own resolved data
// didn't fit the stored record shape) is distinguished from every other failure (a transient Firestore
// write issue, or anything unclassified), since only the former is something the uploader can actually
// act on. Both branches are FIXED, safe strings - never the caught error's own message/name/stack, a
// Firestore path, a doc id, or a signed/sensitive URL value.
function classifyCommitFailure(error: unknown): string {
  if (error instanceof ZodError) {
    return classifyImportReasonCode(
      "ROW_COMMIT_INVALID_SHAPE",
      "This row's data didn't fit the record shape expected when saving (a value was likely too long or in an unexpected format). No record was written for this row.",
    ).message;
  }
  return classifySystemError().message;
}

async function commitContentRow(row: PipelineRowOutcome, batchRef: string): Promise<{ classification: AnalyticsRowClassification; failed: boolean; commitFailureReason: string | null }> {
  if (!row.content || !row.rowIdentityKeyRaw) return { classification: row.classification, failed: false, commitFailureReason: null };
  if (row.classification === "duplicate" || row.classification === "unchanged") return { classification: row.classification, failed: false, commitFailureReason: null };

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
    return { classification: finalClassification, failed: false, commitFailureReason: null };
  } catch (error) {
    // Import Center Completion (spec section 9): a per-row COMMIT failure
    // (the row classified/validated fine; the write itself failed) is
    // "quarantined", not silently left at its prior classification - it
    // is now visibly retryable via resumeAnalyticsImportBatch. A Firestore
    // transaction either fully commits or writes nothing at all, so
    // reaching this catch means NO record was written for this row.
    return { classification: "quarantined", failed: true, commitFailureReason: classifyCommitFailure(error) };
  }
}

async function commitChannelRow(row: PipelineRowOutcome, batchRef: string): Promise<{ classification: AnalyticsRowClassification; failed: boolean; commitFailureReason: string | null }> {
  if (!row.channel || !row.rowIdentityKeyRaw) return { classification: row.classification, failed: false, commitFailureReason: null };
  if (row.classification === "duplicate" || row.classification === "unchanged") return { classification: row.classification, failed: false, commitFailureReason: null };

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
    return { classification: finalClassification, failed: false, commitFailureReason: null };
  } catch (error) {
    return { classification: "quarantined", failed: true, commitFailureReason: classifyCommitFailure(error) };
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
  const sourceHash = sha256HexBuffer(input.fileBuffer);

  if (supersedesBatchRef) {
    const target = await getAnalyticsImportBatchByRef(supersedesBatchRef);
    if (!target) return analyticsInvalidInputResult(`supersedesBatchRef "${supersedesBatchRef}" does not exist.`);
    // Stale-correction guard - reject if some OTHER, DIFFERENT correction
    // already superseded this exact target (i.e. `target` is no longer
    // the current latest revision in its own correction lineage).
    // Finding #67: a REPLAY of the exact same successful superseding
    // request (same target AND same file bytes as what's already on
    // record) is not a stale correction - it's Scenario E, a safe
    // idempotent replay - and must fall through to the identity lookup
    // below rather than being rejected here.
    const alreadySuperseded = await findAnalyticsImportBatchSupersededBy(supersedesBatchRef);
    if (alreadySuperseded && alreadySuperseded.sourceHash !== sourceHash) {
      return analyticsConflictResult(`Batch "${supersedesBatchRef}" has already been superseded by a newer revision - this correction is stale.`);
    }
  }

  // Batch-level idempotency - an identical re-upload of the exact same
  // file content, declaring the exact same supersession intent (or none),
  // is a no-op that returns the already-committed result, never a
  // duplicate batch/rows. Finding #67: source-hash equality ALONE must
  // never be treated as "already imported" when the caller explicitly
  // declares a DIFFERENT supersedesBatchRef than what's on record for
  // this hash - that is Scenario D (an intentional superseding import
  // using the same bytes, e.g. re-asserting a correction), a genuinely
  // new revision, not a replay, so it must proceed to actually run
  // rather than silently return someone else's unrelated result. Only an
  // exact (sourceHash, supersedesBatchRef) match is a real replay.
  // Finding #54: the source hash alone must also never silently override
  // the caller's declared targetKind - if the matching batch was
  // committed under a DIFFERENT targetKind, that is a genuine mismatch
  // (stale client state or a malformed direct API call), not a safe
  // replay, so it must be rejected rather than returning the other
  // target's data under the label the caller didn't ask for.
  const existingForHash = await getCompletedAnalyticsImportBatchesBySourceHash(sourceHash);
  const existingCompleted = existingForHash.find((batch) => batch.supersedesBatchRef === supersedesBatchRef) ?? null;
  if (existingCompleted) {
    if (existingCompleted.targetKind !== input.targetKind) {
      return analyticsConflictResult(
        `This exact file was already imported as "${existingCompleted.targetKind}" (batch ${existingCompleted.batchRef}). Select the same target kind to view that import, or upload a different file if you intended to import as "${input.targetKind}".`,
      );
    }
    return { ok: true, data: batchToDto(existingCompleted, true) };
  }

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
    // Finding #54: same mismatch guard as the completed-batch shortcut above -
    // a concurrent claim for this file's hash was made under a different
    // targetKind, so joining it would silently hand back data under the
    // wrong label instead of a genuine race-safe replay.
    if (terminal.targetKind !== input.targetKind) {
      return analyticsConflictResult(
        `This exact file is being imported concurrently as "${terminal.targetKind}" (batch ${terminal.batchRef}). Select the same target kind to view that import, or upload a different file if you intended to import as "${input.targetKind}".`,
      );
    }
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
        row.commitFailureReason = outcome.commitFailureReason;
        if (outcome.failed) failedRows += 1;
      } else if (row.recordKind === "channel") {
        const outcome = await commitChannelRow(row, claim.batchRef);
        row.classification = outcome.classification;
        row.commitFailureReason = outcome.commitFailureReason;
        if (outcome.failed) failedRows += 1;
      }
    }
    // Wave B / finding #60 re-audit: fold every distinct safe commit-failure reason into the
    // batch's own safeErrorSummary too (bounded/deduped), not just the per-row detail below.
    for (const reason of new Set(result.rows.map((row) => row.commitFailureReason).filter((reason): reason is string => reason !== null && reason !== undefined))) {
      result.safeErrorSummary.push(reason);
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

    // Finding #59: persist the SAME bounded row summary the response
    // carries, so History can show it later without requiring a re-upload.
    const rowSummaries = result.rows.map(summarizeRowOutcome);
    await setAnalyticsImportBatchRowDetail(claim.batchUid, rowSummaries.slice(0, MAX_ROW_DETAIL_ROWS), result.rows.length > MAX_ROW_DETAIL_ROWS);

    return { ok: true, data: { ...batchToDto(finalBatchDoc, false, rowSummaries), counts: finalCounts } };
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
      row.commitFailureReason = outcome.commitFailureReason;
      if (outcome.failed) failedRows += 1;
    } else if (row.recordKind === "channel") {
      const outcome = await commitChannelRow(row, original.batchRef);
      row.classification = outcome.classification;
      row.commitFailureReason = outcome.commitFailureReason;
      if (outcome.failed) failedRows += 1;
    }
  }
  // Wave B / finding #60 re-audit: same safeErrorSummary aggregation as executeAnalyticsImport.
  for (const reason of new Set(result.rows.map((row) => row.commitFailureReason).filter((reason): reason is string => reason !== null && reason !== undefined))) {
    result.safeErrorSummary.push(reason);
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

  // Finding #59: overwrite the persisted row detail with this resume's
  // full (re-parsed) row set, so History reflects the LATEST state, not
  // the pre-resume snapshot.
  const rowSummaries = result.rows.map(summarizeRowOutcome);
  await setAnalyticsImportBatchRowDetail(original.uid, rowSummaries.slice(0, MAX_ROW_DETAIL_ROWS), result.rows.length > MAX_ROW_DETAIL_ROWS);

  return { ok: true, data: { ...batchToDto(updatedDoc, false, rowSummaries), counts: finalCounts } };
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
    // Wave B re-audit: reuses the ONE shared computation (summarizeRowOutcome, import-pipeline.ts) -
    // never recomputed here, so the generic-wrapper path and the real Analytics UI's own raw
    // `/api/imports/execute` path (which never went through this function at all - see types.ts's
    // own comment on AnalyticsImportRowSummaryDto.detail) can never drift apart again.
    detail: row.detail,
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
