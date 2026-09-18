import { randomUUID } from "node:crypto";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { registerImportTarget } from "@/server/imports/target-registry";

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
import { AnalyticsImportRejectedError, runAnalyticsImportPipeline, type AnalyticsImportPipelineInput, type PipelineRowOutcome } from "./import-pipeline";
import {
  ANALYTICS_ROW_CLASSIFICATIONS,
  ANALYTICS_TARGET_KINDS,
  analyticsChannelSourceRecordDocSchema,
  analyticsContentSourceRecordDocSchema,
  analyticsImportBatchClaimDocSchema,
  analyticsImportBatchDocSchema,
  analyticsInvalidInputResult,
  analyticsUnauthorizedResult,
  analyticsConflictResult,
  type AnalyticsBatchStatus,
  type AnalyticsChannelSourceRecordDoc,
  type AnalyticsContentSourceRecordDoc,
  type AnalyticsImportBatchDoc,
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

function batchToDto(doc: AnalyticsImportBatchDoc, idempotentReplay: boolean): AnalyticsImportResultDto {
  const counts = Object.fromEntries(ANALYTICS_ROW_CLASSIFICATIONS.map((c) => [c, 0])) as Record<AnalyticsRowClassification, number>;
  counts.matched = doc.matchedRows;
  counts.unmatched = doc.unmatchedRows;
  counts.ambiguous = doc.ambiguousRows;
  counts.invalid = doc.invalidRows;
  counts.duplicate = doc.duplicateUnchangedRows;
  return {
    batchRef: doc.batchRef,
    targetKind: doc.targetKind,
    totalRows: doc.totalRows,
    counts,
    sourceSheetInventory: doc.sourceSheetInventory,
    safeErrorSummary: doc.safeErrorSummary,
    status: doc.status,
    idempotentReplay,
  };
}

async function commitContentRow(row: PipelineRowOutcome, batchRef: string): Promise<{ classification: AnalyticsRowClassification; failed: boolean }> {
  if (!row.content || !row.rowIdentityKeyRaw) return { classification: row.classification, failed: false };
  if (row.classification === "duplicate" || row.classification === "unchanged") return { classification: row.classification, failed: false };

  const docId = analyticsRowIdentityDocId(row.rowIdentityKeyRaw);
  const db = getAdminFirestore();
  const docRef = analyticsContentSourceRecordsCollection().doc(docId);

  try {
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
    return { classification: row.classification, failed: true };
  }
}

async function commitChannelRow(row: PipelineRowOutcome, batchRef: string): Promise<{ classification: AnalyticsRowClassification; failed: boolean }> {
  if (!row.channel || !row.rowIdentityKeyRaw) return { classification: row.classification, failed: false };
  if (row.classification === "duplicate" || row.classification === "unchanged") return { classification: row.classification, failed: false };

  const docId = analyticsRowIdentityDocId(row.rowIdentityKeyRaw);
  const db = getAdminFirestore();
  const docRef = analyticsChannelSourceRecordsCollection().doc(docId);

  try {
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
    return { classification: row.classification, failed: true };
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
      sourceSheetInventory: result.sourceSheetInventory,
      safeErrorSummary: result.safeErrorSummary,
    });
    await analyticsImportBatchesCollection().doc(claim.batchUid).set(finalBatchDoc);

    return { ok: true, data: { ...batchToDto(finalBatchDoc, false), counts: finalCounts } };
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

// ---- Import Center target registration ---------------------------------
// Registers Analytics under the generic Import Center target registry
// (see @/server/imports/target-registry.ts). Called once, from a module
// side-effect import in the API route wiring (see
// src/app/api/imports/dry-run/route.ts) - idempotent to call more than
// once (re-registering simply overwrites the same entry).
export function registerAnalyticsImportTarget(): void {
  registerImportTarget({
    kind: "analytics",
    label: "Analytics",
    dryRun: async (actor, file, options, requestId) => {
      const result = await dryRunAnalyticsImport(actor, { ...(options as object), fileBuffer: file.buffer, filename: file.filename, mimeType: file.mimeType } as AnalyticsImportRawInput, requestId);
      if (!result.ok) throw new Error(result.message);
      return {
        batchRef: result.data.batchRef,
        totalRows: result.data.totalRows,
        counts: result.data.counts,
        safeErrorSummary: result.data.safeErrorSummary,
        sourceSheetInventory: result.data.sourceSheetInventory,
      };
    },
    execute: async (actor, file, options, requestId) => {
      const result = await executeAnalyticsImport(actor, { ...(options as object), fileBuffer: file.buffer, filename: file.filename, mimeType: file.mimeType } as AnalyticsImportRawInput, requestId);
      if (!result.ok) throw new Error(result.message);
      if (!result.data.batchRef) throw new Error("Execute did not produce a batchRef.");
      return {
        batchRef: result.data.batchRef,
        totalRows: result.data.totalRows,
        counts: result.data.counts,
        safeErrorSummary: result.data.safeErrorSummary,
        sourceSheetInventory: result.data.sourceSheetInventory,
        status: result.data.status ?? "COMPLETED",
      };
    },
  });
}
