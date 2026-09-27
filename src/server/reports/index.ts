// Step 19A: the public service surface of the Governed Reports backend/domain foundation.
//
// Routes import from here; internals (the catalog's own family dispatch table, Firestore helpers)
// stay module-private where practical. Mirrors src/server/operations/index.ts's barrel shape.
export { getReportDefinition, listReportDefinitions } from "./catalog";
export { getReportDefinitionForActor, listReportCatalogForActor, runReport } from "./report-service";
export { computeReportsPermissions, type ReportsPermissionsDto } from "./reports-permissions";
export { finalizeReport, getFinalizedSnapshot, listMyFinalizedSnapshots } from "./snapshot-service";
export { toReportSnapshotDto, type ReportDefinitionDto, type ReportResultDto, type ReportSnapshotDto } from "./client-dto";
export { REPORT_IDS, isReportId, type ReportArtifactDoc, type ReportDefinition, type ReportFilterFieldDef, type ReportId, type ReportResult, type ReportSnapshotDoc, type ReportsServiceResult } from "./types";

// Reports Final-Master: the publication lifecycle service surface.
export {
  createDraftReportRun,
  createSupersedingReportVersion,
  evaluateFinalizationDataQualityGate,
  finalizeReportVersion,
  getReportRunDetail,
  listArtifactsForVersion,
  listMyReportRuns,
  listReportRunVersionSummaries,
  runEvidenceForDraft,
  saveNarrativeSection,
  submitReportForReview,
  type ReportRunDetailDto,
  type ReportVersionSummary,
} from "./report-lifecycle-service";
export { downloadReportArtifact, type ReportArtifactDownload } from "./report-artifacts/download-service";
export { getReportTemplateDefinition, isReportTemplateId, listReportTemplateDefinitions, NARRATIVE_SECTION_LABELS, REPORT_NARRATIVE_SECTION_KEYS, REPORT_TEMPLATE_IDS, type ReportNarrativeSectionKey, type ReportTemplateDefinition, type ReportTemplateId } from "./report-templates";
