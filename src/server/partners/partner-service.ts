import { z } from "zod";

import { targetAudienceArraySchema } from "@/server/discovery/types";
import { getUserDocByRef } from "@/server/authz/firestore";
import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { toPartnerDto, toPartnerDtos, type PartnerDto } from "./client-dto";
import { getPartnerDocByRef, listPartnerDocs, partnersCollection, runPartnerMutation, type PartnerListCursor } from "./firestore";
import { generatePartnerRef } from "./ids";
import { requirePartnerInScope, requirePartnersAccess, requirePartnersFeatureAccess } from "./partners-gate";
import { listPartnerEvents, writePartnerEvent, type PartnerEventListCursor } from "./partner-events";
import { partnerDocSchema, partnersInvalidInputResult, partnersUnauthorizedResult, type PartnerDoc, type PartnerEvent, type PartnersServiceResult } from "./types";

async function findActiveUserByRef(userRef: string): Promise<{ uid: string } | null> {
  const doc = await getUserDocByRef(userRef);
  if (!doc || !doc.active) return null;
  return { uid: doc.uid };
}

async function loadAuthorizedPartner(actor: ActorContext | null, partnerRef: unknown, action: Parameters<typeof requirePartnersAccess>[1]): Promise<{ ok: true; partner: PartnerDoc } | { ok: false; error: PartnersServiceResult<never> }> {
  const gate = await requirePartnersAccess(actor, action);
  if (!gate.ok) return { ok: false, error: partnersUnauthorizedResult(gate.reason) };

  if (typeof partnerRef !== "string" || partnerRef.length === 0) return { ok: false, error: partnersInvalidInputResult("Missing partnerRef.") };
  const partner = await getPartnerDocByRef(partnerRef);
  if (!partner) return { ok: false, error: { ok: false, code: "not_found", message: "Partner not found." } };

  const scopeCheck = await requirePartnerInScope(actor!, partner);
  if (!scopeCheck.ok) return { ok: false, error: partnersUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, partner };
}

// ---- Create ----

const createPartnerInputSchema = z.object({
  displayName: z.string().min(1).max(200),
  legalName: z.string().min(1).max(200).optional(),
  email: z.string().min(1).max(300).optional(),
  phone: z.string().min(1).max(40).optional(),
  regionIds: z.array(z.string().min(1)).max(50).optional(),
  languageIds: z.array(z.string().min(1)).max(50).optional(),
  categoryIds: z.array(z.string().min(1)).max(50).optional(),
  tier: z.string().min(1).max(60).optional(),
  priority: z.string().min(1).max(60).optional(),
  targetAudience: targetAudienceArraySchema.optional(),
  ownerUserRef: z.string().min(1).optional(),
  teamIds: z.array(z.string().min(1)).max(50).optional(),
  // Discovery provenance, when this Partner is known (by the caller) to
  // originate from a specific Lead even though it is being created
  // directly rather than through convertLead.
  originLeadRef: z.string().min(1).optional(),
}).strict();
export type CreatePartnerInput = z.input<typeof createPartnerInputSchema>;

export async function createPartner(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<PartnersServiceResult<PartnerDto>> {
  const gate = await requirePartnersAccess(actor, "create");
  if (!gate.ok) return partnersUnauthorizedResult(gate.reason);

  const parsed = createPartnerInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  let ownerUid: string | null = null;
  if (input.ownerUserRef) {
    const owner = await findActiveUserByRef(input.ownerUserRef);
    if (!owner) return partnersInvalidInputResult("ownerUserRef does not resolve to a real, active user.");
    ownerUid = owner.uid;
  }

  const now = new Date().toISOString();
  const uid = partnersCollection().doc().id;

  const doc: PartnerDoc = partnerDocSchema.parse({
    uid,
    partnerRef: generatePartnerRef(),
    version: 1,
    displayName: input.displayName,
    displayNameLower: input.displayName.toLowerCase(),
    legalName: input.legalName ?? null,
    status: "ACTIVE",
    previousStatus: null,
    statusReason: null,
    regionIds: input.regionIds ?? [],
    languageIds: input.languageIds ?? [],
    categoryIds: input.categoryIds ?? [],
    tier: input.tier ?? null,
    priority: input.priority ?? null,
    targetAudience: input.targetAudience ?? [],
    email: input.email ?? null,
    phone: input.phone ?? null,
    ownerUid,
    teamIds: input.teamIds ?? [],
    originLeadRefs: input.originLeadRef ? [input.originLeadRef] : [],
    sourceDiscovery: null,
    pendingPartnerAccountSetup: false,
    createdAt: now,
    createdByUserRef: actor!.userRef,
    updatedAt: now,
    updatedByUserRef: actor!.userRef,
  });

  await partnersCollection().doc(uid).set(doc);
  await writePartnerEvent({ partnerUid: uid, kind: "created", actorUserRef: actor!.userRef, metadata: { displayName: doc.displayName, direct: true }, requestId });

  return { ok: true, data: await toPartnerDto(doc) };
}

// ---- Read ----

// Reads are gated by Feature Access only (never a specific mutation
// action), matching Discovery's own getLead/list pattern -
// loadAuthorizedPartner (which requires a real ActionId) is only used by
// the mutation paths below.
export async function getPartner(actor: ActorContext | null, partnerRef: unknown): Promise<PartnersServiceResult<PartnerDto>> {
  const gate = await requirePartnersFeatureAccess(actor);
  if (!gate.ok) return partnersUnauthorizedResult(gate.reason);

  if (typeof partnerRef !== "string" || partnerRef.length === 0) return partnersInvalidInputResult("Missing partnerRef.");
  const partner = await getPartnerDocByRef(partnerRef);
  if (!partner) return { ok: false, code: "not_found", message: "Partner not found." };

  const scopeCheck = await requirePartnerInScope(actor!, partner);
  if (!scopeCheck.ok) return partnersUnauthorizedResult(scopeCheck.reason);

  return { ok: true, data: await toPartnerDto(partner) };
}

export type ListPartnersInput = {
  limit?: number;
  cursor?: PartnerListCursor;
  status?: string;
  displayNamePrefix?: string;
  region?: string | string[];
  tier?: string;
  targetAudience?: string | string[];
  // Resolved to the actor's own uid server-side - the browser never
  // supplies a raw uid, only the boolean intent (same idiom as
  // Discovery's listLeads assignedToMe).
  assignedToMe?: boolean;
  pendingPartnerAccountSetup?: boolean;
};

export async function listPartners(actor: ActorContext | null, input: ListPartnersInput): Promise<PartnersServiceResult<{ partners: PartnerDto[]; nextCursor: PartnerListCursor | null }>> {
  const gate = await requirePartnersFeatureAccess(actor);
  if (!gate.ok) return partnersUnauthorizedResult(gate.reason);

  const grants = await getActorScopeGrants(actor!);
  const page = await listPartnerDocs({
    limit: input.limit ?? 20,
    cursor: input.cursor,
    actorUid: actor!.uid,
    grants,
    hasGlobal: hasGlobalScope(grants),
    status: input.status,
    displayNamePrefix: input.displayNamePrefix?.toLowerCase(),
    region: input.region,
    tier: input.tier,
    targetAudience: input.targetAudience,
    ownerUid: input.assignedToMe ? actor!.uid : undefined,
    pendingPartnerAccountSetup: input.pendingPartnerAccountSetup,
  });

  return { ok: true, data: { partners: await toPartnerDtos(page.partners), nextCursor: page.nextCursor } };
}

// ---- Edit ordinary fields ----

const editPartnerInputSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    legalName: z.string().min(1).max(200).nullable().optional(),
    email: z.string().min(1).max(300).nullable().optional(),
    phone: z.string().min(1).max(40).nullable().optional(),
    regionIds: z.array(z.string().min(1)).max(50).optional(),
    languageIds: z.array(z.string().min(1)).max(50).optional(),
    categoryIds: z.array(z.string().min(1)).max(50).optional(),
    tier: z.string().min(1).max(60).nullable().optional(),
    priority: z.string().min(1).max(60).nullable().optional(),
    targetAudience: targetAudienceArraySchema.optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type EditPartnerInput = z.input<typeof editPartnerInputSchema>;

export async function editPartner(actor: ActorContext | null, partnerRef: unknown, rawInput: unknown, requestId: string): Promise<PartnersServiceResult<PartnerDto>> {
  const loaded = await loadAuthorizedPartner(actor, partnerRef, "edit");
  if (!loaded.ok) return loaded.error;

  const parsed = editPartnerInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const result = await runPartnerMutation(loaded.partner.uid, input.expectedVersion, (current) => ({
    ...current,
    displayName: input.displayName ?? current.displayName,
    displayNameLower: input.displayName ? input.displayName.toLowerCase() : current.displayNameLower,
    legalName: input.legalName !== undefined ? input.legalName : current.legalName,
    email: input.email !== undefined ? input.email : current.email,
    phone: input.phone !== undefined ? input.phone : current.phone,
    regionIds: input.regionIds ?? current.regionIds,
    languageIds: input.languageIds ?? current.languageIds,
    categoryIds: input.categoryIds ?? current.categoryIds,
    tier: input.tier !== undefined ? input.tier : current.tier,
    priority: input.priority !== undefined ? input.priority : current.priority,
    targetAudience: input.targetAudience !== undefined ? input.targetAudience : current.targetAudience,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Partner not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Partner was changed elsewhere. Reload and try again." };

  await writePartnerEvent({ partnerUid: loaded.partner.uid, kind: "edited", actorUserRef: actor!.userRef, metadata: { fields: Object.keys(input).filter((k) => k !== "expectedVersion") }, requestId });
  return { ok: true, data: await toPartnerDto(result.doc) };
}

// ---- Owner / team ----

const setOwnerTeamInputSchema = z.object({
  ownerUserRef: z.string().min(1).nullable(),
  teamIds: z.array(z.string().min(1)).max(50),
  expectedVersion: z.number().int().min(1),
});
export type SetPartnerOwnerTeamInput = z.input<typeof setOwnerTeamInputSchema>;

export async function setPartnerOwnerTeam(actor: ActorContext | null, partnerRef: unknown, rawInput: unknown, requestId: string): Promise<PartnersServiceResult<PartnerDto>> {
  const loaded = await loadAuthorizedPartner(actor, partnerRef, "manage_partner_ownership");
  if (!loaded.ok) return loaded.error;

  const parsed = setOwnerTeamInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  let ownerUid: string | null = null;
  if (input.ownerUserRef) {
    const owner = await findActiveUserByRef(input.ownerUserRef);
    if (!owner) return partnersInvalidInputResult("ownerUserRef does not resolve to a real, active user.");
    ownerUid = owner.uid;
  }

  const result = await runPartnerMutation(loaded.partner.uid, input.expectedVersion, (current) => ({
    ...current,
    ownerUid,
    teamIds: input.teamIds,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Partner not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Partner was changed elsewhere. Reload and try again." };

  await writePartnerEvent({ partnerUid: loaded.partner.uid, kind: "owner_team_changed", actorUserRef: actor!.userRef, metadata: { assigned: Boolean(ownerUid), teamCount: input.teamIds.length }, requestId });
  return { ok: true, data: await toPartnerDto(result.doc) };
}

// ---- Status (ACTIVE <-> INACTIVE, ordinary reversible toggle) ----

const setStatusInputSchema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE"]),
  expectedVersion: z.number().int().min(1),
});
export type SetPartnerStatusInput = z.input<typeof setStatusInputSchema>;

export async function setPartnerStatus(actor: ActorContext | null, partnerRef: unknown, rawInput: unknown, requestId: string): Promise<PartnersServiceResult<PartnerDto>> {
  const loaded = await loadAuthorizedPartner(actor, partnerRef, "edit");
  if (!loaded.ok) return loaded.error;

  const parsed = setStatusInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (loaded.partner.status !== "ACTIVE" && loaded.partner.status !== "INACTIVE") {
    return partnersInvalidInputResult(`Cannot set status directly while ${loaded.partner.status} - restore the Partner first.`);
  }

  const result = await runPartnerMutation(loaded.partner.uid, input.expectedVersion, (current) => ({
    ...current,
    status: input.status,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Partner not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Partner was changed elsewhere. Reload and try again." };

  await writePartnerEvent({ partnerUid: loaded.partner.uid, kind: "status_changed", actorUserRef: actor!.userRef, metadata: { to: input.status }, requestId });
  return { ok: true, data: await toPartnerDto(result.doc) };
}

// ---- History ----

const listPartnerHistoryInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.object({ createdAt: z.string().min(1), id: z.string().min(1) }).optional(),
});
export type ListPartnerHistoryInput = z.input<typeof listPartnerHistoryInputSchema>;
export type PartnerHistoryEventDto = PartnerEvent & { id: string; actorDisplayName: string | null };

export async function getPartnerHistory(
  actor: ActorContext | null,
  partnerRef: unknown,
  rawInput: unknown,
): Promise<PartnersServiceResult<{ events: PartnerHistoryEventDto[]; nextCursor: PartnerEventListCursor | null }>> {
  const gate = await requirePartnersFeatureAccess(actor);
  if (!gate.ok) return partnersUnauthorizedResult(gate.reason);

  if (typeof partnerRef !== "string" || partnerRef.length === 0) return partnersInvalidInputResult("Missing partnerRef.");
  const partner = await getPartnerDocByRef(partnerRef);
  if (!partner) return { ok: false, code: "not_found", message: "Partner not found." };

  const scopeCheck = await requirePartnerInScope(actor!, partner);
  if (!scopeCheck.ok) return partnersUnauthorizedResult(scopeCheck.reason);

  const parsed = listPartnerHistoryInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const page = await listPartnerEvents(partner.uid, { limit: parsed.data.limit ?? 20, cursor: parsed.data.cursor });

  // Resolve each distinct actor's display name once - same idiom as
  // Discovery's getLeadHistory.
  const uniqueActorRefs = [...new Set(page.events.map((e) => e.actorUserRef))];
  const actorEntries = await Promise.all(uniqueActorRefs.map(async (ref) => [ref, (await getUserDocByRef(ref))?.displayName ?? null] as const));
  const actorNames = new Map(actorEntries);

  return { ok: true, data: { events: page.events.map((e) => ({ ...e, actorDisplayName: actorNames.get(e.actorUserRef) ?? null })), nextCursor: page.nextCursor } };
}
