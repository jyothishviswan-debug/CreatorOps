import { z } from "zod";

import { getUserDocByRef } from "@/server/authz/firestore";
import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActionId } from "@/server/authz/actions";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { toLeadDto, type LeadDto } from "./client-dto";
import { checkForDuplicates } from "./duplicate-check";
import { requireDiscoveryAccess, requireDiscoveryFeatureAccess, requireLeadInScope } from "./discovery-gate";
import { generateLeadRef } from "./ids";
import { getLeadDocByRef, leadsCollection, listLeadDocs, runLeadMutation, type LeadListCursor } from "./firestore";
import { listLeadEvents, writeLeadEvent, type LeadEventListCursor } from "./lead-events";
import { platformCodeFor, readNextProposalNumber } from "./proposal-number";
import type { LeadEvent } from "./types";
import {
  assetDecisionKindSchema,
  commercialEvidenceSchema,
  discoveryAgreementEvidenceSchema,
  discoveryInvalidInputResult,
  discoveryUnauthorizedResult,
  duplicateCheckResultSchema,
  leadDocSchema,
  leadLifecycleSchema,
  leadSourceSchema,
  outreachDirectionSchema,
  researchSchema,
  reviewDimensionsSchema,
  reviewOutcomeSchema,
  targetAudienceSchema,
  type DiscoveryErrorResult,
  type DiscoveryServiceResult,
  type LeadDoc,
} from "./types";

// Shared by every mutation below: gate on the action, resolve the
// leadRef, load the current doc, and enforce Record Scope - in that
// order, independently on every call (no caching across requests, no
// assuming a prior check still holds).
async function loadAuthorizedLead(actor: ActorContext | null, leadRef: unknown, action: ActionId): Promise<{ ok: true; lead: LeadDoc } | { ok: false; error: DiscoveryErrorResult }> {
  if (!actor) return { ok: false, error: discoveryUnauthorizedResult("not_authenticated") };
  const gate = await requireDiscoveryAccess(actor, action);
  if (!gate.ok) return { ok: false, error: discoveryUnauthorizedResult(gate.reason) };

  if (typeof leadRef !== "string" || leadRef.length === 0) return { ok: false, error: discoveryInvalidInputResult("Missing leadRef.") };
  const lead = await getLeadDocByRef(leadRef);
  if (!lead) return { ok: false, error: { ok: false, code: "not_found", message: "Lead not found." } };

  const scopeCheck = await requireLeadInScope(actor, lead);
  if (!scopeCheck.ok) return { ok: false, error: discoveryUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, lead };
}

// ---- List ----

const listLeadsInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.object({ orderValue: z.string(), uid: z.string().min(1) }).optional(),
  lifecycle: leadLifecycleSchema.optional(),
  region: z.string().min(1).max(80).optional(),
  platform: z.string().min(1).max(60).optional(),
  assignedToMe: z.boolean().optional(),
  // Lowercased server-side too - a caller that doesn't normalize case
  // still gets a correct prefix match.
  search: z.string().min(1).max(200).optional(),
  followUpDue: z.boolean().optional(),
});
export type ListLeadsInput = z.input<typeof listLeadsInputSchema>;

export async function listLeads(actor: ActorContext | null, rawInput: unknown): Promise<DiscoveryServiceResult<{ leads: LeadDto[]; nextCursor: LeadListCursor | null }>> {
  if (!actor) return discoveryUnauthorizedResult("not_authenticated");
  const gate = await requireDiscoveryFeatureAccess(actor);
  if (!gate.ok) return discoveryUnauthorizedResult(gate.reason);

  const parsed = listLeadsInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const grants = await getActorScopeGrants(actor);
  const page = await listLeadDocs({
    limit: parsed.data.limit ?? 20,
    cursor: parsed.data.cursor,
    actorUid: actor.uid,
    grants,
    hasGlobal: hasGlobalScope(grants),
    lifecycle: parsed.data.lifecycle,
    region: parsed.data.region,
    platform: parsed.data.platform,
    assignedToMe: parsed.data.assignedToMe,
    displayNamePrefix: parsed.data.search?.toLowerCase(),
    followUpDue: parsed.data.followUpDue,
  });

  const leads = await Promise.all(page.leads.map(toLeadDto));
  return { ok: true, data: { leads, nextCursor: page.nextCursor } };
}

// ---- Get one ----

export async function getLead(actor: ActorContext | null, leadRef: unknown): Promise<DiscoveryServiceResult<LeadDto>> {
  if (!actor) return discoveryUnauthorizedResult("not_authenticated");
  const gate = await requireDiscoveryFeatureAccess(actor);
  if (!gate.ok) return discoveryUnauthorizedResult(gate.reason);

  if (typeof leadRef !== "string" || leadRef.length === 0) return discoveryInvalidInputResult("Missing leadRef.");
  const lead = await getLeadDocByRef(leadRef);
  if (!lead) return { ok: false, code: "not_found", message: "Lead not found." };

  const scopeCheck = await requireLeadInScope(actor, lead);
  if (!scopeCheck.ok) return discoveryUnauthorizedResult(scopeCheck.reason);

  return { ok: true, data: await toLeadDto(lead) };
}

// ---- Create ----

const createLeadInputSchema = z.object({
  displayName: z.string().min(1).max(200),
  email: z.string().min(1).max(300).optional(),
  phone: z.string().min(1).max(40).optional(),
  profileUrl: z.string().min(1).max(500).optional(),
  platform: z.string().min(1).max(60).optional(),
  handle: z.string().min(1).max(120).optional(),
  source: leadSourceSchema,
  region: z.string().min(1).max(80).optional(),
  teamId: z.string().min(1).max(120).optional(),
  ownerUserRef: z.string().min(1).optional(),
});
export type CreateLeadInput = z.input<typeof createLeadInputSchema>;

export async function createLead(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<LeadDto>> {
  if (!actor) return discoveryUnauthorizedResult("not_authenticated");
  const gate = await requireDiscoveryAccess(actor, "create");
  if (!gate.ok) return discoveryUnauthorizedResult(gate.reason);

  const parsed = createLeadInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  let ownerUid: string | null = null;
  if (input.ownerUserRef) {
    const owner = await findActiveUserByRef(input.ownerUserRef);
    if (!owner) return discoveryInvalidInputResult("ownerUserRef does not resolve to a real, active user.");
    ownerUid = owner.uid;
  }

  const now = new Date().toISOString();
  const uid = leadsCollection().doc().id;

  const doc: LeadDoc = {
    uid,
    leadRef: generateLeadRef(),
    version: 1,
    lifecycle: "NEW",
    previousLifecycle: null,
    lifecycleReason: null,
    displayName: input.displayName,
    displayNameLower: input.displayName.toLowerCase(),
    email: input.email ?? null,
    phone: input.phone ?? null,
    profileUrl: input.profileUrl ?? null,
    platform: input.platform ?? null,
    handle: input.handle ?? null,
    source: input.source,
    region: input.region ?? null,
    teamId: input.teamId ?? null,
    ownerUid,
    research: null,
    latestReview: null,
    outreachSummary: null,
    respondedAt: null,
    commercial: null,
    discoveryAgreement: null,
    assetDecision: null,
    managerUid: null,
    kycPackageComplete: false,
    duplicateCheck: null,
    conversion: null,
    proposalNumber: null,
    proposalPlatformCode: null,
    createdAt: now,
    createdByUserRef: actor.userRef,
    updatedAt: now,
    updatedByUserRef: actor.userRef,
  };

  await leadsCollection().doc(uid).set(doc);
  await writeLeadEvent({ leadUid: uid, kind: "created", actorUserRef: actor.userRef, metadata: { displayName: doc.displayName, source: doc.source.type }, requestId });

  return { ok: true, data: await toLeadDto(doc) };
}

async function findActiveUserByRef(userRef: string): Promise<{ uid: string } | null> {
  const doc = await getUserDocByRef(userRef);
  if (!doc || !doc.active) return null;
  return { uid: doc.uid };
}

// ---- Edit ordinary fields ----

const updateLeadInputSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    email: z.string().min(1).max(300).nullable().optional(),
    phone: z.string().min(1).max(40).nullable().optional(),
    profileUrl: z.string().min(1).max(500).nullable().optional(),
    platform: z.string().min(1).max(60).nullable().optional(),
    handle: z.string().min(1).max(120).nullable().optional(),
    source: leadSourceSchema.optional(),
    region: z.string().min(1).max(80).nullable().optional(),
    teamId: z.string().min(1).max(120).nullable().optional(),
    expectedVersion: z.number().int().min(1),
  })
  .refine((p) => Object.keys(p).some((k) => k !== "expectedVersion"), { message: "At least one field must be provided." });
export type UpdateLeadInput = z.input<typeof updateLeadInputSchema>;

export async function updateLead(actor: ActorContext | null, leadRef: unknown, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<LeadDto>> {
  const loaded = await loadAuthorizedLead(actor, leadRef, "edit");
  if (!loaded.ok) return loaded.error;

  const parsed = updateLeadInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const { expectedVersion, ...patch } = parsed.data;

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  const result = await runLeadMutation(loaded.lead.uid, expectedVersion, (current) => {
    const next: LeadDoc = { ...current, updatedAt: new Date().toISOString(), updatedByUserRef: actor!.userRef };
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      before[key] = current[key];
      after[key] = value;
      (next as Record<string, unknown>)[key] = value;
    }
    // Kept in sync with displayName on every write - see the schema's
    // own comment on displayNameLower.
    if (patch.displayName !== undefined) next.displayNameLower = patch.displayName.toLowerCase();
    return next;
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };

  await writeLeadEvent({ leadUid: loaded.lead.uid, kind: "edited", actorUserRef: actor!.userRef, metadata: { before, after }, requestId });
  return { ok: true, data: await toLeadDto(result.doc) };
}

// ---- Research ----

const saveResearchInputSchema = z.object({
  targetAudience: targetAudienceSchema.nullable(),
  language: z.string().min(1).max(80).optional(),
  location: z.string().min(1).max(120).optional(),
  category: z.string().min(1).max(80).optional(),
  notes: z.string().min(1).max(2000).optional(),
  followerCount: z.number().int().min(0).optional(),
  expectedVersion: z.number().int().min(1),
});
export type SaveResearchInput = z.input<typeof saveResearchInputSchema>;

export async function saveResearch(actor: ActorContext | null, leadRef: unknown, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<LeadDto>> {
  const loaded = await loadAuthorizedLead(actor, leadRef, "manage_research");
  if (!loaded.ok) return loaded.error;

  const parsed = saveResearchInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const { expectedVersion, ...input } = parsed.data;

  const result = await runLeadMutation(loaded.lead.uid, expectedVersion, (current) => {
    const research = researchSchema.parse({ ...input, updatedAt: new Date().toISOString(), updatedByUserRef: actor!.userRef });
    return { ...current, research, updatedAt: research.updatedAt, updatedByUserRef: actor!.userRef };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };

  await writeLeadEvent({ leadUid: loaded.lead.uid, kind: "research_saved", actorUserRef: actor!.userRef, metadata: { targetAudience: input.targetAudience }, requestId });
  return { ok: true, data: await toLeadDto(result.doc) };
}

// ---- Review / shortlist ----

const recordReviewInputSchema = z.object({
  outcome: reviewOutcomeSchema,
  dimensions: reviewDimensionsSchema.optional(),
  reason: z.string().min(1).max(1000).optional(),
  expectedVersion: z.number().int().min(1),
});
export type RecordReviewInput = z.input<typeof recordReviewInputSchema>;

export async function recordReview(actor: ActorContext | null, leadRef: unknown, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<LeadDto>> {
  const loaded = await loadAuthorizedLead(actor, leadRef, "manage_review");
  if (!loaded.ok) return loaded.error;

  const parsed = recordReviewInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (input.outcome !== "SHORTLIST" && !input.reason) {
    return discoveryInvalidInputResult(`A reason is required for the "${input.outcome}" outcome.`);
  }

  const result = await runLeadMutation(loaded.lead.uid, input.expectedVersion, (current) => {
    // Firestore rejects an explicitly-`undefined` field value outright -
    // `reason` must be entirely absent when not supplied, never present
    // with value undefined (same discipline as
    // access-overrides-service.ts's buildFeatureOverride).
    const latestReview = {
      outcome: input.outcome,
      dimensions: input.dimensions ?? {},
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      actorUserRef: actor!.userRef,
      createdAt: new Date().toISOString(),
    };
    return { ...current, latestReview, updatedAt: latestReview.createdAt, updatedByUserRef: actor!.userRef };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };

  await writeLeadEvent({ leadUid: loaded.lead.uid, kind: "review_recorded", actorUserRef: actor!.userRef, metadata: { outcome: input.outcome }, requestId });
  return { ok: true, data: await toLeadDto(result.doc) };
}

// ---- Outreach / response ----

const recordOutreachInputSchema = z.object({
  direction: outreachDirectionSchema,
  channel: z.string().min(1).max(60),
  summary: z.string().min(1).max(1000),
  outcome: z.string().min(1).max(120),
  notes: z.string().min(1).max(2000).optional(),
  supportingReference: z.string().min(1).max(300).optional(),
  nextFollowUpAt: z.string().min(1).optional(),
  meaningfulResponse: z.boolean().optional(),
  expectedVersion: z.number().int().min(1),
});
export type RecordOutreachInput = z.input<typeof recordOutreachInputSchema>;

export async function recordOutreach(actor: ActorContext | null, leadRef: unknown, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<LeadDto>> {
  const loaded = await loadAuthorizedLead(actor, leadRef, "manage_outreach");
  if (!loaded.ok) return loaded.error;

  const parsed = recordOutreachInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const result = await runLeadMutation(loaded.lead.uid, input.expectedVersion, (current) => {
    // Server-captured timestamp - the operator never supplies the
    // authoritative contact time (Step 6A section 4).
    const createdAt = new Date().toISOString();
    const outreachSummary = {
      totalCount: (current.outreachSummary?.totalCount ?? 0) + 1,
      lastDirection: input.direction,
      lastChannel: input.channel,
      lastOutcome: input.outcome,
      lastAt: createdAt,
      nextFollowUpAt: input.nextFollowUpAt ?? null,
    };

    // The first genuine outbound contact can advance NEW/RESEARCHING to
    // CONTACTED; a meaningful inbound response can advance CONTACTED to
    // RESPONDED. Both are the ONLY lifecycle side effects this function
    // ever applies, and both go through the exact same transition table
    // every other lifecycle change does (see authz/lifecycle.ts) - an
    // outreach entry recorded from a state that doesn't allow the
    // implied transition simply doesn't move the lifecycle at all.
    let lifecycle = current.lifecycle;
    let respondedAt = current.respondedAt;
    if (input.direction === "OUTBOUND" && (current.lifecycle === "NEW" || current.lifecycle === "RESEARCHING")) {
      lifecycle = "CONTACTED";
    } else if (input.direction === "INBOUND" && input.meaningfulResponse && current.lifecycle === "CONTACTED") {
      lifecycle = "RESPONDED";
      respondedAt = createdAt;
    }

    return { ...current, outreachSummary, lifecycle, respondedAt, updatedAt: createdAt, updatedByUserRef: actor!.userRef };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };

  await writeLeadEvent({
    leadUid: loaded.lead.uid,
    kind: "outreach_recorded",
    actorUserRef: actor!.userRef,
    metadata: { direction: input.direction, channel: input.channel, outcome: input.outcome, meaningfulResponse: input.meaningfulResponse ?? false, lifecycle: result.doc.lifecycle },
    requestId,
  });
  return { ok: true, data: await toLeadDto(result.doc) };
}

// ---- Commercial / agreement evidence ----

const saveCommercialInputSchema = commercialEvidenceSchema.omit({ updatedAt: true, updatedByUserRef: true }).extend({ expectedVersion: z.number().int().min(1) });
export type SaveCommercialInput = z.input<typeof saveCommercialInputSchema>;

export async function saveCommercial(actor: ActorContext | null, leadRef: unknown, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<LeadDto>> {
  const loaded = await loadAuthorizedLead(actor, leadRef, "manage_commercial");
  if (!loaded.ok) return loaded.error;

  const parsed = saveCommercialInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const { expectedVersion, ...input } = parsed.data;

  const result = await runLeadMutation(loaded.lead.uid, expectedVersion, (current) => {
    const commercial = commercialEvidenceSchema.parse({ ...input, updatedAt: new Date().toISOString(), updatedByUserRef: actor!.userRef });
    return { ...current, commercial, updatedAt: commercial.updatedAt, updatedByUserRef: actor!.userRef };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };

  await writeLeadEvent({ leadUid: loaded.lead.uid, kind: "commercial_saved", actorUserRef: actor!.userRef, metadata: { alignmentConfirmed: input.alignmentConfirmed }, requestId });
  return { ok: true, data: await toLeadDto(result.doc) };
}

const saveAgreementInputSchema = z.object({
  summary: z.string().min(1).max(2000).optional(),
  referenceUrl: z.string().min(1).max(500).optional(),
  confirmed: z.boolean(),
  expectedVersion: z.number().int().min(1),
});
export type SaveAgreementInput = z.input<typeof saveAgreementInputSchema>;

type SaveAgreementTxResult = { kind: "ok"; doc: LeadDoc } | { kind: "stale" } | { kind: "not_found" };

export async function saveDiscoveryAgreement(actor: ActorContext | null, leadRef: unknown, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<LeadDto>> {
  const loaded = await loadAuthorizedLead(actor, leadRef, "manage_commercial");
  if (!loaded.ok) return loaded.error;

  const parsed = saveAgreementInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  // A custom transaction, not the shared single-document runLeadMutation
  // helper - the first time a Lead's Agreement evidence is confirmed,
  // this also allocates its Drive proposal number from a SECOND
  // document (a per-platform-code counter), which must happen inside
  // the same transaction as the Agreement write itself so the two can
  // never disagree. Firestore requires every read before any write, so
  // the (conditional) counter read happens before either document is
  // written.
  const db = getAdminFirestore();
  const leadDocRef = leadsCollection().doc(loaded.lead.uid);

  const result = await db.runTransaction<SaveAgreementTxResult>(async (tx) => {
    const snap = await tx.get(leadDocRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsedLead = leadDocSchema.safeParse(snap.data());
    if (!parsedLead.success) return { kind: "not_found" };
    const current = parsedLead.data;
    if (current.version !== input.expectedVersion) return { kind: "stale" };

    const now = new Date().toISOString();
    const discoveryAgreement = discoveryAgreementEvidenceSchema.parse({
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.referenceUrl !== undefined ? { referenceUrl: input.referenceUrl } : {}),
      confirmedAt: input.confirmed ? now : null,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });

    let proposalNumber = current.proposalNumber;
    let proposalPlatformCode = current.proposalPlatformCode;
    if (input.confirmed && proposalNumber == null) {
      const code = platformCodeFor(current.platform);
      const counter = await readNextProposalNumber(tx, db, code);
      tx.set(counter.ref, { next: counter.next + 1 }, { merge: true });
      proposalNumber = counter.next;
      proposalPlatformCode = code;
    }

    const updated: LeadDoc = { ...current, discoveryAgreement, proposalNumber, proposalPlatformCode, version: current.version + 1, updatedAt: now, updatedByUserRef: actor!.userRef };
    tx.set(leadDocRef, updated);
    return { kind: "ok", doc: updated };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };

  await writeLeadEvent({ leadUid: loaded.lead.uid, kind: "agreement_saved", actorUserRef: actor!.userRef, metadata: { confirmed: input.confirmed }, requestId });
  return { ok: true, data: await toLeadDto(result.doc) };
}

// ---- Asset decision ----

const saveAssetDecisionInputSchema = z.object({
  decision: assetDecisionKindSchema,
  existingPartnerAccountRef: z.string().min(1).optional(),
  notes: z.string().min(1).max(1000).optional(),
  expectedVersion: z.number().int().min(1),
});
export type SaveAssetDecisionInput = z.input<typeof saveAssetDecisionInputSchema>;

export async function saveAssetDecision(actor: ActorContext | null, leadRef: unknown, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<LeadDto>> {
  const loaded = await loadAuthorizedLead(actor, leadRef, "manage_asset_decision");
  if (!loaded.ok) return loaded.error;

  const parsed = saveAssetDecisionInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (input.decision !== "NEW_ACCOUNT" && !input.existingPartnerAccountRef) {
    return discoveryInvalidInputResult(`"${input.decision}" requires existingPartnerAccountRef.`);
  }
  if (input.decision === "NEW_ACCOUNT" && input.existingPartnerAccountRef) {
    return discoveryInvalidInputResult("NEW_ACCOUNT must not reference an existing Partner Account.");
  }

  const result = await runLeadMutation(loaded.lead.uid, input.expectedVersion, (current) => {
    const now = new Date().toISOString();
    const assetDecision = {
      decision: input.decision,
      ...(input.existingPartnerAccountRef !== undefined ? { existingPartnerAccountRef: input.existingPartnerAccountRef } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      decidedAt: now,
      decidedByUserRef: actor!.userRef,
    };
    return { ...current, assetDecision, updatedAt: now, updatedByUserRef: actor!.userRef };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };

  await writeLeadEvent({ leadUid: loaded.lead.uid, kind: "asset_decision_saved", actorUserRef: actor!.userRef, metadata: { decision: input.decision }, requestId });
  return { ok: true, data: await toLeadDto(result.doc) };
}

// ---- Manager assignment ----

const assignManagerInputSchema = z.object({
  managerUserRef: z.string().min(1).nullable(),
  expectedVersion: z.number().int().min(1),
});
export type AssignManagerInput = z.input<typeof assignManagerInputSchema>;

export async function assignManager(actor: ActorContext | null, leadRef: unknown, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<LeadDto>> {
  const loaded = await loadAuthorizedLead(actor, leadRef, "manage_manager_assignment");
  if (!loaded.ok) return loaded.error;

  const parsed = assignManagerInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  let managerUid: string | null = null;
  if (input.managerUserRef) {
    const manager = await findActiveUserByRef(input.managerUserRef);
    if (!manager) return discoveryInvalidInputResult("managerUserRef must reference a real, active, admitted user.");
    managerUid = manager.uid;
  }

  const result = await runLeadMutation(loaded.lead.uid, input.expectedVersion, (current) => ({
    ...current,
    managerUid,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };

  await writeLeadEvent({ leadUid: loaded.lead.uid, kind: "manager_assigned", actorUserRef: actor!.userRef, metadata: { assigned: Boolean(managerUid) }, requestId });
  return { ok: true, data: await toLeadDto(result.doc) };
}

// ---- Duplicate check (persisted onto an existing Lead) ----

const checkLeadDuplicatesInputSchema = z.object({ expectedVersion: z.number().int().min(1) });
export type CheckLeadDuplicatesInput = z.input<typeof checkLeadDuplicatesInputSchema>;

export async function checkLeadDuplicates(actor: ActorContext | null, leadRef: unknown, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<LeadDto>> {
  const loaded = await loadAuthorizedLead(actor, leadRef, "edit");
  if (!loaded.ok) return loaded.error;

  const parsed = checkLeadDuplicatesInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const checkResult = await checkForDuplicates({
    email: loaded.lead.email ?? undefined,
    phone: loaded.lead.phone ?? undefined,
    profileUrl: loaded.lead.profileUrl ?? undefined,
    handle: loaded.lead.handle ?? undefined,
    excludeLeadUid: loaded.lead.uid,
  });
  const duplicateCheck = duplicateCheckResultSchema.parse(checkResult);

  const result = await runLeadMutation(loaded.lead.uid, parsed.data.expectedVersion, (current) => ({
    ...current,
    duplicateCheck,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };

  await writeLeadEvent({ leadUid: loaded.lead.uid, kind: "duplicate_checked", actorUserRef: actor!.userRef, metadata: { status: duplicateCheck.status, matchCount: duplicateCheck.matches.length }, requestId });
  return { ok: true, data: await toLeadDto(result.doc) };
}

// Pre-create duplicate check - no Lead exists yet, so nothing is
// persisted; read-only, gated by Feature Access alone (see
// requireDiscoveryFeatureAccess's doc comment for why list/get-shaped
// reads don't need a specific action).
const precheckDuplicatesInputSchema = z.object({
  email: z.string().min(1).max(300).optional(),
  phone: z.string().min(1).max(40).optional(),
  profileUrl: z.string().min(1).max(500).optional(),
  handle: z.string().min(1).max(120).optional(),
});
export type PrecheckDuplicatesInput = z.input<typeof precheckDuplicatesInputSchema>;

export async function precheckDuplicates(actor: ActorContext | null, rawInput: unknown): Promise<DiscoveryServiceResult<ReturnType<typeof duplicateCheckResultSchema.parse>>> {
  if (!actor) return discoveryUnauthorizedResult("not_authenticated");
  const gate = await requireDiscoveryFeatureAccess(actor);
  if (!gate.ok) return discoveryUnauthorizedResult(gate.reason);

  const parsed = precheckDuplicatesInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  if (!parsed.data.email && !parsed.data.phone && !parsed.data.profileUrl && !parsed.data.handle) {
    return discoveryInvalidInputResult("At least one of email, phone, profileUrl, handle is required.");
  }

  const result = await checkForDuplicates(parsed.data);
  return { ok: true, data: duplicateCheckResultSchema.parse(result) };
}

// ---- History / activity (Step 6B) ----
// Reads the append-only leads/{uid}/events subcollection - the same
// history Step 6A's audit trail is built from. Read-only, gated by
// Feature Access + Record Scope like get/list; the events themselves are
// already redacted at write time (see lead-events.ts), so nothing
// restricted ever reaches this response.
const listLeadHistoryInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.object({ createdAt: z.string().min(1), id: z.string().min(1) }).optional(),
});
export type ListLeadHistoryInput = z.input<typeof listLeadHistoryInputSchema>;

export type LeadHistoryEventDto = LeadEvent & { id: string; actorDisplayName: string | null };

export async function getLeadHistory(
  actor: ActorContext | null,
  leadRef: unknown,
  rawInput: unknown,
): Promise<DiscoveryServiceResult<{ events: LeadHistoryEventDto[]; nextCursor: LeadEventListCursor | null }>> {
  if (!actor) return discoveryUnauthorizedResult("not_authenticated");
  const gate = await requireDiscoveryFeatureAccess(actor);
  if (!gate.ok) return discoveryUnauthorizedResult(gate.reason);

  if (typeof leadRef !== "string" || leadRef.length === 0) return discoveryInvalidInputResult("Missing leadRef.");
  const lead = await getLeadDocByRef(leadRef);
  if (!lead) return { ok: false, code: "not_found", message: "Lead not found." };

  const scopeCheck = await requireLeadInScope(actor, lead);
  if (!scopeCheck.ok) return discoveryUnauthorizedResult(scopeCheck.reason);

  const parsed = listLeadHistoryInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const page = await listLeadEvents(lead.uid, { limit: parsed.data.limit ?? 20, cursor: parsed.data.cursor });

  // Resolve each distinct actor's display name once, not once per event
  // - a short activity feed page usually has far fewer unique actors
  // than events. Fails soft to null (a display concern only) rather
  // than dropping the event if a user doc can no longer be found.
  const uniqueActorRefs = [...new Set(page.events.map((e) => e.actorUserRef))];
  const actorEntries = await Promise.all(uniqueActorRefs.map(async (ref) => [ref, (await getUserDocByRef(ref))?.displayName ?? null] as const));
  const actorNames = new Map(actorEntries);

  return { ok: true, data: { events: page.events.map((e) => ({ ...e, actorDisplayName: actorNames.get(e.actorUserRef) ?? null })), nextCursor: page.nextCursor } };
}
