import { z } from "zod";

import { canTransitionLifecycle, REPORT_VERSION_LIFECYCLE_TRANSITIONS } from "@/server/authz/lifecycle";
import type { ActorContext } from "@/server/authz/types";

import { getReportDefinition } from "./catalog";
import { parseAppliedFilters } from "./filters";
import {
  getReportRunHeadDoc,
  getReportVersionDoc,
  listReportArtifactDocsForVersion,
  listReportRunHeadDocsByActor,
  listReportVersionDocs,
  txCreateNarrativeRevision,
  txCreateReportRunHead,
  txCreateReportVersion,
  txGetReportRunHead,
  txGetReportVersion,
  txSetReportRunHead,
  txSetReportVersion,
} from "./firestore";
import { generateRunRef } from "./ids";
import { ensureArtifactsForFinalizedVersion } from "./report-artifacts/generate-artifacts";
import { runReport } from "./report-service";
import { assembleFullReportSections, buildEvidenceSections, type NarrativeAssemblyEntry } from "./report-sections/build-sections";
import type { ReportSectionModel } from "./report-sections/types";
import { getReportTemplateDefinition, isReportTemplateId, NARRATIVE_SECTION_LABELS, reportNarrativeSectionKeySchema, type ReportNarrativeSectionKey, type ReportTemplateId } from "./report-templates";
import { getAdminFirestore } from "@/server/firebase/admin";
import { requireReportsAccess, requireSourceFeatureAccess } from "./reports-gate";
import {
  MAX_REPORT_VERSIONS,
  reportLifecycleConflictResult,
  reportLifecycleInternalResult,
  reportLifecycleInvalidInputResult,
  reportLifecycleNotFoundResult,
  reportLifecycleStaleResult,
  reportLifecycleUnauthorizedResult,
  type ReportArtifactDoc,
  type ReportEvidenceSnapshot,
  type ReportId,
  type ReportLifecycleResult,
  type ReportNarrativePointer,
  type ReportRunHeadDoc,
  type ReportVersionDoc,
} from "./types";

// Reports Final-Master (spec sections 2/12-16): the ReportRun/Draft -> Evidence -> Narrative ->
// Review -> Finalized -> Supersession lifecycle service. Mirrors
// src/server/finance-agreements/agreement-lifecycle-service.ts's own transaction shape (ALL reads
// first, then writes, an optimistic `docVersion`/`revision` precondition on every mutating call, one
// audit-worthy state change per transaction) - see that file's own header comment for the precedent
// this deliberately follows.

const transitions = REPORT_VERSION_LIFECYCLE_TRANSITIONS;

// --- Input schemas -------------------------------------------------------------------------------------
const createDraftRunInputSchema = z.object({ templateId: z.string().min(1), filters: z.record(z.string(), z.unknown()).optional() }).strict();
const runRefOnlySchema = z.object({ runRef: z.string().min(1), expectedDocVersion: z.number().int().min(1) }).strict();
const saveNarrativeInputSchema = z
  .object({
    runRef: z.string().min(1),
    version: z.number().int().min(1),
    sectionKey: reportNarrativeSectionKeySchema,
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(20_000),
    expectedRevision: z.number().int().min(0), // 0 means "no revision exists yet" (first save).
  })
  .strict();

// --- Visibility (disclosed decision - see the task's own recon item 3) --------------------------------
// DRAFT/IN_REVIEW versions are private to the actor who drafted them. FINALIZED/SUPERSEDED versions
// are visible to ANY actor holding ordinary Reports view-level access AND current source-feature
// access to every module the underlying report reads through - matching Finance Agreement's own
// access model (an Agreement's confirmed/active history is visible to anyone with Finance Agreement
// access, not only its own author), rather than literally reusing legacy reportSnapshots' owner-only
// rule. Legacy reportSnapshots documents and routes are UNCHANGED (see snapshot-service.ts) - they
// keep their pre-existing owner-only visibility for backward compatibility.
async function canViewReportVersion(actor: ActorContext, version: ReportVersionDoc): Promise<boolean> {
  if (version.status === "DRAFT" || version.status === "IN_REVIEW") return version.actorUserRef === actor.userRef;
  const viewAccess = await requireReportsAccess(actor);
  if (!viewAccess.ok) return false;
  const definition = getReportDefinition(version.reportId);
  const sourceAccess = await requireSourceFeatureAccess(actor, definition.requiredSourceFeatures);
  return sourceAccess.ok;
}

// --- DTO -----------------------------------------------------------------------------------------------
export type ReportRunDetailDto = {
  runRef: string;
  reportId: ReportId;
  templateId: string;
  templateTitle: string;
  latestVersion: number;
  openVersion: number | null;
  currentFinalizedVersion: number | null;
  // The HEAD's own optimistic-concurrency counter - this is the `expectedDocVersion` every run-level
  // mutation (runEvidenceForDraft/submitReportForReview/finalizeReportVersion/
  // createSupersedingReportVersion) checks against (never the per-version docVersion, which tracks a
  // single version's own edits only - see report-lifecycle-service.ts's own transactions). A client
  // MUST read this field and pass it back on the next run-level call.
  headDocVersion: number;
  version: {
    version: number;
    status: ReportVersionDoc["status"];
    actorUserRef: string;
    appliedFilters: Record<string, string>;
    scopeSummary: { basis: string; note: string };
    hasEvidence: boolean;
    evidenceCapturedAt: string | null;
    evidenceSourceRevisionCutoff: string | null;
    evidenceTruncated: boolean | null;
    evidenceRowCount: number | null;
    evidenceLimitations: string[];
    sections: ReportSectionModel[];
    narrativePointers: Record<string, ReportNarrativePointer>;
    requiredNarrativeSectionKeys: string[];
    reviewerUserRef: string | null;
    submittedForReviewAt: string | null;
    finalizedByUserRef: string | null;
    finalizedAt: string | null;
    supersededByVersion: number | null;
    supersededAt: string | null;
    createdAt: string;
    updatedAt: string;
    docVersion: number;
  };
};

function narrativeByKeyFromPointers(version: ReportVersionDoc): Partial<Record<ReportNarrativeSectionKey, NarrativeAssemblyEntry>> {
  const out: Partial<Record<ReportNarrativeSectionKey, NarrativeAssemblyEntry>> = {};
  for (const [key, pointer] of Object.entries(version.narrativePointers)) {
    const parsed = reportNarrativeSectionKeySchema.safeParse(key);
    if (!parsed.success) continue;
    out[parsed.data] = { title: pointer.title, body: pointer.body, reviewStatus: pointer.reviewStatus };
  }
  return out;
}

function toReportRunDetailDto(head: ReportRunHeadDoc, version: ReportVersionDoc): ReportRunDetailDto {
  const template = isReportTemplateId(head.templateId) ? getReportTemplateDefinition(head.templateId) : null;
  const evidenceSections = (version.evidence?.sectionModels as ReportSectionModel[] | undefined) ?? [];
  const sections = version.evidence ? assembleFullReportSections(evidenceSections, narrativeByKeyFromPointers(version)) : [];
  return {
    runRef: head.runRef,
    reportId: head.reportId,
    templateId: head.templateId,
    templateTitle: template?.title ?? head.templateId,
    latestVersion: head.latestVersion,
    openVersion: head.openVersion,
    currentFinalizedVersion: head.currentFinalizedVersion,
    headDocVersion: head.docVersion,
    version: {
      version: version.version,
      status: version.status,
      actorUserRef: version.actorUserRef,
      appliedFilters: version.appliedFilters,
      scopeSummary: version.scopeSummary,
      hasEvidence: version.evidence !== null,
      evidenceCapturedAt: version.evidence?.capturedAt ?? null,
      evidenceSourceRevisionCutoff: version.evidence?.sourceRevisionCutoff ?? null,
      evidenceTruncated: version.evidence?.truncated ?? null,
      evidenceRowCount: version.evidence?.rowCount ?? null,
      evidenceLimitations: version.evidence?.limitations ?? [],
      sections,
      narrativePointers: version.narrativePointers,
      requiredNarrativeSectionKeys: version.requiredNarrativeSectionKeys,
      reviewerUserRef: version.reviewerUserRef,
      submittedForReviewAt: version.submittedForReviewAt,
      finalizedByUserRef: version.finalizedByUserRef,
      finalizedAt: version.finalizedAt,
      supersededByVersion: version.supersededByVersion,
      supersededAt: version.supersededAt,
      createdAt: version.createdAt,
      updatedAt: version.updatedAt,
      docVersion: version.docVersion,
    },
  };
}

// --- Create draft --------------------------------------------------------------------------------------
export async function createDraftReportRun(actor: ActorContext | null, rawInput: unknown): Promise<ReportLifecycleResult<ReportRunDetailDto>> {
  const parsed = createDraftRunInputSchema.safeParse(rawInput);
  if (!parsed.success) return reportLifecycleInvalidInputResult("Invalid draft request.");
  if (!isReportTemplateId(parsed.data.templateId)) return reportLifecycleInvalidInputResult("Unknown report template.");
  const templateId: ReportTemplateId = parsed.data.templateId;
  const template = getReportTemplateDefinition(templateId);

  const access = await requireReportsAccess(actor, "run_reports");
  if (!access.ok) return reportLifecycleUnauthorizedResult(access.reason);
  if (!actor) return reportLifecycleUnauthorizedResult("not_authenticated");

  const definition = getReportDefinition(template.reportId);
  const sourceAccess = await requireSourceFeatureAccess(actor, definition.requiredSourceFeatures);
  if (!sourceAccess.ok) return reportLifecycleUnauthorizedResult(sourceAccess.reason);

  const now = new Date().toISOString();
  const runRef = generateRunRef();
  const head: ReportRunHeadDoc = { runRef, reportId: template.reportId, templateId, latestVersion: 1, openVersion: 1, currentFinalizedVersion: null, createdByUserRef: actor.userRef, createdAt: now, updatedAt: now, updatedByUserRef: actor.userRef, docVersion: 1 };
  const appliedFilters = parseAppliedFilters(parsed.data.filters, definition);
  const version: ReportVersionDoc = {
    runRef,
    version: 1,
    reportId: template.reportId,
    templateId,
    definitionVersion: definition.version,
    status: "DRAFT",
    actorUserRef: actor.userRef,
    appliedFilters,
    scopeSummary: { basis: "not yet run", note: "Evidence has not been run for this draft yet." },
    evidence: null,
    narrativePointers: {},
    requiredNarrativeSectionKeys: template.requiredNarrativeSectionKeys,
    reviewerUserRef: null,
    submittedForReviewAt: null,
    finalizedByUserRef: null,
    finalizedAt: null,
    supersededByVersion: null,
    supersededAt: null,
    createdAt: now,
    updatedAt: now,
    updatedByUserRef: actor.userRef,
    docVersion: 1,
  };

  await getAdminFirestore().runTransaction(async (tx) => {
    txCreateReportRunHead(tx, head);
    txCreateReportVersion(tx, version);
  });

  return { ok: true, data: toReportRunDetailDto(head, version) };
}

// --- Run/refresh evidence (explicit, never silent - spec section 13) -----------------------------------
export async function runEvidenceForDraft(actor: ActorContext | null, rawInput: unknown): Promise<ReportLifecycleResult<ReportRunDetailDto>> {
  const parsed = runRefOnlySchema.safeParse(rawInput);
  if (!parsed.success) return reportLifecycleInvalidInputResult("Invalid request.");

  const access = await requireReportsAccess(actor, "run_reports");
  if (!access.ok) return reportLifecycleUnauthorizedResult(access.reason);
  if (!actor) return reportLifecycleUnauthorizedResult("not_authenticated");

  const head = await getReportRunHeadDoc(parsed.data.runRef);
  if (!head) return reportLifecycleNotFoundResult();
  const version = await getReportVersionDoc(parsed.data.runRef, head.openVersion ?? -1);
  if (!version) return reportLifecycleNotFoundResult();
  if (version.actorUserRef !== actor.userRef) return reportLifecycleNotFoundResult();
  if (version.status !== "DRAFT" && version.status !== "IN_REVIEW") return reportLifecycleConflictResult("Evidence can only be (re-)run while a version is DRAFT or IN_REVIEW.");
  if (head.docVersion !== parsed.data.expectedDocVersion) return reportLifecycleStaleResult();

  const template = isReportTemplateId(head.templateId) ? getReportTemplateDefinition(head.templateId) : null;
  if (!template) return reportLifecycleInternalResult("Unknown template on this run.");
  const definition = getReportDefinition(head.reportId);

  const runResult = await runReport(actor, head.reportId, version.appliedFilters);
  if (!runResult.ok) return { ok: false, code: runResult.code === "unauthorized" ? "unauthorized" : "conflict", message: runResult.message, reason: runResult.reason };

  const result = runResult.data;
  const sectionModels = buildEvidenceSections(template.templateId, definition, result);
  // Firestore rejects a bare `undefined` anywhere in a written document (an optional
  // ReportSectionModel field like `note`/`totalsRow` is often simply absent, which JS represents as
  // `undefined`, not `null`) - a JSON round-trip is the standard, safe way to strip every `undefined`
  // key recursively before this ever reaches a Firestore write, without having to individually audit
  // every section builder for "never emit an undefined optional field".
  const jsonSafeSectionModels = JSON.parse(JSON.stringify(sectionModels)) as typeof sectionModels;
  const jsonSafeRawSections = JSON.parse(JSON.stringify(result.sections)) as typeof result.sections;
  const evidence: ReportEvidenceSnapshot = {
    capturedAt: new Date().toISOString(),
    definitionVersion: result.definitionVersion,
    metricRegistryVersion: "report-metrics@1",
    appliedFilters: result.appliedFilters,
    sourceRevisionCutoff: result.evidenceCutoff,
    metrics: result.metrics,
    rows: result.rows,
    rawSections: jsonSafeRawSections,
    sectionModels: jsonSafeSectionModels,
    limitations: result.limitations,
    truncated: result.truncated,
    rowCount: result.rowCount,
    maxRows: result.maxRows,
    provenance: result.provenance,
  };

  // The evidence composition above (runReport -> other source modules' own reads) deliberately runs
  // OUTSIDE any Firestore transaction (calling arbitrary cross-module async work inside a transaction
  // callback risks silent re-execution on transaction retry) - the write-back below re-validates the
  // SAME optimistic precondition freshly, inside the one transaction that actually writes.
  type Ok = { head: ReportRunHeadDoc; version: ReportVersionDoc };
  const writeResult = await getAdminFirestore().runTransaction<Ok | { error: "stale" | "conflict"; message?: string }>(async (tx) => {
    const freshHead = await txGetReportRunHead(tx, head.runRef);
    if (!freshHead) return { error: "conflict", message: "This run no longer exists." };
    if (freshHead.docVersion !== parsed.data.expectedDocVersion) return { error: "stale" };
    const freshVersion = await txGetReportVersion(tx, head.runRef, freshHead.openVersion ?? -1);
    if (!freshVersion || (freshVersion.status !== "DRAFT" && freshVersion.status !== "IN_REVIEW")) return { error: "conflict", message: "This version can no longer accept a new evidence run." };

    const now = new Date().toISOString();
    const nextVersion: ReportVersionDoc = { ...freshVersion, evidence, scopeSummary: result.scopeSummary, updatedAt: now, updatedByUserRef: actor.userRef, docVersion: freshVersion.docVersion + 1 };
    const nextHead: ReportRunHeadDoc = { ...freshHead, updatedAt: now, updatedByUserRef: actor.userRef, docVersion: freshHead.docVersion + 1 };
    txSetReportVersion(tx, nextVersion);
    txSetReportRunHead(tx, nextHead);
    return { head: nextHead, version: nextVersion };
  });

  if ("error" in writeResult) {
    if (writeResult.error === "stale") return reportLifecycleStaleResult();
    return reportLifecycleConflictResult(writeResult.message ?? "Conflict.");
  }
  return { ok: true, data: toReportRunDetailDto(writeResult.head, writeResult.version) };
}

// --- Narrative -------------------------------------------------------------------------------------------
export async function saveNarrativeSection(actor: ActorContext | null, rawInput: unknown): Promise<ReportLifecycleResult<ReportRunDetailDto>> {
  const parsed = saveNarrativeInputSchema.safeParse(rawInput);
  if (!parsed.success) return reportLifecycleInvalidInputResult("Invalid narrative save request.");
  const input = parsed.data;

  const access = await requireReportsAccess(actor, "edit_narrative");
  if (!access.ok) return reportLifecycleUnauthorizedResult(access.reason);
  if (!actor) return reportLifecycleUnauthorizedResult("not_authenticated");

  const result = await getAdminFirestore().runTransaction<{ head: ReportRunHeadDoc; version: ReportVersionDoc } | { error: "not_found" | "stale" | "conflict"; message?: string }>(async (tx) => {
    const head = await txGetReportRunHead(tx, input.runRef);
    if (!head) return { error: "not_found" };
    const version = await txGetReportVersion(tx, input.runRef, input.version);
    if (!version) return { error: "not_found" };
    // Ownership is only enforced while the version is still OPEN (DRAFT/IN_REVIEW - private to its
    // own drafter, per canViewReportVersion's own visibility rule). A FINALIZED/SUPERSEDED version is
    // already visible to any actor with ordinary current access (the outer edit_narrative gate has
    // already run) - denying an edit attempt on it is reported as the real reason (immutable), never
    // disguised as not_found.
    if (version.status === "DRAFT" || version.status === "IN_REVIEW") {
      if (version.actorUserRef !== actor.userRef) return { error: "not_found" };
    } else {
      return { error: "conflict", message: "A finalized report version's narrative is immutable. Create a superseding version to make corrections." };
    }

    const existingPointer = version.narrativePointers[input.sectionKey];
    const expectedRevision = existingPointer?.revision ?? 0;
    if (expectedRevision !== input.expectedRevision) return { error: "stale" };

    const now = new Date().toISOString();
    const nextRevision = expectedRevision + 1;
    const title = input.title ?? existingPointer?.title ?? NARRATIVE_SECTION_LABELS[input.sectionKey];
    txCreateNarrativeRevision(tx, { runRef: input.runRef, version: input.version, sectionKey: input.sectionKey, revision: nextRevision, title, body: input.body, evidenceRefs: [], reviewStatus: "DRAFT", authorUserRef: actor.userRef, createdAt: now });

    const pointer: ReportNarrativePointer = { revision: nextRevision, title, body: input.body, updatedAt: now, updatedByUserRef: actor.userRef, reviewStatus: "DRAFT" };
    const nextVersion: ReportVersionDoc = { ...version, narrativePointers: { ...version.narrativePointers, [input.sectionKey]: pointer }, updatedAt: now, updatedByUserRef: actor.userRef, docVersion: version.docVersion + 1 };
    txSetReportVersion(tx, nextVersion);
    return { head, version: nextVersion };
  });

  if ("error" in result) {
    if (result.error === "not_found") return reportLifecycleNotFoundResult();
    if (result.error === "stale") return reportLifecycleStaleResult("This narrative section was changed since you last loaded it. Reload and try again.");
    return reportLifecycleConflictResult(result.message ?? "Conflict.");
  }
  return { ok: true, data: toReportRunDetailDto(result.head, result.version) };
}

// --- Submit for review -----------------------------------------------------------------------------------
export async function submitReportForReview(actor: ActorContext | null, rawInput: unknown): Promise<ReportLifecycleResult<ReportRunDetailDto>> {
  const parsed = runRefOnlySchema.safeParse(rawInput);
  if (!parsed.success) return reportLifecycleInvalidInputResult("Invalid request.");

  const access = await requireReportsAccess(actor, "submit_for_review");
  if (!access.ok) return reportLifecycleUnauthorizedResult(access.reason);
  if (!actor) return reportLifecycleUnauthorizedResult("not_authenticated");

  const result = await getAdminFirestore().runTransaction<{ head: ReportRunHeadDoc; version: ReportVersionDoc } | { error: "not_found" | "stale" | "conflict"; message?: string }>(async (tx) => {
    const head = await txGetReportRunHead(tx, parsed.data.runRef);
    if (!head || head.openVersion === null) return { error: "not_found" };
    const version = await txGetReportVersion(tx, parsed.data.runRef, head.openVersion);
    if (!version) return { error: "not_found" };
    if (version.actorUserRef !== actor.userRef) return { error: "not_found" };
    if (head.docVersion !== parsed.data.expectedDocVersion) return { error: "stale" };
    if (!canTransitionLifecycle(version.status, "IN_REVIEW", transitions)) return { error: "conflict", message: `Version ${version.version} is ${version.status} and cannot be submitted for review.` };
    if (!version.evidence) return { error: "conflict", message: "Run evidence at least once before submitting for review." };

    const now = new Date().toISOString();
    const nextVersion: ReportVersionDoc = { ...version, status: "IN_REVIEW", submittedForReviewAt: now, updatedAt: now, updatedByUserRef: actor.userRef, docVersion: version.docVersion + 1 };
    const nextHead: ReportRunHeadDoc = { ...head, updatedAt: now, updatedByUserRef: actor.userRef, docVersion: head.docVersion + 1 };
    txSetReportVersion(tx, nextVersion);
    txSetReportRunHead(tx, nextHead);
    return { head: nextHead, version: nextVersion };
  });

  if ("error" in result) {
    if (result.error === "not_found") return reportLifecycleNotFoundResult();
    if (result.error === "stale") return reportLifecycleStaleResult();
    return reportLifecycleConflictResult(result.message ?? "Conflict.");
  }
  return { ok: true, data: toReportRunDetailDto(result.head, result.version) };
}

// --- Data-quality finalization gate (spec section 15/10) -------------------------------------------------
// Deliberately conservative: truncation and disclosed limitations are NORMAL, expected, and already
// surfaced in Data Quality - they never block finalize on their own. What DOES block finalize is
// evidence that is genuinely, entirely empty (no rows AND no non-null/non-zero metric) - the one case
// where finalizing would publish a report with nothing real in it.
export function evaluateFinalizationDataQualityGate(evidence: ReportEvidenceSnapshot): { blocked: boolean; reasons: string[] } {
  const hasAnyMetric = Object.values(evidence.metrics).some((v) => v !== null && v !== 0 && v !== "");
  const reasons: string[] = [];
  if (evidence.rowCount === 0 && !hasAnyMetric) {
    reasons.push("Evidence is completely empty (no rows and no non-zero metric) for the applied parameters - finalize is blocked. Re-run evidence with different parameters, or confirm this is genuinely expected before proceeding.");
  }
  return { blocked: reasons.length > 0, reasons };
}

// --- Finalize (spec section 15) ---------------------------------------------------------------------------
export async function finalizeReportVersion(actor: ActorContext | null, rawInput: unknown): Promise<ReportLifecycleResult<ReportRunDetailDto>> {
  const parsed = runRefOnlySchema.safeParse(rawInput);
  if (!parsed.success) return reportLifecycleInvalidInputResult("Invalid request.");

  const access = await requireReportsAccess(actor, "finalize_report");
  if (!access.ok) return reportLifecycleUnauthorizedResult(access.reason);
  if (!actor) return reportLifecycleUnauthorizedResult("not_authenticated");

  type Ok = { head: ReportRunHeadDoc; version: ReportVersionDoc; superseded: ReportVersionDoc | null; alreadyFinalized: boolean };
  const result = await getAdminFirestore().runTransaction<Ok | { error: "not_found" | "stale" | "conflict"; message?: string }>(async (tx) => {
    const head = await txGetReportRunHead(tx, parsed.data.runRef);
    if (!head) return { error: "not_found" };
    // Idempotent-retry lookup: the FIRST (successful) finalize call clears head.openVersion, so a
    // retried call must fall back to head.currentFinalizedVersion to find the SAME version again -
    // relying on openVersion alone would make every retry after success report not_found.
    const targetVersionNumber = head.openVersion ?? head.currentFinalizedVersion;
    if (targetVersionNumber === null) return { error: "not_found" };
    const version = await txGetReportVersion(tx, parsed.data.runRef, targetVersionNumber);
    if (!version) return { error: "not_found" };

    // Idempotent retry: if this exact version is ALREADY finalized (a client retry after a
    // network failure on the first response), return success rather than erroring - finalize must
    // be idempotent/race-safe (spec section 15).
    if (version.status === "FINALIZED") return { head, version, superseded: null, alreadyFinalized: true };

    if (head.docVersion !== parsed.data.expectedDocVersion) return { error: "stale" };
    if (!canTransitionLifecycle(version.status, "FINALIZED", transitions)) return { error: "conflict", message: `Version ${version.version} is ${version.status} and cannot be finalized - submit it for review first.` };
    if (!version.evidence) return { error: "conflict", message: "This version has no evidence - run evidence before finalizing." };

    const missingNarrative = version.requiredNarrativeSectionKeys.filter((key) => !version.narrativePointers[key]);
    if (missingNarrative.length > 0) return { error: "conflict", message: `Required narrative section(s) missing: ${missingNarrative.map((k) => NARRATIVE_SECTION_LABELS[k as ReportNarrativeSectionKey] ?? k).join(", ")}.` };

    const gate = evaluateFinalizationDataQualityGate(version.evidence);
    if (gate.blocked) return { error: "conflict", message: gate.reasons.join(" ") };

    const priorFinalizedNumber = head.currentFinalizedVersion;
    const prior = priorFinalizedNumber !== null && priorFinalizedNumber !== version.version ? await txGetReportVersion(tx, parsed.data.runRef, priorFinalizedNumber) : null;

    const now = new Date().toISOString();
    const finalized: ReportVersionDoc = { ...version, status: "FINALIZED", finalizedByUserRef: actor.userRef, finalizedAt: now, updatedAt: now, updatedByUserRef: actor.userRef, docVersion: version.docVersion + 1 };
    const superseded: ReportVersionDoc | null = prior ? { ...prior, status: "SUPERSEDED", supersededByVersion: version.version, supersededAt: now, updatedAt: now, updatedByUserRef: actor.userRef, docVersion: prior.docVersion + 1 } : null;
    const nextHead: ReportRunHeadDoc = { ...head, openVersion: null, currentFinalizedVersion: version.version, updatedAt: now, updatedByUserRef: actor.userRef, docVersion: head.docVersion + 1 };

    txSetReportVersion(tx, finalized, true);
    if (superseded) txSetReportVersion(tx, superseded, true);
    txSetReportRunHead(tx, nextHead);
    return { head: nextHead, version: finalized, superseded, alreadyFinalized: false };
  });

  if ("error" in result) {
    if (result.error === "not_found") return reportLifecycleNotFoundResult();
    if (result.error === "stale") return reportLifecycleStaleResult();
    return reportLifecycleConflictResult(result.message ?? "Conflict.");
  }

  // Spec section 15: "on finalization: ... generate declared artifacts." Runs AFTER the transaction
  // commits (byte generation/Storage I/O is not transaction-safe) and is itself idempotent/race-safe
  // (see generate-artifacts.ts's own header comment) - a retried finalize call (this version is
  // already FINALIZED, handled above as `alreadyFinalized`) re-enters here and safely re-attempts
  // any artifact that did not finish generating on a prior attempt.
  try {
    await ensureArtifactsForFinalizedVersion(result.version, actor.userRef);
  } catch (error) {
    return reportLifecycleInternalResult(`The report version was finalized, but artifact generation failed (${error instanceof Error ? error.message : "unknown error"}). Finalize again to retry artifact generation - this is safe and will not create duplicates.`);
  }
  return { ok: true, data: toReportRunDetailDto(result.head, result.version) };
}

// --- Create a superseding (correction) version (spec section 16) -------------------------------------------
export async function createSupersedingReportVersion(actor: ActorContext | null, rawInput: unknown): Promise<ReportLifecycleResult<ReportRunDetailDto>> {
  const parsed = runRefOnlySchema.safeParse(rawInput);
  if (!parsed.success) return reportLifecycleInvalidInputResult("Invalid request.");

  const access = await requireReportsAccess(actor, "create_superseding_version");
  if (!access.ok) return reportLifecycleUnauthorizedResult(access.reason);
  if (!actor) return reportLifecycleUnauthorizedResult("not_authenticated");

  type Ok = { head: ReportRunHeadDoc; version: ReportVersionDoc };
  const result = await getAdminFirestore().runTransaction<Ok | { error: "not_found" | "stale" | "conflict"; message?: string }>(async (tx) => {
    const head = await txGetReportRunHead(tx, parsed.data.runRef);
    if (!head) return { error: "not_found" };
    if (head.docVersion !== parsed.data.expectedDocVersion) return { error: "stale" };
    if (head.openVersion !== null) return { error: "conflict", message: `Version ${head.openVersion} is still open. Finish or finalize it before creating a correction.` };
    if (head.currentFinalizedVersion === null) return { error: "conflict", message: "There is no finalized version to correct yet." };
    if (head.latestVersion >= MAX_REPORT_VERSIONS) return { error: "conflict", message: "This report run has reached its maximum number of versions." };

    const base = await txGetReportVersion(tx, head.runRef, head.currentFinalizedVersion);
    if (!base) return { error: "not_found" };

    const now = new Date().toISOString();
    const nextNumber = head.latestVersion + 1;
    // Corrections start with a FRESH evidence pin (null) - re-run evidence is required explicitly
    // (spec section 16: "regenerate evidence"), never carried over stale from the prior version.
    // Narrative is prefilled from the prior version's pointers as a NEW revision-1 copy per section
    // (a genuinely fresh copy the author can edit - never a shared reference to the old text).
    const narrativePointers: Record<string, ReportNarrativePointer> = {};
    for (const [key, pointer] of Object.entries(base.narrativePointers)) {
      narrativePointers[key] = { ...pointer, revision: 1, updatedAt: now, updatedByUserRef: actor.userRef, reviewStatus: "DRAFT" };
    }
    const draft: ReportVersionDoc = {
      runRef: head.runRef,
      version: nextNumber,
      reportId: head.reportId,
      templateId: head.templateId,
      definitionVersion: base.definitionVersion,
      status: "DRAFT",
      actorUserRef: actor.userRef,
      appliedFilters: base.appliedFilters,
      scopeSummary: { basis: "not yet run", note: "Evidence has not been re-run for this correcting version yet." },
      evidence: null,
      narrativePointers,
      requiredNarrativeSectionKeys: base.requiredNarrativeSectionKeys,
      reviewerUserRef: null,
      submittedForReviewAt: null,
      finalizedByUserRef: null,
      finalizedAt: null,
      supersededByVersion: null,
      supersededAt: null,
      createdAt: now,
      updatedAt: now,
      updatedByUserRef: actor.userRef,
      docVersion: 1,
    };
    const nextHead: ReportRunHeadDoc = { ...head, latestVersion: nextNumber, openVersion: nextNumber, updatedAt: now, updatedByUserRef: actor.userRef, docVersion: head.docVersion + 1 };

    // Seed each carried-over narrative section's revision-1 row so its history is genuinely complete.
    for (const [key, pointer] of Object.entries(narrativePointers)) {
      txCreateNarrativeRevision(tx, { runRef: head.runRef, version: nextNumber, sectionKey: key, revision: 1, title: pointer.title, body: pointer.body, evidenceRefs: [], reviewStatus: "DRAFT", authorUserRef: actor.userRef, createdAt: now });
    }
    txCreateReportVersion(tx, draft);
    txSetReportRunHead(tx, nextHead);
    return { head: nextHead, version: draft };
  });

  if ("error" in result) {
    if (result.error === "not_found") return reportLifecycleNotFoundResult();
    if (result.error === "stale") return reportLifecycleStaleResult();
    return reportLifecycleConflictResult(result.message ?? "Conflict.");
  }
  return { ok: true, data: toReportRunDetailDto(result.head, result.version) };
}

// --- Reads -----------------------------------------------------------------------------------------------
export async function getReportRunDetail(actor: ActorContext | null, rawRunRef: unknown, rawVersion?: unknown): Promise<ReportLifecycleResult<ReportRunDetailDto>> {
  if (!actor) return reportLifecycleUnauthorizedResult("not_authenticated");
  if (typeof rawRunRef !== "string") return reportLifecycleNotFoundResult();
  const head = await getReportRunHeadDoc(rawRunRef);
  if (!head) return reportLifecycleNotFoundResult();
  const requestedVersion = typeof rawVersion === "number" ? rawVersion : (head.currentFinalizedVersion ?? head.openVersion ?? head.latestVersion);
  const version = await getReportVersionDoc(rawRunRef, requestedVersion);
  if (!version) return reportLifecycleNotFoundResult();
  const visible = await canViewReportVersion(actor, version);
  if (!visible) return reportLifecycleNotFoundResult();
  return { ok: true, data: toReportRunDetailDto(head, version) };
}

export type ReportVersionSummary = { version: number; status: ReportVersionDoc["status"]; finalizedAt: string | null; supersededAt: string | null; supersededByVersion: number | null };

export async function listReportRunVersionSummaries(actor: ActorContext | null, rawRunRef: unknown): Promise<ReportLifecycleResult<ReportVersionSummary[]>> {
  if (!actor) return reportLifecycleUnauthorizedResult("not_authenticated");
  if (typeof rawRunRef !== "string") return reportLifecycleNotFoundResult();
  const head = await getReportRunHeadDoc(rawRunRef);
  if (!head) return reportLifecycleNotFoundResult();
  const versions = await listReportVersionDocs(rawRunRef);
  const visible: ReportVersionSummary[] = [];
  for (const version of versions) {
    if (await canViewReportVersion(actor, version)) visible.push({ version: version.version, status: version.status, finalizedAt: version.finalizedAt, supersededAt: version.supersededAt, supersededByVersion: version.supersededByVersion });
  }
  if (visible.length === 0) return reportLifecycleNotFoundResult();
  return { ok: true, data: visible };
}

export async function listArtifactsForVersion(actor: ActorContext | null, rawRunRef: unknown, rawVersion: unknown): Promise<ReportLifecycleResult<ReportArtifactDoc[]>> {
  if (!actor) return reportLifecycleUnauthorizedResult("not_authenticated");
  if (typeof rawRunRef !== "string" || typeof rawVersion !== "number") return reportLifecycleNotFoundResult();
  const version = await getReportVersionDoc(rawRunRef, rawVersion);
  if (!version) return reportLifecycleNotFoundResult();
  if (!(await canViewReportVersion(actor, version))) return reportLifecycleNotFoundResult();
  const docs = await listReportArtifactDocsForVersion(rawRunRef, rawVersion);
  return { ok: true, data: docs };
}

export async function listMyReportRuns(actor: ActorContext | null, limit = 20): Promise<ReportLifecycleResult<ReportRunHeadDoc[]>> {
  if (!actor) return reportLifecycleUnauthorizedResult("not_authenticated");
  const docs = await listReportRunHeadDocsByActor(actor.userRef, limit);
  return { ok: true, data: docs };
}
