import { getUserDoc } from "@/server/authz/firestore";
import type { AssignmentBrief, AssignmentDoc, AssignmentStatus } from "./types";

// The only shape of an Assignment ever handed to the browser - no
// Firestore doc id, no raw Firebase uid anywhere (ownerUid resolved to
// the owner's own opaque userRef, same pattern as CampaignDto).
export type AssignmentDto = {
  assignmentRef: string;
  version: number;
  campaignRef: string;
  partnerRef: string;
  partnerAccountRefs: string[];
  status: AssignmentStatus;
  statusReason: string | null;
  brief: AssignmentBrief;
  regionIds: string[];
  ownerRef: string | null;
  ownerDisplayName: string | null;
  teamIds: string[];
  createdAt: string;
  createdByUserRef: string;
  updatedAt: string;
  updatedByUserRef: string;
};

async function resolveUserRefAndName(uid: string | null): Promise<{ ref: string | null; displayName: string | null }> {
  if (!uid) return { ref: null, displayName: null };
  const doc = await getUserDoc(uid);
  return { ref: doc?.userRef ?? null, displayName: doc?.displayName ?? null };
}

export async function toAssignmentDto(doc: AssignmentDoc): Promise<AssignmentDto> {
  const owner = await resolveUserRefAndName(doc.ownerUid);
  return {
    assignmentRef: doc.assignmentRef,
    version: doc.version,
    campaignRef: doc.campaignRef,
    partnerRef: doc.partnerRef,
    partnerAccountRefs: doc.partnerAccountRefs,
    status: doc.status,
    statusReason: doc.statusReason,
    brief: doc.brief,
    regionIds: doc.regionIds,
    ownerRef: owner.ref,
    ownerDisplayName: owner.displayName,
    teamIds: doc.teamIds,
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
    updatedAt: doc.updatedAt,
    updatedByUserRef: doc.updatedByUserRef,
  };
}

// Batched, N+1-safe - resolves each distinct ownerUid at most once
// regardless of list size (used by list endpoints; toAssignmentDto alone
// is fine for a single get).
export async function toAssignmentDtos(docs: AssignmentDoc[]): Promise<AssignmentDto[]> {
  const uniqueOwnerUids = [...new Set(docs.map((d) => d.ownerUid).filter((uid): uid is string => Boolean(uid)))];
  const owners = new Map(await Promise.all(uniqueOwnerUids.map(async (uid) => [uid, await resolveUserRefAndName(uid)] as const)));

  return docs.map((doc) => {
    const owner = doc.ownerUid ? (owners.get(doc.ownerUid) ?? { ref: null, displayName: null }) : { ref: null, displayName: null };
    return {
      assignmentRef: doc.assignmentRef,
      version: doc.version,
      campaignRef: doc.campaignRef,
      partnerRef: doc.partnerRef,
      partnerAccountRefs: doc.partnerAccountRefs,
      status: doc.status,
      statusReason: doc.statusReason,
      brief: doc.brief,
      regionIds: doc.regionIds,
      ownerRef: owner.ref,
      ownerDisplayName: owner.displayName,
      teamIds: doc.teamIds,
      createdAt: doc.createdAt,
      createdByUserRef: doc.createdByUserRef,
      updatedAt: doc.updatedAt,
      updatedByUserRef: doc.updatedByUserRef,
    };
  });
}
