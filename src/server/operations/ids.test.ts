import { describe, expect, it } from "vitest";

import { buildApprovalItemRef, buildSourceKey, generateReminderRef, generateTaskRef, sourceKeyDocId } from "./ids";

describe("generateTaskRef / generateReminderRef", () => {
  it("produce the expected opaque prefix+hex shape and are unique across calls", () => {
    const refs = new Set(Array.from({ length: 20 }, () => generateTaskRef()));
    expect(refs.size).toBe(20);
    for (const ref of refs) expect(ref).toMatch(/^tsk_[0-9a-f]{20}$/);

    const reminderRefs = new Set(Array.from({ length: 20 }, () => generateReminderRef()));
    expect(reminderRefs.size).toBe(20);
    for (const ref of reminderRefs) expect(ref).toMatch(/^rmd_[0-9a-f]{20}$/);
  });
});

describe("buildSourceKey (section 8: deterministic/idempotent source keys)", () => {
  it("is a pure function of its inputs - identical inputs always produce the identical key", () => {
    const a = buildSourceKey({ origin: "APPROVAL_FOLLOW_UP", targetType: "INVOICE", targetRef: "inv_abc", targetVersion: 2, qualifier: "follow-up" });
    const b = buildSourceKey({ origin: "APPROVAL_FOLLOW_UP", targetType: "INVOICE", targetRef: "inv_abc", targetVersion: 2, qualifier: "follow-up" });
    expect(a).toBe(b);
  });

  it("changes when any one input changes", () => {
    const base = buildSourceKey({ origin: "MODULE_ACTION", targetType: "PAYABLE", targetRef: "pyb_1", targetVersion: 1, qualifier: "q" });
    expect(buildSourceKey({ origin: "MODULE_ACTION", targetType: "PAYABLE", targetRef: "pyb_2", targetVersion: 1, qualifier: "q" })).not.toBe(base);
    expect(buildSourceKey({ origin: "MODULE_ACTION", targetType: "PAYABLE", targetRef: "pyb_1", targetVersion: 2, qualifier: "q" })).not.toBe(base);
    expect(buildSourceKey({ origin: "MODULE_ACTION", targetType: "PAYABLE", targetRef: "pyb_1", targetVersion: 1, qualifier: "r" })).not.toBe(base);
  });

  it("treats a missing targetVersion consistently ('none')", () => {
    const withoutVersion = buildSourceKey({ origin: "MODULE_ACTION", targetType: "PARTNER", targetRef: "p1", qualifier: "q" });
    const withNullVersion = buildSourceKey({ origin: "MODULE_ACTION", targetType: "PARTNER", targetRef: "p1", targetVersion: null, qualifier: "q" });
    expect(withoutVersion).toBe(withNullVersion);
    expect(withoutVersion).toContain("|none|");
  });
});

describe("sourceKeyDocId", () => {
  it("is deterministic and doc-id-safe even for a key containing '/'", () => {
    const key = "MODULE_ACTION|INVOICE|inv/abc|1|follow-up";
    const id1 = sourceKeyDocId(key);
    const id2 = sourceKeyDocId(key);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{48}$/);
  });
});

describe("buildApprovalItemRef (section 8: one Approval projection per exact source action/version)", () => {
  it("is deterministic - refreshing the same pending source action always yields the same ref", () => {
    const a = buildApprovalItemRef({ sourceModule: "finance_invoices", sourceType: "INVOICE", sourceRef: "inv_1", sourceVersion: 3, actionType: "APPROVE_OR_REJECT_INVOICE" });
    const b = buildApprovalItemRef({ sourceModule: "finance_invoices", sourceType: "INVOICE", sourceRef: "inv_1", sourceVersion: 3, actionType: "APPROVE_OR_REJECT_INVOICE" });
    expect(a).toBe(b);
    expect(a).toMatch(/^apr_[0-9a-f]{40}$/);
  });

  it("changes when the source version changes (a new decision is a new projection)", () => {
    const v1 = buildApprovalItemRef({ sourceModule: "finance_invoices", sourceType: "INVOICE", sourceRef: "inv_1", sourceVersion: 1, actionType: "APPROVE_OR_REJECT_INVOICE" });
    const v2 = buildApprovalItemRef({ sourceModule: "finance_invoices", sourceType: "INVOICE", sourceRef: "inv_1", sourceVersion: 2, actionType: "APPROVE_OR_REJECT_INVOICE" });
    expect(v1).not.toBe(v2);
  });

  it("differs across source modules/types even with the same ref and version (no cross-module collision)", () => {
    const invoice = buildApprovalItemRef({ sourceModule: "finance_invoices", sourceType: "INVOICE", sourceRef: "x", sourceVersion: 1, actionType: "APPROVE_OR_REJECT_INVOICE" });
    const payment = buildApprovalItemRef({ sourceModule: "finance_payments", sourceType: "PAYMENT", sourceRef: "x", sourceVersion: 1, actionType: "CONFIRM_PAYMENT" });
    expect(invoice).not.toBe(payment);
  });
});
