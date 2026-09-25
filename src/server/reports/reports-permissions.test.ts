import { describe, expect, it } from "vitest";

import { deriveReportsPermissions, NO_REPORTS_PERMISSIONS } from "./reports-permissions";

describe("deriveReportsPermissions", () => {
  it("every permission is false when the actor cannot even view Reports, regardless of individual action grants", () => {
    const result = deriveReportsPermissions({ reportsView: false, runReports: true, exportReports: true });
    expect(result).toEqual(NO_REPORTS_PERMISSIONS);
  });

  it("a view-only grant (Viewer's real shape) yields canView + canViewerSafeRun true, but canRunReports/canExport false", () => {
    const viewOnly = deriveReportsPermissions({ reportsView: true, runReports: false, exportReports: false });
    expect(viewOnly).toEqual({ canView: true, canRunReports: false, canViewerSafeRun: true, canExport: false });
  });

  it("full grants yield every permission true", () => {
    const full = deriveReportsPermissions({ reportsView: true, runReports: true, exportReports: true });
    expect(full).toEqual({ canView: true, canRunReports: true, canViewerSafeRun: true, canExport: true });
  });

  it("canRunReports/canExport require BOTH view AND their own exact grant - never derived from the other", () => {
    const onlyRun = deriveReportsPermissions({ reportsView: true, runReports: true, exportReports: false });
    expect(onlyRun.canRunReports).toBe(true);
    expect(onlyRun.canExport).toBe(false);
  });
});
