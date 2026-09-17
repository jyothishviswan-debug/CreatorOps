import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";

// Step 8A.1: the ONE canonical restricted-subject collection family for
// Partner and Vendor tax/bank/KYC data - "restrictedFinancialIdentities".
// Step 8A had introduced a parallel Vendor-only collection
// ("restrictedVendorFinancialIdentities"), which diverged from the
// canonical data model; this module is the single source of truth going
// forward, imported by BOTH src/server/partners/restricted-identity-
// service.ts and src/server/vendors/restricted-identity-service.ts, so
// neither domain "owns" it and there is exactly one place the canonical
// shape/collection/doc-id scheme is defined.
//
// The trusted-server boundary this replaces stays exactly as it was for
// each domain: Vendor routes/services keep their own Vendor-specific
// methods and the separate "vendor_payment_details" sensitive category;
// only the underlying PERSISTENCE family is unified. Partner and Vendor
// subject documents coexist safely in the one collection via an explicit
// subjectType discriminator plus a deterministic, type-prefixed document
// id (see restrictedIdentityDocId) - a Partner uid and a Vendor uid are
// drawn from independent Firestore auto-id spaces in production, but
// deterministic seed/test uids are exactly where an un-prefixed
// collision could realistically happen, so the prefix is not
// theoretical caution.
export const RESTRICTED_FINANCIAL_IDENTITIES_COLLECTION = "restrictedFinancialIdentities";

export const RESTRICTED_FINANCIAL_SUBJECT_TYPES = ["PARTNER", "VENDOR"] as const;
export const restrictedFinancialSubjectTypeSchema = z.enum(RESTRICTED_FINANCIAL_SUBJECT_TYPES);
export type RestrictedFinancialSubjectType = z.infer<typeof restrictedFinancialSubjectTypeSchema>;

// docType union covers both subjects' evidence kinds - "aadhaar" is only
// ever used by PARTNER subjects in practice (Vendor is a business
// entity), but the schema itself doesn't need to enforce that; each
// domain's own input schema already only accepts the fields relevant to
// it (see each restricted-identity-service.ts's own zod input schema).
export const restrictedFinancialIdentityEvidenceSchema = z.object({
  docType: z.enum(["pan", "aadhaar", "gst", "bank", "other"]),
  kind: z.enum(["link", "upload"]),
  url: z.string().min(1).max(1000),
  fileName: z.string().min(1).max(200).nullable(),
  addedAt: z.string().min(1),
  addedByUserRef: z.string().min(1),
});
export type RestrictedFinancialIdentityEvidence = z.infer<typeof restrictedFinancialIdentityEvidenceSchema>;

export const restrictedFinancialIdentityDocSchema = z.object({
  // Deterministic, type-prefixed (see restrictedIdentityDocId) - never a
  // bare subject uid, so a Partner and a Vendor can never collide on the
  // same document even if their underlying uids were ever equal.
  uid: z.string().min(1),
  subjectType: restrictedFinancialSubjectTypeSchema,
  // The subject's own opaque, browser-facing ref (a partnerRef or
  // vendorRef) - never a raw Firestore/Firebase uid.
  subjectRef: z.string().min(1),
  version: z.number().int().min(1),
  pan: z.object({ number: z.string().min(1).max(20) }).nullable().default(null),
  aadhaar: z.object({ number: z.string().min(1).max(40) }).nullable().default(null),
  gst: z.object({ applicable: z.boolean(), number: z.string().min(1).max(30).optional() }).nullable().default(null),
  bank: z
    .object({
      accountHolderName: z.string().min(1).max(200),
      accountNumber: z.string().min(1).max(40),
      ifsc: z.string().min(1).max(20),
      bankName: z.string().min(1).max(120),
      branchName: z.string().min(1).max(120),
    })
    .nullable()
    .default(null),
  evidence: z.array(restrictedFinancialIdentityEvidenceSchema).default([]),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type RestrictedFinancialIdentityDoc = z.infer<typeof restrictedFinancialIdentityDocSchema>;

export function restrictedFinancialIdentitiesCollection() {
  return getAdminFirestore().collection(RESTRICTED_FINANCIAL_IDENTITIES_COLLECTION);
}

// The one place the type-prefixed doc-id scheme is defined - every
// reader/writer of this collection MUST go through this, never a bare
// subject uid, or the Partner/Vendor collision-prevention guarantee
// breaks silently.
export function restrictedIdentityDocId(subjectType: RestrictedFinancialSubjectType, subjectUid: string): string {
  return `${subjectType}:${subjectUid}`;
}

export async function getRestrictedFinancialIdentityDoc(subjectType: RestrictedFinancialSubjectType, subjectUid: string): Promise<RestrictedFinancialIdentityDoc | null> {
  const snapshot = await restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId(subjectType, subjectUid)).get();
  if (!snapshot.exists) return null;
  const result = restrictedFinancialIdentityDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}
