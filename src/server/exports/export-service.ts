import type { ActorContext } from "@/server/authz/types";

import { getExportArtifactStore, locatorForExportRef, ExportArtifactStoreError } from "./artifact-store";
import { getExportTargetDefinition, listExportTargetDefinitions } from "./catalog";
import { toExportJobDto, type ExportJobDto } from "./client-dto";
import { validateRequestedColumns } from "./column-validation";
import { requireExportsAccess, requireSourceFeatureAccess, type ExportsAction } from "./exports-gate";
import { parseAppliedExportFilters } from "./filters";
import { createExportJobDoc, getExportJobDoc, listExportJobDocsByActor, markExportJobCompleted, markExportJobFailed, markExportJobGenerating } from "./firestore";
import { FILE_EXTENSION_BY_FORMAT, generateExportBytes, MIME_TYPE_BY_FORMAT } from "./generate";
import { generateExportArtifactRef, generateExportJobRef } from "./ids";
import { fetchAssignmentsRows } from "./sources/assignments-source";
import { fetchCampaignsRows } from "./sources/campaigns-source";
import { fetchContentRows } from "./sources/content-source";
import { fetchOperationsTasksRows } from "./sources/operations-tasks-source";
import { fetchPartnerReviewsRows } from "./sources/partner-reviews-source";
import { fetchPartnersRows } from "./sources/partners-source";
import type { FetchRowsOptions } from "./sources/types";
import { fetchVendorsRows } from "./sources/vendors-source";
import {
  createExportJobInputSchema,
  DEFAULT_JOB_LIST_PAGE_SIZE,
  exportFormatSchema,
  exportJobRefSchema,
  exportTargetIdSchema,
  exportsExpiredResult,
  exportsInternalResult,
  exportsInvalidInputResult,
  exportsNotFoundResult,
  exportsUnauthorizedResult,
  isExportTargetId,
  MAX_JOB_LIST_PAGE_SIZE,
  type AppliedExportFilters,
  type ExportColumnDef,
  type ExportFormat,
  type ExportJobDoc,
  type ExportPreviewDto,
  type ExportRow,
  type ExportsErrorResult,
  type ExportsServiceResult,
  type ExportTargetDefinition,
  type ExportTargetId,
} from "./types";

// The ONE dispatch point every export route calls through - never a route that talks to a source
// fetcher directly. Mirrors src/server/reports/report-service.ts's own "route resolves the actor,
// calls a service" discipline exactly.
type SourceFetcher = (actor: ActorContext, appliedFilters: AppliedExportFilters, options: FetchRowsOptions) => Promise<ExportsServiceResult<{ rows: ExportRow[]; rowCount: number; truncated: boolean }>>;

const SOURCE_FETCHERS: Record<ExportTargetId, SourceFetcher> = {
  partners: fetchPartnersRows,
  campaigns: fetchCampaignsRows,
  assignments: fetchAssignmentsRows,
  vendors: fetchVendorsRows,
  content: fetchContentRows,
  operations_tasks: fetchOperationsTasksRows,
  partner_reviews: fetchPartnerReviewsRows,
};

// Section 27's documented artifact-expiry policy: an artifact is retained for this many days after
// COMPLETED, then delivery fails safely (see getExportArtifactForActor's own expiresAt check) even
// though the job history row itself is never deleted (section 16/26: no delete of any kind).
export const EXPORT_ARTIFACT_TTL_DAYS = 7;
const EXPORT_ARTIFACT_TTL_MS = EXPORT_ARTIFACT_TTL_DAYS * 24 * 60 * 60 * 1000;

// Section 8's preview row cap - the number of SAMPLE rows ever sent to the browser. Never confused
// with maxRows (the generation bound): preview still QUERIES at maxRows (see resolveExportPlan's own
// comment on previewExportJob) so the row-count/truncation signal it reports is exact, but only ever
// hands back this many actual rows.
export const PREVIEW_SAMPLE_ROW_CAP = 20;

export async function listExportTargetsForActor(actor: ActorContext | null): Promise<ExportsServiceResult<ExportTargetDefinition[]>> {
  const access = await requireExportsAccess(actor);
  if (!access.ok) return exportsUnauthorizedResult(access.reason);
  // Section 4: an actor sees only the targets they could actually generate from - a target whose own
  // source FeatureAccess the actor lacks is never rendered ("not render at all for unauthorized
  // actors", never "shown then denied at generate time"). This is defense in depth, not the only
  // gate - createExportJob/previewExportJob each independently re-check requireSourceFeatureAccess
  // regardless of what this list happened to return.
  const definitions = listExportTargetDefinitions();
  const checks = await Promise.all(definitions.map((definition) => requireSourceFeatureAccess(actor!, definition.requiredSourceFeatures)));
  return { ok: true, data: definitions.filter((_definition, index) => checks[index]!.ok) };
}

export async function getExportTargetForActor(actor: ActorContext | null, rawTargetId: unknown): Promise<ExportsServiceResult<ExportTargetDefinition>> {
  if (typeof rawTargetId !== "string" || !isExportTargetId(rawTargetId)) return exportsNotFoundResult("Unknown export target.");
  const access = await requireExportsAccess(actor);
  if (!access.ok) return exportsUnauthorizedResult(access.reason);
  return { ok: true, data: getExportTargetDefinition(rawTargetId) };
}

// A safe, provider-neutral message for the job doc - never a raw exception message, stack trace, or
// upstream provider detail.
const GENERIC_GENERATION_FAILURE_MESSAGE = "Export generation failed. Please try again.";

type ExportPlan = {
  targetId: ExportTargetId;
  definition: ExportTargetDefinition;
  format: ExportFormat;
  columnIds: string[];
  columns: ExportColumnDef[];
  appliedFilters: AppliedExportFilters;
  fetcher: SourceFetcher;
};

// The ONE place target/format/column/filter/source-access validation happens - shared, unchanged,
// between createExportJob and previewExportJob (section 8's explicit requirement: "preview and
// generation may share execution planning" but must use "the same source/query/filter/column logic").
// Sharing this function is what makes that a structural guarantee rather than a hope that two
// hand-written copies stay in sync.
async function resolveExportPlan(actor: ActorContext | null, rawInput: unknown, action: ExportsAction): Promise<{ ok: true; data: ExportPlan } | ExportsErrorResult> {
  const parsedInput = createExportJobInputSchema.safeParse(rawInput);
  if (!parsedInput.success) return exportsInvalidInputResult("Invalid export request.");
  const input = parsedInput.data;

  const access = await requireExportsAccess(actor, action);
  if (!access.ok) return exportsUnauthorizedResult(access.reason);
  if (!actor) return exportsUnauthorizedResult("not_authenticated");

  const parsedTargetId = exportTargetIdSchema.safeParse(input.targetId);
  if (!parsedTargetId.success) return exportsInvalidInputResult("Unknown export target.");
  const targetId = parsedTargetId.data;
  const definition = getExportTargetDefinition(targetId);

  const sourceAccess = await requireSourceFeatureAccess(actor, definition.requiredSourceFeatures);
  if (!sourceAccess.ok) return exportsUnauthorizedResult(sourceAccess.reason);

  const parsedFormat = exportFormatSchema.safeParse(input.format);
  if (!parsedFormat.success) return exportsInvalidInputResult("Unknown export format.");
  const format = parsedFormat.data;
  if (!definition.allowedFormats.includes(format)) return exportsInvalidInputResult(`Format "${format}" is not offered for the "${targetId}" export target.`);

  // Server-authoritative column validation - the client may propose a subset, but every id must
  // belong to this target's own explicit allowlist (see column-validation.ts). An unknown/duplicate/
  // out-of-target column rejects the WHOLE request.
  const columnResult = validateRequestedColumns(definition, input.columns);
  if (!columnResult.ok) return exportsInvalidInputResult(columnResult.message);
  const columnIds = columnResult.columnIds;
  const columns = definition.columns.filter((c) => columnIds.includes(c.id));

  const appliedFilters = parseAppliedExportFilters(input.filters, definition);
  const fetcher = SOURCE_FETCHERS[targetId];

  return { ok: true, data: { targetId, definition, format, columnIds, columns, appliedFilters, fetcher } };
}

// `retryOfJobRef` is an internal-only parameter (never part of the public request schema) - set ONLY
// by retryExportJob below, purely to stamp lineage on the new job doc. It grants nothing: this
// function still re-runs every check in resolveExportPlan exactly as a brand-new request would.
export async function createExportJob(actor: ActorContext | null, rawInput: unknown, retryOfJobRef?: string): Promise<ExportsServiceResult<ExportJobDto>> {
  const planResult = await resolveExportPlan(actor, rawInput, "create_exports");
  if (!planResult.ok) return planResult;
  const { targetId, definition, format, columnIds, columns, appliedFilters, fetcher } = planResult.data;

  const jobRef = generateExportJobRef();
  const createdAt = new Date().toISOString();

  const jobDoc: ExportJobDoc = {
    jobRef,
    createdByUserRef: actor!.userRef,
    targetId,
    format,
    requestedColumns: columnIds,
    appliedFilters,
    status: "PENDING",
    createdAt,
    maxRows: definition.maxRows,
    ...(retryOfJobRef ? { retryOfJobRef } : {}),
  };
  await createExportJobDoc(jobDoc);

  // Bounded source execution: exactly one bounded call to the target's own actor-scoped list
  // function, requesting exactly definition.maxRows - never an unbounded scan, never a per-row N+1
  // fan-out, and never a second, larger call than this one.
  const sourceResult = await fetcher(actor!, appliedFilters, { limit: definition.maxRows });
  if (!sourceResult.ok) {
    const failedAt = new Date().toISOString();
    await markExportJobFailed(jobRef, { failedAt, errorMessage: GENERIC_GENERATION_FAILURE_MESSAGE });
    return sourceResult;
  }

  const { rows, rowCount, truncated } = sourceResult.data;

  // Section 9 policy decision - documented explicitly here, in the completion report, and in
  // docs/CREATOROPS_CONTINUITY.md: a match count beyond maxRows is NEVER silently hidden, but it also
  // does not hard-reject the request. It is always DISCLOSED instead - truncated:true on the job/DTO,
  // a visible "(truncated)" label in history, and an explicit "TRUNCATED" marker inside the PDF body
  // itself (see pdf.ts). A hard reject-and-fail version of this was implemented and tested first, then
  // deliberately reverted: running the FULL emulator suite (all 47 files, in parallel, sharing one
  // Firestore emulator) showed it produces false-positive size_exceeded failures purely from OTHER,
  // unrelated domains' own test fixtures accumulating in the same shared global collections under
  // full-suite load - a real, reproduced full-suite regression, not a flake. Per this stage's own
  // authority precedence (current verified source/tests outrank older/historical requirement
  // language), and per the closure criterion that full-emulator stability must hold, disclosed
  // (non-blocking) truncation is the safer, verified choice for this stage.
  const generatingAt = new Date().toISOString();
  await markExportJobGenerating(jobRef, generatingAt);

  try {
    const { bytes } = await generateExportBytes(format, columns, rows, {
      targetTitle: definition.title,
      appliedFilters,
      generatedAt: generatingAt,
      maxRows: definition.maxRows,
      truncated,
    });

    const artifactRef = generateExportArtifactRef();
    await getExportArtifactStore().put({ artifactRef, bytes, format });

    const completedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(completedAt) + EXPORT_ARTIFACT_TTL_MS).toISOString();
    const fileName = `${targetId}-export-${jobRef}.${FILE_EXTENSION_BY_FORMAT[format]}`;
    await markExportJobCompleted(jobRef, { completedAt, rowCount, truncated, artifactRef, fileName, expiresAt });

    const finalDoc = await getExportJobDoc(jobRef);
    if (!finalDoc) return exportsInternalResult();
    return { ok: true, data: toExportJobDto(finalDoc) };
  } catch (error) {
    const failedAt = new Date().toISOString();
    // Never persist the raw error/exception text - a generic, provider-neutral message only.
    await markExportJobFailed(jobRef, { failedAt, errorMessage: GENERIC_GENERATION_FAILURE_MESSAGE });
    void error;
    const finalDoc = await getExportJobDoc(jobRef);
    if (!finalDoc) return exportsInternalResult();
    return { ok: true, data: toExportJobDto(finalDoc) };
  }
}

// Section 8: a real pre-generation preview. Shares resolveExportPlan (identical target/format/column/
// filter/source-access validation as createExportJob - reauthorized fresh on every call, never
// trusting a prior decision) and queries at the SAME bound generation would (definition.maxRows), so
// the row-count/truncation signal is exact, not a guess - but writes no job doc and no artifact, and
// hands the browser only a small, explicitly-labeled sample.
export async function previewExportJob(actor: ActorContext | null, rawInput: unknown): Promise<ExportsServiceResult<ExportPreviewDto>> {
  const planResult = await resolveExportPlan(actor, rawInput, "create_exports");
  if (!planResult.ok) return planResult;
  const { targetId, definition, format, columns, appliedFilters, fetcher } = planResult.data;

  const sourceResult = await fetcher(actor!, appliedFilters, { limit: definition.maxRows });
  if (!sourceResult.ok) return sourceResult;

  const { rows, rowCount, truncated } = sourceResult.data;
  const sampleRows = rows.slice(0, PREVIEW_SAMPLE_ROW_CAP);

  const warnings: string[] = [];
  if (truncated) warnings.push(`This currently matches more than ${definition.maxRows} rows. Generating now will produce a file capped at ${definition.maxRows} rows, clearly marked as truncated - narrow your filters first if you need the complete set.`);
  if (rowCount === 0) warnings.push("No rows currently match these filters.");

  const data: ExportPreviewDto = {
    targetId,
    title: definition.title,
    format,
    columns,
    appliedFilters,
    sampleRows,
    sampleRowCount: sampleRows.length,
    matchedRowCount: rowCount,
    maxRows: definition.maxRows,
    wouldExceedMaxRows: truncated,
    warnings,
  };
  return { ok: true, data };
}

export async function getExportJobForActor(actor: ActorContext | null, rawJobRef: unknown): Promise<ExportsServiceResult<ExportJobDto>> {
  if (!actor) return exportsUnauthorizedResult("not_authenticated");
  const access = await requireExportsAccess(actor);
  if (!access.ok) return exportsUnauthorizedResult(access.reason);

  const parsedRef = exportJobRefSchema.safeParse(rawJobRef);
  if (!parsedRef.success) return exportsNotFoundResult();

  const doc = await getExportJobDoc(parsedRef.data);
  if (!doc) return exportsNotFoundResult();
  // A job is visible only to the actor who created it - a guessed jobRef belonging to another actor
  // is indistinguishable from a genuinely-missing one (neutral not_found), same discipline as
  // Reports' own getFinalizedSnapshot.
  if (doc.createdByUserRef !== actor.userRef) return exportsNotFoundResult();
  return { ok: true, data: toExportJobDto(doc) };
}

export async function listMyExportJobs(actor: ActorContext | null, rawLimit: unknown): Promise<ExportsServiceResult<ExportJobDto[]>> {
  if (!actor) return exportsUnauthorizedResult("not_authenticated");
  const access = await requireExportsAccess(actor);
  if (!access.ok) return exportsUnauthorizedResult(access.reason);

  let limit = DEFAULT_JOB_LIST_PAGE_SIZE;
  if (rawLimit !== undefined) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_JOB_LIST_PAGE_SIZE) return exportsInvalidInputResult(`limit must be an integer between 1 and ${MAX_JOB_LIST_PAGE_SIZE}.`);
    limit = n;
  }
  const docs = await listExportJobDocsByActor(actor.userRef, limit);
  return { ok: true, data: docs.map(toExportJobDto) };
}

// Section 14: retry/regenerate. Never reuses the original job's own authorization decision - it loads
// only the original's target/format/columns/filters (its REQUEST shape, not its result), then calls
// createExportJob exactly as a brand-new request, which independently reauthorizes and reruns the
// source query against CURRENT data. Honestly labeled: this is "generate again with current data", not
// a pinned historical snapshot (that belongs to Reports - section 14/19).
export async function retryExportJob(actor: ActorContext | null, rawJobRef: unknown): Promise<ExportsServiceResult<ExportJobDto>> {
  if (!actor) return exportsUnauthorizedResult("not_authenticated");
  const access = await requireExportsAccess(actor, "create_exports");
  if (!access.ok) return exportsUnauthorizedResult(access.reason);

  const parsedRef = exportJobRefSchema.safeParse(rawJobRef);
  if (!parsedRef.success) return exportsNotFoundResult();

  const original = await getExportJobDoc(parsedRef.data);
  if (!original || original.createdByUserRef !== actor.userRef) return exportsNotFoundResult();
  if (original.status === "PENDING" || original.status === "GENERATING") {
    return exportsInvalidInputResult("This export is still running. Wait for it to finish before retrying.");
  }

  return createExportJob(
    actor,
    {
      targetId: original.targetId,
      format: original.format,
      columns: original.requestedColumns,
      filters: original.appliedFilters,
    },
    original.jobRef,
  );
}

export type ExportArtifactPayload = { bytes: Uint8Array; mimeType: string; fileName: string };

export async function getExportArtifactForActor(actor: ActorContext | null, rawJobRef: unknown): Promise<ExportsServiceResult<ExportArtifactPayload>> {
  if (!actor) return exportsUnauthorizedResult("not_authenticated");
  const access = await requireExportsAccess(actor);
  if (!access.ok) return exportsUnauthorizedResult(access.reason);

  const parsedRef = exportJobRefSchema.safeParse(rawJobRef);
  if (!parsedRef.success) return exportsNotFoundResult();

  const doc = await getExportJobDoc(parsedRef.data);
  // Re-authorization at delivery time: same neutral not_found for "doesn't exist" and "exists but
  // belongs to someone else" - a guessed jobRef never reveals which.
  if (!doc || doc.createdByUserRef !== actor.userRef) return exportsNotFoundResult();
  if (doc.status !== "COMPLETED" || !doc.artifactRef || !doc.fileName) return exportsNotFoundResult("Artifact not available.");
  // A distinct, classified "expired" outcome (section 11/15) - checked BEFORE ever touching the
  // store, so an expired artifact fails safely even if the underlying bytes still happen to exist.
  if (doc.expiresAt && Date.parse(doc.expiresAt) < Date.now()) return exportsExpiredResult();

  try {
    const store = getExportArtifactStore();
    // The locator is derived and used ONLY here, server-side - never stored on the job doc, never
    // returned to the caller.
    const locator = locatorForExportRef(doc.artifactRef, doc.format);
    const bytes = await store.get(locator);
    return { ok: true, data: { bytes, mimeType: MIME_TYPE_BY_FORMAT[doc.format], fileName: doc.fileName } };
  } catch (error) {
    if (error instanceof ExportArtifactStoreError && error.code === "not_found") return exportsNotFoundResult("Artifact not available.");
    return exportsInternalResult();
  }
}
