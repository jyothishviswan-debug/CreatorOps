import { describe, expect, it } from "vitest";

import { createInMemoryReportArtifactStore, ReportArtifactStoreError } from "./artifact-store";

describe("in-memory report artifact store (test seam, same contract as the Storage adapter)", () => {
  it("puts, checks, gets and refuses to overwrite", async () => {
    const store = createInMemoryReportArtifactStore();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const locator = await store.put({ artifactRef: "rar_abc123", bytes, format: "pdf" });
    expect(locator).toBe("report-artifacts/rar_abc123.pdf");
    expect(await store.exists?.(locator)).toBe(true);
    expect(Array.from(await store.get(locator))).toEqual([1, 2, 3, 4]);
    await expect(store.put({ artifactRef: "rar_abc123", bytes, format: "pdf" })).rejects.toMatchObject({ code: "already_exists" });
  });

  it("reports a missing object as not_found", async () => {
    const store = createInMemoryReportArtifactStore();
    await expect(store.get("report-artifacts/rar_missing.pdf")).rejects.toMatchObject({ code: "not_found" });
  });

  it("derives a distinct locator per format for the same artifactRef", async () => {
    const store = createInMemoryReportArtifactStore();
    const pdf = await store.put({ artifactRef: "rar_multi00000000000000000001", bytes: new Uint8Array([1]), format: "pdf" });
    const xlsx = await store.put({ artifactRef: "rar_multi00000000000000000002", bytes: new Uint8Array([2]), format: "xlsx" });
    const csv = await store.put({ artifactRef: "rar_multi00000000000000000003", bytes: new Uint8Array([3]), format: "csv" });
    expect(new Set([pdf, xlsx, csv]).size).toBe(3);
  });

  it("rejects an invalid artifactRef", async () => {
    const store = createInMemoryReportArtifactStore();
    await expect(store.put({ artifactRef: "../etc/passwd", bytes: new Uint8Array([1]), format: "pdf" })).rejects.toBeInstanceOf(ReportArtifactStoreError);
  });

  it("rejects a locator outside the report-artifacts/ namespace", async () => {
    const store = createInMemoryReportArtifactStore();
    await expect(store.get("export-artifacts/exa_x.pdf")).rejects.toMatchObject({ code: "invalid_locator" });
  });
});
