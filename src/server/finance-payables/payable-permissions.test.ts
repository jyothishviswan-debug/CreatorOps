import { describe, expect, it } from "vitest";

import { ACTIONS } from "@/server/authz/actions";
import { MODULE_ACTIONS } from "@/server/authz/module-actions";
import { SENSITIVE_CATEGORIES } from "@/server/authz/sensitive-categories";

import { derivePayablePermissions, NO_PAYABLE_PERMISSIONS, type PayablePermissionInputs } from "./payable-permissions";

// Step 15A section 12: THE PAYABLES PERMISSION MATRIX, documented in a test as the spec requires.
//
// There are six separable capabilities and every one of them is an EXPLICIT grant. There is no
// wildcard, no minimum role, no role ranking and no implication of one capability by another -
// holding manage_payables never implies approve_payables, adjust_payables or void_payables, and
// none of the four implies the finance_amounts sensitive category.
//
//   capability                              feature   action             sensitive category
//   ------------------------------------------------------------------------------------------
//   view Payables                           finance   (none)             -
//   create / edit draft Payables            finance   manage_payables    -
//   move Payable to READY_FOR_INVOICE       finance   approve_payables   -
//   void Payable                            finance   void_payables      -
//   add manual financial adjustment         finance   adjust_payables    finance_amounts
//   see exact Payable amounts               finance   (none)             finance_amounts
//
// SEED ROLE GRANTS (src/server/authz/seed-access-data.ts), conservative where no
// product-authoritative grant existed - except finance_amounts for Manager, which is an explicit
// product confirmation (Step 15A follow-up), not a conservative default:
//
//   role                  finance  manage_payables  approve_payables  adjust_payables  void_payables  finance_amounts
//   -----------------------------------------------------------------------------------------------------------------
//   viewer                no       no               no                no               no             no
//   analyst               no       no               no                no               no             no
//   partnership_manager   yes      YES              no                no               no             YES
//   partnership_head      yes      YES              YES               YES              YES            YES
//   super_admin           yes      YES              YES               YES              YES            YES
//
// The Manager row is the "day-to-day but not governance" split this codebase uses everywhere:
// Manager operates and SEES the Payables workflow (including exact amounts) but cannot finalize,
// void, or hand-adjust one - canAdjust still needs adjustPayables too (see the "BOTH" test below),
// which Manager does not hold, so finance_amounts alone does not grant adjustment.

const NONE: PayablePermissionInputs = { financeView: false, managePayables: false, approvePayables: false, adjustPayables: false, voidPayables: false, financeAmounts: false };

const ROLE_INPUTS: Record<string, PayablePermissionInputs> = {
  viewer: NONE,
  analyst: NONE,
  partnership_manager: { financeView: true, managePayables: true, approvePayables: false, adjustPayables: false, voidPayables: false, financeAmounts: true },
  partnership_head: { financeView: true, managePayables: true, approvePayables: true, adjustPayables: true, voidPayables: true, financeAmounts: true },
  super_admin: { financeView: true, managePayables: true, approvePayables: true, adjustPayables: true, voidPayables: true, financeAmounts: true },
};

describe("the vocabulary this module relies on actually exists", () => {
  it("the two new Payable actions are in the canonical action catalog and in the finance module's own action list", () => {
    for (const action of ["manage_payables", "approve_payables", "adjust_payables", "void_payables"]) {
      expect(ACTIONS as readonly string[]).toContain(action);
      expect(MODULE_ACTIONS.finance.map((entry) => entry.id)).toContain(action);
    }
  });

  it("the amounts gate is the existing canonical finance_amounts category, not a new one", () => {
    const category = SENSITIVE_CATEGORIES.find((entry) => entry.id === "finance_amounts");
    expect(category?.description).toMatch(/Payable/);
  });
});

describe("the derived permission matrix", () => {
  it("Viewer and Analyst hold nothing at all - no finance feature means no Payables capability", () => {
    for (const role of ["viewer", "analyst"]) {
      expect(derivePayablePermissions(ROLE_INPUTS[role]!), role).toEqual(NO_PAYABLE_PERMISSIONS);
    }
  });

  it("Manager may view, prepare a draft, and see exact amounts, but may not finalize, void, or hand-adjust", () => {
    expect(derivePayablePermissions(ROLE_INPUTS.partnership_manager!)).toEqual({ canView: true, canManage: true, canApprove: false, canAdjust: false, canVoid: false, canViewAmounts: true });
  });

  it("Head and Super Admin hold every capability", () => {
    for (const role of ["partnership_head", "super_admin"]) {
      expect(derivePayablePermissions(ROLE_INPUTS[role]!), role).toEqual({ canView: true, canManage: true, canApprove: true, canAdjust: true, canVoid: true, canViewAmounts: true });
    }
  });
});

describe("fail-closed and non-implication", () => {
  it("every capability requires the finance feature first - an action grant alone holds nothing", () => {
    const actionsOnly = derivePayablePermissions({ financeView: false, managePayables: true, approvePayables: true, adjustPayables: true, voidPayables: true, financeAmounts: true });
    expect(actionsOnly).toEqual(NO_PAYABLE_PERMISSIONS);
  });

  it("a manual adjustment needs BOTH the exact action and the amounts category - neither alone is enough", () => {
    const actionOnly = { ...NONE, financeView: true, adjustPayables: true };
    const categoryOnly = { ...NONE, financeView: true, financeAmounts: true };
    expect(derivePayablePermissions(actionOnly).canAdjust).toBe(false);
    expect(derivePayablePermissions(categoryOnly).canAdjust).toBe(false);
    expect(derivePayablePermissions({ ...actionOnly, financeAmounts: true }).canAdjust).toBe(true);
  });

  it("no capability implies another: granting exactly one leaves every other false", () => {
    const only = (key: keyof PayablePermissionInputs) => derivePayablePermissions({ ...NONE, financeView: true, [key]: true });
    expect(only("managePayables")).toEqual({ canView: true, canManage: true, canApprove: false, canAdjust: false, canVoid: false, canViewAmounts: false });
    expect(only("approvePayables")).toEqual({ canView: true, canManage: false, canApprove: true, canAdjust: false, canVoid: false, canViewAmounts: false });
    expect(only("voidPayables")).toEqual({ canView: true, canManage: false, canApprove: false, canAdjust: false, canVoid: true, canViewAmounts: false });
    expect(only("financeAmounts")).toEqual({ canView: true, canManage: false, canApprove: false, canAdjust: false, canVoid: false, canViewAmounts: true });
  });
});
