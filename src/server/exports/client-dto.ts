import type { ExportJobDoc, ExportJobStatus, ExportTargetDefinition } from "./types";

// The catalog's own definitions are already entirely safe, descriptive metadata (title, description,
// filters, column labels, limitations) - no server secret, no locator, nothing restricted - so the
// target DTO is a plain passthrough of ExportTargetDefinition, same as Reports' own
// ReportDefinitionDto treats ReportDefinition.
export type ExportTargetDto = ExportTargetDefinition;

// The ONLY shape of an export job ever handed to the browser. Deliberately omits nothing sensitive
// (there is nothing sensitive on ExportJobDoc to omit) but this indirection exists so a future field
// added to ExportJobDoc must be deliberately added here too, rather than silently reaching the
// browser - same discipline as every other module's own toXDto function.
export type ExportJobDto = {
  jobRef: string;
  targetId: string;
  format: string;
  requestedColumns: string[];
  appliedFilters: Record<string, string>;
  status: ExportJobStatus;
  createdAt: string;
  generatingAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  errorMessage: string | null;
  rowCount: number | null;
  truncated: boolean | null;
  maxRows: number;
  // Present only once COMPLETED. This is the opaque, unguessable client-facing handle (never the raw
  // Storage locator - see artifact-store.ts's own comment) used solely to request
  // /api/exports/jobs/{jobRef}/artifact, which re-authorizes against the job's own actor scope before
  // ever touching the store.
  hasArtifact: boolean;
};

export function toExportJobDto(doc: ExportJobDoc): ExportJobDto {
  return {
    jobRef: doc.jobRef,
    targetId: doc.targetId,
    format: doc.format,
    requestedColumns: doc.requestedColumns,
    appliedFilters: doc.appliedFilters,
    status: doc.status,
    createdAt: doc.createdAt,
    generatingAt: doc.generatingAt ?? null,
    completedAt: doc.completedAt ?? null,
    failedAt: doc.failedAt ?? null,
    errorMessage: doc.errorMessage ?? null,
    rowCount: doc.rowCount ?? null,
    truncated: doc.truncated ?? null,
    maxRows: doc.maxRows,
    hasArtifact: doc.status === "COMPLETED" && Boolean(doc.artifactRef),
  };
}
