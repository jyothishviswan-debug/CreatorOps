import { describe, expect, it } from "vitest";

import { MODULE_ACTIONS } from "@/server/authz/module-actions";

import { derivePaymentPermissions, NO_PAYMENT_PERMISSIONS } from "./payment-permissions";

describe("derivePaymentPermissions", () => {
  it("holds nothing without the finance feature, regardless of any action grant", () => {
    const result = derivePaymentPermissions({ financeView: false, managePayments: true, confirmPayments: true, voidPayments: true, overridePaymentOverage: true, financeAmounts: true });
    expect(result).toEqual(NO_PAYMENT_PERMISSIONS);
  });

  it("canManage/canConfirm/canVoid each require their own exact action, independent of the others", () => {
    const base = { financeView: true, managePayments: false, confirmPayments: false, voidPayments: false, overridePaymentOverage: false, financeAmounts: false };
    expect(derivePaymentPermissions({ ...base, managePayments: true }).canManage).toBe(true);
    expect(derivePaymentPermissions({ ...base, managePayments: true }).canConfirm).toBe(false);
    expect(derivePaymentPermissions({ ...base, confirmPayments: true }).canConfirm).toBe(true);
    expect(derivePaymentPermissions({ ...base, confirmPayments: true }).canManage).toBe(false);
    expect(derivePaymentPermissions({ ...base, voidPayments: true }).canVoid).toBe(true);
  });

  it("canOverrideOverage requires BOTH the exact action AND finance_amounts", () => {
    const base = { financeView: true, managePayments: false, confirmPayments: false, voidPayments: false, overridePaymentOverage: false, financeAmounts: false };
    expect(derivePaymentPermissions({ ...base, overridePaymentOverage: true, financeAmounts: false }).canOverrideOverage).toBe(false);
    expect(derivePaymentPermissions({ ...base, overridePaymentOverage: false, financeAmounts: true }).canOverrideOverage).toBe(false);
    expect(derivePaymentPermissions({ ...base, overridePaymentOverage: true, financeAmounts: true }).canOverrideOverage).toBe(true);
  });

  it("canViewAmounts requires finance_amounts and nothing else", () => {
    expect(derivePaymentPermissions({ financeView: true, managePayments: false, confirmPayments: false, voidPayments: false, overridePaymentOverage: false, financeAmounts: true }).canViewAmounts).toBe(true);
  });

  it("every Payment action id this module checks is a real entry in the canonical finance module-action catalog", () => {
    const financeActionIds = MODULE_ACTIONS.finance.map((entry) => entry.id);
    for (const action of ["manage_payments", "confirm_payments", "void_payments", "override_payment_overage"]) {
      expect(financeActionIds).toContain(action);
    }
  });
});
