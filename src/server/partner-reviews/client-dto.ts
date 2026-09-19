import { getPartnerDocsByRefs } from "@/server/partners/firestore";
import type { EvidenceSnapshot, PartnerReviewFreshness, PartnerReviewHeadDoc, PartnerReviewSourceRef, PartnerReviewStatus, PartnerReviewVersionDoc } from "./types";

// The only shapes of a review ever handed to the browser: no Firestore doc
// ids beyond the opaque reviewRef, no raw Firebase uid anywhere (only
// userRefs), no scope-snapshot fields (ownerUid/regionIds/teamIds/
// partnerUid stay server-side), and no Partner data beyond partnerRef +
// displayName. The evidence snapshot itself is built exclusively from safe
// structured fields (see evidence-builder.ts).

export type PartnerReviewHeadDto = {
  reviewRef: string;
  partnerRef: string;
  partnerDisplayName: string | null;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  latestVersion: number;
  latestStatus: PartnerReviewStatus;
  currentFinalizedVersion: number | null;
  openVersion: number | null;
  docVersion: number;
  createdAt: string;
  createdByUserRef: string;
  updatedAt: string;
  updatedByUserRef: string;
};

export type PartnerReviewVersionSummaryDto = {
  version: number;
  status: PartnerReviewStatus;
  docVersion: number;
  evidenceCutoff: string;
  sourceFingerprint: string;
  generatedAt: string;
  generatedByUserRef: string;
  lastRefreshedAt: string | null;
  lastRefreshedByUserRef: string | null;
  submittedAt: string | null;
  submittedByUserRef: string | null;
  finalizedAt: string | null;
  finalizedByUserRef: string | null;
  supersededAt: string | null;
  supersededByVersion: number | null;
  statusReason: string | null;
};

export type PartnerReviewVersionDto = PartnerReviewVersionSummaryDto & {
  snapshot: EvidenceSnapshot;
  sourceRefs: PartnerReviewSourceRef[];
};

export type PartnerReviewFreshnessDto = PartnerReviewFreshness & {
  version: number;
  snapshotFingerprint: string;
  // null when no comparison was needed (a SUPERSEDED historical version).
  currentFingerprint: string | null;
  evaluatedAt: string;
};

export type PartnerReviewDetailDto = {
  head: PartnerReviewHeadDto;
  versions: PartnerReviewVersionSummaryDto[];
  hasMoreVersions: boolean;
  selectedVersion: PartnerReviewVersionDto | null;
  freshness: PartnerReviewFreshnessDto | null;
};

export function toPartnerReviewHeadDto(head: PartnerReviewHeadDoc, partnerDisplayName: string | null): PartnerReviewHeadDto {
  return {
    reviewRef: head.reviewRef,
    partnerRef: head.partnerRef,
    partnerDisplayName,
    periodKey: head.periodKey,
    periodStart: head.periodStart,
    periodEnd: head.periodEnd,
    latestVersion: head.latestVersion,
    latestStatus: head.latestStatus,
    currentFinalizedVersion: head.currentFinalizedVersion,
    openVersion: head.openVersion,
    docVersion: head.docVersion,
    createdAt: head.createdAt,
    createdByUserRef: head.createdByUserRef,
    updatedAt: head.updatedAt,
    updatedByUserRef: head.updatedByUserRef,
  };
}

// Batched, N+1-safe list path: resolves every distinct partner display name
// in one bounded bulk read.
export async function toPartnerReviewHeadDtos(heads: PartnerReviewHeadDoc[]): Promise<PartnerReviewHeadDto[]> {
  const partners = await getPartnerDocsByRefs(heads.map((head) => head.partnerRef));
  return heads.map((head) => toPartnerReviewHeadDto(head, partners.get(head.partnerRef)?.displayName ?? null));
}

export function toPartnerReviewVersionSummaryDto(doc: PartnerReviewVersionDoc): PartnerReviewVersionSummaryDto {
  return {
    version: doc.version,
    status: doc.status,
    docVersion: doc.docVersion,
    evidenceCutoff: doc.evidenceCutoff,
    sourceFingerprint: doc.sourceFingerprint,
    generatedAt: doc.generatedAt,
    generatedByUserRef: doc.generatedByUserRef,
    lastRefreshedAt: doc.lastRefreshedAt,
    lastRefreshedByUserRef: doc.lastRefreshedByUserRef,
    submittedAt: doc.submittedAt,
    submittedByUserRef: doc.submittedByUserRef,
    finalizedAt: doc.finalizedAt,
    finalizedByUserRef: doc.finalizedByUserRef,
    supersededAt: doc.supersededAt,
    supersededByVersion: doc.supersededByVersion,
    statusReason: doc.statusReason,
  };
}

export function toPartnerReviewVersionDto(doc: PartnerReviewVersionDoc): PartnerReviewVersionDto {
  return { ...toPartnerReviewVersionSummaryDto(doc), snapshot: doc.snapshot, sourceRefs: doc.sourceRefs };
}
