// Import Center Completion (spec sections 2B, 12, 13): real Firestore-
// emulator proof of the contract-bundle adapter - every mutation goes
// through the EXISTING createCounterpartyFromOnboarding orchestration
// (never a direct/bespoke Partner write), duplicate rows are never
// force-created, a restricted/KYC-looking column is rejected wholesale
// before a single row is read, and authorization is by explicit grant
// (imports:manage_imports AND finance:manage_agreements), never role
// rank. Same hermetic-harness idiom as onboarding.emulator.test.ts.
import { createHash } from "node:crypto";

import * as XLSX from "xlsx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { partnerEventsCollection, partnersCollection } from "@/server/partners/firestore";
import { createOnboardingHarness, type OnboardingHarness } from "@/server/testing/finance-onboarding-harness";
import { vendorsCollection } from "@/server/vendors/firestore";

import { getContractBundleImportBatchDetail, rowClientRequestId } from "./contract-bundle-import";
import { registerImportTargets } from "./register-targets";
import { getImportTarget, ImportAdapterError, type ImportTargetAdapter } from "./target-registry";

let h: OnboardingHarness;
let importer: ActorContext; // finance:manage_agreements (via role) + explicit imports:manage_imports override
let noImportsGrant: ActorContext; // finance:manage_agreements only - imports feature not granted
let noFinanceGrant: ActorContext; // imports:manage_imports only - finance feature explicitly removed
let target: ImportTargetAdapter;

const importedBatchRefsCollection = () => getAdminFirestore().collection("importContractBundleBatches");
const createdBatchUids: string[] = [];

function workbookBuffer(sheetName: string, rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// Same sha256-of-the-raw-buffer the adapter itself computes (sha256Hex in
// contract-bundle-import.ts) - used here only so the test can pre-compute
// the SAME deterministic row clientRequestId the adapter will use, purely
// to register it with the harness's own cleanup sweep.
function sourceHashOf(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

beforeAll(async () => {
  h = await createOnboardingHarness("cbi");
  importer = await h.actor("partnership_manager", { override: { imports: { view: true, actions: { manage_imports: true } } } });
  noImportsGrant = await h.actor("partnership_manager");
  noFinanceGrant = await h.actor("partnership_manager", { override: { imports: { view: true, actions: { manage_imports: true } }, finance: { view: false, actions: {} } } });
  registerImportTargets();
  target = getImportTarget("contract_bundle")!;
}, 120_000);

afterAll(async () => {
  for (const uid of createdBatchUids.splice(0)) await importedBatchRefsCollection().doc(uid).delete();
  await h.teardown();
});

async function trackBatch(batchRef: string | null) {
  if (!batchRef) return;
  const snap = await importedBatchRefsCollection().where("batchRef", "==", batchRef).limit(1).get();
  if (!snap.empty) createdBatchUids.push(snap.docs[0]!.id);
}

describe("contract-bundle import adapter (Import Center Completion)", () => {
  it("dry-run classifies a fresh Partner+Account row as CREATE and mutates nothing", async () => {
    const displayName = h.uniqueName("Bundle Partner");
    const email = h.uniqueEmail().toLowerCase();
    const buffer = workbookBuffer("Bundle", [
      ["Type", "Display Name", "Email", "Region", "Platform", "Handle"],
      ["Partner", displayName, email, h.R_IN, "instagram", h.uniqueHandle("bundle")],
    ]);

    const result = await target.dryRun(importer, { buffer, filename: "bundle.xlsx", mimeType: XLSX_MIME }, {}, "req-cb-dry-1");
    expect(result.counts.CREATE).toBe(1);
    expect(result.batchRef).toBeNull();

    const stillZero = await partnersCollection().where("email", "==", email).get();
    expect(stillZero.size).toBe(0);
  });

  it("execute creates the Partner through the OWNING onboarding orchestration, with createdVia provenance and a real Agreement draft", async () => {
    const displayName = h.uniqueName("Bundle Partner Real");
    const email = h.uniqueEmail().toLowerCase();
    const handle = h.uniqueHandle("bundlereal");
    const buffer = workbookBuffer("Bundle", [
      ["Type", "Display Name", "Email", "Region", "Platform", "Handle"],
      ["Partner", displayName, email, h.R_IN, "instagram", handle],
    ]);
    h.trackRequest(importer, rowClientRequestId(sourceHashOf(buffer), "Bundle", 2));

    const result = await target.execute(importer, { buffer, filename: "bundle-real.xlsx", mimeType: XLSX_MIME }, {}, "req-cb-exec-1");
    expect(result.status === "COMPLETED").toBe(true);
    expect(result.counts.CREATE).toBe(1);
    await trackBatch(result.batchRef);

    const detail = await getContractBundleImportBatchDetail(importer, result.batchRef!);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    const row = detail.data.rows[0]!;
    expect(row.outcome).toBe("CREATE");
    expect(row.counterpartyRef).not.toBeNull();
    expect(row.agreementRef).not.toBeNull();

    const partnerSnap = await partnersCollection().where("email", "==", email).get();
    expect(partnerSnap.size).toBe(1);
    // createdVia provenance is recorded on the owning module's own
    // "created" event, not the Partner doc itself (see partner-service.ts).
    const createdEvents = await partnerEventsCollection(partnerSnap.docs[0]!.id).where("kind", "==", "created").get();
    expect(createdEvents.docs[0]!.data().metadata.createdVia).toBe("FINANCE_AGREEMENT_ONBOARDING");
  });

  it("re-running execute on the exact same row is an idempotent replay - no second Vendor is created", async () => {
    const displayName = h.uniqueName("Bundle Idempotent");
    const email = h.uniqueEmail().toLowerCase();
    const buffer = workbookBuffer("Bundle", [
      ["Type", "Display Name", "Email", "Region", "Vendor Type"],
      ["Vendor", displayName, email, h.R_IN, "AGENCY"],
    ]);
    h.trackRequest(importer, rowClientRequestId(sourceHashOf(buffer), "Bundle", 2));

    const first = await target.execute(importer, { buffer, filename: "bundle-idem.xlsx", mimeType: XLSX_MIME }, {}, "req-cb-idem-1");
    expect(first.counts.CREATE).toBe(1);
    await trackBatch(first.batchRef);

    const second = await target.execute(importer, { buffer, filename: "bundle-idem.xlsx", mimeType: XLSX_MIME }, {}, "req-cb-idem-2");
    expect(second.counts.UNCHANGED).toBe(1);
    expect(second.counts.CREATE ?? 0).toBe(0);
    await trackBatch(second.batchRef);

    const vendorSnap = await vendorsCollection().where("email", "==", email).get();
    expect(vendorSnap.size).toBe(1);
  });

  it("a likely-duplicate row is never force-created - it is reported for manual review, and no second record is created", async () => {
    // Seeded pre-normalized (lowercase) - the duplicate check queries by
    // the NORMALIZED email, same as every real Partner created through
    // createPartner would already be stored.
    const seeded = await h.seedPartner({ email: h.uniqueEmail().toLowerCase() });
    const buffer = workbookBuffer("Bundle", [
      ["Type", "Display Name", "Email", "Region"],
      ["Partner", h.uniqueName("Different Display Name"), seeded.email, h.R_IN],
    ]);

    const dryRun = await target.dryRun(importer, { buffer, filename: "bundle-dupe.xlsx", mimeType: XLSX_MIME }, {}, "req-cb-dupe-1");
    expect(dryRun.counts.AMBIGUOUS).toBe(1);
    expect(dryRun.counts.CREATE ?? 0).toBe(0);

    const execResult = await target.execute(importer, { buffer, filename: "bundle-dupe.xlsx", mimeType: XLSX_MIME }, {}, "req-cb-dupe-2");
    await trackBatch(execResult.batchRef);
    expect(execResult.counts.CREATE ?? 0).toBe(0);

    const byEmail = await partnersCollection().where("email", "==", seeded.email).get();
    expect(byEmail.size).toBe(1); // still just the one seeded record - no accidental identity collapse, no second record
  });

  it("a sheet with a restricted/KYC-looking column is rejected wholesale, before a single row is read", async () => {
    const buffer = workbookBuffer("Bundle", [
      ["Type", "Display Name", "Email", "Region", "PAN"],
      ["Partner", h.uniqueName("Restricted"), h.uniqueEmail(), h.R_IN, "ABCDE1234F"],
    ]);

    await expect(target.dryRun(importer, { buffer, filename: "bundle-restricted.xlsx", mimeType: XLSX_MIME }, {}, "req-cb-restricted-1")).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ImportAdapterError);
      const classified = (error as ImportAdapterError).classified;
      expect(classified.category).toBe("STRUCTURE");
      expect(classified.code).toBe("RESTRICTED_FIELD_REJECTED");
      // Never echoes the restricted VALUE itself, only the column name.
      expect(classified.message).not.toContain("ABCDE1234F");
      return true;
    });
  });

  it("denies an actor with finance:manage_agreements but no imports:manage_imports grant", async () => {
    const buffer = workbookBuffer("Bundle", [
      ["Type", "Display Name", "Email", "Region"],
      ["Partner", h.uniqueName("Denied"), h.uniqueEmail(), h.R_IN],
    ]);
    await expect(target.dryRun(noImportsGrant, { buffer, filename: "denied.xlsx", mimeType: XLSX_MIME }, {}, "req-cb-denied-1")).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ImportAdapterError);
      expect((error as ImportAdapterError).classified.category).toBe("AUTHORIZATION");
      return true;
    });
  });

  it("denies an actor with imports:manage_imports but no finance access", async () => {
    const buffer = workbookBuffer("Bundle", [
      ["Type", "Display Name", "Email", "Region"],
      ["Partner", h.uniqueName("Denied2"), h.uniqueEmail(), h.R_IN],
    ]);
    await expect(target.dryRun(noFinanceGrant, { buffer, filename: "denied2.xlsx", mimeType: XLSX_MIME }, {}, "req-cb-denied-2")).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ImportAdapterError);
      expect((error as ImportAdapterError).classified.category).toBe("AUTHORIZATION");
      return true;
    });
  });
});
