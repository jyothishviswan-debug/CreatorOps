import { describe, expect, it } from "vitest";

import { deriveExportsPermissions, NO_EXPORTS_PERMISSIONS } from "./exports-permissions";

describe("deriveExportsPermissions", () => {
  it("denies everything with no view grant, even if createExports is somehow true", () => {
    expect(deriveExportsPermissions({ exportsView: false, createExports: true })).toEqual({ canView: false, canCreateExports: false });
  });

  it("view without create_exports can see but not create", () => {
    expect(deriveExportsPermissions({ exportsView: true, createExports: false })).toEqual({ canView: true, canCreateExports: false });
  });

  it("view with create_exports can do both", () => {
    expect(deriveExportsPermissions({ exportsView: true, createExports: true })).toEqual({ canView: true, canCreateExports: true });
  });

  it("NO_EXPORTS_PERMISSIONS is fully closed", () => {
    expect(NO_EXPORTS_PERMISSIONS).toEqual({ canView: false, canCreateExports: false });
  });
});
