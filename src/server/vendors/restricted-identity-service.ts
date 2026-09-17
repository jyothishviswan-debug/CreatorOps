import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import type { ActorContext } from "@/server/authz/types";
import {
  getRestrictedFinancialIdentityDoc,
  restrictedFinancialIdentitiesCollection,
  restrictedFinancialIdentityDocSchema,
  restrictedIdentityDocId,
  type RestrictedFinancialIdentityDoc,
  type RestrictedFinancialIdentityEvidence,
} from "@/server/shared/restricted-financial-identity";
import { ensureVendorDriveFolder, uploadFileToVendorDriveFolder, vendorDriveFolderName } from "./drive-client";
import { getVendorDocByRef, vendorsCollection } from "./firestore";
import { writeVendorEvent } from "./vendor-events";
import { requireVendorInScope, requireVendorRestrictedIdentitySensitiveAccess, requireVendorsAccess } from "./vendors-gate";
import { vendorDocSchema, vendorsInvalidInputResult, vendorsUnauthorizedResult, type VendorDoc, type VendorsServiceResult } from "./types";

// Step 8A.1: persists into the ONE canonical restrictedFinancialIdentities
// collection (see src/server/shared/restricted-financial-identity.ts),
// discriminated by subjectType "VENDOR" and a deterministic
// type-prefixed doc id - never the old parallel
// "restrictedVendorFinancialIdentities" collection. The browser-facing
// DTO stays exactly as narrow as before: never exposes the raw doc id,
// subjectType, or subjectRef, only the restricted fields the UI needs.
export type VendorRestrictedIdentityDto = Omit<RestrictedFinancialIdentityDoc, "uid" | "subjectType" | "subjectRef">;
function toRestrictedIdentityDto(doc: RestrictedFinancialIdentityDoc): VendorRestrictedIdentityDto {
  const rest: Partial<RestrictedFinancialIdentityDoc> = { ...doc };
  delete rest.uid;
  delete rest.subjectType;
  delete rest.subjectRef;
  return rest as VendorRestrictedIdentityDto;
}

// Restricted identity is gated by BOTH the manage_vendor_restricted_identity
// action AND the "vendor_payment_details" sensitive-access category - same
// two-gate discipline as Partners' own restricted identity (a role can be
// allowed to operate the workflow without being allowed to see the
// actual restricted values).
async function requireRestrictedAccess(actor: ActorContext | null, vendorRef: unknown): Promise<{ ok: true; vendor: VendorDoc } | { ok: false; error: VendorsServiceResult<never> }> {
  const gate = await requireVendorsAccess(actor, "manage_vendor_restricted_identity");
  if (!gate.ok) return { ok: false, error: vendorsUnauthorizedResult(gate.reason) };

  const sensitiveGate = await requireVendorRestrictedIdentitySensitiveAccess(actor!);
  if (!sensitiveGate.ok) return { ok: false, error: vendorsUnauthorizedResult(sensitiveGate.reason) };

  if (typeof vendorRef !== "string" || vendorRef.length === 0) return { ok: false, error: vendorsInvalidInputResult("Missing vendorRef.") };
  const vendor = await getVendorDocByRef(vendorRef);
  if (!vendor) return { ok: false, error: { ok: false, code: "not_found", message: "Vendor not found." } };

  const scopeCheck = await requireVendorInScope(actor!, vendor);
  if (!scopeCheck.ok) return { ok: false, error: vendorsUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, vendor };
}

export async function getVendorRestrictedIdentity(actor: ActorContext | null, vendorRef: unknown): Promise<VendorsServiceResult<VendorRestrictedIdentityDto | null>> {
  const loaded = await requireRestrictedAccess(actor, vendorRef);
  if (!loaded.ok) return loaded.error;

  const doc = await getRestrictedFinancialIdentityDoc("VENDOR", loaded.vendor.uid);
  return { ok: true, data: doc ? toRestrictedIdentityDto(doc) : null };
}

const saveRestrictedIdentityInputSchema = z.object({
  pan: z.object({ number: z.string().min(1).max(20) }).nullable().optional(),
  gst: z.object({ applicable: z.boolean(), number: z.string().min(1).max(30).optional() }).nullable().optional(),
  bank: z
    .object({
      accountHolderName: z.string().min(1).max(200),
      accountNumber: z.string().min(1).max(40),
      ifsc: z.string().min(1).max(20),
      bankName: z.string().min(1).max(120),
      branchName: z.string().min(1).max(120),
    })
    .nullable()
    .optional(),
  expectedVersion: z.number().int().min(0), // 0 == "no restricted identity doc exists yet"
});
export type SaveVendorRestrictedIdentityInput = z.input<typeof saveRestrictedIdentityInputSchema>;

type SaveTxResult = { kind: "ok"; doc: RestrictedFinancialIdentityDoc } | { kind: "stale" };

// Full-document overwrite of the restricted fields only - `evidence` is
// always carried forward untouched (never silently dropped by a core-
// field save). Never logs a raw restricted value into the append-only
// event log - only that a save happened. When a GST number is supplied,
// this also runs a bounded, safe exact-collision check against every
// OTHER VENDOR's restricted GST (Step 8A section 6, unchanged by Step
// 8A.1's section 6: "advisory/safe collision check, not a transactional
// global uniqueness lock... no GST claim collection") - scoped to
// subjectType "VENDOR" only, since the collection is now shared with
// Partner subjects and a Partner's own GST must never false-positive a
// Vendor collision (or vice versa). The raw value of the colliding
// record is never returned, only the fact of the collision.
export async function saveVendorRestrictedIdentity(actor: ActorContext | null, vendorRef: unknown, rawInput: unknown, requestId: string): Promise<VendorsServiceResult<VendorRestrictedIdentityDto>> {
  const loaded = await requireRestrictedAccess(actor, vendorRef);
  if (!loaded.ok) return loaded.error;

  const parsed = saveRestrictedIdentityInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (input.gst?.applicable && !input.gst.number) {
    return vendorsInvalidInputResult("gst.number is required when GST is applicable.");
  }

  const docId = restrictedIdentityDocId("VENDOR", loaded.vendor.uid);

  if (input.gst?.number) {
    const collision = await restrictedFinancialIdentitiesCollection()
      .where("subjectType", "==", "VENDOR")
      .where("gst.number", "==", input.gst.number)
      .limit(2)
      .get();
    const collidesWithAnother = collision.docs.some((doc) => doc.id !== docId);
    if (collidesWithAnother) {
      return { ok: false, code: "conflict", message: "This GST number is already on file for another Vendor." };
    }
  }

  const db = getAdminFirestore();
  const docRef = restrictedFinancialIdentitiesCollection().doc(docId);
  const now = new Date().toISOString();

  const result = await db.runTransaction<SaveTxResult>(async (tx) => {
    const snap = await tx.get(docRef);
    const existing = snap.exists ? restrictedFinancialIdentityDocSchema.safeParse(snap.data()) : null;
    const currentVersion = existing?.success ? existing.data.version : 0;
    if (currentVersion !== input.expectedVersion) return { kind: "stale" };

    const next: RestrictedFinancialIdentityDoc = restrictedFinancialIdentityDocSchema.parse({
      uid: docId,
      subjectType: "VENDOR",
      subjectRef: loaded.vendor.vendorRef,
      version: currentVersion + 1,
      pan: input.pan !== undefined ? input.pan : (existing?.success ? existing.data.pan : null),
      gst: input.gst !== undefined ? input.gst : (existing?.success ? existing.data.gst : null),
      bank: input.bank !== undefined ? input.bank : (existing?.success ? existing.data.bank : null),
      evidence: existing?.success ? existing.data.evidence : [],
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    tx.set(docRef, next);
    return { kind: "ok", doc: next };
  });

  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Vendor's restricted identity was changed elsewhere. Reload and try again." };

  await writeVendorEvent({
    vendorUid: loaded.vendor.uid,
    kind: "restricted_identity_saved",
    actorUserRef: actor!.userRef,
    metadata: { fieldsPresent: Object.keys(input).filter((k) => k !== "expectedVersion" && input[k as keyof typeof input] != null) },
    requestId,
  });
  return { ok: true, data: toRestrictedIdentityDto(result.doc) };
}

// ---- Evidence (real KYC upload feature, mirrors Discovery's own) ------
// The actual evidence for the fields above - each entry is either an
// operator-supplied link or a real file uploaded into this Vendor's own
// Drive subfolder (see drive-client.ts). Requires the core restricted-
// identity fields to already exist (the operator saves PAN/GST/bank
// first) - evidence has nowhere to live before that, same discipline as
// Discovery's own KYC attachments.

const SEQUENCE_COUNTERS_COLLECTION = "sequenceCounters";

// Allocated exactly once per Vendor, the first time evidence is
// uploaded - never reassigned afterward (see types.ts's sequenceNumber
// field comment). All reads happen before the one write, inside a single
// transaction, so two concurrent first-uploads for two DIFFERENT Vendors
// can never be handed the same number - same discipline as the
// Vendor<->Partner active-link claim mechanism.
async function ensureVendorSequenceNumber(vendor: VendorDoc): Promise<number> {
  if (vendor.sequenceNumber != null) return vendor.sequenceNumber;

  const db = getAdminFirestore();
  const counterRef = db.collection(SEQUENCE_COUNTERS_COLLECTION).doc("vendor");
  const vendorRef = vendorsCollection().doc(vendor.uid);

  return db.runTransaction<number>(async (tx) => {
    const [counterSnap, vendorSnap] = await Promise.all([tx.get(counterRef), tx.get(vendorRef)]);
    const freshVendor = vendorDocSchema.safeParse(vendorSnap.data());
    if (freshVendor.success && freshVendor.data.sequenceNumber != null) return freshVendor.data.sequenceNumber;

    const next = counterSnap.exists ? ((counterSnap.data()?.next as number | undefined) ?? 1) : 1;
    tx.set(counterRef, { next: next + 1 });
    tx.update(vendorRef, { sequenceNumber: next });
    return next;
  });
}

const evidenceDocTypeSchema = z.enum(["pan", "gst", "bank", "other"]);

type EvidenceTxResult = { kind: "ok"; version: number; evidence: RestrictedFinancialIdentityEvidence } | { kind: "stale" } | { kind: "no_restricted_identity" };

async function appendEvidence(docId: string, expectedVersion: number, evidence: RestrictedFinancialIdentityEvidence): Promise<EvidenceTxResult> {
  const db = getAdminFirestore();
  const docRef = restrictedFinancialIdentitiesCollection().doc(docId);

  return db.runTransaction<EvidenceTxResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "no_restricted_identity" };
    const parsed = restrictedFinancialIdentityDocSchema.safeParse(snap.data());
    if (!parsed.success) return { kind: "no_restricted_identity" };
    const current = parsed.data;
    if (current.version !== expectedVersion) return { kind: "stale" };

    const next = restrictedFinancialIdentityDocSchema.parse({ ...current, version: current.version + 1, evidence: [...current.evidence, evidence] });
    tx.set(docRef, next);
    return { kind: "ok", version: next.version, evidence };
  });
}

const addLinkEvidenceInputSchema = z.object({
  docType: evidenceDocTypeSchema,
  url: z.string().min(1).max(1000),
  expectedVersion: z.number().int().min(0),
});
export type AddVendorRestrictedIdentityLinkEvidenceInput = z.input<typeof addLinkEvidenceInputSchema>;

export async function addVendorRestrictedIdentityLinkEvidence(
  actor: ActorContext | null,
  vendorRef: unknown,
  rawInput: unknown,
  requestId: string,
): Promise<VendorsServiceResult<{ version: number; evidence: RestrictedFinancialIdentityEvidence }>> {
  const loaded = await requireRestrictedAccess(actor, vendorRef);
  if (!loaded.ok) return loaded.error;

  const parsed = addLinkEvidenceInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const evidence: RestrictedFinancialIdentityEvidence = { docType: input.docType, kind: "link", url: input.url, fileName: null, addedAt: new Date().toISOString(), addedByUserRef: actor!.userRef };

  const docId = restrictedIdentityDocId("VENDOR", loaded.vendor.uid);
  const result = await appendEvidence(docId, input.expectedVersion, evidence);
  if (result.kind === "no_restricted_identity") return vendorsInvalidInputResult("Save the restricted identity fields above before adding evidence.");
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Vendor's restricted identity was changed elsewhere. Reload and try again." };

  await writeVendorEvent({ vendorUid: loaded.vendor.uid, kind: "restricted_identity_saved", actorUserRef: actor!.userRef, metadata: { evidenceAdded: input.docType, kind: "link" }, requestId });
  return { ok: true, data: { version: result.version, evidence: result.evidence } };
}

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export type AddVendorRestrictedIdentityUploadEvidenceInput = {
  docType: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  expectedVersion: number;
};

// Real (never simulated) upload: creates-or-reuses this Vendor's own
// Drive subfolder (named "V{sequenceNumber}_{displayName}_", allocated
// on first upload - see ensureVendorSequenceNumber), uploads the file
// there, and only ever stores the real webViewLink Drive returns. If
// Drive itself fails (folder not shared, API not enabled, network), this
// fails loudly with that reason - it never records a fabricated link.
export async function addVendorRestrictedIdentityUploadEvidence(
  actor: ActorContext | null,
  vendorRef: unknown,
  input: AddVendorRestrictedIdentityUploadEvidenceInput,
  requestId: string,
): Promise<VendorsServiceResult<{ version: number; evidence: RestrictedFinancialIdentityEvidence }>> {
  const loaded = await requireRestrictedAccess(actor, vendorRef);
  if (!loaded.ok) return loaded.error;

  const docType = evidenceDocTypeSchema.safeParse(input.docType);
  if (!docType.success) return vendorsInvalidInputResult("Invalid docType.");
  if (!input.fileName || input.fileName.length > 200) return vendorsInvalidInputResult("Invalid file name.");
  if (input.buffer.byteLength === 0) return vendorsInvalidInputResult("The uploaded file is empty.");
  if (input.buffer.byteLength > MAX_UPLOAD_BYTES) return vendorsInvalidInputResult("Files larger than 15 MB are not supported.");

  const sequenceNumber = await ensureVendorSequenceNumber(loaded.vendor);
  const folderName = vendorDriveFolderName(sequenceNumber, loaded.vendor.displayName);
  const folder = await ensureVendorDriveFolder(folderName);
  if (!folder.ok) return vendorsInvalidInputResult(folder.message);

  const uploaded = await uploadFileToVendorDriveFolder(folder.data.folderId, { buffer: input.buffer, fileName: input.fileName, mimeType: input.mimeType });
  if (!uploaded.ok) return vendorsInvalidInputResult(uploaded.message);

  const evidence: RestrictedFinancialIdentityEvidence = {
    docType: docType.data,
    kind: "upload",
    url: uploaded.data.webViewLink,
    fileName: input.fileName,
    addedAt: new Date().toISOString(),
    addedByUserRef: actor!.userRef,
  };

  const docId = restrictedIdentityDocId("VENDOR", loaded.vendor.uid);
  const result = await appendEvidence(docId, input.expectedVersion, evidence);
  if (result.kind === "no_restricted_identity") return vendorsInvalidInputResult("Save the restricted identity fields above before adding evidence.");
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Vendor's restricted identity was changed elsewhere. Reload and try again." };

  await writeVendorEvent({ vendorUid: loaded.vendor.uid, kind: "restricted_identity_saved", actorUserRef: actor!.userRef, metadata: { evidenceAdded: input.docType, kind: "upload" }, requestId });
  return { ok: true, data: { version: result.version, evidence: result.evidence } };
}
