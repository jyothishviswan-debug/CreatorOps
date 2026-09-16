import { getUserDoc } from "@/server/authz/firestore";
import type {
  DuplicateCheckResult,
  LeadAssetDecision,
  LeadCommercialEvidence,
  LeadConversionRecord,
  LeadDiscoveryAgreementEvidence,
  LeadDoc,
  LeadLifecycle,
  LeadOutreachSummary,
  LeadResearch,
  LeadReview,
  LeadSource,
} from "./types";

// The only shape of a Lead ever handed to the browser - no Firestore doc
// id, no raw Firebase uid anywhere (ownerUid/managerUid are resolved to
// their owner's/manager's own opaque userRef, same pattern as
// AdminUserDto). Restricted KYC is never included here at all - see
// kyc-service.ts's own, separately-gated DTO.
export type LeadDto = {
  leadRef: string;
  version: number;
  lifecycle: LeadLifecycle;
  previousLifecycle: LeadLifecycle | null;
  lifecycleReason: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  profileUrl: string | null;
  platform: string | null;
  handle: string | null;
  source: LeadSource;
  region: string | null;
  teamId: string | null;
  ownerRef: string | null;
  research: LeadResearch | null;
  latestReview: LeadReview | null;
  outreachSummary: LeadOutreachSummary | null;
  respondedAt: string | null;
  commercial: LeadCommercialEvidence | null;
  discoveryAgreement: LeadDiscoveryAgreementEvidence | null;
  assetDecision: LeadAssetDecision | null;
  managerRef: string | null;
  kycPackageComplete: boolean;
  duplicateCheck: DuplicateCheckResult | null;
  conversion: LeadConversionRecord | null;
  createdAt: string;
  createdByUserRef: string;
  updatedAt: string;
  updatedByUserRef: string;
};

// A referenced uid (owner/manager) can, in principle, no longer resolve
// (the user doc was somehow removed) - fail soft here (null) rather than
// throwing, since this is a display concern, not an authorization
// decision; nothing about access control depends on this lookup
// succeeding.
async function resolveUserRef(uid: string | null): Promise<string | null> {
  if (!uid) return null;
  const doc = await getUserDoc(uid);
  return doc?.userRef ?? null;
}

export async function toLeadDto(doc: LeadDoc): Promise<LeadDto> {
  const [ownerRef, managerRef] = await Promise.all([resolveUserRef(doc.ownerUid), resolveUserRef(doc.managerUid)]);

  return {
    leadRef: doc.leadRef,
    version: doc.version,
    lifecycle: doc.lifecycle,
    previousLifecycle: doc.previousLifecycle,
    lifecycleReason: doc.lifecycleReason,
    displayName: doc.displayName,
    email: doc.email,
    phone: doc.phone,
    profileUrl: doc.profileUrl,
    platform: doc.platform,
    handle: doc.handle,
    source: doc.source,
    region: doc.region,
    teamId: doc.teamId,
    ownerRef,
    research: doc.research,
    latestReview: doc.latestReview,
    outreachSummary: doc.outreachSummary,
    respondedAt: doc.respondedAt,
    commercial: doc.commercial,
    discoveryAgreement: doc.discoveryAgreement,
    assetDecision: doc.assetDecision,
    managerRef,
    kycPackageComplete: doc.kycPackageComplete,
    duplicateCheck: doc.duplicateCheck,
    conversion: doc.conversion,
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
    updatedAt: doc.updatedAt,
    updatedByUserRef: doc.updatedByUserRef,
  };
}
