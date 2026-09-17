import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import type { ActorContext } from "@/server/authz/types";
import { getVendorDocByRef, getRestrictedVendorFinancialIdentityDoc, restrictedVendorFinancialIdentitiesCollection } from "./firestore";
import { writeVendorEvent } from "./vendor-events";
import { requireVendorInScope, requireVendorRestrictedIdentitySensitiveAccess, requireVendorsAccess } from "./vendors-gate";
import { restrictedVendorFinancialIdentityDocSchema, vendorsInvalidInputResult, vendorsUnauthorizedResult, type RestrictedVendorFinancialIdentityDoc, type VendorDoc, type VendorsServiceResult } from "./types";

// Never exposes the raw Vendor uid to the browser - vendorRef already
// identifies the record.
export type RestrictedVendorFinancialIdentityDto = Omit<RestrictedVendorFinancialIdentityDoc, "uid">;
function toRestrictedIdentityDto(doc: RestrictedVendorFinancialIdentityDoc): RestrictedVendorFinancialIdentityDto {
  const rest: Partial<RestrictedVendorFinancialIdentityDoc> = { ...doc };
  delete rest.uid;
  return rest as RestrictedVendorFinancialIdentityDto;
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

export async function getVendorRestrictedIdentity(actor: ActorContext | null, vendorRef: unknown): Promise<VendorsServiceResult<RestrictedVendorFinancialIdentityDto | null>> {
  const loaded = await requireRestrictedAccess(actor, vendorRef);
  if (!loaded.ok) return loaded.error;

  const doc = await getRestrictedVendorFinancialIdentityDoc(loaded.vendor.uid);
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

type SaveTxResult = { kind: "ok"; doc: RestrictedVendorFinancialIdentityDoc } | { kind: "stale" };

// Full-document overwrite of the restricted fields only - `evidence` is
// always carried forward untouched (never silently dropped by a core-
// field save). Never logs a raw restricted value into the append-only
// event log - only that a save happened. When a GST number is supplied,
// this also runs a bounded, safe exact-collision check against every
// OTHER Vendor's restricted GST (Step 8A section 6: "Restricted GST/tax
// identifiers, if used for exact collision detection, remain inside the
// restricted trusted service and return only safe collision results") -
// the raw value of the colliding record is never returned, only the
// fact of the collision.
export async function saveVendorRestrictedIdentity(actor: ActorContext | null, vendorRef: unknown, rawInput: unknown, requestId: string): Promise<VendorsServiceResult<RestrictedVendorFinancialIdentityDto>> {
  const loaded = await requireRestrictedAccess(actor, vendorRef);
  if (!loaded.ok) return loaded.error;

  const parsed = saveRestrictedIdentityInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (input.gst?.applicable && !input.gst.number) {
    return vendorsInvalidInputResult("gst.number is required when GST is applicable.");
  }

  if (input.gst?.number) {
    const collision = await restrictedVendorFinancialIdentitiesCollection().where("gst.number", "==", input.gst.number).limit(2).get();
    const collidesWithAnother = collision.docs.some((doc) => doc.id !== loaded.vendor.uid);
    if (collidesWithAnother) {
      return { ok: false, code: "conflict", message: "This GST number is already on file for another Vendor." };
    }
  }

  const db = getAdminFirestore();
  const docRef = restrictedVendorFinancialIdentitiesCollection().doc(loaded.vendor.uid);
  const now = new Date().toISOString();

  const result = await db.runTransaction<SaveTxResult>(async (tx) => {
    const snap = await tx.get(docRef);
    const existing = snap.exists ? restrictedVendorFinancialIdentityDocSchema.safeParse(snap.data()) : null;
    const currentVersion = existing?.success ? existing.data.version : 0;
    if (currentVersion !== input.expectedVersion) return { kind: "stale" };

    const next: RestrictedVendorFinancialIdentityDoc = restrictedVendorFinancialIdentityDocSchema.parse({
      uid: loaded.vendor.uid,
      vendorRef: loaded.vendor.vendorRef,
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
