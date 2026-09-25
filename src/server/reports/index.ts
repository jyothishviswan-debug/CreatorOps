// Step 19A: the public service surface of the Governed Reports backend/domain foundation.
//
// Routes import from here; internals (the catalog's own family dispatch table, Firestore helpers)
// stay module-private where practical. Mirrors src/server/operations/index.ts's barrel shape.
export { getReportDefinition, listReportDefinitions } from "./catalog";
export { getReportDefinitionForActor, listReportCatalogForActor, runReport } from "./report-service";
export { computeReportsPermissions, type ReportsPermissionsDto } from "./reports-permissions";
export { finalizeReport, getFinalizedSnapshot, listMyFinalizedSnapshots } from "./snapshot-service";
export { toReportSnapshotDto, type ReportDefinitionDto, type ReportResultDto, type ReportSnapshotDto } from "./client-dto";
export { REPORT_IDS, isReportId, type ReportDefinition, type ReportId, type ReportResult, type ReportSnapshotDoc, type ReportsServiceResult } from "./types";
