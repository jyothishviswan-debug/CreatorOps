import { z } from "zod";

import { getUserDocByRef } from "@/server/authz/firestore";
import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { getCampaignDocByRef } from "@/server/campaigns/firestore";
import { requireCampaignInScope } from "@/server/campaigns/campaigns-gate";
import { getPartnerAccountDocByRef, getPartnerDocByRef } from "@/server/partners/firestore";
import { requirePartnerInScope } from "@/server/partners/partners-gate";
import { getAdminFirestore } from "@/server/firebase/admin";
import { normalizePlatformIdentifier } from "@/server/shared/platform";
import { isHttpUrl } from "@/server/shared/http-url";
import { evaluatePartnerAccountEligibility, isCampaignStatusAllowingAssignmentCreation, PARTNER_ACCOUNT_UNAVAILABLE_INACTIVE } from "./create-eligibility";
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
  assignmentsConflictResult,
  assignmentsInvalidInputResult,
  assignmentsUnauthorizedResult,
  type AssignmentActiveClaimDoc,
  type AssignmentDoc,
  type AssignmentEvent,
  type AssignmentsErrorResult,
  type AssignmentsServiceResult,
} from "./types";

// Campaign lifecycle states that permit creating an Assignment under it
// (PLANNED/ACTIVE only) live in ./create-eligibility - a pure module shared
// with the Campaign Detail downstream/create-options services so the rule is
// defined exactly once.

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

// Step 12C.2: the ONE resource-link input schema, shared by create and by
// editAssignmentBrief so a link that could not be created can never be
// edited in. The URL must be a real http(s) URL - enforced on the trusted
// server (a bare `z.string()` would let javascript:/data:/ftp:/scheme-less
// values through), not only in the create dialog. `shareExternally` stays
// optional here; both callers map an omitted value to the fail-closed
// `false`, never to an inherited `true`.
const resourceLinkInputSchema = z
  .object({
    label: z.string().min(1).max(200),
    url: z.string().min(1).max(1000).refine(isHttpUrl, { message: "Resource link URL must be a valid http(s) URL." }),
    shareExternally: z.boolean().optional(),
  })
  .strict();

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
    resourceLinks: z.array(resourceLinkInputSchema).max(20).optional(),
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

// "created" = this call wrote the canonical Assignment; "existing" = the
// permanent (campaignRef, partnerRef) claim already existed, so the one
// canonical Assignment was returned unchanged (nothing was written).
export type CreateAssignmentOutcome = { outcome: "created" | "existing"; assignment: AssignmentDto };

type CreateAssignmentTxResult = { kind: "created"; doc: AssignmentDoc } | { kind: "idempotent"; doc: AssignmentDoc } | { kind: "conflict" };

// Step 12C.2: the ONE definition of the Partner Account / brief-platform
// invariants, called by BOTH createAssignmentInternal and editAssignmentBrief
// so an Assignment valid at creation can never be edited into an invalid
// state (and the two paths can never drift apart). Accounts are matched by
// ref only - never by display name - and every account must (1) exist,
// (2) belong to the Assignment's canonical Partner, (3) be ACTIVE and (4)
// have a platform that, after the shared normalizer, is one of the
// Campaign's own platforms. Returns the error result, or null when valid.
async function validatePartnerAccountsForCampaign(args: {
  partnerRef: string;
  accountRefs: readonly string[];
  campaignPlatforms: readonly string[];
  // Wording only: "this Partner" (create) / "this Assignment's Partner" (edit).
  partnerPhrase: string;
}): Promise<AssignmentsErrorResult | null> {
  for (const ref of args.accountRefs) {
    const account = await getPartnerAccountDocByRef(ref);
    if (!account) return assignmentsInvalidInputResult(`partnerAccountRefs contains "${ref}", which does not resolve to a real Partner Account.`);
    if (account.partnerRef !== args.partnerRef) return assignmentsInvalidInputResult(`Partner Account "${ref}" does not belong to ${args.partnerPhrase}.`);

    const eligibility = evaluatePartnerAccountEligibility(account, args.campaignPlatforms);
    if (!eligibility.selectable) {
      return assignmentsInvalidInputResult(
        eligibility.unavailableReason === PARTNER_ACCOUNT_UNAVAILABLE_INACTIVE
          ? "A selected Partner Account is inactive and cannot be assigned."
          : `A selected Partner Account is on a platform (${eligibility.platform}) that is not part of this Campaign's own platforms.`,
      );
    }
  }
  return null;
}

// Every brief platform must be one of the Campaign's own platforms.
function validateBriefPlatformsForCampaign(requestedPlatforms: readonly string[], campaignPlatforms: readonly string[]): AssignmentsErrorResult | null {
  const allowed = new Set(campaignPlatforms);
  const incompatible = requestedPlatforms.filter((p) => !allowed.has(p));
  if (incompatible.length > 0) return assignmentsInvalidInputResult(`Platform(s) ${incompatible.join(", ")} are not part of this Campaign's own platforms.`);
  return null;
}

// Step 10A section 4's trusted cross-record validation, then section 2's
// concurrency-safe uniqueness claim. Campaign is the OWNING context (its own
// scope is checked via requireCampaignInScope). Step 12C.2: the selected
// Partner's own Record Scope is ALSO required, via the accepted
// requirePartnerInScope check (GLOBAL / self-owner / region / team /
// PARTNER grant / EXPLICIT_RECORD, reused as-is - no role-rank, no
// minimum-role, no wildcard, no inference from names/regions/Campaign
// scope/client options). The scoped Partner picker is a convenience, never
// an authorization boundary: a forged POST /api/assignments naming an
// out-of-scope Partner is denied here, before the uniqueness transaction,
// so a denial writes no Assignment, no claim doc and no event. A missing
// Partner is still the same invalid_input it always was (checked first),
// and a denial reuses the existing safe "scope_denied" convention (HTTP 403
// "Forbidden.") - it never echoes anything about the Partner. This lives in
// createAssignmentInternal so BOTH createAssignment and
// createAssignmentWithOutcome are covered. What this does NOT change:
// Partner visibility still never broadens Assignment READ access (Step 10A
// section 6) - requirePartnerInScope gates only who may create for a
// Partner, never who may read the resulting Assignment.
async function createAssignmentInternal(
  actor: ActorContext | null,
  rawInput: unknown,
  requestId: string,
  options: { enforceExistingScope: boolean },
): Promise<AssignmentsServiceResult<CreateAssignmentOutcome>> {
  const gate = await requireAssignmentsAccess(actor, "create");
  if (!gate.ok) return assignmentsUnauthorizedResult(gate.reason);

  const parsed = createAssignmentInputSchema.safeParse(rawInput);
  if (!parsed.success) return assignmentsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const campaign = await getCampaignDocByRef(input.campaignRef);
  if (!campaign) return assignmentsInvalidInputResult("campaignRef does not resolve to a real Campaign.");

  const campaignScopeCheck = await requireCampaignInScope(actor!, campaign);
  if (!campaignScopeCheck.ok) return assignmentsUnauthorizedResult("scope_denied");

  if (!isCampaignStatusAllowingAssignmentCreation(campaign.status)) {
    return assignmentsInvalidInputResult(`Cannot create an Assignment while the Campaign is ${campaign.status}.`);
  }

  const partner = await getPartnerDocByRef(input.partnerRef);
  if (!partner) return assignmentsInvalidInputResult("partnerRef does not resolve to a real Partner.");

  // Step 12C.2: Partner Record Scope, before ANY further validation or
  // write (see the header comment above).
  const partnerScopeCheck = await requirePartnerInScope(actor!, partner);
  if (!partnerScopeCheck.ok) return assignmentsUnauthorizedResult("scope_denied");

  if (partner.status !== "ACTIVE") return assignmentsInvalidInputResult(`This Partner is ${partner.status.toLowerCase()} and is not eligible for a new Assignment.`);

  const partnerAccountRefs = input.partnerAccountRefs ?? [];
  const accountsError = await validatePartnerAccountsForCampaign({ partnerRef: partner.partnerRef, accountRefs: partnerAccountRefs, campaignPlatforms: campaign.platforms, partnerPhrase: "this Partner" });
  if (accountsError) return accountsError;

  const requestedPlatforms = input.brief?.platforms ?? [];
  const platformsError = validateBriefPlatformsForCampaign(requestedPlatforms, campaign.platforms);
  if (platformsError) return platformsError;

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

  // Step 12C.1: an "existing" result must never hand back an Assignment the
  // actor may not read (Campaign scope does not imply Assignment scope - an
  // explicit CAMPAIGN grant, for one, deliberately does not bridge). The pair
  // is still reported as taken (409), but the other Assignment's identity is
  // not returned. Only the new outcome-aware entry point enforces this; the
  // legacy createAssignment wrapper keeps its original behavior exactly.
  if (txResult.kind === "idempotent" && options.enforceExistingScope) {
    const existingScope = await requireAssignmentInScope(actor!, txResult.doc);
    if (!existingScope.ok) return assignmentsConflictResult("An Assignment already exists for this Campaign and Partner.");
  }

  if (txResult.kind === "created") {
    await writeAssignmentEvent({ assignmentUid: uid, kind: "created", actorUserRef: actor!.userRef, metadata: { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef }, requestId });
  }

  return { ok: true, data: { outcome: txResult.kind === "created" ? "created" : "existing", assignment: await toAssignmentDto(txResult.doc) } };
}

// The outcome-aware create used by POST /api/assignments (Campaign Detail's
// contextual create): reports "created" vs "existing" and never returns an
// existing Assignment outside the actor's own Assignment scope.
export async function createAssignmentWithOutcome(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<AssignmentsServiceResult<CreateAssignmentOutcome>> {
  return createAssignmentInternal(actor, rawInput, requestId, { enforceExistingScope: true });
}

// Thin wrapper preserving createAssignment's original contract exactly -
// a repeat create for an already-claimed pair is still plain idempotent
// success returning the one canonical Assignment. Every pre-Step-12C.1
// caller/test keeps using this unchanged; only the Campaign Detail create
// flow (via POST /api/assignments) needs to tell "created" from "existing".
export async function createAssignment(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<AssignmentsServiceResult<AssignmentDto>> {
  const result = await createAssignmentInternal(actor, rawInput, requestId, { enforceExistingScope: false });
  if (!result.ok) return result;
  return { ok: true, data: result.data.assignment };
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
    // Step 12C.2: same http(s)-only validation as create (shared schema).
    resourceLinks: z.array(resourceLinkInputSchema).max(20).optional(),
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

  // Step 12C.2: every check below runs BEFORE runAssignmentMutation, so a
  // rejected edit changes nothing (no version bump, no updatedAt, no brief/
  // account change, no event). The Campaign is always reloaded server-side
  // from the Assignment's own immutable campaignRef - never from the payload
  // (the strict schema rejects campaignRef/partnerRef outright) - and the
  // Partner is always the Assignment's own canonical partnerRef.
  if (input.platforms || input.partnerAccountRefs) {
    const campaign = await getCampaignDocByRef(loaded.assignment.campaignRef);
    if (!campaign) return { ok: false, code: "not_found", message: "Owning Campaign not found." };

    if (input.platforms) {
      const platformsError = validateBriefPlatformsForCampaign(input.platforms, campaign.platforms);
      if (platformsError) return platformsError;
    }

    if (input.partnerAccountRefs) {
      const accountsError = await validatePartnerAccountsForCampaign({
        partnerRef: loaded.assignment.partnerRef,
        accountRefs: input.partnerAccountRefs,
        campaignPlatforms: campaign.platforms,
        partnerPhrase: "this Assignment's Partner",
      });
      if (accountsError) return accountsError;
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
      // Fail-closed default preserved even on the plain-object mutation
      // path (not re-run through assignmentBriefSchema.parse) - an
      // omitted shareExternally in the input never silently inherits
      // `true` from anywhere.
      resourceLinks: input.resourceLinks ? input.resourceLinks.map((link) => ({ ...link, shareExternally: link.shareExternally ?? false })) : current.brief.resourceLinks,
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
