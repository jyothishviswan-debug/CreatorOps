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
  regionIds: string[];
  teamId: string | null;
  ownerRef: string | null;
  ownerDisplayName: string | null;
  research: LeadResearch | null;
  latestReview: LeadReview | null;
  outreachSummary: LeadOutreachSummary | null;
  respondedAt: string | null;
  commercial: LeadCommercialEvidence | null;
  discoveryAgreement: LeadDiscoveryAgreementEvidence | null;
  assetDecision: LeadAssetDecision | null;
  managerRef: string | null;
  managerDisplayName: string | null;
  kycPackageComplete: boolean;
  proposalNumber: number | null;
  proposalPlatformCode: string | null;
  duplicateCheck: DuplicateCheckResult | null;
  conversion: LeadConversionRecord | null;
  createdAt: string;
  createdByUserRef: string;
  updatedAt: string;
  updatedByUserRef: string;
};

// A referenced uid (owner/manager) can, in principle, no longer resolve
// (the user doc was somehow removed) - fail soft here (nulls) rather
// than throwing, since this is a display concern, not an authorization
// decision; nothing about access control depends on this lookup
// succeeding. Resolves both the opaque userRef AND a display name in one
// lookup - Discovery UI needs a human-readable owner/manager name (the
// Workspace table, the Detail page) without a second round-trip through
// an Administration endpoint Discovery actors may not have access to.
async function resolveUserRefAndName(uid: string | null): Promise<{ ref: string | null; displayName: string | null }> {
  if (!uid) return { ref: null, displayName: null };
  const doc = await getUserDoc(uid);
  return { ref: doc?.userRef ?? null, displayName: doc?.displayName ?? null };
}

export async function toLeadDto(doc: LeadDoc): Promise<LeadDto> {
  const [owner, manager] = await Promise.all([resolveUserRefAndName(doc.ownerUid), resolveUserRefAndName(doc.managerUid)]);

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
    regionIds: doc.regionIds,
    teamId: doc.teamId,
    ownerRef: owner.ref,
    ownerDisplayName: owner.displayName,
    research: doc.research,
    latestReview: doc.latestReview,
    outreachSummary: doc.outreachSummary,
    respondedAt: doc.respondedAt,
    commercial: doc.commercial,
    discoveryAgreement: doc.discoveryAgreement,
    assetDecision: doc.assetDecision,
    managerRef: manager.ref,
    managerDisplayName: manager.displayName,
    kycPackageComplete: doc.kycPackageComplete,
    proposalNumber: doc.proposalNumber,
    proposalPlatformCode: doc.proposalPlatformCode,
    duplicateCheck: doc.duplicateCheck,
    conversion: doc.conversion,
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
    updatedAt: doc.updatedAt,
    updatedByUserRef: doc.updatedByUserRef,
  };
}
