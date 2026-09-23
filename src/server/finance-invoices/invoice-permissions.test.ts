import { describe, expect, it } from "vitest";

import { MODULE_ACTIONS } from "@/server/authz/module-actions";

import { deriveInvoicePermissions, NO_INVOICE_PERMISSIONS } from "./invoice-permissions";

describe("deriveInvoicePermissions", () => {
  it("holds nothing without the finance feature, regardless of any action grant", () => {
    const result = deriveInvoicePermissions({ financeView: false, manageInvoices: true, approveInvoices: true, voidInvoices: true, overrideInvoiceMismatch: true, financeAmounts: true });
    expect(result).toEqual(NO_INVOICE_PERMISSIONS);
  });

  it("canManage/canApprove/canVoid each require their own exact action, independent of the others", () => {
    const base = { financeView: true, manageInvoices: false, approveInvoices: false, voidInvoices: false, overrideInvoiceMismatch: false, financeAmounts: false };
    expect(deriveInvoicePermissions({ ...base, manageInvoices: true }).canManage).toBe(true);
    expect(deriveInvoicePermissions({ ...base, manageInvoices: true }).canApprove).toBe(false);
    expect(deriveInvoicePermissions({ ...base, approveInvoices: true }).canApprove).toBe(true);
    expect(deriveInvoicePermissions({ ...base, approveInvoices: true }).canManage).toBe(false);
    expect(deriveInvoicePermissions({ ...base, voidInvoices: true }).canVoid).toBe(true);
  });

  it("canOverrideMismatch requires BOTH the exact action AND finance_amounts", () => {
    const base = { financeView: true, manageInvoices: false, approveInvoices: false, voidInvoices: false, overrideInvoiceMismatch: false, financeAmounts: false };
    expect(deriveInvoicePermissions({ ...base, overrideInvoiceMismatch: true, financeAmounts: false }).canOverrideMismatch).toBe(false);
    expect(deriveInvoicePermissions({ ...base, overrideInvoiceMismatch: false, financeAmounts: true }).canOverrideMismatch).toBe(false);
    expect(deriveInvoicePermissions({ ...base, overrideInvoiceMismatch: true, financeAmounts: true }).canOverrideMismatch).toBe(true);
  });

  it("canViewAmounts requires finance_amounts and nothing else", () => {
    expect(deriveInvoicePermissions({ financeView: true, manageInvoices: false, approveInvoices: false, voidInvoices: false, overrideInvoiceMismatch: false, financeAmounts: true }).canViewAmounts).toBe(true);
  });

  it("every Invoice action id this module checks is a real entry in the canonical finance module-action catalog", () => {
    const financeActionIds = MODULE_ACTIONS.finance.map((entry) => entry.id);
    for (const action of ["manage_invoices", "approve_invoices", "void_invoices", "override_invoice_mismatch"]) {
      expect(financeActionIds).toContain(action);
    }
  });
});
