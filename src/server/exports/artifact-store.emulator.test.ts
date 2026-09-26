import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createFirebaseStorageArtifactStore } from "./artifact-store";

// Smoke test of the REAL Firebase Storage adapter against the Storage emulator - mirrors
// src/server/finance-agreements/contract-artifacts/store.emulator.test.ts exactly. SKIPS unless
// FIREBASE_STORAGE_EMULATOR_HOST is set (and a bucket is named), so it can never reach a live bucket.
//
// Run: FIRESTORE_EMULATOR_HOST=127.0.0.1:8180 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9299 \
//   FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9399 FIREBASE_STORAGE_BUCKET=demo-creatorops.appspot.com \
//   npx vitest run --config vitest.emulator.config.mts src/server/exports/artifact-store.emulator.test.ts

const emulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const bucket = process.env.FIREBASE_STORAGE_BUCKET ?? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
const skipReason = !emulatorHost ? "FIREBASE_STORAGE_EMULATOR_HOST is not set; refusing to touch a real bucket" : !bucket ? "no FIREBASE_STORAGE_BUCKET / NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET set" : null;

if (skipReason) console.warn(`[exports/artifact-store.emulator.test] SKIPPED: ${skipReason}`);

describe.skipIf(skipReason !== null)("Firebase Storage export artifact store (emulator)", () => {
  const store = createFirebaseStorageArtifactStore();
  const csvBytes = new TextEncoder().encode("a,b\r\n1,2\r\n");

  it("puts, checks, gets and refuses to overwrite (csv)", async () => {
    const artifactRef = `exa_smoke${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const locator = await store.put({ artifactRef, bytes: csvBytes, format: "csv" });
    expect(locator).toBe(`export-artifacts/${artifactRef}.csv`);
    expect(await store.exists?.(locator)).toBe(true);
    expect(Array.from(await store.get(locator))).toEqual(Array.from(csvBytes));
    await expect(store.put({ artifactRef, bytes: csvBytes, format: "csv" })).rejects.toMatchObject({ code: "already_exists" });
  });

  it("stores an xlsx and a pdf artifact under distinct locators", async () => {
    const artifactRef = `exa_multi${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const xlsxLocator = await store.put({ artifactRef: `${artifactRef}x`, bytes: new Uint8Array([1, 2, 3]), format: "xlsx" });
    const pdfLocator = await store.put({ artifactRef: `${artifactRef}p`, bytes: new Uint8Array([4, 5, 6]), format: "pdf" });
    expect(xlsxLocator.endsWith(".xlsx")).toBe(true);
    expect(pdfLocator.endsWith(".pdf")).toBe(true);
  });

  it("reports a missing object as not_found", async () => {
    const locator = `export-artifacts/exa_missing${randomUUID().replace(/-/g, "").slice(0, 12)}.csv`;
    expect(await store.exists?.(locator)).toBe(false);
    await expect(store.get(locator)).rejects.toMatchObject({ code: "not_found" });
  });
});
