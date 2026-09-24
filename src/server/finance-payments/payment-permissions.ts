import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { canAccessSensitive } from "@/server/authz/sensitive";
import type { ActorContext } from "@/server/authz/types";

import type { PaymentPermissionsDto } from "./client-dto";
import { FINANCE_AMOUNTS_CATEGORY } from "./finance-payments-gate";

// Step 17A: what the browser may OFFER, computed from REAL grants (feature / action / sensitive
// category) - never from a role name, and never a substitute for the services' own gates (every
// mutation re-checks server-side). Mirrors Invoices' own invoice-permissions.ts exactly.
//
//   canView              `finance` feature view
//   canManage             canView + manage_payments   (create/revise a draft, record a transfer)
//   canConfirm             canView + confirm_payments
//   canVoid                canView + void_payments
//   canOverrideOverage    canView + override_payment_overage + finance_amounts
//   canViewAmounts        canView + finance_amounts   (otherwise every figure is withheld)

export type PaymentPermissionInputs = {
  financeView: boolean;
  managePayments: boolean;
  confirmPayments: boolean;
  voidPayments: boolean;
  overridePaymentOverage: boolean;
  financeAmounts: boolean;
};

export function derivePaymentPermissions(inputs: PaymentPermissionInputs): PaymentPermissionsDto {
  const view = inputs.financeView;
  return {
    canView: view,
    canManage: view && inputs.managePayments,
    canConfirm: view && inputs.confirmPayments,
    canVoid: view && inputs.voidPayments,
    canOverrideOverage: view && inputs.overridePaymentOverage && inputs.financeAmounts,
    canViewAmounts: view && inputs.financeAmounts,
  };
}

export const NO_PAYMENT_PERMISSIONS: PaymentPermissionsDto = derivePaymentPermissions({
  financeView: false,
  managePayments: false,
  confirmPayments: false,
  voidPayments: false,
  overridePaymentOverage: false,
  financeAmounts: false,
});

export async function computePaymentPermissions(actor: ActorContext | null): Promise<PaymentPermissionsDto> {
  if (!actor) return NO_PAYMENT_PERMISSIONS;
  const [financeView, managePayments, confirmPayments, voidPayments, overridePaymentOverage, financeAmounts] = await Promise.all([
    canAccessFeature(actor, "finance"),
    canPerformAction(actor, "finance", "manage_payments"),
    canPerformAction(actor, "finance", "confirm_payments"),
    canPerformAction(actor, "finance", "void_payments"),
    canPerformAction(actor, "finance", "override_payment_overage"),
    canAccessSensitive(actor, FINANCE_AMOUNTS_CATEGORY),
  ]);
  return derivePaymentPermissions({ financeView, managePayments, confirmPayments, voidPayments, overridePaymentOverage, financeAmounts });
}
