import { describe, expect, it } from "vitest";

import { createInMemoryExportArtifactStore, ExportArtifactStoreError } from "./artifact-store";

describe("in-memory export artifact store (test seam, same contract as the Storage adapter)", () => {
  it("puts, checks, gets and refuses to overwrite", async () => {
    const store = createInMemoryExportArtifactStore();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const locator = await store.put({ artifactRef: "exa_abc123", bytes, format: "csv" });
    expect(locator).toBe("export-artifacts/exa_abc123.csv");
    expect(await store.exists?.(locator)).toBe(true);
    expect(Array.from(await store.get(locator))).toEqual([1, 2, 3, 4]);
    await expect(store.put({ artifactRef: "exa_abc123", bytes, format: "csv" })).rejects.toMatchObject({ code: "already_exists" });
  });

  it("reports a missing object as not_found", async () => {
    const store = createInMemoryExportArtifactStore();
    await expect(store.get("export-artifacts/exa_missing.pdf")).rejects.toMatchObject({ code: "not_found" });
    expect(await store.exists?.("export-artifacts/exa_missing.pdf")).toBe(false);
  });

  it("derives a distinct locator per format for the same artifactRef (never collides)", async () => {
    const store = createInMemoryExportArtifactStore();
    const csvLocator = await store.put({ artifactRef: "exa_multi000000001", bytes: new Uint8Array([1]), format: "csv" });
    const xlsxLocator = await store.put({ artifactRef: "exa_multi000000002", bytes: new Uint8Array([2]), format: "xlsx" });
    const pdfLocator = await store.put({ artifactRef: "exa_multi000000003", bytes: new Uint8Array([3]), format: "pdf" });
    expect(new Set([csvLocator, xlsxLocator, pdfLocator]).size).toBe(3);
  });

  it("rejects an invalid artifactRef", async () => {
    const store = createInMemoryExportArtifactStore();
    await expect(store.put({ artifactRef: "../etc/passwd", bytes: new Uint8Array([1]), format: "csv" })).rejects.toBeInstanceOf(ExportArtifactStoreError);
  });

  it("rejects a locator outside the export-artifacts/ namespace", async () => {
    const store = createInMemoryExportArtifactStore();
    await expect(store.get("finance-contracts/ca_x.pdf")).rejects.toMatchObject({ code: "invalid_locator" });
  });
});
