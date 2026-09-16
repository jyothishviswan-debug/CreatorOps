import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { requireDiscoveryAccess, requireDiscoveryKycSensitiveAccess, requireLeadInScope } from "./discovery-gate";
import { ensureLeadDriveFolder, leadDriveFolderName, uploadFileToDriveFolder } from "./drive-client";
import { getLeadDocByRef, getLeadRestrictedKycDoc, leadRestrictedKycCollection, leadsCollection } from "./firestore";
import { getAdminFirestore } from "@/server/firebase/admin";
import { writeLeadEvent } from "./lead-events";
import { platformCodeFor } from "./proposal-number";
import {
  discoveryInvalidInputResult,
  discoveryUnauthorizedResult,
  leadDocSchema,
  leadRestrictedKycDocSchema,
  type DiscoveryErrorResult,
  type DiscoveryServiceResult,
  type LeadDoc,
  type LeadKycAttachment,
} from "./types";

// The restricted-KYC DTO - deliberately its own type, never merged into
// LeadDto, so there is no code path where an ordinary Lead read could
// accidentally include it. `uid` (the Lead's internal Firestore id) is
// still never exposed - `leadRef` identifies it instead.
export type LeadKycDto = {
  leadRef: string;
  version: number;
  email: string;
  aadhaar: { number: string };
  pan: { number: string };
  bank: { accountHolderName: string; accountNumber: string; ifsc: string; bankName: string; branchName: string };
  gst: { applicable: boolean; number?: string };
  attachments: LeadKycAttachment[];
  updatedAt: string;
  updatedByUserRef: string;
};

async function requireKycAccess(actor: ActorContext | null, leadRef: unknown): Promise<{ ok: true; lead: LeadDoc } | { ok: false; error: DiscoveryErrorResult }> {
  if (!actor) return { ok: false, error: discoveryUnauthorizedResult("not_authenticated") };
  const gate = await requireDiscoveryAccess(actor, "manage_kyc");
  if (!gate.ok) return { ok: false, error: discoveryUnauthorizedResult(gate.reason) };
  const sensitiveGate = await requireDiscoveryKycSensitiveAccess(actor);
  if (!sensitiveGate.ok) return { ok: false, error: discoveryUnauthorizedResult(sensitiveGate.reason) };

  if (typeof leadRef !== "string" || leadRef.length === 0) return { ok: false, error: discoveryInvalidInputResult("Missing leadRef.") };
  const lead = await getLeadDocByRef(leadRef);
  if (!lead) return { ok: false, error: { ok: false, code: "not_found", message: "Lead not found." } };

  const scopeCheck = await requireLeadInScope(actor, lead);
  if (!scopeCheck.ok) return { ok: false, error: discoveryUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, lead };
}

// ---- Read ----

export async function getLeadKyc(actor: ActorContext | null, leadRef: unknown): Promise<DiscoveryServiceResult<LeadKycDto | null>> {
  const access = await requireKycAccess(actor, leadRef);
  if (!access.ok) return access.error;

  const doc = await getLeadRestrictedKycDoc(access.lead.uid);
  if (!doc) return { ok: true, data: null };

  const leadRefStr = typeof leadRef === "string" ? leadRef : "";
  return {
    ok: true,
    data: {
      leadRef: leadRefStr,
      version: doc.version,
      email: doc.email,
      aadhaar: doc.aadhaar,
      pan: doc.pan,
      bank: doc.bank,
      gst: doc.gst,
      attachments: doc.attachments,
      updatedAt: doc.updatedAt,
      updatedByUserRef: doc.updatedByUserRef,
    },
  };
}

// ---- Write: core fields ----

const saveKycInputSchema = z.object({
  email: z.string().min(1).max(300),
  aadhaar: z.object({ number: z.string().min(1).max(40) }),
  pan: z.object({ number: z.string().min(1).max(20) }),
  bank: z.object({
    accountHolderName: z.string().min(1).max(200),
    accountNumber: z.string().min(1).max(40),
    ifsc: z.string().min(1).max(20),
    bankName: z.string().min(1).max(120),
    branchName: z.string().min(1).max(120),
  }),
  gst: z.object({ applicable: z.boolean(), number: z.string().min(1).max(30).optional() }),
  // 0 means "no KYC document exists yet for this Lead".
  expectedKycVersion: z.number().int().min(0),
  expectedLeadVersion: z.number().int().min(1),
});
export type SaveKycInput = z.input<typeof saveKycInputSchema>;

type SaveKycTxResult = { kind: "ok"; version: number } | { kind: "stale_kyc" } | { kind: "stale_lead" } | { kind: "not_found" };

// Writes the restricted KYC package AND the Lead's non-sensitive
// kycPackageComplete summary flag in the same transaction - the two
// documents must never disagree about whether a package exists. Neither
// the raw values nor any KYC field name reaches the append-only event
// log; kyc_updated records only that a save happened. The existing
// `attachments` list (added separately, see below) is always carried
// forward untouched - this is a full-document overwrite of the core
// fields only, never a place that silently drops prior attachments.
export async function saveLeadKyc(actor: ActorContext | null, leadRef: unknown, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<{ version: number }>> {
  const access = await requireKycAccess(actor, leadRef);
  if (!access.ok) return access.error;

  const parsed = saveKycInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (input.gst.applicable && !input.gst.number) {
    return discoveryInvalidInputResult("gst.number is required when GST is applicable.");
  }

  const db = getAdminFirestore();
  const kycRef = leadRestrictedKycCollection().doc(access.lead.uid);
  const leadDocRef = leadsCollection().doc(access.lead.uid);

  const result = await db.runTransaction<SaveKycTxResult>(async (tx) => {
    const [kycSnap, leadSnap] = await Promise.all([tx.get(kycRef), tx.get(leadDocRef)]);
    if (!leadSnap.exists) return { kind: "not_found" };
    const parsedLead = leadDocSchema.safeParse(leadSnap.data());
    if (!parsedLead.success) return { kind: "not_found" };
    if (parsedLead.data.version !== input.expectedLeadVersion) return { kind: "stale_lead" };

    const parsedKyc = kycSnap.exists ? leadRestrictedKycDocSchema.safeParse(kycSnap.data()) : null;
    const onDiskVersion = parsedKyc?.success ? parsedKyc.data.version : 0;
    if (onDiskVersion !== input.expectedKycVersion) return { kind: "stale_kyc" };

    const now = new Date().toISOString();
    const nextKyc = leadRestrictedKycDocSchema.parse({
      uid: access.lead.uid,
      version: onDiskVersion + 1,
      email: input.email,
      aadhaar: input.aadhaar,
      pan: input.pan,
      bank: input.bank,
      gst: input.gst,
      attachments: parsedKyc?.success ? parsedKyc.data.attachments : [],
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    tx.set(kycRef, nextKyc);
    tx.update(leadDocRef, { kycPackageComplete: true, version: parsedLead.data.version + 1, updatedAt: now, updatedByUserRef: actor!.userRef });

    return { kind: "ok", version: nextKyc.version };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale_lead") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };
  if (result.kind === "stale_kyc") return { ok: false, code: "stale_write", message: "This Lead's KYC package was changed elsewhere. Reload and try again." };

  await writeLeadEvent({ leadUid: access.lead.uid, kind: "kyc_updated", actorUserRef: actor!.userRef, metadata: { saved: true }, requestId });
  return { ok: true, data: { version: result.version } };
}

// ---- Write: attachments (Step 6B.1) ----
// The actual evidence for the identifiers above - each entry is either
// an operator-supplied link or a real file uploaded into the Lead's own
// Drive subfolder. Requires the core KYC package to already exist (the
// operator saves email/Aadhaar/PAN/bank/GST first); attachments have
// nowhere to live before that.

const docTypeSchema = z.enum(["aadhaar", "pan", "bank", "gst", "other"]);

type AttachmentTxResult = { kind: "ok"; version: number; attachment: LeadKycAttachment } | { kind: "stale_kyc" } | { kind: "no_kyc_package" };

async function appendAttachment(
  leadUid: string,
  expectedKycVersion: number,
  attachment: LeadKycAttachment,
): Promise<AttachmentTxResult> {
  const db = getAdminFirestore();
  const kycRef = leadRestrictedKycCollection().doc(leadUid);

  return db.runTransaction<AttachmentTxResult>(async (tx) => {
    const snap = await tx.get(kycRef);
    if (!snap.exists) return { kind: "no_kyc_package" };
    const parsed = leadRestrictedKycDocSchema.safeParse(snap.data());
    if (!parsed.success) return { kind: "no_kyc_package" };
    const current = parsed.data;
    if (current.version !== expectedKycVersion) return { kind: "stale_kyc" };

    const next = leadRestrictedKycDocSchema.parse({
      ...current,
      version: current.version + 1,
      attachments: [...current.attachments, attachment],
    });
    tx.set(kycRef, next);
    return { kind: "ok", version: next.version, attachment };
  });
}

const addLinkAttachmentInputSchema = z.object({
  docType: docTypeSchema,
  url: z.string().min(1).max(1000),
  expectedKycVersion: z.number().int().min(0),
});
export type AddKycLinkAttachmentInput = z.input<typeof addLinkAttachmentInputSchema>;

export async function addKycLinkAttachment(
  actor: ActorContext | null,
  leadRef: unknown,
  rawInput: unknown,
  requestId: string,
): Promise<DiscoveryServiceResult<{ version: number; attachment: LeadKycAttachment }>> {
  const access = await requireKycAccess(actor, leadRef);
  if (!access.ok) return access.error;

  const parsed = addLinkAttachmentInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const attachment: LeadKycAttachment = {
    docType: input.docType,
    kind: "link",
    url: input.url,
    fileName: null,
    addedAt: new Date().toISOString(),
    addedByUserRef: actor!.userRef,
  };

  const result = await appendAttachment(access.lead.uid, input.expectedKycVersion, attachment);
  if (result.kind === "no_kyc_package") return discoveryInvalidInputResult("Save the KYC package above before adding attachments.");
  if (result.kind === "stale_kyc") return { ok: false, code: "stale_write", message: "This Lead's KYC package was changed elsewhere. Reload and try again." };

  await writeLeadEvent({ leadUid: access.lead.uid, kind: "kyc_updated", actorUserRef: actor!.userRef, metadata: { attachmentAdded: input.docType, kind: "link" }, requestId });
  return { ok: true, data: { version: result.version, attachment: result.attachment } };
}

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export type AddKycUploadAttachmentInput = {
  docType: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  expectedKycVersion: number;
};

// Real (never simulated) upload: creates-or-reuses the Lead's own Drive
// subfolder (named from its proposal number, allocated when Agreement
// was first confirmed - see lead-service.ts), uploads the file there,
// and only ever stores the real webViewLink Drive returns. If Drive
// itself fails (folder not shared, API not enabled, network), this
// fails loudly with that reason - it never records a fabricated link.
export async function addKycUploadAttachment(
  actor: ActorContext | null,
  leadRef: unknown,
  input: AddKycUploadAttachmentInput,
  requestId: string,
): Promise<DiscoveryServiceResult<{ version: number; attachment: LeadKycAttachment }>> {
  const access = await requireKycAccess(actor, leadRef);
  if (!access.ok) return access.error;

  const docType = docTypeSchema.safeParse(input.docType);
  if (!docType.success) return discoveryInvalidInputResult("Invalid docType.");
  if (!input.fileName || input.fileName.length > 200) return discoveryInvalidInputResult("Invalid file name.");
  if (input.buffer.byteLength === 0) return discoveryInvalidInputResult("The uploaded file is empty.");
  if (input.buffer.byteLength > MAX_UPLOAD_BYTES) return discoveryInvalidInputResult("Files larger than 15 MB are not supported.");

  if (access.lead.proposalNumber == null) {
    return discoveryInvalidInputResult("Complete the Agreement stage (confirm the operational agreement) before uploading KYC documents - that is what generates this Lead's Drive folder.");
  }

  const folderName = leadDriveFolderName(access.lead.proposalPlatformCode ?? platformCodeFor(access.lead.platform), access.lead.proposalNumber, access.lead.displayName);
  const folder = await ensureLeadDriveFolder(folderName);
  if (!folder.ok) return discoveryInvalidInputResult(folder.message);

  const uploaded = await uploadFileToDriveFolder(folder.data.folderId, { buffer: input.buffer, fileName: input.fileName, mimeType: input.mimeType });
  if (!uploaded.ok) return discoveryInvalidInputResult(uploaded.message);

  const attachment: LeadKycAttachment = {
    docType: docType.data,
    kind: "upload",
    url: uploaded.data.webViewLink,
    fileName: input.fileName,
    addedAt: new Date().toISOString(),
    addedByUserRef: actor!.userRef,
  };

  const result = await appendAttachment(access.lead.uid, input.expectedKycVersion, attachment);
  if (result.kind === "no_kyc_package") return discoveryInvalidInputResult("Save the KYC package above before adding attachments.");
  if (result.kind === "stale_kyc") return { ok: false, code: "stale_write", message: "This Lead's KYC package was changed elsewhere. Reload and try again." };

  await writeLeadEvent({ leadUid: access.lead.uid, kind: "kyc_updated", actorUserRef: actor!.userRef, metadata: { attachmentAdded: input.docType, kind: "upload" }, requestId });
  return { ok: true, data: { version: result.version, attachment: result.attachment } };
}
