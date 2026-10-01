import { z } from "zod";

import { getUserDocByRef } from "@/server/authz/firestore";
import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import type { CampaignDoc } from "@/server/campaigns/types";
import { getCampaignDocByRef } from "@/server/campaigns/firestore";
import { requireCampaignInScope } from "@/server/campaigns/campaigns-gate";
import type { PartnerDoc } from "@/server/partners/types";
import { getPartnerAccountDocByRef, getPartnerDocByRef } from "@/server/partners/firestore";
import { requirePartnerInScope } from "@/server/partners/partners-gate";
import { getVendorDocByRef, listVendorPartnerLinkDocsForPartner } from "@/server/vendors/firestore";
import { getAdminFirestore } from "@/server/firebase/admin";
import { notifyAssignmentCreated } from "@/server/notifications";
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
  assignmentsNotFoundResult,
  assignmentsUnauthorizedResult,
  MAX_ASSIGNMENT_REQUIRED_COUNT,
  type AssignmentActiveClaimDoc,
  type AssignmentDoc,
  type AssignmentEvent,
  type AssignmentsErrorResult,
  type AssignmentsServiceResult,
  type AssignmentStatus,
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
  if (!assignment) return { ok: false, error: assignmentsNotFoundResult() };

  // Production hardening (base spec section 4): a scoped-out ref collapses into the SAME neutral
  // not-found outcome as a missing one - see assignmentsNotFoundResult's own comment. Never a 403
  // here; that would let a caller distinguish "exists but I can't see it" from "doesn't exist".
  const scopeCheck = await requireAssignmentInScope(actor!, assignment);
  if (!scopeCheck.ok) return { ok: false, error: assignmentsNotFoundResult() };

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
    requiredCount: z.number().int().min(1).max(MAX_ASSIGNMENT_REQUIRED_COUNT).optional(),
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

// Finding #49: `brief.language`, like `brief.platforms`, is ONE shared value applied to every
// Assignment created in a request (never per-Partner - see the "Instructions (shared across every
// selected Partner)" label right next to it in CreateAssignmentDialog.tsx) - so it is validated,
// once per request, against the UNION of the requested Partners' own recorded canonical
// `languageIds` (the same real, per-Partner-known set assignment-options-service.ts's
// toSafePartnerOption now projects to the picker - there is no separate global language taxonomy
// anywhere in this domain, unlike Region/TargetAudience). A historical stored Assignment's own
// free-text `language` is never touched by this - it only gates NEW writes. When none of the
// requested Partners have ANY recorded language yet (a real, common state for this brand-new
// field), there is nothing to validate against - the value passes through unrestricted rather than
// making language unusable for every Partner who hasn't backfilled it, a disclosed judgment call
// since no closed set exists to reject against in that case.
function validateBriefLanguageForPartners(language: string | null | undefined, partners: readonly { languageIds: readonly string[] }[]): AssignmentsErrorResult | null {
  const trimmed = language?.trim();
  if (!trimmed) return null;
  const known = new Set(partners.flatMap((p) => p.languageIds));
  if (known.size === 0) return null;
  if (!known.has(trimmed)) return assignmentsInvalidInputResult(`Language "${trimmed}" is not a recorded language for any selected Partner.`);
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
// Findings #40/#42/#51 (user-decided): the ONE definition of "claim-or-reuse the canonical Assignment
// for a (campaignRef, partnerRef) pair" - the exact transaction/claim logic that already lived inline in
// createAssignmentInternal, extracted so the new bulk path (createAssignmentsForPartners) and the
// existing single-create path can never drift apart on this delicate concurrency-safe mechanism (the
// same kind of duplication this whole program keeps finding and closing). `initialStatus` is the only
// behavioral difference between the two callers - DRAFT for the legacy single-create path (unchanged),
// IN_PROGRESS for a new Assignment created through the new bulk path (findings #42/#51: it skips
// DRAFT/ASSIGNED/ACCEPTED entirely). `routedThroughVendorRef` is pure provenance, never validated here
// (the caller already validated it, if applicable) and never affects claim/uniqueness semantics.
type PairBriefInput = {
  instructions?: string;
  contentRequirementSummary?: string;
  requiredCount?: number;
  formats?: string[];
  language?: string;
  hashtags?: string[];
  dueAt?: string;
  resourceLinks?: Array<{ label: string; url: string; shareExternally?: boolean }>;
};

async function createOrReuseAssignmentForPair(args: {
  actor: ActorContext;
  requestId: string;
  campaign: CampaignDoc;
  partner: PartnerDoc;
  partnerAccountRefs: readonly string[];
  requestedPlatforms: readonly string[];
  briefInput: PairBriefInput | undefined;
  routedThroughVendorRef: string | null;
  initialStatus: AssignmentStatus;
}): Promise<CreateAssignmentTxResult> {
  const { actor, requestId, campaign, partner, partnerAccountRefs, requestedPlatforms, briefInput, routedThroughVendorRef, initialStatus } = args;

  const now = new Date().toISOString();
  const uid = assignmentsCollection().doc().id;

  const doc: AssignmentDoc = assignmentDocSchema.parse({
    uid,
    assignmentRef: generateAssignmentRef(),
    version: 1,
    campaignRef: campaign.campaignRef,
    partnerRef: partner.partnerRef,
    partnerAccountRefs,
    routedThroughVendorRef,
    status: initialStatus,
    statusReason: null,
    brief: assignmentBriefSchema.parse({
      instructions: briefInput?.instructions ?? null,
      contentRequirementSummary: briefInput?.contentRequirementSummary ?? null,
      requiredCount: briefInput?.requiredCount ?? null,
      formats: briefInput?.formats ?? [],
      platforms: requestedPlatforms,
      language: briefInput?.language ?? null,
      hashtags: briefInput?.hashtags ?? [],
      dueAt: briefInput?.dueAt ?? null,
      resourceLinks: briefInput?.resourceLinks ?? [],
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
    createdByUserRef: actor.userRef,
    updatedAt: now,
    updatedByUserRef: actor.userRef,
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

  if (txResult.kind === "created") {
    await writeAssignmentEvent({ assignmentUid: uid, kind: "created", actorUserRef: actor.userRef, metadata: { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef }, requestId });

    // Notifications Completion (spec section 4/22): recipient is the new Assignment's own ownerUid
    // (inherited from its Campaign - see this function's own `ownerUid: campaign.ownerUid` above) -
    // projection only, after the transaction above has already committed.
    await notifyAssignmentCreated({ assignmentRef: doc.assignmentRef, ownerUid: doc.ownerUid, actorUserRef: actor.userRef, requestId }).catch(() => undefined);
  }

  return txResult;
}

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

  const languageError = validateBriefLanguageForPartners(input.brief?.language, [partner]);
  if (languageError) return languageError;

  const txResult = await createOrReuseAssignmentForPair({
    actor: actor!,
    requestId,
    campaign,
    partner,
    partnerAccountRefs,
    requestedPlatforms,
    briefInput: input.brief,
    routedThroughVendorRef: null,
    initialStatus: "DRAFT",
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

// ---- Bulk create (findings #40/#42/#51, user-decided) ----

// A Partner with more Campaign+Partner pairs requested in one call than this is an anomaly, not a normal
// bulk action - fail loud with a clear validation error rather than accepting an unbounded array.
export const MAX_BULK_ASSIGNMENT_PARTNERS = 50;
// A Vendor with more distinct Vendor sections selected in one call than this is likewise an anomaly.
export const MAX_BULK_ASSIGNMENT_VENDORS = 20;

// Finding #40 correction (user-directed): Direct and Through-Vendor selection are ADDITIVE, never
// mutually exclusive - one request may name any mix of directly-selected Partners AND one or more
// Vendors, each with its own selected mapped Partners. `vendorSelections` mirrors the UI's own natural
// shape (one section per chosen Vendor) rather than a single batch-wide routedThroughVendorRef.
const vendorSelectionInputSchema = z.object({
  vendorRef: z.string().min(1),
  partnerRefs: z.array(z.string().min(1)).min(1).max(MAX_BULK_ASSIGNMENT_PARTNERS),
});

const createAssignmentsForPartnersInputSchema = z
  .object({
    campaignRef: z.string().min(1),
    directPartnerRefs: z.array(z.string().min(1)).max(MAX_BULK_ASSIGNMENT_PARTNERS).default([]),
    vendorSelections: z.array(vendorSelectionInputSchema).max(MAX_BULK_ASSIGNMENT_VENDORS).default([]),
    brief: createAssignmentBriefInputSchema.optional(),
  })
  .strict()
  .refine((value) => value.directPartnerRefs.length > 0 || value.vendorSelections.some((v) => v.partnerRefs.length > 0), {
    message: "At least one Partner must be selected, directly or through a Vendor.",
  });
export type CreateAssignmentsForPartnersInput = z.input<typeof createAssignmentsForPartnersInputSchema>;

export type BulkAssignmentPartnerResult = { partnerRef: string; outcome: "created" | "existing" | "error"; assignmentRef: string | null; error: string | null };
export type CreateAssignmentsForPartnersResult = { results: BulkAssignmentPartnerResult[] };

// Findings #40/#42/#51 (user-decided, #40 corrected): one logical bulk request covering BOTH Direct and
// Through-Vendor selection in the same call - additive, never mutually exclusive. Dedupes Partner refs
// server-side (across Direct + every Vendor section together), authorizes the whole batch ONCE (Campaign
// scope/status/brief-platform validation happen exactly once, never per-Partner), then calls the SAME
// claim-or-reuse core (createOrReuseAssignmentForPair) as the legacy single-create path for each Partner,
// so a Campaign+Partner pair that already has an Assignment is idempotent/safe-to-replay exactly the way
// the single path always has been - this function invents no separate idempotency-key mechanism because
// the underlying per-pair claim already provides one. A Partner named both directly and through exactly
// one Vendor in the same request is not an error - the Vendor route wins (preserved as provenance). A
// Partner named through two DIFFERENT Vendors in the same request is rejected for the whole request (not
// guessed, not silently resolved) before any Firestore write happens. Every new Assignment created this
// way starts IN_PROGRESS (finding #42/#51 - never DRAFT/ASSIGNED/ACCEPTED); the legacy
// createAssignment/createAssignmentWithOutcome above are UNCHANGED (still DRAFT, still single-Partner)
// for any other existing caller. A per-Partner failure (not found, out of scope, inactive, an invalid
// Vendor-routing claim, or a genuine claim-resolution conflict) is reported as that one Partner's own
// "error" result - it never aborts or rolls back the rest of the batch.
export async function createAssignmentsForPartners(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<AssignmentsServiceResult<CreateAssignmentsForPartnersResult>> {
  const gate = await requireAssignmentsAccess(actor, "create");
  if (!gate.ok) return assignmentsUnauthorizedResult(gate.reason);

  const parsed = createAssignmentsForPartnersInputSchema.safeParse(rawInput);
  if (!parsed.success) return assignmentsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const campaign = await getCampaignDocByRef(input.campaignRef);
  if (!campaign) return assignmentsInvalidInputResult("campaignRef does not resolve to a real Campaign.");

  const campaignScopeCheck = await requireCampaignInScope(actor!, campaign);
  if (!campaignScopeCheck.ok) return assignmentsUnauthorizedResult("scope_denied");

  if (!isCampaignStatusAllowingAssignmentCreation(campaign.status)) {
    return assignmentsInvalidInputResult(`Cannot create an Assignment while the Campaign is ${campaign.status}.`);
  }

  const requestedPlatforms = input.brief?.platforms ?? [];
  const platformsError = validateBriefPlatformsForCampaign(requestedPlatforms, campaign.platforms);
  if (platformsError) return platformsError;

  // Merge Direct + every Vendor section into one map of partnerRef -> the set of distinct non-null
  // Vendor refs it was requested under. A Partner named both directly AND through exactly one Vendor is
  // NOT ambiguous - the explicit Vendor route wins (finding #40 correction: "create/reuse one Assignment
  // and preserve the explicit Vendor route"). A Partner named through two DIFFERENT Vendors in the SAME
  // request IS ambiguous and must be rejected outright rather than silently picking one - this can only
  // happen from a malformed/inconsistent client request (a real Partner can hold at most one ACTIVE
  // Vendor link at a time, enforced by `vendorPartnerActiveClaims`, so the UI's own per-Vendor Partner
  // lists can never legitimately overlap this way).
  const vendorRefsByPartner = new Map<string, Set<string>>();
  for (const partnerRef of input.directPartnerRefs) {
    if (!vendorRefsByPartner.has(partnerRef)) vendorRefsByPartner.set(partnerRef, new Set());
  }
  for (const selection of input.vendorSelections) {
    for (const partnerRef of selection.partnerRefs) {
      const set = vendorRefsByPartner.get(partnerRef) ?? new Set<string>();
      set.add(selection.vendorRef);
      vendorRefsByPartner.set(partnerRef, set);
    }
  }

  const ambiguousPartnerRefs = [...vendorRefsByPartner.entries()].filter(([, vendorRefs]) => vendorRefs.size > 1).map(([partnerRef]) => partnerRef);
  if (ambiguousPartnerRefs.length > 0) {
    return assignmentsInvalidInputResult(`Partner(s) selected through more than one Vendor in the same request, which cannot be resolved automatically: ${ambiguousPartnerRefs.sort().join(", ")}.`);
  }

  if (vendorRefsByPartner.size > MAX_BULK_ASSIGNMENT_PARTNERS) {
    return assignmentsInvalidInputResult(`No more than ${MAX_BULK_ASSIGNMENT_PARTNERS} distinct Partners may be selected in one request.`);
  }

  // Every distinct Vendor referenced anywhere in the request must be a real Vendor - resolved once, not
  // per-Partner. Whether a Vendor ACTUALLY has an ACTIVE relationship with each specific Partner it was
  // selected for is checked per-Partner below.
  const distinctVendorRefs = [...new Set(input.vendorSelections.map((s) => s.vendorRef))];
  for (const vendorRef of distinctVendorRefs) {
    const vendor = await getVendorDocByRef(vendorRef);
    if (!vendor) return assignmentsInvalidInputResult(`vendorRef "${vendorRef}" does not resolve to a real Vendor.`);
  }

  // Sort for a deterministic response order, regardless of what order the client happened to send.
  const partnerRefs = [...vendorRefsByPartner.keys()].sort();

  // Fetched once, up front, so both the whole-request language validation (finding #49 - the same
  // shared-value-across-the-batch discipline as requestedPlatforms above) and the per-Partner loop
  // below reuse the identical reads instead of fetching each Partner doc twice.
  const partnerDocsByRef = new Map<string, Awaited<ReturnType<typeof getPartnerDocByRef>>>();
  for (const partnerRef of partnerRefs) {
    partnerDocsByRef.set(partnerRef, await getPartnerDocByRef(partnerRef));
  }

  const languageError = validateBriefLanguageForPartners(
    input.brief?.language,
    [...partnerDocsByRef.values()].filter((p): p is NonNullable<typeof p> => p !== null),
  );
  if (languageError) return languageError;

  const results: BulkAssignmentPartnerResult[] = [];
  for (const partnerRef of partnerRefs) {
    const partner = partnerDocsByRef.get(partnerRef) ?? null;
    if (!partner) {
      results.push({ partnerRef, outcome: "error", assignmentRef: null, error: "Does not resolve to a real Partner." });
      continue;
    }

    const partnerScopeCheck = await requirePartnerInScope(actor!, partner);
    if (!partnerScopeCheck.ok) {
      results.push({ partnerRef, outcome: "error", assignmentRef: null, error: "This Partner is outside your Record Scope." });
      continue;
    }

    if (partner.status !== "ACTIVE") {
      results.push({ partnerRef, outcome: "error", assignmentRef: null, error: `This Partner is ${partner.status.toLowerCase()} and is not eligible for a new Assignment.` });
      continue;
    }

    // Exactly zero or one Vendor ref survives here per Partner - the ambiguous (2+) case was already
    // rejected for the whole request above.
    const [routedThroughVendorRef = null] = vendorRefsByPartner.get(partnerRef) ?? [];
    if (routedThroughVendorRef !== null) {
      const links = await listVendorPartnerLinkDocsForPartner(partner.partnerRef);
      const hasActiveLink = links.some((link) => link.vendorRef === routedThroughVendorRef && link.status === "ACTIVE");
      if (!hasActiveLink) {
        results.push({ partnerRef, outcome: "error", assignmentRef: null, error: "This Partner has no ACTIVE relationship with the selected Vendor." });
        continue;
      }
    }

    const txResult = await createOrReuseAssignmentForPair({
      actor: actor!,
      requestId,
      campaign,
      partner,
      partnerAccountRefs: [],
      requestedPlatforms,
      briefInput: input.brief,
      routedThroughVendorRef,
      initialStatus: "IN_PROGRESS",
    });

    if (txResult.kind === "conflict") {
      results.push({ partnerRef, outcome: "error", assignmentRef: null, error: "This Campaign+Partner pair already has an Assignment, and it could not be resolved. Reload and try again." });
      continue;
    }

    // Same scope discipline as the outcome-aware single-create path: an "existing" result never hands
    // back an Assignment the actor may not read.
    if (txResult.kind === "idempotent") {
      const existingScope = await requireAssignmentInScope(actor!, txResult.doc);
      if (!existingScope.ok) {
        results.push({ partnerRef, outcome: "existing", assignmentRef: null, error: null });
        continue;
      }
    }

    results.push({ partnerRef, outcome: txResult.kind === "created" ? "created" : "existing", assignmentRef: txResult.doc.assignmentRef, error: null });
  }

  return { ok: true, data: { results } };
}

// ---- Read ----

export async function getAssignment(actor: ActorContext | null, assignmentRef: unknown): Promise<AssignmentsServiceResult<AssignmentDto>> {
  const gate = await requireAssignmentsFeatureAccess(actor);
  if (!gate.ok) return assignmentsUnauthorizedResult(gate.reason);

  if (typeof assignmentRef !== "string" || assignmentRef.length === 0) return assignmentsInvalidInputResult("Missing assignmentRef.");
  const assignment = await getAssignmentDocByRef(assignmentRef);
  if (!assignment) return assignmentsNotFoundResult();

  // Production hardening (base spec section 4): see loadAuthorizedAssignment's own identical
  // comment - a scoped-out ref is indistinguishable from a missing one.
  const scopeCheck = await requireAssignmentInScope(actor!, assignment);
  if (!scopeCheck.ok) return assignmentsNotFoundResult();

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
    requiredCount: z.number().int().min(1).max(MAX_ASSIGNMENT_REQUIRED_COUNT).nullable().optional(),
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
  if (!assignment) return assignmentsNotFoundResult();

  // Production hardening (base spec section 4): see loadAuthorizedAssignment's own identical
  // comment - a scoped-out ref is indistinguishable from a missing one.
  const scopeCheck = await requireAssignmentInScope(actor!, assignment);
  if (!scopeCheck.ok) return assignmentsNotFoundResult();

  const parsed = listAssignmentHistoryInputSchema.safeParse(rawInput);
  if (!parsed.success) return assignmentsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const page = await listAssignmentEvents(assignment.uid, { limit: parsed.data.limit ?? 20, cursor: parsed.data.cursor });

  const uniqueActorRefs = [...new Set(page.events.map((e) => e.actorUserRef))];
  const actorEntries = await Promise.all(uniqueActorRefs.map(async (ref) => [ref, (await getUserDocByRef(ref))?.displayName ?? null] as const));
  const actorNames = new Map(actorEntries);

  return { ok: true, data: { events: page.events.map((e) => ({ ...e, actorDisplayName: actorNames.get(e.actorUserRef) ?? null })), nextCursor: page.nextCursor } };
}
