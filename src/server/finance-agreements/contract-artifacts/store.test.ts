import { afterEach, describe, expect, it } from "vitest";

import {
  ContractArtifactStoreError,
  createInMemoryArtifactStore,
  getContractArtifactStore,
  setContractArtifactStoreForTests,
} from "./store";

const bytes = new TextEncoder().encode("%PDF-1.4 synthetic");

describe("createInMemoryArtifactStore", () => {
  it("round-trips bytes through an opaque locator", async () => {
    const store = createInMemoryArtifactStore();
    const locator = await store.put({ artifactRef: "ca_abc123", bytes, mimeType: "application/pdf" });
    expect(locator).toBe("finance-contracts/ca_abc123.pdf");
    expect(await store.exists?.(locator)).toBe(true);
    expect(Array.from(await store.get(locator))).toEqual(Array.from(bytes));
  });

  it("copies bytes so later mutation of the input cannot change the stored object", async () => {
    const store = createInMemoryArtifactStore();
    const input = new Uint8Array(bytes);
    const locator = await store.put({ artifactRef: "ca_copy", bytes: input, mimeType: "application/pdf" });
    input[0] = 0;
    expect((await store.get(locator))[0]).toBe(bytes[0]);
  });

  it("is write-once per artifactRef", async () => {
    const store = createInMemoryArtifactStore();
    await store.put({ artifactRef: "ca_once", bytes, mimeType: "application/pdf" });
    await expect(store.put({ artifactRef: "ca_once", bytes, mimeType: "application/pdf" })).rejects.toMatchObject({ code: "already_exists" });
  });

  it("rejects unsafe refs, non-pdf mime types, foreign locators and missing objects", async () => {
    const store = createInMemoryArtifactStore();
    await expect(store.put({ artifactRef: "../evil", bytes, mimeType: "application/pdf" })).rejects.toMatchObject({ code: "invalid_artifact_ref" });
    await expect(store.put({ artifactRef: "a/b", bytes, mimeType: "application/pdf" })).rejects.toMatchObject({ code: "invalid_artifact_ref" });
    await expect(store.put({ artifactRef: "ca_x", bytes, mimeType: "text/plain" })).rejects.toMatchObject({ code: "unsupported_mime_type" });
    await expect(store.get("other-prefix/ca_x.pdf")).rejects.toBeInstanceOf(ContractArtifactStoreError);
    await expect(store.get("finance-contracts/../secret.pdf")).rejects.toMatchObject({ code: "invalid_locator" });
    await expect(store.get("finance-contracts/ca_missing.pdf")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("setContractArtifactStoreForTests", () => {
  afterEach(() => setContractArtifactStoreForTests(null));

  it("overrides and restores the module-level store", () => {
    const fake = createInMemoryArtifactStore();
    setContractArtifactStoreForTests(fake);
    expect(getContractArtifactStore()).toBe(fake);
    setContractArtifactStoreForTests(null);
    expect(getContractArtifactStore()).not.toBe(fake);
  });

  it("throws outside a test run", () => {
    const nodeEnv = process.env.NODE_ENV;
    const vitest = process.env.VITEST;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      delete process.env.VITEST;
      expect(() => setContractArtifactStoreForTests(null)).toThrow(/test run/);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv;
      if (vitest !== undefined) process.env.VITEST = vitest;
    }
  });
});
