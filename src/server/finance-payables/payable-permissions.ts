import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { canAccessSensitive } from "@/server/authz/sensitive";
import type { ActorContext } from "@/server/authz/types";

import type { PayablePermissionsDto } from "./client-dto";
import { FINANCE_AMOUNTS_CATEGORY } from "./finance-payables-gate";

// Step 15A: what the browser may OFFER, computed from REAL grants (feature / action / sensitive
// category) - never from a role name, and never a substitute for the services' own gates (every
// mutation re-checks server-side; these booleans only decide which controls are rendered, so
// nothing is revealed and then hidden).
//
//   canView         `finance` feature view
//   canManage       canView + manage_payables      (create / revise a DRAFT payable)
//   canApprove      canView + approve_payables     (move to READY_FOR_INVOICE)
//   canAdjust       canView + adjust_payables + finance_amounts
//                   (a manual financial adjustment needs BOTH the exact action AND the amounts
//                    category - you cannot set money you are not allowed to see)
//   canVoid         canView + void_payables
//   canViewAmounts  canView + finance_amounts      (otherwise every figure is withheld)

export type PayablePermissionInputs = {
  financeView: boolean;
  managePayables: boolean;
  approvePayables: boolean;
  adjustPayables: boolean;
  voidPayables: boolean;
  financeAmounts: boolean;
};

// Pure derivation (unit-tested): every boolean requires the finance feature first - a role without
// it holds nothing here.
export function derivePayablePermissions(inputs: PayablePermissionInputs): PayablePermissionsDto {
  const view = inputs.financeView;
  return {
    canView: view,
    canManage: view && inputs.managePayables,
    canApprove: view && inputs.approvePayables,
    canAdjust: view && inputs.adjustPayables && inputs.financeAmounts,
    canVoid: view && inputs.voidPayables,
    canViewAmounts: view && inputs.financeAmounts,
  };
}

export const NO_PAYABLE_PERMISSIONS: PayablePermissionsDto = derivePayablePermissions({
  financeView: false,
  managePayables: false,
  approvePayables: false,
  adjustPayables: false,
  voidPayables: false,
  financeAmounts: false,
});

export async function computePayablePermissions(actor: ActorContext | null): Promise<PayablePermissionsDto> {
  if (!actor) return NO_PAYABLE_PERMISSIONS;
  const [financeView, managePayables, approvePayables, adjustPayables, voidPayables, financeAmounts] = await Promise.all([
    canAccessFeature(actor, "finance"),
    canPerformAction(actor, "finance", "manage_payables"),
    canPerformAction(actor, "finance", "approve_payables"),
    canPerformAction(actor, "finance", "adjust_payables"),
    canPerformAction(actor, "finance", "void_payables"),
    canAccessSensitive(actor, FINANCE_AMOUNTS_CATEGORY),
  ]);
  return derivePayablePermissions({ financeView, managePayables, approvePayables, adjustPayables, voidPayables, financeAmounts });
}
