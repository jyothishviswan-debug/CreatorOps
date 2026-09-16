import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { requireDiscoveryAccess, requireDiscoveryKycSensitiveAccess, requireLeadInScope } from "./discovery-gate";
import { getLeadDocByRef, getLeadRestrictedKycDoc, leadRestrictedKycCollection, leadsCollection } from "./firestore";
import { getAdminFirestore } from "@/server/firebase/admin";
import { writeLeadEvent } from "./lead-events";
import { discoveryInvalidInputResult, discoveryUnauthorizedResult, leadDocSchema, leadRestrictedKycDocSchema, type DiscoveryErrorResult, type DiscoveryServiceResult } from "./types";

// The restricted-KYC DTO - deliberately its own type, never merged into
// LeadDto, so there is no code path where an ordinary Lead read could
// accidentally include it. `uid` (the Lead's internal Firestore id) is
// still never exposed - `leadRef` identifies it instead.
export type LeadKycDto = {
  leadRef: string;
  version: number;
  email: string;
  aadhaar: { number: string; evidenceRef: string };
  pan: { number: string; evidenceRef: string };
  bank: { accountHolderName: string; accountNumber: string; ifsc: string; bankName: string; proofRef: string };
  gst: { applicable: boolean; number?: string; certificateRef?: string };
  updatedAt: string;
  updatedByUserRef: string;
};

async function requireKycAccess(actor: ActorContext | null, leadRef: unknown): Promise<{ ok: true; leadUid: string } | { ok: false; error: DiscoveryErrorResult }> {
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

  return { ok: true, leadUid: lead.uid };
}

// ---- Read ----

export async function getLeadKyc(actor: ActorContext | null, leadRef: unknown): Promise<DiscoveryServiceResult<LeadKycDto | null>> {
  const access = await requireKycAccess(actor, leadRef);
  if (!access.ok) return access.error;

  const doc = await getLeadRestrictedKycDoc(access.leadUid);
  if (!doc) return { ok: true, data: null };

  const leadRefStr = typeof leadRef === "string" ? leadRef : "";
  return {
    ok: true,
    data: { leadRef: leadRefStr, version: doc.version, email: doc.email, aadhaar: doc.aadhaar, pan: doc.pan, bank: doc.bank, gst: doc.gst, updatedAt: doc.updatedAt, updatedByUserRef: doc.updatedByUserRef },
  };
}

// ---- Write ----

const saveKycInputSchema = z.object({
  email: z.string().min(1).max(300),
  aadhaar: z.object({ number: z.string().min(1).max(40), evidenceRef: z.string().min(1).max(300) }),
  pan: z.object({ number: z.string().min(1).max(20), evidenceRef: z.string().min(1).max(300) }),
  bank: z.object({
    accountHolderName: z.string().min(1).max(200),
    accountNumber: z.string().min(1).max(40),
    ifsc: z.string().min(1).max(20),
    bankName: z.string().min(1).max(120),
    proofRef: z.string().min(1).max(300),
  }),
  gst: z.object({ applicable: z.boolean(), number: z.string().min(1).max(30).optional(), certificateRef: z.string().min(1).max(300).optional() }),
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
// log; kyc_updated records only that a save happened.
export async function saveLeadKyc(actor: ActorContext | null, leadRef: unknown, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<{ version: number }>> {
  const access = await requireKycAccess(actor, leadRef);
  if (!access.ok) return access.error;

  const parsed = saveKycInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (input.gst.applicable && (!input.gst.number || !input.gst.certificateRef)) {
    return discoveryInvalidInputResult("gst.number and gst.certificateRef are required when GST is applicable.");
  }

  const db = getAdminFirestore();
  const kycRef = leadRestrictedKycCollection().doc(access.leadUid);
  const leadRef2 = leadsCollection().doc(access.leadUid);

  const result = await db.runTransaction<SaveKycTxResult>(async (tx) => {
    const [kycSnap, leadSnap] = await Promise.all([tx.get(kycRef), tx.get(leadRef2)]);
    if (!leadSnap.exists) return { kind: "not_found" };
    const parsedLead = leadDocSchema.safeParse(leadSnap.data());
    if (!parsedLead.success) return { kind: "not_found" };
    if (parsedLead.data.version !== input.expectedLeadVersion) return { kind: "stale_lead" };

    const currentKycVersion = kycSnap.exists ? leadRestrictedKycDocSchema.safeParse(kycSnap.data()) : null;
    const onDiskVersion = currentKycVersion?.success ? currentKycVersion.data.version : 0;
    if (onDiskVersion !== input.expectedKycVersion) return { kind: "stale_kyc" };

    const now = new Date().toISOString();
    const nextKyc = leadRestrictedKycDocSchema.parse({
      uid: access.leadUid,
      version: onDiskVersion + 1,
      email: input.email,
      aadhaar: input.aadhaar,
      pan: input.pan,
      bank: input.bank,
      gst: input.gst,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    tx.set(kycRef, nextKyc);
    tx.update(leadRef2, { kycPackageComplete: true, version: parsedLead.data.version + 1, updatedAt: now, updatedByUserRef: actor!.userRef });

    return { kind: "ok", version: nextKyc.version };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale_lead") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };
  if (result.kind === "stale_kyc") return { ok: false, code: "stale_write", message: "This Lead's KYC package was changed elsewhere. Reload and try again." };

  await writeLeadEvent({ leadUid: access.leadUid, kind: "kyc_updated", actorUserRef: actor!.userRef, metadata: { saved: true }, requestId });
  return { ok: true, data: { version: result.version } };
}
