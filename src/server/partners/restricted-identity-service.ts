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
import { ensurePartnerDriveFolder, partnerDriveFolderName, uploadFileToPartnerDriveFolder } from "./drive-client";
import { getPartnerDocByRef, partnersCollection } from "./firestore";
import { writePartnerEvent } from "./partner-events";
import { requirePartnerInScope, requirePartnerRestrictedIdentitySensitiveAccess, requirePartnersAccess } from "./partners-gate";
import { partnerDocSchema, partnersInvalidInputResult, partnersUnauthorizedResult, type PartnerDoc, type PartnersServiceResult } from "./types";

// Step 8A.1: persists into the ONE canonical restrictedFinancialIdentities
// collection (see src/server/shared/restricted-financial-identity.ts),
// discriminated by subjectType "PARTNER" and a deterministic
// type-prefixed doc id - never a parallel Partner-only collection. The
// browser-facing DTO stays exactly as narrow as before: never exposes
// the raw doc id, subjectType, or subjectRef, only the restricted
// fields the UI actually needs.
export type PartnerRestrictedIdentityDto = Omit<RestrictedFinancialIdentityDoc, "uid" | "subjectType" | "subjectRef">;
function toRestrictedIdentityDto(doc: RestrictedFinancialIdentityDoc): PartnerRestrictedIdentityDto {
  const rest: Partial<RestrictedFinancialIdentityDoc> = { ...doc };
  delete rest.uid;
  delete rest.subjectType;
  delete rest.subjectRef;
  return rest as PartnerRestrictedIdentityDto;
}

// Restricted identity is gated by BOTH the manage_partner_restricted_identity
// action AND the payment_details sensitive-access category - same
// two-gate discipline as Discovery's KYC (a role can be allowed to
// operate the workflow without being allowed to see the actual restricted
// values).
async function requireRestrictedAccess(actor: ActorContext | null, partnerRef: unknown): Promise<{ ok: true; partner: PartnerDoc } | { ok: false; error: PartnersServiceResult<never> }> {
  const gate = await requirePartnersAccess(actor, "manage_partner_restricted_identity");
  if (!gate.ok) return { ok: false, error: partnersUnauthorizedResult(gate.reason) };

  const sensitiveGate = await requirePartnerRestrictedIdentitySensitiveAccess(actor!);
  if (!sensitiveGate.ok) return { ok: false, error: partnersUnauthorizedResult(sensitiveGate.reason) };

  if (typeof partnerRef !== "string" || partnerRef.length === 0) return { ok: false, error: partnersInvalidInputResult("Missing partnerRef.") };
  const partner = await getPartnerDocByRef(partnerRef);
  if (!partner) return { ok: false, error: { ok: false, code: "not_found", message: "Partner not found." } };

  const scopeCheck = await requirePartnerInScope(actor!, partner);
  if (!scopeCheck.ok) return { ok: false, error: partnersUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, partner };
}

export async function getPartnerRestrictedIdentity(actor: ActorContext | null, partnerRef: unknown): Promise<PartnersServiceResult<PartnerRestrictedIdentityDto | null>> {
  const loaded = await requireRestrictedAccess(actor, partnerRef);
  if (!loaded.ok) return loaded.error;

  const doc = await getRestrictedFinancialIdentityDoc("PARTNER", loaded.partner.uid);
  return { ok: true, data: doc ? toRestrictedIdentityDto(doc) : null };
}

const saveRestrictedIdentityInputSchema = z.object({
  pan: z.object({ number: z.string().min(1).max(20) }).nullable().optional(),
  aadhaar: z.object({ number: z.string().min(1).max(40) }).nullable().optional(),
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
  gst: z.object({ applicable: z.boolean(), number: z.string().min(1).max(30).optional() }).nullable().optional(),
  expectedVersion: z.number().int().min(0), // 0 == "no restricted identity doc exists yet"
});
export type SavePartnerRestrictedIdentityInput = z.input<typeof saveRestrictedIdentityInputSchema>;

type SaveTxResult = { kind: "ok"; doc: RestrictedFinancialIdentityDoc } | { kind: "stale" };

// Full-document overwrite of the restricted fields only - `evidence` is
// always carried forward untouched (added separately, see
// addRestrictedIdentityEvidence), never silently dropped by a core-field
// save. Never logs a raw restricted value into the append-only event
// log - only that a save happened (same discipline as Discovery's KYC).
export async function savePartnerRestrictedIdentity(actor: ActorContext | null, partnerRef: unknown, rawInput: unknown, requestId: string): Promise<PartnersServiceResult<PartnerRestrictedIdentityDto>> {
  const loaded = await requireRestrictedAccess(actor, partnerRef);
  if (!loaded.ok) return loaded.error;

  const parsed = saveRestrictedIdentityInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (input.gst?.applicable && !input.gst.number) {
    return partnersInvalidInputResult("gst.number is required when GST is applicable.");
  }

  const db = getAdminFirestore();
  const docId = restrictedIdentityDocId("PARTNER", loaded.partner.uid);
  const docRef = restrictedFinancialIdentitiesCollection().doc(docId);
  const now = new Date().toISOString();

  const result = await db.runTransaction<SaveTxResult>(async (tx) => {
    const snap = await tx.get(docRef);
    const existing = snap.exists ? restrictedFinancialIdentityDocSchema.safeParse(snap.data()) : null;
    const currentVersion = existing?.success ? existing.data.version : 0;
    if (currentVersion !== input.expectedVersion) return { kind: "stale" };

    const next: RestrictedFinancialIdentityDoc = restrictedFinancialIdentityDocSchema.parse({
      uid: docId,
      subjectType: "PARTNER",
      subjectRef: loaded.partner.partnerRef,
      version: currentVersion + 1,
      pan: input.pan !== undefined ? input.pan : (existing?.success ? existing.data.pan : null),
      aadhaar: input.aadhaar !== undefined ? input.aadhaar : (existing?.success ? existing.data.aadhaar : null),
      bank: input.bank !== undefined ? input.bank : (existing?.success ? existing.data.bank : null),
      gst: input.gst !== undefined ? input.gst : (existing?.success ? existing.data.gst : null),
      evidence: existing?.success ? existing.data.evidence : [],
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    tx.set(docRef, next);
    return { kind: "ok", doc: next };
  });

  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Partner's restricted identity was changed elsewhere. Reload and try again." };

  await writePartnerEvent({ partnerUid: loaded.partner.uid, kind: "restricted_identity_saved", actorUserRef: actor!.userRef, metadata: { fieldsPresent: Object.keys(input).filter((k) => k !== "expectedVersion" && input[k as keyof typeof input] != null) }, requestId });
  return { ok: true, data: toRestrictedIdentityDto(result.doc) };
}

// ---- Evidence (real KYC upload feature, mirrors Discovery's own) ------
// The actual evidence for the fields above - each entry is either an
// operator-supplied link or a real file uploaded into this Partner's own
// Drive subfolder (see drive-client.ts). Requires the core restricted-
// identity fields to already exist (the operator saves PAN/Aadhaar/bank
// first) - evidence has nowhere to live before that, same discipline as
// Discovery's own KYC attachments.

const SEQUENCE_COUNTERS_COLLECTION = "sequenceCounters";

// Allocated exactly once per Partner, the first time evidence is
// uploaded - never reassigned afterward (see types.ts's sequenceNumber
// field comment). All reads happen before the one write, inside a single
// transaction, so two concurrent first-uploads for two DIFFERENT
// Partners can never be handed the same number.
async function ensurePartnerSequenceNumber(partner: PartnerDoc): Promise<number> {
  if (partner.sequenceNumber != null) return partner.sequenceNumber;

  const db = getAdminFirestore();
  const counterRef = db.collection(SEQUENCE_COUNTERS_COLLECTION).doc("partner");
  const partnerRef = partnersCollection().doc(partner.uid);

  return db.runTransaction<number>(async (tx) => {
    const [counterSnap, partnerSnap] = await Promise.all([tx.get(counterRef), tx.get(partnerRef)]);
    const freshPartner = partnerDocSchema.safeParse(partnerSnap.data());
    if (freshPartner.success && freshPartner.data.sequenceNumber != null) return freshPartner.data.sequenceNumber;

    const next = counterSnap.exists ? ((counterSnap.data()?.next as number | undefined) ?? 1) : 1;
    tx.set(counterRef, { next: next + 1 });
    tx.update(partnerRef, { sequenceNumber: next });
    return next;
  });
}

const evidenceDocTypeSchema = z.enum(["pan", "aadhaar", "gst", "bank", "other"]);

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
export type AddPartnerRestrictedIdentityLinkEvidenceInput = z.input<typeof addLinkEvidenceInputSchema>;

export async function addPartnerRestrictedIdentityLinkEvidence(
  actor: ActorContext | null,
  partnerRef: unknown,
  rawInput: unknown,
  requestId: string,
): Promise<PartnersServiceResult<{ version: number; evidence: RestrictedFinancialIdentityEvidence }>> {
  const loaded = await requireRestrictedAccess(actor, partnerRef);
  if (!loaded.ok) return loaded.error;

  const parsed = addLinkEvidenceInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const evidence: RestrictedFinancialIdentityEvidence = { docType: input.docType, kind: "link", url: input.url, fileName: null, addedAt: new Date().toISOString(), addedByUserRef: actor!.userRef };

  const docId = restrictedIdentityDocId("PARTNER", loaded.partner.uid);
  const result = await appendEvidence(docId, input.expectedVersion, evidence);
  if (result.kind === "no_restricted_identity") return partnersInvalidInputResult("Save the restricted identity fields above before adding evidence.");
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Partner's restricted identity was changed elsewhere. Reload and try again." };

  await writePartnerEvent({ partnerUid: loaded.partner.uid, kind: "restricted_identity_saved", actorUserRef: actor!.userRef, metadata: { evidenceAdded: input.docType, kind: "link" }, requestId });
  return { ok: true, data: { version: result.version, evidence: result.evidence } };
}

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export type AddPartnerRestrictedIdentityUploadEvidenceInput = {
  docType: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  expectedVersion: number;
};

// Real (never simulated) upload: creates-or-reuses this Partner's own
// Drive subfolder (named "P{sequenceNumber}_{displayName}_", allocated
// on first upload - see ensurePartnerSequenceNumber), uploads the file
// there, and only ever stores the real webViewLink Drive returns. If
// Drive itself fails (folder not shared, API not enabled, network), this
// fails loudly with that reason - it never records a fabricated link.
export async function addPartnerRestrictedIdentityUploadEvidence(
  actor: ActorContext | null,
  partnerRef: unknown,
  input: AddPartnerRestrictedIdentityUploadEvidenceInput,
  requestId: string,
): Promise<PartnersServiceResult<{ version: number; evidence: RestrictedFinancialIdentityEvidence }>> {
  const loaded = await requireRestrictedAccess(actor, partnerRef);
  if (!loaded.ok) return loaded.error;

  const docType = evidenceDocTypeSchema.safeParse(input.docType);
  if (!docType.success) return partnersInvalidInputResult("Invalid docType.");
  if (!input.fileName || input.fileName.length > 200) return partnersInvalidInputResult("Invalid file name.");
  if (input.buffer.byteLength === 0) return partnersInvalidInputResult("The uploaded file is empty.");
  if (input.buffer.byteLength > MAX_UPLOAD_BYTES) return partnersInvalidInputResult("Files larger than 15 MB are not supported.");

  const sequenceNumber = await ensurePartnerSequenceNumber(loaded.partner);
  const folderName = partnerDriveFolderName(sequenceNumber, loaded.partner.displayName);
  const folder = await ensurePartnerDriveFolder(folderName);
  if (!folder.ok) return partnersInvalidInputResult(folder.message);

  const uploaded = await uploadFileToPartnerDriveFolder(folder.data.folderId, { buffer: input.buffer, fileName: input.fileName, mimeType: input.mimeType });
  if (!uploaded.ok) return partnersInvalidInputResult(uploaded.message);

  const evidence: RestrictedFinancialIdentityEvidence = {
    docType: docType.data,
    kind: "upload",
    url: uploaded.data.webViewLink,
    fileName: input.fileName,
    addedAt: new Date().toISOString(),
    addedByUserRef: actor!.userRef,
  };

  const docId = restrictedIdentityDocId("PARTNER", loaded.partner.uid);
  const result = await appendEvidence(docId, input.expectedVersion, evidence);
  if (result.kind === "no_restricted_identity") return partnersInvalidInputResult("Save the restricted identity fields above before adding evidence.");
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Partner's restricted identity was changed elsewhere. Reload and try again." };

  await writePartnerEvent({ partnerUid: loaded.partner.uid, kind: "restricted_identity_saved", actorUserRef: actor!.userRef, metadata: { evidenceAdded: input.docType, kind: "upload" }, requestId });
  return { ok: true, data: { version: result.version, evidence: result.evidence } };
}
