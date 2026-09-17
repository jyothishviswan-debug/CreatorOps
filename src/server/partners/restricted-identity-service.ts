import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import type { ActorContext } from "@/server/authz/types";
import { getPartnerDocByRef, getRestrictedFinancialIdentityDoc, restrictedFinancialIdentitiesCollection } from "./firestore";
import { writePartnerEvent } from "./partner-events";
import { requirePartnerInScope, requirePartnerRestrictedIdentitySensitiveAccess, requirePartnersAccess } from "./partners-gate";
import { partnersInvalidInputResult, partnersUnauthorizedResult, restrictedFinancialIdentityDocSchema, type PartnerDoc, type PartnersServiceResult, type RestrictedFinancialIdentityDoc } from "./types";

// Never exposes the raw Partner uid to the browser - partnerRef already
// identifies the record.
export type RestrictedFinancialIdentityDto = Omit<RestrictedFinancialIdentityDoc, "uid">;
function toRestrictedIdentityDto(doc: RestrictedFinancialIdentityDoc): RestrictedFinancialIdentityDto {
  const rest: Partial<RestrictedFinancialIdentityDoc> = { ...doc };
  delete rest.uid;
  return rest as RestrictedFinancialIdentityDto;
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

export async function getPartnerRestrictedIdentity(actor: ActorContext | null, partnerRef: unknown): Promise<PartnersServiceResult<RestrictedFinancialIdentityDto | null>> {
  const loaded = await requireRestrictedAccess(actor, partnerRef);
  if (!loaded.ok) return loaded.error;

  const doc = await getRestrictedFinancialIdentityDoc(loaded.partner.uid);
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
export async function savePartnerRestrictedIdentity(actor: ActorContext | null, partnerRef: unknown, rawInput: unknown, requestId: string): Promise<PartnersServiceResult<RestrictedFinancialIdentityDto>> {
  const loaded = await requireRestrictedAccess(actor, partnerRef);
  if (!loaded.ok) return loaded.error;

  const parsed = saveRestrictedIdentityInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (input.gst?.applicable && !input.gst.number) {
    return partnersInvalidInputResult("gst.number is required when GST is applicable.");
  }

  const db = getAdminFirestore();
  const docRef = restrictedFinancialIdentitiesCollection().doc(loaded.partner.uid);
  const now = new Date().toISOString();

  const result = await db.runTransaction<SaveTxResult>(async (tx) => {
    const snap = await tx.get(docRef);
    const existing = snap.exists ? restrictedFinancialIdentityDocSchema.safeParse(snap.data()) : null;
    const currentVersion = existing?.success ? existing.data.version : 0;
    if (currentVersion !== input.expectedVersion) return { kind: "stale" };

    const next: RestrictedFinancialIdentityDoc = restrictedFinancialIdentityDocSchema.parse({
      uid: loaded.partner.uid,
      partnerRef: loaded.partner.partnerRef,
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
