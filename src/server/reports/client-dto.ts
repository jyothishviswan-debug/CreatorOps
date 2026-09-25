import type { ReportDefinition, ReportResult, ReportSnapshotDoc } from "./types";

// Step 19A: the only shapes ever handed to the browser. A ReportDefinition/ReportResult is already
// built entirely from safe, already-vetted fields (no raw Firebase uid, no Firestore path, no
// sensitive category value) - this file's job is to pin that as the CONTRACT (so a future change to
// types.ts can't silently widen what a route serializes) and to convert the server-only
// ReportSnapshotDoc into its own safe DTO (createdByUserRef stays a userRef, never a raw uid - same
// discipline as every other module's own client-dto.ts).

export type ReportDefinitionDto = ReportDefinition;
export type ReportResultDto = ReportResult;

export type ReportSnapshotDto = {
  snapshotRef: string;
  reportId: ReportSnapshotDoc["reportId"];
  definitionVersion: number;
  generatedAt: string;
  evidenceCutoff: string;
  appliedFilters: Record<string, string>;
  scopeSummary: ReportSnapshotDoc["scopeSummary"];
  limitations: string[];
  truncated: boolean;
  rowCount: number;
  maxRows: number;
  result: ReportSnapshotDoc["result"];
  createdAt: string;
  createdByUserRef: string;
};

export function toReportSnapshotDto(doc: ReportSnapshotDoc): ReportSnapshotDto {
  return {
    snapshotRef: doc.snapshotRef,
    reportId: doc.reportId,
    definitionVersion: doc.definitionVersion,
    generatedAt: doc.generatedAt,
    evidenceCutoff: doc.evidenceCutoff,
    appliedFilters: doc.appliedFilters,
    scopeSummary: doc.scopeSummary,
    limitations: doc.limitations,
    truncated: doc.truncated,
    rowCount: doc.rowCount,
    maxRows: doc.maxRows,
    result: doc.result,
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
  };
}
