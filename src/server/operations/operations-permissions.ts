import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import type { ActorContext } from "@/server/authz/types";

import type { OperationsPermissionsDto } from "./client-dto";

// Step 18A: what the browser may OFFER, computed from REAL grants (feature/action) - never from a
// role name. Mirrors src/server/finance-payments/payment-permissions.ts exactly.
export type OperationsPermissionInputs = { operationsView: boolean; manageTasks: boolean; assignTasks: boolean; completeTasks: boolean; viewApprovalQueue: boolean; manageReminders: boolean };

export function deriveOperationsPermissions(inputs: OperationsPermissionInputs): OperationsPermissionsDto {
  const view = inputs.operationsView;
  return {
    canView: view,
    canManageTasks: view && inputs.manageTasks,
    canAssignTasks: view && inputs.assignTasks,
    canCompleteTasks: view && inputs.completeTasks,
    canViewApprovalQueue: view && inputs.viewApprovalQueue,
    canManageReminders: view && inputs.manageReminders,
  };
}

export const NO_OPERATIONS_PERMISSIONS: OperationsPermissionsDto = deriveOperationsPermissions({ operationsView: false, manageTasks: false, assignTasks: false, completeTasks: false, viewApprovalQueue: false, manageReminders: false });

export async function computeOperationsPermissions(actor: ActorContext | null): Promise<OperationsPermissionsDto> {
  if (!actor) return NO_OPERATIONS_PERMISSIONS;
  const [operationsView, manageTasks, assignTasks, completeTasks, viewApprovalQueue, manageReminders] = await Promise.all([
    canAccessFeature(actor, "operations"),
    canPerformAction(actor, "operations", "manage_tasks"),
    canPerformAction(actor, "operations", "assign_tasks"),
    canPerformAction(actor, "operations", "complete_tasks"),
    canPerformAction(actor, "operations", "view_approval_queue"),
    canPerformAction(actor, "operations", "manage_reminders"),
  ]);
  return deriveOperationsPermissions({ operationsView, manageTasks, assignTasks, completeTasks, viewApprovalQueue, manageReminders });
}
