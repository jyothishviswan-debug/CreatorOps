import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createFirebaseStorageArtifactStore } from "./store";

// Smoke test of the REAL Firebase Storage adapter against the Storage emulator.
// SKIPS unless FIREBASE_STORAGE_EMULATOR_HOST is set (and a bucket is named),
// so it can never reach a live bucket: the admin SDK only redirects to the
// emulator when that variable is present.
//
// WARNING: vitest.emulator.config.mts falls back to .env.local (the default dev
// emulator ports 8080/9099/9199) for any host you do not pass, and its globalSetup
// RESETS that Firestore/Auth emulator. Always pass all three private hosts
// explicitly, as below.
//
// Run: FIRESTORE_EMULATOR_HOST=127.0.0.1:8180 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9299 \
//   FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9399 FIREBASE_STORAGE_BUCKET=demo-creatorops.appspot.com \
//   npx vitest run --config vitest.emulator.config.mts src/server/finance-agreements/contract-artifacts/store.emulator.test.ts

const emulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
const bucket = process.env.FIREBASE_STORAGE_BUCKET ?? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
const skipReason = !emulatorHost
  ? "FIREBASE_STORAGE_EMULATOR_HOST is not set; refusing to touch a real bucket"
  : !bucket
    ? "no FIREBASE_STORAGE_BUCKET / NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET set"
    : null;

if (skipReason) console.warn(`[store.emulator.test] SKIPPED: ${skipReason}`);

describe.skipIf(skipReason !== null)("Firebase Storage contract artifact store (emulator)", () => {
  const store = createFirebaseStorageArtifactStore();
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0xff, 0x10]);

  it("puts, checks, gets and refuses to overwrite", async () => {
    const artifactRef = `ca_smoke${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const locator = await store.put({ artifactRef, bytes, mimeType: "application/pdf" });
    expect(locator).toBe(`finance-contracts/${artifactRef}.pdf`);
    expect(await store.exists?.(locator)).toBe(true);
    expect(Array.from(await store.get(locator))).toEqual(Array.from(bytes));
    await expect(store.put({ artifactRef, bytes, mimeType: "application/pdf" })).rejects.toMatchObject({ code: "already_exists" });
  });

  it("reports a missing object as not_found", async () => {
    const locator = `finance-contracts/ca_missing${randomUUID().replace(/-/g, "").slice(0, 12)}.pdf`;
    expect(await store.exists?.(locator)).toBe(false);
    await expect(store.get(locator)).rejects.toMatchObject({ code: "not_found" });
  });
});
