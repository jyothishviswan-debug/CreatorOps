import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import type { ActorContext } from "@/server/authz/types";
import {
  getRestrictedFinancialIdentityDoc,
  restrictedFinancialIdentitiesCollection,
  restrictedFinancialIdentityDocSchema,
  restrictedIdentityDocId,
  type RestrictedFinancialIdentityDoc,
} from "@/server/shared/restricted-financial-identity";
import { getVendorDocByRef } from "./firestore";
import { writeVendorEvent } from "./vendor-events";
import { requireVendorInScope, requireVendorRestrictedIdentitySensitiveAccess, requireVendorsAccess } from "./vendors-gate";
import { vendorsInvalidInputResult, vendorsUnauthorizedResult, type VendorDoc, type VendorsServiceResult } from "./types";

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
