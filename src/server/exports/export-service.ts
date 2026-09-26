import type { ActorContext } from "@/server/authz/types";

import { getExportArtifactStore, locatorForExportRef, ExportArtifactStoreError } from "./artifact-store";
import { getExportTargetDefinition, listExportTargetDefinitions } from "./catalog";
import { toExportJobDto, type ExportJobDto } from "./client-dto";
import { validateRequestedColumns } from "./column-validation";
import { requireExportsAccess, requireSourceFeatureAccess } from "./exports-gate";
import { parseAppliedExportFilters } from "./filters";
import { createExportJobDoc, getExportJobDoc, listExportJobDocsByActor, markExportJobCompleted, markExportJobFailed, markExportJobGenerating } from "./firestore";
import { FILE_EXTENSION_BY_FORMAT, generateExportBytes, MIME_TYPE_BY_FORMAT } from "./generate";
import { generateExportArtifactRef, generateExportJobRef } from "./ids";
import { fetchAssignmentsRows } from "./sources/assignments-source";
import { fetchCampaignsRows } from "./sources/campaigns-source";
import { fetchPartnersRows } from "./sources/partners-source";
import {
  createExportJobInputSchema,
  DEFAULT_JOB_LIST_PAGE_SIZE,
  exportFormatSchema,
  exportJobRefSchema,
  exportTargetIdSchema,
  exportsInternalResult,
  exportsInvalidInputResult,
  exportsNotFoundResult,
  exportsUnauthorizedResult,
  isExportTargetId,
  MAX_JOB_LIST_PAGE_SIZE,
  type AppliedExportFilters,
  type ExportJobDoc,
  type ExportRow,
  type ExportsServiceResult,
  type ExportTargetDefinition,
  type ExportTargetId,
} from "./types";

// The ONE dispatch point every export route calls through - never a route that talks to a source
// fetcher directly. Mirrors src/server/reports/report-service.ts's own "route resolves the actor,
// calls a service" discipline exactly.
type SourceFetcher = (actor: ActorContext, appliedFilters: AppliedExportFilters) => Promise<ExportsServiceResult<{ rows: ExportRow[]; rowCount: number; truncated: boolean }>>;

const SOURCE_FETCHERS: Record<ExportTargetId, SourceFetcher> = {
  partners: fetchPartnersRows,
  campaigns: fetchCampaignsRows,
  assignments: fetchAssignmentsRows,
};

export async function listExportTargetsForActor(actor: ActorContext | null): Promise<ExportsServiceResult<ExportTargetDefinition[]>> {
  const access = await requireExportsAccess(actor);
  if (!access.ok) return exportsUnauthorizedResult(access.reason);
  return { ok: true, data: listExportTargetDefinitions() };
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

export async function createExportJob(actor: ActorContext | null, rawInput: unknown): Promise<ExportsServiceResult<ExportJobDto>> {
  const parsedInput = createExportJobInputSchema.safeParse(rawInput);
  if (!parsedInput.success) return exportsInvalidInputResult("Invalid export request.");
  const input = parsedInput.data;

  const access = await requireExportsAccess(actor, "create_exports");
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
  const jobRef = generateExportJobRef();
  const createdAt = new Date().toISOString();

  const jobDoc: ExportJobDoc = {
    jobRef,
    createdByUserRef: actor.userRef,
    targetId,
    format,
    requestedColumns: columnIds,
    appliedFilters,
    status: "PENDING",
    createdAt,
    maxRows: definition.maxRows,
  };
  await createExportJobDoc(jobDoc);

  // Bounded source execution: exactly one bounded call to the target's own actor-scoped list
  // function - never an unbounded scan, never a per-row N+1 fan-out.
  const sourceResult = await fetcher(actor, appliedFilters);
  if (!sourceResult.ok) {
    const failedAt = new Date().toISOString();
    await markExportJobFailed(jobRef, { failedAt, errorMessage: GENERIC_GENERATION_FAILURE_MESSAGE });
    return sourceResult;
  }

  const generatingAt = new Date().toISOString();
  await markExportJobGenerating(jobRef, generatingAt);

  try {
    const { rows, rowCount, truncated } = sourceResult.data;
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
    const fileName = `${targetId}-export-${jobRef}.${FILE_EXTENSION_BY_FORMAT[format]}`;
    await markExportJobCompleted(jobRef, { completedAt, rowCount, truncated, artifactRef, fileName });

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
