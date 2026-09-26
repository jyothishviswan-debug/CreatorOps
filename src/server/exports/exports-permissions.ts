import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import type { ActorContext } from "@/server/authz/types";

// What the browser may OFFER, computed from REAL grants (feature/action) - never from a role name.
// Mirrors src/server/reports/reports-permissions.ts exactly.
export type ExportsPermissionsDto = { canView: boolean; canCreateExports: boolean };

export function deriveExportsPermissions(inputs: { exportsView: boolean; createExports: boolean }): ExportsPermissionsDto {
  return { canView: inputs.exportsView, canCreateExports: inputs.exportsView && inputs.createExports };
}

export const NO_EXPORTS_PERMISSIONS: ExportsPermissionsDto = deriveExportsPermissions({ exportsView: false, createExports: false });

export async function computeExportsPermissions(actor: ActorContext | null): Promise<ExportsPermissionsDto> {
  if (!actor) return NO_EXPORTS_PERMISSIONS;
  const [exportsView, createExports] = await Promise.all([canAccessFeature(actor, "exports"), canPerformAction(actor, "exports", "create_exports")]);
  return deriveExportsPermissions({ exportsView, createExports });
}
