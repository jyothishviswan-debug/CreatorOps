import { describe, expect, it } from "vitest";

import { ImportAdapterError, getImportTarget, listImportTargets, registerImportTarget } from "./target-registry";

describe("target-registry", () => {
  it("registers and looks up an adapter by kind", () => {
    registerImportTarget({ kind: "__test_kind__", label: "Test", dryRun: async () => ({ batchRef: null, totalRows: 0, counts: {}, safeErrorSummary: [], sourceSheetInventory: [] }), execute: async () => ({ batchRef: "b1", status: "COMPLETED", totalRows: 0, counts: {}, safeErrorSummary: [], sourceSheetInventory: [] }) });
    const target = getImportTarget("__test_kind__");
    expect(target).not.toBeNull();
    expect(target!.label).toBe("Test");
  });

  it("re-registering the same kind overwrites the prior entry (idempotent)", () => {
    registerImportTarget({ kind: "__test_kind_2__", label: "First", dryRun: async () => ({ batchRef: null, totalRows: 0, counts: {}, safeErrorSummary: [], sourceSheetInventory: [] }), execute: async () => ({ batchRef: "b", status: "COMPLETED", totalRows: 0, counts: {}, safeErrorSummary: [], sourceSheetInventory: [] }) });
    registerImportTarget({ kind: "__test_kind_2__", label: "Second", dryRun: async () => ({ batchRef: null, totalRows: 0, counts: {}, safeErrorSummary: [], sourceSheetInventory: [] }), execute: async () => ({ batchRef: "b", status: "COMPLETED", totalRows: 0, counts: {}, safeErrorSummary: [], sourceSheetInventory: [] }) });
    expect(getImportTarget("__test_kind_2__")!.label).toBe("Second");
  });

  it("returns null for an unregistered kind", () => {
    expect(getImportTarget("__totally_unregistered_kind__")).toBeNull();
  });

  it("lists every registered target, and it includes every real registrant once register-targets.ts has run", async () => {
    const { registerImportTargets } = await import("./register-targets");
    registerImportTargets();
    const kinds = listImportTargets().map((t) => t.kind);
    expect(kinds).toContain("analytics");
    expect(kinds).toContain("contract_bundle");
    // Finding #44 (user-decided): a separate, semantically correct target kind - confirms it never
    // needed a third AnalyticsTargetKind value to exist.
    expect(kinds).toContain("content_links");
  });

  it("ImportAdapterError carries its classified error through", () => {
    const error = new ImportAdapterError({ category: "FILE", code: "FILE_TOO_LARGE", message: "too big", correctable: true });
    expect(error.classified.category).toBe("FILE");
    expect(error.message).toBe("too big");
  });
});
