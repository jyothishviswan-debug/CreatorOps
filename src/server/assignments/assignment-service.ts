import { z } from "zod";

import { getUserDocByRef } from "@/server/authz/firestore";
import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { getCampaignDocByRef } from "@/server/campaigns/firestore";
import { requireCampaignInScope } from "@/server/campaigns/campaigns-gate";
import type { CampaignDoc } from "@/server/campaigns/types";
import { getPartnerAccountDocByRef, getPartnerDocByRef } from "@/server/partners/firestore";
import { getAdminFirestore } from "@/server/firebase/admin";
import { normalizePlatformIdentifier } from "@/server/shared/platform";
import { toAssignmentDto, toAssignmentDtos, type AssignmentDto } from "./client-dto";
import { writeAssignmentEvent, listAssignmentEvents, type AssignmentEventListCursor } from "./assignment-events";
import { requireAssignmentInScope, requireAssignmentsAccess, requireAssignmentsFeatureAccess } from "./assignments-gate";
import {
  assignmentActiveClaimDocId,
  assignmentActiveClaimsCollection,
  assignmentsCollection,
  getAssignmentDocByRef,
  listAssignmentDocs,
  runAssignmentMutation,
  type AssignmentListCursor,
} from "./firestore";
import { generateAssignmentRef } from "./ids";
import {
  assignmentActiveClaimDocSchema,
  assignmentBriefSchema,
  assignmentDocSchema,
  assignmentPlatformsArraySchema,
  assignmentsInvalidInputResult,
  assignmentsUnauthorizedResult,
  type AssignmentActiveClaimDoc,
  type AssignmentDoc,
  type AssignmentEvent,
  type AssignmentsServiceResult,
} from "./types";

// Campaign lifecycle states that permit creating/issuing an Assignment
// under it - judgment call #1 (see the Step 10A plan). PLANNED = the
// Campaign has passed its own readiness gate; ACTIVE = currently running.
// DRAFT is pre-readiness (fields not guaranteed valid yet); PAUSED is a
// deliberate temporary halt during which new obligations shouldn't start;
// COMPLETED/CANCELLED/ARCHIVED are terminal.
const CAMPAIGN_STATES_ALLOWING_ASSIGNMENT_CREATION: ReadonlySet<CampaignDoc["status"]> = new Set(["PLANNED", "ACTIVE"]);

// Assignment has no separately-settable owner of its own - ownerUid/
// regionIds/teamIds are always a point-in-time snapshot of the owning
// Campaign at creation (judgment call #4), never independently assigned
// the way Campaign/Vendor/Partner's own owner/team fields are - so there
// is deliberately no findActiveUserByRef/setAssignmentOwnerTeam here.

export async function loadAuthorizedAssignment(
  actor: ActorContext | null,
  assignmentRef: unknown,
  action: Parameters<typeof requireAssignmentsAccess>[1],
): Promise<{ ok: true; assignment: AssignmentDoc } | { ok: false; error: AssignmentsServiceResult<never> }> {
  const gate = await requireAssignmentsAccess(actor, action);
  if (!gate.ok) return { ok: false, error: assignmentsUnauthorizedResult(gate.reason) };

  if (typeof assignmentRef !== "string" || assignmentRef.length === 0) return { ok: false, error: assignmentsInvalidInputResult("Missing assignmentRef.") };
  const assignment = await getAssignmentDocByRef(assignmentRef);
  if (!assignment) return { ok: false, error: { ok: false, code: "not_found", message: "Assignment not found." } };

  const scopeCheck = await requireAssignmentInScope(actor!, assignment);
  if (!scopeCheck.ok) return { ok: false, error: assignmentsUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, assignment };
}

// ---- Create ----

// Only the caller-editable brief fields - campaignName/campaignObjective/
// reviewPolicy are always server-derived from the Campaign, never
// client-supplied (Step 10A section 4's "client must not submit
// authoritative scope metadata" applies equally to brief provenance).
const createAssignmentBriefInputSchema = z
  .object({
    instructions: z.string().min(1).max(2000).optional(),
    contentRequirementSummary: z.string().min(1).max(1000).optional(),
    requiredCount: z.number().int().min(1).max(1000).optional(),
    formats: z.array(z.string().min(1).max(60)).max(20).optional(),
    platforms: assignmentPlatformsArraySchema.optional(),
    language: z.string().min(1).max(60).optional(),
    hashtags: z.array(z.string().min(1).max(60)).max(30).optional(),
    dueAt: z.string().min(1).optional(),
    resourceLinks: z.array(z.object({ label: z.string().min(1).max(200), url: z.string().min(1).max(1000) }).strict()).max(20).optional(),
  })
  .strict();

const createAssignmentInputSchema = z
  .object({
    campaignRef: z.string().min(1),
    partnerRef: z.string().min(1),
    partnerAccountRefs: z.array(z.string().min(1)).max(10).optional(),
    brief: createAssignmentBriefInputSchema.optional(),
  })
  .strict();
export type CreateAssignmentInput = z.input<typeof createAssignmentInputSchema>;

type CreateAssignmentTxResult = { kind: "created"; doc: AssignmentDoc } | { kind: "idempotent"; doc: AssignmentDoc } | { kind: "conflict" };

// Step 10A section 4's trusted cross-record validation, then section 2's
// concurrency-safe uniqueness claim. Campaign is the OWNING context here
// (its own scope is checked for real, via requireCampaignInScope -
// exactly the same "owning record's scope is checked, linked record is
// only existence/eligibility-checked" idiom
// createVendorPartnerLink uses for its Vendor/Partner pair), Partner is
// only validated for real existence + eligibility (never a separate
// Partner-scope check - Step 10A section 6's "Vendor/Partner visibility
// alone must never broaden Assignment access" holds by construction,
// since nothing here ever calls requirePartnerInScope).
export async function createAssignment(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<AssignmentsServiceResult<AssignmentDto>> {
  const gate = await requireAssignmentsAccess(actor, "create");
  if (!gate.ok) return assignmentsUnauthorizedResult(gate.reason);

  const parsed = createAssignmentInputSchema.safeParse(rawInput);
  if (!parsed.success) return assignmentsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const campaign = await getCampaignDocByRef(input.campaignRef);
  if (!campaign) return assignmentsInvalidInputResult("campaignRef does not resolve to a real Campaign.");

  const campaignScopeCheck = await requireCampaignInScope(actor!, campaign);
  if (!campaignScopeCheck.ok) return assignmentsUnauthorizedResult("scope_denied");

  if (!CAMPAIGN_STATES_ALLOWING_ASSIGNMENT_CREATION.has(campaign.status)) {
    return assignmentsInvalidInputResult(`Cannot create an Assignment while the Campaign is ${campaign.status}.`);
  }

  const partner = await getPartnerDocByRef(input.partnerRef);
  if (!partner) return assignmentsInvalidInputResult("partnerRef does not resolve to a real Partner.");
  if (partner.status !== "ACTIVE") return assignmentsInvalidInputResult(`This Partner is ${partner.status.toLowerCase()} and is not eligible for a new Assignment.`);

  const partnerAccountRefs = input.partnerAccountRefs ?? [];
  for (const ref of partnerAccountRefs) {
    const account = await getPartnerAccountDocByRef(ref);
    if (!account) return assignmentsInvalidInputResult(`partnerAccountRefs contains "${ref}", which does not resolve to a real Partner Account.`);
    if (account.partnerRef !== partner.partnerRef) return assignmentsInvalidInputResult(`Partner Account "${ref}" does not belong to this Partner.`);
  }

  const requestedPlatforms = input.brief?.platforms ?? [];
  const campaignPlatforms = new Set(campaign.platforms);
  const incompatible = requestedPlatforms.filter((p) => !campaignPlatforms.has(p));
  if (incompatible.length > 0) {
    return assignmentsInvalidInputResult(`Platform(s) ${incompatible.join(", ")} are not part of this Campaign's own platforms.`);
  }

  const now = new Date().toISOString();
  const uid = assignmentsCollection().doc().id;

  const doc: AssignmentDoc = assignmentDocSchema.parse({
    uid,
    assignmentRef: generateAssignmentRef(),
    version: 1,
    campaignRef: campaign.campaignRef,
    partnerRef: partner.partnerRef,
    partnerAccountRefs,
    status: "DRAFT",
    statusReason: null,
    brief: assignmentBriefSchema.parse({
      instructions: input.brief?.instructions ?? null,
      contentRequirementSummary: input.brief?.contentRequirementSummary ?? null,
      requiredCount: input.brief?.requiredCount ?? null,
      formats: input.brief?.formats ?? [],
      platforms: requestedPlatforms,
      language: input.brief?.language ?? null,
      hashtags: input.brief?.hashtags ?? [],
      dueAt: input.brief?.dueAt ?? null,
      resourceLinks: input.brief?.resourceLinks ?? [],
      // Frozen Campaign-derived context - a point-in-time copy, never
      // re-synced by a later Campaign edit (Step 10A section 3).
      reviewPolicy: campaign.defaultReviewPolicy,
      campaignName: campaign.name,
      campaignObjective: campaign.objective,
    }),
    // Server-derived scope snapshot - never accepted from the client
    // (Step 10A section 4/6's own rule; judgment call #4's Campaign-only
    // snapshot source).
    ownerUid: campaign.ownerUid,
    regionIds: campaign.regionIds,
    teamIds: campaign.teamIds,
    createdAt: now,
    createdByUserRef: actor!.userRef,
    updatedAt: now,
    updatedByUserRef: actor!.userRef,
  });

  // Step 10A section 2's hard invariant: at most one canonical Assignment
  // per (campaignRef, partnerRef). Existence-as-lock claim doc, same
  // race-safe "all reads before the only writes" transaction discipline
  // as Vendors' own createVendorPartnerLink. Unlike that one, a repeat
  // create for an already-claimed pair is ALWAYS treated as idempotent
  // success (never a conflict) - there is no "different recipient"
  // distinguishing factor the way Vendor's link has (vendorRef); by
  // construction there is only ever one canonical Assignment for a given
  // pair, so returning the existing one is always the correct response to
  // a repeat/retried create call.
  const db = getAdminFirestore();
  const claimRef = assignmentActiveClaimsCollection().doc(assignmentActiveClaimDocId(campaign.campaignRef, partner.partnerRef));
  const newAssignmentRef = assignmentsCollection().doc(uid);

  const txResult = await db.runTransaction<CreateAssignmentTxResult>(async (tx) => {
    const claimSnap = await tx.get(claimRef);
    if (claimSnap.exists) {
      const claim = assignmentActiveClaimDocSchema.safeParse(claimSnap.data());
      if (!claim.success) return { kind: "conflict" };
      const existingSnap = await tx.get(assignmentsCollection().doc(claim.data.assignmentUid));
      const existing = existingSnap.exists ? assignmentDocSchema.safeParse(existingSnap.data()) : null;
      if (!existing?.success) return { kind: "conflict" };
      return { kind: "idempotent", doc: existing.data };
    }

    tx.set(newAssignmentRef, doc);
    tx.set(
      claimRef,
      assignmentActiveClaimDocSchema.parse({
        campaignRef: campaign.campaignRef,
        partnerRef: partner.partnerRef,
        assignmentRef: doc.assignmentRef,
        assignmentUid: doc.uid,
        claimedAt: now,
      } satisfies AssignmentActiveClaimDoc),
    );
    return { kind: "created", doc };
  });

  if (txResult.kind === "conflict") {
    return { ok: false, code: "conflict", message: "This Campaign+Partner pair already has an Assignment, and it could not be resolved. Reload and try again." };
  }

  if (txResult.kind === "created") {
    await writeAssignmentEvent({ assignmentUid: uid, kind: "created", actorUserRef: actor!.userRef, metadata: { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef }, requestId });
  }

  return { ok: true, data: await toAssignmentDto(txResult.doc) };
}

// ---- Read ----

export async function getAssignment(actor: ActorContext | null, assignmentRef: unknown): Promise<AssignmentsServiceResult<AssignmentDto>> {
  const gate = await requireAssignmentsFeatureAccess(actor);
  if (!gate.ok) return assignmentsUnauthorizedResult(gate.reason);

  if (typeof assignmentRef !== "string" || assignmentRef.length === 0) return assignmentsInvalidInputResult("Missing assignmentRef.");
  const assignment = await getAssignmentDocByRef(assignmentRef);
  if (!assignment) return { ok: false, code: "not_found", message: "Assignment not found." };

  const scopeCheck = await requireAssignmentInScope(actor!, assignment);
  if (!scopeCheck.ok) return assignmentsUnauthorizedResult(scopeCheck.reason);

  return { ok: true, data: await toAssignmentDto(assignment) };
}

export type ListAssignmentsInput = {
  limit?: number;
  cursor?: AssignmentListCursor;
  status?: string;
  campaignRef?: string;
  partnerRef?: string;
  platform?: string;
  assignedToMe?: boolean;
};

export async function listAssignments(actor: ActorContext | null, input: ListAssignmentsInput): Promise<AssignmentsServiceResult<{ assignments: AssignmentDto[]; nextCursor: AssignmentListCursor | null }>> {
  const gate = await requireAssignmentsFeatureAccess(actor);
  if (!gate.ok) return assignmentsUnauthorizedResult(gate.reason);

  const grants = await getActorScopeGrants(actor!);
  const page = await listAssignmentDocs({
    limit: input.limit ?? 20,
    cursor: input.cursor,
    actorUid: actor!.uid,
    grants,
    hasGlobal: hasGlobalScope(grants),
    status: input.status,
    campaignRef: input.campaignRef,
    partnerRef: input.partnerRef,
    // Stored platform values are always normalized (see
    // @/server/shared/platform) - an un-normalized filter value would
    // silently never match.
    platform: input.platform ? normalizePlatformIdentifier(input.platform) : undefined,
    ownerUid: input.assignedToMe ? actor!.uid : undefined,
  });

  return { ok: true, data: { assignments: await toAssignmentDtos(page.assignments), nextCursor: page.nextCursor } };
}

// ---- Edit draft brief ----

const editAssignmentBriefInputSchema = z
  .object({
    instructions: z.string().min(1).max(2000).nullable().optional(),
    contentRequirementSummary: z.string().min(1).max(1000).nullable().optional(),
    requiredCount: z.number().int().min(1).max(1000).nullable().optional(),
    formats: z.array(z.string().min(1).max(60)).max(20).optional(),
    platforms: assignmentPlatformsArraySchema.optional(),
    language: z.string().min(1).max(60).nullable().optional(),
    hashtags: z.array(z.string().min(1).max(60)).max(30).optional(),
    dueAt: z.string().min(1).nullable().optional(),
    resourceLinks: z.array(z.object({ label: z.string().min(1).max(200), url: z.string().min(1).max(1000) }).strict()).max(20).optional(),
    partnerAccountRefs: z.array(z.string().min(1)).max(10).optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type EditAssignmentBriefInput = z.input<typeof editAssignmentBriefInputSchema>;

// Brief edits are only permitted while DRAFT - once issued (ASSIGNED+),
// the brief is frozen (Step 10A section 3/5's own rule: "ordinary
// material commercial... fields are locked from generic in-place editing"
// applied to Assignment's own brief the same way Campaign locks its own
// active-state fields). campaignName/campaignObjective/reviewPolicy are
// never touched here - they stay exactly as captured at creation.
export async function editAssignmentBrief(actor: ActorContext | null, assignmentRef: unknown, rawInput: unknown, requestId: string): Promise<AssignmentsServiceResult<AssignmentDto>> {
  const loaded = await loadAuthorizedAssignment(actor, assignmentRef, "edit");
  if (!loaded.ok) return loaded.error;

  if (loaded.assignment.status !== "DRAFT") {
    return assignmentsInvalidInputResult("This Assignment's brief can only be edited while it is DRAFT.");
  }

  const parsed = editAssignmentBriefInputSchema.safeParse(rawInput);
  if (!parsed.success) return assignmentsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (input.platforms) {
    const campaign = await getCampaignDocByRef(loaded.assignment.campaignRef);
    if (!campaign) return { ok: false, code: "not_found", message: "Owning Campaign not found." };
    const campaignPlatforms = new Set(campaign.platforms);
    const incompatible = input.platforms.filter((p) => !campaignPlatforms.has(p));
    if (incompatible.length > 0) return assignmentsInvalidInputResult(`Platform(s) ${incompatible.join(", ")} are not part of this Campaign's own platforms.`);
  }

  if (input.partnerAccountRefs) {
    for (const ref of input.partnerAccountRefs) {
      const account = await getPartnerAccountDocByRef(ref);
      if (!account) return assignmentsInvalidInputResult(`partnerAccountRefs contains "${ref}", which does not resolve to a real Partner Account.`);
      if (account.partnerRef !== loaded.assignment.partnerRef) return assignmentsInvalidInputResult(`Partner Account "${ref}" does not belong to this Assignment's Partner.`);
    }
  }

  const result = await runAssignmentMutation(loaded.assignment.uid, input.expectedVersion, (current) => ({
    ...current,
    partnerAccountRefs: input.partnerAccountRefs ?? current.partnerAccountRefs,
    brief: {
      ...current.brief,
      instructions: input.instructions !== undefined ? input.instructions : current.brief.instructions,
      contentRequirementSummary: input.contentRequirementSummary !== undefined ? input.contentRequirementSummary : current.brief.contentRequirementSummary,
      requiredCount: input.requiredCount !== undefined ? input.requiredCount : current.brief.requiredCount,
      formats: input.formats ?? current.brief.formats,
      platforms: input.platforms ?? current.brief.platforms,
      language: input.language !== undefined ? input.language : current.brief.language,
      hashtags: input.hashtags ?? current.brief.hashtags,
      dueAt: input.dueAt !== undefined ? input.dueAt : current.brief.dueAt,
      resourceLinks: input.resourceLinks ?? current.brief.resourceLinks,
    },
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Assignment not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Assignment was changed elsewhere. Reload and try again." };

  await writeAssignmentEvent({
    assignmentUid: loaded.assignment.uid,
    kind: "edited",
    actorUserRef: actor!.userRef,
    metadata: { fields: Object.keys(input).filter((k) => k !== "expectedVersion") },
    requestId,
  });
  return { ok: true, data: await toAssignmentDto(result.doc) };
}

// ---- History ----

const listAssignmentHistoryInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.object({ createdAt: z.string().min(1), id: z.string().min(1) }).optional(),
});
export type ListAssignmentHistoryInput = z.input<typeof listAssignmentHistoryInputSchema>;
export type AssignmentHistoryEventDto = AssignmentEvent & { id: string; actorDisplayName: string | null };

export async function getAssignmentHistory(
  actor: ActorContext | null,
  assignmentRef: unknown,
  rawInput: unknown,
): Promise<AssignmentsServiceResult<{ events: AssignmentHistoryEventDto[]; nextCursor: AssignmentEventListCursor | null }>> {
  const gate = await requireAssignmentsFeatureAccess(actor);
  if (!gate.ok) return assignmentsUnauthorizedResult(gate.reason);

  if (typeof assignmentRef !== "string" || assignmentRef.length === 0) return assignmentsInvalidInputResult("Missing assignmentRef.");
  const assignment = await getAssignmentDocByRef(assignmentRef);
  if (!assignment) return { ok: false, code: "not_found", message: "Assignment not found." };

  const scopeCheck = await requireAssignmentInScope(actor!, assignment);
  if (!scopeCheck.ok) return assignmentsUnauthorizedResult(scopeCheck.reason);

  const parsed = listAssignmentHistoryInputSchema.safeParse(rawInput);
  if (!parsed.success) return assignmentsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const page = await listAssignmentEvents(assignment.uid, { limit: parsed.data.limit ?? 20, cursor: parsed.data.cursor });

  const uniqueActorRefs = [...new Set(page.events.map((e) => e.actorUserRef))];
  const actorEntries = await Promise.all(uniqueActorRefs.map(async (ref) => [ref, (await getUserDocByRef(ref))?.displayName ?? null] as const));
  const actorNames = new Map(actorEntries);

  return { ok: true, data: { events: page.events.map((e) => ({ ...e, actorDisplayName: actorNames.get(e.actorUserRef) ?? null })), nextCursor: page.nextCursor } };
}
