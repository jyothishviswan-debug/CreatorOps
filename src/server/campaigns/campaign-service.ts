import { createHash } from "node:crypto";
import { z } from "zod";

import { getUserDocByRef } from "@/server/authz/firestore";
import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { toCampaignDto, toCampaignDtos, type CampaignDto } from "./client-dto";
import { campaignsCollection, getCampaignDocByRef, listCampaignDocs, runCampaignMutation, type CampaignListCursor } from "./firestore";
import { generateCampaignRef, generateCampaignResourceRef } from "./ids";
import { evaluateCampaignReadiness } from "./readiness";
import { requireCampaignInScope, requireCampaignsAccess, requireCampaignsFeatureAccess } from "./campaigns-gate";
import { listCampaignEvents, writeCampaignEvent, type CampaignEventListCursor } from "./campaign-events";
import { normalizePlatformIdentifier } from "@/server/shared/platform";
import { CAMPAIGN_RESOURCE_ALLOWED_MIME_TYPES, CAMPAIGN_RESOURCE_UPLOAD_NOT_CONFIGURED_MESSAGE, getCampaignResourceStorage, isCampaignResourceMimeType } from "./resource-storage";
import {
  campaignCriteriaSchema,
  campaignDocSchema,
  campaignPlatformsArraySchema,
  campaignsInvalidInputResult,
  campaignsUnauthorizedResult,
  reviewPolicySchema,
  type CampaignDoc,
  type CampaignEvent,
  type CampaignReadinessResult,
  type CampaignsServiceResult,
} from "./types";

async function findActiveUserByRef(userRef: string): Promise<{ uid: string } | null> {
  const doc = await getUserDocByRef(userRef);
  if (!doc || !doc.active) return null;
  return { uid: doc.uid };
}

async function loadAuthorizedCampaign(actor: ActorContext | null, campaignRef: unknown, action: Parameters<typeof requireCampaignsAccess>[1]): Promise<{ ok: true; campaign: CampaignDoc } | { ok: false; error: CampaignsServiceResult<never> }> {
  const gate = await requireCampaignsAccess(actor, action);
  if (!gate.ok) return { ok: false, error: campaignsUnauthorizedResult(gate.reason) };

  if (typeof campaignRef !== "string" || campaignRef.length === 0) return { ok: false, error: campaignsInvalidInputResult("Missing campaignRef.") };
  const campaign = await getCampaignDocByRef(campaignRef);
  if (!campaign) return { ok: false, error: { ok: false, code: "not_found", message: "Campaign not found." } };

  const scopeCheck = await requireCampaignInScope(actor!, campaign);
  if (!scopeCheck.ok) return { ok: false, error: campaignsUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, campaign };
}

// ---- Create ----

const createCampaignInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    objective: z.string().min(1).max(2000),
    platforms: campaignPlatformsArraySchema.optional(),
    startDate: z.string().min(1),
    endDate: z.string().min(1),
    regionIds: z.array(z.string().min(1)).max(50).optional(),
    ownerUserRef: z.string().min(1).optional(),
    teamIds: z.array(z.string().min(1)).max(50).optional(),
    criteria: campaignCriteriaSchema.partial().optional(),
    defaultReviewPolicy: reviewPolicySchema,
  })
  .strict();
export type CreateCampaignInput = z.input<typeof createCampaignInputSchema>;

export async function createCampaign(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<CampaignsServiceResult<CampaignDto>> {
  const gate = await requireCampaignsAccess(actor, "create");
  if (!gate.ok) return campaignsUnauthorizedResult(gate.reason);

  const parsed = createCampaignInputSchema.safeParse(rawInput);
  if (!parsed.success) return campaignsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (input.endDate < input.startDate) return campaignsInvalidInputResult("endDate cannot be before startDate.");

  let ownerUid: string | null = null;
  if (input.ownerUserRef) {
    const owner = await findActiveUserByRef(input.ownerUserRef);
    if (!owner) return campaignsInvalidInputResult("ownerUserRef does not resolve to a real, active user.");
    ownerUid = owner.uid;
  }

  const now = new Date().toISOString();
  const uid = campaignsCollection().doc().id;

  const doc: CampaignDoc = campaignDocSchema.parse({
    uid,
    campaignRef: generateCampaignRef(),
    version: 1,
    name: input.name,
    nameLower: input.name.toLowerCase(),
    objective: input.objective,
    status: "DRAFT",
    statusReason: null,
    platforms: input.platforms ?? [],
    startDate: input.startDate,
    endDate: input.endDate,
    regionIds: input.regionIds ?? [],
    ownerUid,
    teamIds: input.teamIds ?? [],
    // Finding #34: criteria.platforms is no longer independently
    // user-maintained - the canonical top-level `platforms` is the one
    // source of truth for a new Campaign, and this mirrors it in
    // regardless of anything a caller might still send for
    // criteria.platforms (the schema field itself stays, for the same
    // .strict()-backward-compatibility reason #32's categoryIds does -
    // see below and the create form's own comment).
    criteria: campaignCriteriaSchema.parse({ ...(input.criteria ?? {}), platforms: input.platforms ?? [] }),
    resources: [],
    defaultReviewPolicy: input.defaultReviewPolicy,
    createdAt: now,
    createdByUserRef: actor!.userRef,
    updatedAt: now,
    updatedByUserRef: actor!.userRef,
  });

  await campaignsCollection().doc(uid).set(doc);
  await writeCampaignEvent({ campaignUid: uid, kind: "created", actorUserRef: actor!.userRef, metadata: { name: doc.name, status: doc.status }, requestId });

  return { ok: true, data: await toCampaignDto(doc) };
}

// ---- Read ----

export async function getCampaign(actor: ActorContext | null, campaignRef: unknown): Promise<CampaignsServiceResult<CampaignDto>> {
  const gate = await requireCampaignsFeatureAccess(actor);
  if (!gate.ok) return campaignsUnauthorizedResult(gate.reason);

  if (typeof campaignRef !== "string" || campaignRef.length === 0) return campaignsInvalidInputResult("Missing campaignRef.");
  const campaign = await getCampaignDocByRef(campaignRef);
  if (!campaign) return { ok: false, code: "not_found", message: "Campaign not found." };

  const scopeCheck = await requireCampaignInScope(actor!, campaign);
  if (!scopeCheck.ok) return campaignsUnauthorizedResult(scopeCheck.reason);

  return { ok: true, data: await toCampaignDto(campaign) };
}

export type ListCampaignsInput = {
  limit?: number;
  cursor?: CampaignListCursor;
  status?: string;
  namePrefix?: string;
  region?: string | string[];
  platform?: string;
  assignedToMe?: boolean;
};

export async function listCampaigns(actor: ActorContext | null, input: ListCampaignsInput): Promise<CampaignsServiceResult<{ campaigns: CampaignDto[]; nextCursor: CampaignListCursor | null }>> {
  const gate = await requireCampaignsFeatureAccess(actor);
  if (!gate.ok) return campaignsUnauthorizedResult(gate.reason);

  const grants = await getActorScopeGrants(actor!);
  const page = await listCampaignDocs({
    limit: input.limit ?? 20,
    cursor: input.cursor,
    actorUid: actor!.uid,
    grants,
    hasGlobal: hasGlobalScope(grants),
    status: input.status,
    namePrefix: input.namePrefix?.toLowerCase(),
    region: input.region,
    // Stored platform values are always normalized (see
    // @/server/shared/platform) - an un-normalized filter value would
    // silently never match.
    platform: input.platform ? normalizePlatformIdentifier(input.platform) : undefined,
    ownerUid: input.assignedToMe ? actor!.uid : undefined,
  });

  return { ok: true, data: { campaigns: await toCampaignDtos(page.campaigns), nextCursor: page.nextCursor } };
}

// ---- Edit ordinary plan fields ----

const editCampaignInputSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    objective: z.string().min(1).max(2000).optional(),
    platforms: campaignPlatformsArraySchema.optional(),
    startDate: z.string().min(1).optional(),
    endDate: z.string().min(1).optional(),
    regionIds: z.array(z.string().min(1)).max(50).optional(),
    criteria: campaignCriteriaSchema.partial().optional(),
    defaultReviewPolicy: reviewPolicySchema.optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type EditCampaignInput = z.input<typeof editCampaignInputSchema>;

export async function editCampaign(actor: ActorContext | null, campaignRef: unknown, rawInput: unknown, requestId: string): Promise<CampaignsServiceResult<CampaignDto>> {
  const loaded = await loadAuthorizedCampaign(actor, campaignRef, "edit");
  if (!loaded.ok) return loaded.error;

  const parsed = editCampaignInputSchema.safeParse(rawInput);
  if (!parsed.success) return campaignsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const nextStartDate = input.startDate ?? loaded.campaign.startDate;
  const nextEndDate = input.endDate ?? loaded.campaign.endDate;
  if (nextEndDate < nextStartDate) return campaignsInvalidInputResult("endDate cannot be before startDate.");

  const reviewPolicyChanged = input.defaultReviewPolicy !== undefined && input.defaultReviewPolicy !== loaded.campaign.defaultReviewPolicy;
  const previousReviewPolicy = loaded.campaign.defaultReviewPolicy;

  const result = await runCampaignMutation(loaded.campaign.uid, input.expectedVersion, (current) => ({
    ...current,
    name: input.name ?? current.name,
    nameLower: input.name ? input.name.toLowerCase() : current.nameLower,
    objective: input.objective ?? current.objective,
    platforms: input.platforms ?? current.platforms,
    startDate: nextStartDate,
    endDate: nextEndDate,
    regionIds: input.regionIds ?? current.regionIds,
    // Finding #34: criteria.platforms mirrors the canonical top-level
    // `platforms` whenever THIS edit actually touches platforms and/or
    // criteria - matching the same "only checked when this request
    // touches the relevant field(s)" discipline used elsewhere in this
    // program (Partner Accounts #20's own conflict check), so an
    // unrelated edit (e.g. renaming the Campaign) never retroactively
    // overwrites a genuinely-divergent historical value.
    criteria:
      input.criteria || input.platforms !== undefined
        ? campaignCriteriaSchema.parse({ ...current.criteria, ...input.criteria, platforms: input.platforms ?? current.platforms })
        : current.criteria,
    defaultReviewPolicy: input.defaultReviewPolicy ?? current.defaultReviewPolicy,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Campaign not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Campaign was changed elsewhere. Reload and try again." };

  await writeCampaignEvent({ campaignUid: loaded.campaign.uid, kind: "edited", actorUserRef: actor!.userRef, metadata: { fields: Object.keys(input).filter((k) => k !== "expectedVersion") }, requestId });
  // A later Assignment must snapshot the effective policy at creation
  // time - changing this default must never silently rewrite existing
  // Assignment history (Step 9A section 3's own rule). No snapshot
  // mechanism exists yet (Step 9A explicitly defers it); this event is
  // the only trace of the change until Assignments exist.
  if (reviewPolicyChanged) {
    await writeCampaignEvent({ campaignUid: loaded.campaign.uid, kind: "default_review_policy_changed", actorUserRef: actor!.userRef, metadata: { from: previousReviewPolicy, to: input.defaultReviewPolicy }, requestId });
  }
  return { ok: true, data: await toCampaignDto(result.doc) };
}

// ---- Owner / team ----

const setOwnerTeamInputSchema = z.object({
  ownerUserRef: z.string().min(1).nullable(),
  teamIds: z.array(z.string().min(1)).max(50),
  expectedVersion: z.number().int().min(1),
});
export type SetCampaignOwnerTeamInput = z.input<typeof setOwnerTeamInputSchema>;

export async function setCampaignOwnerTeam(actor: ActorContext | null, campaignRef: unknown, rawInput: unknown, requestId: string): Promise<CampaignsServiceResult<CampaignDto>> {
  const loaded = await loadAuthorizedCampaign(actor, campaignRef, "manage_campaign_ownership");
  if (!loaded.ok) return loaded.error;

  const parsed = setOwnerTeamInputSchema.safeParse(rawInput);
  if (!parsed.success) return campaignsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  let ownerUid: string | null = null;
  if (input.ownerUserRef) {
    const owner = await findActiveUserByRef(input.ownerUserRef);
    if (!owner) return campaignsInvalidInputResult("ownerUserRef does not resolve to a real, active user.");
    ownerUid = owner.uid;
  }

  const result = await runCampaignMutation(loaded.campaign.uid, input.expectedVersion, (current) => ({
    ...current,
    ownerUid,
    teamIds: input.teamIds,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Campaign not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Campaign was changed elsewhere. Reload and try again." };

  await writeCampaignEvent({ campaignUid: loaded.campaign.uid, kind: "owner_team_changed", actorUserRef: actor!.userRef, metadata: { assigned: Boolean(ownerUid), teamCount: input.teamIds.length }, requestId });
  return { ok: true, data: await toCampaignDto(result.doc) };
}

// ---- Resources (bounded ordinary metadata) ----

// Findings #36/#37 (user-decided): the 3 current, real resource types - narrower than the full
// campaignResourceTypeSchema read schema (which also still accepts the 4 legacy values for backward
// compatibility, see types.ts's own comment). UPLOAD is deliberately NOT accepted by this function - it
// has no client-supplied url, only real file bytes; see addCampaignResourceUpload below.
const addResourceInputSchema = z
  .object({
    label: z.string().min(1).max(200),
    type: z.enum(["LINK", "TEXT"]),
    url: z.string().min(1).max(1000).optional(),
    content: z.string().min(1).max(4000).optional(),
    description: z.string().min(1).max(1000).optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict()
  .refine((v) => (v.type === "LINK" ? Boolean(v.url) && !v.content : Boolean(v.content) && !v.url), {
    message: "LINK requires a url (and no content); TEXT requires content (and no url).",
  });
export type AddCampaignResourceInput = z.input<typeof addResourceInputSchema>;

export async function addCampaignResource(actor: ActorContext | null, campaignRef: unknown, rawInput: unknown, requestId: string): Promise<CampaignsServiceResult<CampaignDto>> {
  const loaded = await loadAuthorizedCampaign(actor, campaignRef, "manage_campaign_resources");
  if (!loaded.ok) return loaded.error;

  const parsed = addResourceInputSchema.safeParse(rawInput);
  if (!parsed.success) return campaignsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (loaded.campaign.resources.length >= 50) return campaignsInvalidInputResult("This Campaign already has the maximum number of resources.");

  const now = new Date().toISOString();
  const resourceRef = generateCampaignResourceRef();

  const result = await runCampaignMutation(loaded.campaign.uid, input.expectedVersion, (current) => ({
    ...current,
    resources: [
      ...current.resources,
      // Firestore rejects an explicit `undefined` value outright (never `ignoreUndefinedProperties`,
      // matching this codebase's own strict discipline) - `url` must be OMITTED entirely for a TEXT
      // resource, never written as `url: undefined`. An unconditional `url: input.url` here would create
      // that exact key with an undefined value even when input.url was never supplied.
      { resourceRef, label: input.label, type: input.type, ...(input.url !== undefined ? { url: input.url } : {}), content: input.content ?? null, description: input.description ?? null, addedAt: now, addedByUserRef: actor!.userRef },
    ],
    updatedAt: now,
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Campaign not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Campaign was changed elsewhere. Reload and try again." };

  await writeCampaignEvent({ campaignUid: loaded.campaign.uid, kind: "resource_added", actorUserRef: actor!.userRef, metadata: { resourceRef, label: input.label, type: input.type }, requestId });
  return { ok: true, data: await toCampaignDto(result.doc) };
}

// Findings #36/#37: the UPLOAD path - real file bytes, never a client-supplied url ("no fake
// paste-URL-as-upload behavior"). Uploads through the canonical storage abstraction
// (resource-storage/index.ts's getCampaignResourceStorage - fake in tests, real Drive only with
// explicit opt-in), then appends the resource entry in the SAME mutation, same as every other resource
// type - never a two-step "upload now, hope the metadata write happens later" gap.
const addResourceUploadInputSchema = z
  .object({
    label: z.string().min(1).max(200),
    description: z.string().min(1).max(1000).optional(),
    fileName: z.string().min(1).max(300),
    mimeType: z.string().min(1).max(100),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type AddCampaignResourceUploadInput = z.input<typeof addResourceUploadInputSchema> & { buffer: Buffer };

export async function addCampaignResourceUpload(actor: ActorContext | null, campaignRef: unknown, rawInput: unknown, requestId: string): Promise<CampaignsServiceResult<CampaignDto>> {
  const loaded = await loadAuthorizedCampaign(actor, campaignRef, "manage_campaign_resources");
  if (!loaded.ok) return loaded.error;

  const { buffer, ...rest } = (rawInput ?? {}) as { buffer?: unknown };
  const parsed = addResourceUploadInputSchema.safeParse(rest);
  if (!parsed.success) return campaignsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  if (!(buffer instanceof Buffer) || buffer.byteLength === 0) return campaignsInvalidInputResult("The uploaded file is empty or invalid.");
  if (buffer.byteLength > 15 * 1024 * 1024) return campaignsInvalidInputResult("Files larger than 15 MB are not supported.");
  const input = parsed.data;

  if (!isCampaignResourceMimeType(input.mimeType)) return campaignsInvalidInputResult(`Unsupported file type "${input.mimeType}". Allowed types: ${CAMPAIGN_RESOURCE_ALLOWED_MIME_TYPES.join(", ")}.`);

  if (loaded.campaign.resources.length >= 50) return campaignsInvalidInputResult("This Campaign already has the maximum number of resources.");

  const resourceRef = generateCampaignResourceRef();
  const idempotencyKey = createHash("sha256").update(`${loaded.campaign.campaignRef}|${resourceRef}|${createHash("sha256").update(buffer).digest("hex")}`).digest("hex");

  const resolution = getCampaignResourceStorage();
  if (resolution.state === "NOT_CONFIGURED") return campaignsInvalidInputResult(CAMPAIGN_RESOURCE_UPLOAD_NOT_CONFIGURED_MESSAGE);

  const uploaded = await resolution.storage.store({
    idempotencyKey,
    bytes: new Uint8Array(buffer),
    mimeType: input.mimeType,
    fileName: input.fileName,
    metadata: { campaignRef: loaded.campaign.campaignRef, resourceRef },
  });
  if (!uploaded.ok) return campaignsInvalidInputResult(uploaded.message);

  const now = new Date().toISOString();
  const result = await runCampaignMutation(loaded.campaign.uid, input.expectedVersion, (current) => ({
    ...current,
    resources: [
      ...current.resources,
      { resourceRef, label: input.label, type: "UPLOAD" as const, url: uploaded.data.webViewLink, content: null, description: input.description ?? null, addedAt: now, addedByUserRef: actor!.userRef },
    ],
    updatedAt: now,
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Campaign not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Campaign was changed elsewhere. Reload and try again." };

  await writeCampaignEvent({ campaignUid: loaded.campaign.uid, kind: "resource_added", actorUserRef: actor!.userRef, metadata: { resourceRef, label: input.label, type: "UPLOAD" }, requestId });
  return { ok: true, data: await toCampaignDto(result.doc) };
}

const editResourceInputSchema = z
  .object({
    resourceRef: z.string().min(1),
    label: z.string().min(1).max(200).optional(),
    // Findings #36/#37: narrower than the full read enum - editing a resource's type INTO a legacy
    // value would be equivalent to newly creating one, which is exactly what's no longer allowed.
    // Editing label/description/url/content on an EXISTING legacy resource (type left unspecified)
    // still works fine, unaffected.
    type: z.enum(["LINK", "UPLOAD", "TEXT"]).optional(),
    url: z.string().min(1).max(1000).optional(),
    content: z.string().min(1).max(4000).optional(),
    description: z.string().min(1).max(1000).nullable().optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type EditCampaignResourceInput = z.input<typeof editResourceInputSchema>;

export async function editCampaignResource(actor: ActorContext | null, campaignRef: unknown, rawInput: unknown, requestId: string): Promise<CampaignsServiceResult<CampaignDto>> {
  const loaded = await loadAuthorizedCampaign(actor, campaignRef, "manage_campaign_resources");
  if (!loaded.ok) return loaded.error;

  const parsed = editResourceInputSchema.safeParse(rawInput);
  if (!parsed.success) return campaignsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (!loaded.campaign.resources.some((r) => r.resourceRef === input.resourceRef)) return campaignsInvalidInputResult("Resource not found on this Campaign.");

  const result = await runCampaignMutation(loaded.campaign.uid, input.expectedVersion, (current) => ({
    ...current,
    resources: current.resources.map((r) =>
      r.resourceRef === input.resourceRef
        ? {
            // Same Firestore-undefined-value rule as addCampaignResource above: `{...r}` already
            // correctly preserves r's own url presence/absence (a TEXT resource genuinely has no url
            // key at all), so url is only ever overridden when input.url was explicitly supplied - never
            // an unconditional `url: input.url ?? r.url`, which would write an explicit `url: undefined`
            // key whenever BOTH sides were absent (editing a TEXT resource's description, say).
            ...r,
            label: input.label ?? r.label,
            type: input.type ?? r.type,
            content: input.content !== undefined ? input.content : r.content,
            description: input.description !== undefined ? input.description : r.description,
            ...(input.url !== undefined ? { url: input.url } : {}),
          }
        : r,
    ),
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Campaign not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Campaign was changed elsewhere. Reload and try again." };

  await writeCampaignEvent({ campaignUid: loaded.campaign.uid, kind: "resource_edited", actorUserRef: actor!.userRef, metadata: { resourceRef: input.resourceRef }, requestId });
  return { ok: true, data: await toCampaignDto(result.doc) };
}

const removeResourceInputSchema = z.object({ resourceRef: z.string().min(1), expectedVersion: z.number().int().min(1) }).strict();
export type RemoveCampaignResourceInput = z.input<typeof removeResourceInputSchema>;

export async function removeCampaignResource(actor: ActorContext | null, campaignRef: unknown, rawInput: unknown, requestId: string): Promise<CampaignsServiceResult<CampaignDto>> {
  const loaded = await loadAuthorizedCampaign(actor, campaignRef, "manage_campaign_resources");
  if (!loaded.ok) return loaded.error;

  const parsed = removeResourceInputSchema.safeParse(rawInput);
  if (!parsed.success) return campaignsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (!loaded.campaign.resources.some((r) => r.resourceRef === input.resourceRef)) return campaignsInvalidInputResult("Resource not found on this Campaign.");

  const result = await runCampaignMutation(loaded.campaign.uid, input.expectedVersion, (current) => ({
    ...current,
    resources: current.resources.filter((r) => r.resourceRef !== input.resourceRef),
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Campaign not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Campaign was changed elsewhere. Reload and try again." };

  await writeCampaignEvent({ campaignUid: loaded.campaign.uid, kind: "resource_removed", actorUserRef: actor!.userRef, metadata: { resourceRef: input.resourceRef }, requestId });
  return { ok: true, data: await toCampaignDto(result.doc) };
}

// ---- Readiness ----

export async function getCampaignReadiness(actor: ActorContext | null, campaignRef: unknown): Promise<CampaignsServiceResult<CampaignReadinessResult>> {
  const gate = await requireCampaignsFeatureAccess(actor);
  if (!gate.ok) return campaignsUnauthorizedResult(gate.reason);

  if (typeof campaignRef !== "string" || campaignRef.length === 0) return campaignsInvalidInputResult("Missing campaignRef.");
  const campaign = await getCampaignDocByRef(campaignRef);
  if (!campaign) return { ok: false, code: "not_found", message: "Campaign not found." };

  const scopeCheck = await requireCampaignInScope(actor!, campaign);
  if (!scopeCheck.ok) return campaignsUnauthorizedResult(scopeCheck.reason);

  return { ok: true, data: await evaluateCampaignReadiness(campaign) };
}

// ---- History ----

const listCampaignHistoryInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.object({ createdAt: z.string().min(1), id: z.string().min(1) }).optional(),
});
export type ListCampaignHistoryInput = z.input<typeof listCampaignHistoryInputSchema>;
export type CampaignHistoryEventDto = CampaignEvent & { id: string; actorDisplayName: string | null };

export async function getCampaignHistory(
  actor: ActorContext | null,
  campaignRef: unknown,
  rawInput: unknown,
): Promise<CampaignsServiceResult<{ events: CampaignHistoryEventDto[]; nextCursor: CampaignEventListCursor | null }>> {
  const gate = await requireCampaignsFeatureAccess(actor);
  if (!gate.ok) return campaignsUnauthorizedResult(gate.reason);

  if (typeof campaignRef !== "string" || campaignRef.length === 0) return campaignsInvalidInputResult("Missing campaignRef.");
  const campaign = await getCampaignDocByRef(campaignRef);
  if (!campaign) return { ok: false, code: "not_found", message: "Campaign not found." };

  const scopeCheck = await requireCampaignInScope(actor!, campaign);
  if (!scopeCheck.ok) return campaignsUnauthorizedResult(scopeCheck.reason);

  const parsed = listCampaignHistoryInputSchema.safeParse(rawInput);
  if (!parsed.success) return campaignsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const page = await listCampaignEvents(campaign.uid, { limit: parsed.data.limit ?? 20, cursor: parsed.data.cursor });

  const uniqueActorRefs = [...new Set(page.events.map((e) => e.actorUserRef))];
  const actorEntries = await Promise.all(uniqueActorRefs.map(async (ref) => [ref, (await getUserDocByRef(ref))?.displayName ?? null] as const));
  const actorNames = new Map(actorEntries);

  return { ok: true, data: { events: page.events.map((e) => ({ ...e, actorDisplayName: actorNames.get(e.actorUserRef) ?? null })), nextCursor: page.nextCursor } };
}
