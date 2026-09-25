import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import type { ActorContext } from "@/server/authz/types";

// Step 19A: what the browser may OFFER, computed from REAL grants (feature/action) - never from a
// role name. Mirrors src/server/operations/operations-permissions.ts exactly.
export type ReportsPermissionsDto = { canView: boolean; canRunReports: boolean; canViewerSafeRun: boolean; canExport: boolean };

export type ReportsPermissionInputs = { reportsView: boolean; runReports: boolean; exportReports: boolean };

export function deriveReportsPermissions(inputs: ReportsPermissionInputs): ReportsPermissionsDto {
  const view = inputs.reportsView;
  return {
    canView: view,
    canRunReports: view && inputs.runReports,
    // The Viewer-safe run path needs nothing beyond the plain "reports" feature grant every
    // view-holding role already carries - see reports-gate.ts's own comment.
    canViewerSafeRun: view,
    canExport: view && inputs.exportReports,
  };
}

export const NO_REPORTS_PERMISSIONS: ReportsPermissionsDto = deriveReportsPermissions({ reportsView: false, runReports: false, exportReports: false });

export async function computeReportsPermissions(actor: ActorContext | null): Promise<ReportsPermissionsDto> {
  if (!actor) return NO_REPORTS_PERMISSIONS;
  const [reportsView, runReports, exportReports] = await Promise.all([canAccessFeature(actor, "reports"), canPerformAction(actor, "reports", "run_reports"), canPerformAction(actor, "reports", "export")]);
  return deriveReportsPermissions({ reportsView, runReports, exportReports });
}
