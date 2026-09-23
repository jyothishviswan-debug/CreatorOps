import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { canAccessSensitive } from "@/server/authz/sensitive";
import type { ActorContext } from "@/server/authz/types";

import type { InvoicePermissionsDto } from "./client-dto";
import { FINANCE_AMOUNTS_CATEGORY } from "./finance-invoices-gate";

// Step 16A: what the browser may OFFER, computed from REAL grants (feature / action / sensitive
// category) - never from a role name, and never a substitute for the services' own gates (every
// mutation re-checks server-side). Mirrors Payables' own payable-permissions.ts exactly.
//
//   canView             `finance` feature view
//   canManage            canView + manage_invoices   (create/edit/submit a DRAFT or reopened Invoice)
//   canApprove           canView + approve_invoices  (approve or reject a SUBMITTED Invoice)
//   canVoid              canView + void_invoices
//   canOverrideMismatch  canView + override_invoice_mismatch + finance_amounts
//   canViewAmounts       canView + finance_amounts   (otherwise every figure is withheld)

export type InvoicePermissionInputs = {
  financeView: boolean;
  manageInvoices: boolean;
  approveInvoices: boolean;
  voidInvoices: boolean;
  overrideInvoiceMismatch: boolean;
  financeAmounts: boolean;
};

// Pure derivation (unit-tested): every boolean requires the finance feature first.
export function deriveInvoicePermissions(inputs: InvoicePermissionInputs): InvoicePermissionsDto {
  const view = inputs.financeView;
  return {
    canView: view,
    canManage: view && inputs.manageInvoices,
    canApprove: view && inputs.approveInvoices,
    canVoid: view && inputs.voidInvoices,
    canOverrideMismatch: view && inputs.overrideInvoiceMismatch && inputs.financeAmounts,
    canViewAmounts: view && inputs.financeAmounts,
  };
}

export const NO_INVOICE_PERMISSIONS: InvoicePermissionsDto = deriveInvoicePermissions({
  financeView: false,
  manageInvoices: false,
  approveInvoices: false,
  voidInvoices: false,
  overrideInvoiceMismatch: false,
  financeAmounts: false,
});

export async function computeInvoicePermissions(actor: ActorContext | null): Promise<InvoicePermissionsDto> {
  if (!actor) return NO_INVOICE_PERMISSIONS;
  const [financeView, manageInvoices, approveInvoices, voidInvoices, overrideInvoiceMismatch, financeAmounts] = await Promise.all([
    canAccessFeature(actor, "finance"),
    canPerformAction(actor, "finance", "manage_invoices"),
    canPerformAction(actor, "finance", "approve_invoices"),
    canPerformAction(actor, "finance", "void_invoices"),
    canPerformAction(actor, "finance", "override_invoice_mismatch"),
    canAccessSensitive(actor, FINANCE_AMOUNTS_CATEGORY),
  ]);
  return deriveInvoicePermissions({ financeView, manageInvoices, approveInvoices, voidInvoices, overrideInvoiceMismatch, financeAmounts });
}
