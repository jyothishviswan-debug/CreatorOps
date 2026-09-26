import { z } from "zod";

import type { FeatureId } from "@/server/authz/features";

// Export Center - the governed export-generation backend/domain foundation.
//
// Boundary (source-defined, see AGENTS spec): Export Center is its own module, separate from
// Reports. Reports composes cross-domain, read-only ANALYTICAL output (metrics/sections). Export
// Center generates a downloadable file (CSV/XLSX/PDF) of RECORD ROWS from exactly ONE governed
// target, with server-validated column selection and a durable job history. Nothing here reads
// Reports' own catalog/types, and nothing in Reports imports from here.
//
// Shape family mirrors every other module's own {ok:true,data}|{ok:false,code,message} result
// contract (see src/server/reports/types.ts) - deliberately its own parallel type, never a shared
// import.

// --- Target catalog ---------------------------------------------------------------------------------
export const EXPORT_TARGET_IDS = ["partners", "campaigns", "assignments"] as const;
export const exportTargetIdSchema = z.enum(EXPORT_TARGET_IDS);
export type ExportTargetId = z.infer<typeof exportTargetIdSchema>;

export function isExportTargetId(value: unknown): value is ExportTargetId {
  return typeof value === "string" && (EXPORT_TARGET_IDS as readonly string[]).includes(value);
}

export const EXPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export const exportFormatSchema = z.enum(EXPORT_FORMATS);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value);
}

export const EXPORT_FILTER_FIELD_TYPES = ["text", "status", "region", "platform"] as const;
export type ExportFilterFieldType = (typeof EXPORT_FILTER_FIELD_TYPES)[number];
export type ExportFilterFieldDef = { id: string; type: ExportFilterFieldType; label: string };

// A single allowed, exportable column. `id` is the ONLY key the server will ever honor from a
// client-requested column list (see column-validation.ts) - never a raw source-DTO field name
// reached by guessing. `label` is the column header used in every generated file.
export type ExportColumnDef = { id: string; label: string };

// The metadata a governed catalog entry carries (mirrors ReportDefinition's own shape family, sized
// for "one target, one record type" rather than Reports' multi-section analytical shape).
export type ExportTargetDefinition = {
  targetId: ExportTargetId;
  title: string;
  description: string;
  sourceModule: string;
  requiredSourceFeatures: FeatureId[];
  recordScopeNote: string;
  supportedFilters: ExportFilterFieldDef[];
  // The full allowed column allowlist - never every field on the source DTO. Deliberately excludes
  // any PAN/Aadhaar/bank/GSTIN/KYC/Drive-id/credential-adjacent field, and any large nested/internal
  // object - see each source's own comment in sources/*.ts for the specific exclusions.
  columns: ExportColumnDef[];
  defaultColumnIds: string[];
  allowedFormats: ExportFormat[];
  limitations: string[];
  maxRows: number;
};

// --- Filters -----------------------------------------------------------------------------------------
// Only keys the target's OWN definition declares in supportedFilters are ever honored - same
// "requested ids never grant access" discipline as Reports' own filters.ts.
export type RawExportFilters = Record<string, unknown>;
export type AppliedExportFilters = Record<string, string>;

// --- Rows ----------------------------------------------------------------------------------------------
export type ExportRowValue = string | number | boolean | null;
export type ExportRow = Record<string, ExportRowValue>;

// --- Result/error plumbing - same shape family as every other module's own ------------------------
export type ExportsDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied";
export type ExportsServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "unsupported" | "source_unavailable" | "size_exceeded" | "internal";
export type ExportsServiceResult<T> = { ok: true; data: T } | { ok: false; code: ExportsServiceErrorCode; message: string; reason?: ExportsDenialReason };
export type ExportsErrorResult = Extract<ExportsServiceResult<unknown>, { ok: false }>;

export function exportsUnauthorizedResult(reason: ExportsDenialReason): ExportsErrorResult {
  return { ok: false, code: "unauthorized", message: `Export Center access denied (${reason}).`, reason };
}
export function exportsInvalidInputResult(message: string): ExportsErrorResult {
  return { ok: false, code: "invalid_input", message };
}
export const EXPORTS_NEUTRAL_NOT_FOUND_MESSAGE = "Not found.";
export function exportsNotFoundResult(message: string = EXPORTS_NEUTRAL_NOT_FOUND_MESSAGE): ExportsErrorResult {
  return { ok: false, code: "not_found", message };
}
export function exportsSourceUnavailableResult(message: string): ExportsErrorResult {
  return { ok: false, code: "source_unavailable", message };
}
export function exportsInternalResult(message = "Something went wrong."): ExportsErrorResult {
  return { ok: false, code: "internal", message };
}

// --- Export job (Firestore-backed, mutable across a few lifecycle states) --------------------------
// Deliberately the smallest state set this implementation actually needs (per the spec's own "use
// only the lifecycle states the implementation actually needs" instruction): a job is created
// PENDING, immediately transitions to GENERATING while the file is produced, then to exactly one of
// COMPLETED (an artifact exists) or FAILED (a safe, provider-neutral errorMessage exists, no
// artifact). There is no queue/worker in this stage - generation is synchronous - but the states are
// real, persisted transitions, not a cosmetic label.
export const EXPORT_JOB_STATUSES = ["PENDING", "GENERATING", "COMPLETED", "FAILED"] as const;
export const exportJobStatusSchema = z.enum(EXPORT_JOB_STATUSES);
export type ExportJobStatus = z.infer<typeof exportJobStatusSchema>;

const isoTimestamp = z.string().min(1);
const nonEmpty = z.string().min(1);

export const exportJobRefSchema = z.string().regex(/^exp_[0-9a-f]{20}$/, "Invalid export job reference.");
export const exportArtifactRefSchema = z.string().regex(/^exa_[0-9a-f]{20}$/, "Invalid export artifact reference.");

// Firestore document shape. `artifactRef` is an opaque, unguessable client-facing handle (same
// discipline as finance-agreements' own ContractArtifactDto.artifactRef) - it is NOT the raw Storage
// locator (see artifact-store.ts's own comment: the locator is a server-only string, derived only
// inside the store, and never stored on this doc or handed to a client).
export const exportJobDocSchema = z
  .object({
    jobRef: nonEmpty,
    createdByUserRef: nonEmpty,
    targetId: exportTargetIdSchema,
    format: exportFormatSchema,
    requestedColumns: z.array(nonEmpty),
    appliedFilters: z.record(z.string(), z.string()),
    status: exportJobStatusSchema,
    createdAt: isoTimestamp,
    generatingAt: isoTimestamp.optional(),
    completedAt: isoTimestamp.optional(),
    failedAt: isoTimestamp.optional(),
    errorMessage: z.string().optional(),
    rowCount: z.number().int().min(0).optional(),
    truncated: z.boolean().optional(),
    maxRows: z.number().int().min(1),
    artifactRef: exportArtifactRefSchema.optional(),
    fileName: z.string().optional(),
  })
  .strict();
export type ExportJobDoc = z.infer<typeof exportJobDocSchema>;

export const createExportJobInputSchema = z
  .object({
    targetId: z.string().min(1),
    format: z.string().min(1),
    columns: z.array(z.string()).optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CreateExportJobInput = z.infer<typeof createExportJobInputSchema>;

export const MAX_JOB_LIST_PAGE_SIZE = 50;
export const DEFAULT_JOB_LIST_PAGE_SIZE = 20;
