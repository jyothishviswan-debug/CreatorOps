import { describe, expect, it } from "vitest";

import { toReportSnapshotDto } from "./client-dto";
import type { ReportSnapshotDoc } from "./types";

const doc: ReportSnapshotDoc = {
  snapshotRef: "rsn_00000000000000000000",
  reportId: "operations_attention",
  definitionVersion: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  evidenceCutoff: "2026-01-01T00:00:00.000Z",
  appliedFilters: { status: "OPEN" },
  scopeSummary: { basis: "actor-scope", note: "note" },
  provenance: [{ sourceModule: "operations", sourceFunction: "listTasks", recordCount: 3, scanned: 10 }],
  limitations: ["a limitation"],
  truncated: false,
  rowCount: 3,
  maxRows: 300,
  result: { metrics: { openTaskCount: 3 }, rows: [{ ref: "tsk_1" }], sections: { tasks: [] } },
  createdAt: "2026-01-01T00:00:01.000Z",
  createdByUserRef: "user_actor",
};

describe("toReportSnapshotDto", () => {
  it("carries every safe field through unchanged", () => {
    const dto = toReportSnapshotDto(doc);
    expect(dto.snapshotRef).toBe(doc.snapshotRef);
    expect(dto.reportId).toBe(doc.reportId);
    expect(dto.result).toEqual(doc.result);
    expect(dto.createdByUserRef).toBe("user_actor");
  });

  it("never exposes the internal provenance array (sourceFunction/scanned - implementation detail, not a client-safe field)", () => {
    const dto = toReportSnapshotDto(doc) as Record<string, unknown>;
    expect(dto).not.toHaveProperty("provenance");
  });

  it("createdByUserRef is always the opaque userRef, never something that looks like a raw Firebase uid path", () => {
    const dto = toReportSnapshotDto(doc);
    expect(dto.createdByUserRef).toMatch(/^user_/);
  });
});
