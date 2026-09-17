import { z } from "zod";

import { getUserDocByRef } from "@/server/authz/firestore";
import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { toVendorDto, toVendorDtos, type VendorDto } from "./client-dto";
import { getVendorDocByRef, listVendorDocs, vendorsCollection, runVendorMutation, type VendorListCursor } from "./firestore";
import { generateVendorRef } from "./ids";
import { requireVendorInScope, requireVendorsAccess, requireVendorsFeatureAccess } from "./vendors-gate";
import { listVendorEvents, writeVendorEvent, type VendorEventListCursor } from "./vendor-events";
import { vendorDocSchema, vendorTypeSchema, vendorsInvalidInputResult, vendorsUnauthorizedResult, type VendorDoc, type VendorEvent, type VendorsServiceResult } from "./types";

async function findActiveUserByRef(userRef: string): Promise<{ uid: string } | null> {
  const doc = await getUserDocByRef(userRef);
  if (!doc || !doc.active) return null;
  return { uid: doc.uid };
}

async function loadAuthorizedVendor(actor: ActorContext | null, vendorRef: unknown, action: Parameters<typeof requireVendorsAccess>[1]): Promise<{ ok: true; vendor: VendorDoc } | { ok: false; error: VendorsServiceResult<never> }> {
  const gate = await requireVendorsAccess(actor, action);
  if (!gate.ok) return { ok: false, error: vendorsUnauthorizedResult(gate.reason) };

  if (typeof vendorRef !== "string" || vendorRef.length === 0) return { ok: false, error: vendorsInvalidInputResult("Missing vendorRef.") };
  const vendor = await getVendorDocByRef(vendorRef);
  if (!vendor) return { ok: false, error: { ok: false, code: "not_found", message: "Vendor not found." } };

  const scopeCheck = await requireVendorInScope(actor!, vendor);
  if (!scopeCheck.ok) return { ok: false, error: vendorsUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, vendor };
}

// ---- Create ----

const businessReferenceSchema = z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(300) });

const createVendorInputSchema = z
  .object({
    displayName: z.string().min(1).max(200),
    legalName: z.string().min(1).max(200).optional(),
    vendorType: vendorTypeSchema,
    email: z.string().min(1).max(300).optional(),
    phone: z.string().min(1).max(40).optional(),
    businessReferences: z.array(businessReferenceSchema).max(20).optional(),
    regionIds: z.array(z.string().min(1)).max(50).optional(),
    ownerUserRef: z.string().min(1).optional(),
    teamIds: z.array(z.string().min(1)).max(50).optional(),
  })
  .strict();
export type CreateVendorInput = z.input<typeof createVendorInputSchema>;

export async function createVendor(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<VendorsServiceResult<VendorDto>> {
  const gate = await requireVendorsAccess(actor, "create");
  if (!gate.ok) return vendorsUnauthorizedResult(gate.reason);

  const parsed = createVendorInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  let ownerUid: string | null = null;
  if (input.ownerUserRef) {
    const owner = await findActiveUserByRef(input.ownerUserRef);
    if (!owner) return vendorsInvalidInputResult("ownerUserRef does not resolve to a real, active user.");
    ownerUid = owner.uid;
  }

  const now = new Date().toISOString();
  const uid = vendorsCollection().doc().id;

  const doc: VendorDoc = vendorDocSchema.parse({
    uid,
    vendorRef: generateVendorRef(),
    version: 1,
    displayName: input.displayName,
    displayNameLower: input.displayName.toLowerCase(),
    legalName: input.legalName ?? null,
    vendorType: input.vendorType,
    status: "ACTIVE",
    previousStatus: null,
    statusReason: null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    businessReferences: input.businessReferences ?? [],
    regionIds: input.regionIds ?? [],
    ownerUid,
    teamIds: input.teamIds ?? [],
    createdAt: now,
    createdByUserRef: actor!.userRef,
    updatedAt: now,
    updatedByUserRef: actor!.userRef,
  });

  await vendorsCollection().doc(uid).set(doc);
  await writeVendorEvent({ vendorUid: uid, kind: "created", actorUserRef: actor!.userRef, metadata: { displayName: doc.displayName, vendorType: doc.vendorType }, requestId });

  return { ok: true, data: await toVendorDto(doc) };
}

// ---- Read ----

// Reads are gated by Feature Access only (never a specific mutation
// action), matching Partners' own getPartner/list pattern -
// loadAuthorizedVendor (which requires a real ActionId) is only used by
// the mutation paths below.
export async function getVendor(actor: ActorContext | null, vendorRef: unknown): Promise<VendorsServiceResult<VendorDto>> {
  const gate = await requireVendorsFeatureAccess(actor);
  if (!gate.ok) return vendorsUnauthorizedResult(gate.reason);

  if (typeof vendorRef !== "string" || vendorRef.length === 0) return vendorsInvalidInputResult("Missing vendorRef.");
  const vendor = await getVendorDocByRef(vendorRef);
  if (!vendor) return { ok: false, code: "not_found", message: "Vendor not found." };

  const scopeCheck = await requireVendorInScope(actor!, vendor);
  if (!scopeCheck.ok) return vendorsUnauthorizedResult(scopeCheck.reason);

  return { ok: true, data: await toVendorDto(vendor) };
}

export type ListVendorsInput = {
  limit?: number;
  cursor?: VendorListCursor;
  status?: string;
  displayNamePrefix?: string;
  region?: string | string[];
  vendorType?: string;
  // Resolved to the actor's own uid server-side - the browser never
  // supplies a raw uid, only the boolean intent (same idiom as Partners'
  // listPartners assignedToMe).
  assignedToMe?: boolean;
};

export async function listVendors(actor: ActorContext | null, input: ListVendorsInput): Promise<VendorsServiceResult<{ vendors: VendorDto[]; nextCursor: VendorListCursor | null }>> {
  const gate = await requireVendorsFeatureAccess(actor);
  if (!gate.ok) return vendorsUnauthorizedResult(gate.reason);

  const grants = await getActorScopeGrants(actor!);
  const page = await listVendorDocs({
    limit: input.limit ?? 20,
    cursor: input.cursor,
    actorUid: actor!.uid,
    grants,
    hasGlobal: hasGlobalScope(grants),
    status: input.status,
    displayNamePrefix: input.displayNamePrefix?.toLowerCase(),
    region: input.region,
    vendorType: input.vendorType,
    ownerUid: input.assignedToMe ? actor!.uid : undefined,
  });

  return { ok: true, data: { vendors: await toVendorDtos(page.vendors), nextCursor: page.nextCursor } };
}

// ---- Edit ordinary fields ----

const editVendorInputSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    legalName: z.string().min(1).max(200).nullable().optional(),
    vendorType: vendorTypeSchema.optional(),
    email: z.string().min(1).max(300).nullable().optional(),
    phone: z.string().min(1).max(40).nullable().optional(),
    businessReferences: z.array(businessReferenceSchema).max(20).optional(),
    regionIds: z.array(z.string().min(1)).max(50).optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type EditVendorInput = z.input<typeof editVendorInputSchema>;

export async function editVendor(actor: ActorContext | null, vendorRef: unknown, rawInput: unknown, requestId: string): Promise<VendorsServiceResult<VendorDto>> {
  const loaded = await loadAuthorizedVendor(actor, vendorRef, "edit");
  if (!loaded.ok) return loaded.error;

  const parsed = editVendorInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const result = await runVendorMutation(loaded.vendor.uid, input.expectedVersion, (current) => ({
    ...current,
    displayName: input.displayName ?? current.displayName,
    displayNameLower: input.displayName ? input.displayName.toLowerCase() : current.displayNameLower,
    legalName: input.legalName !== undefined ? input.legalName : current.legalName,
    vendorType: input.vendorType ?? current.vendorType,
    email: input.email !== undefined ? input.email : current.email,
    phone: input.phone !== undefined ? input.phone : current.phone,
    businessReferences: input.businessReferences ?? current.businessReferences,
    regionIds: input.regionIds ?? current.regionIds,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Vendor not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Vendor was changed elsewhere. Reload and try again." };

  await writeVendorEvent({ vendorUid: loaded.vendor.uid, kind: "edited", actorUserRef: actor!.userRef, metadata: { fields: Object.keys(input).filter((k) => k !== "expectedVersion") }, requestId });
  return { ok: true, data: await toVendorDto(result.doc) };
}

// ---- Owner / team ----

const setOwnerTeamInputSchema = z.object({
  ownerUserRef: z.string().min(1).nullable(),
  teamIds: z.array(z.string().min(1)).max(50),
  expectedVersion: z.number().int().min(1),
});
export type SetVendorOwnerTeamInput = z.input<typeof setOwnerTeamInputSchema>;

export async function setVendorOwnerTeam(actor: ActorContext | null, vendorRef: unknown, rawInput: unknown, requestId: string): Promise<VendorsServiceResult<VendorDto>> {
  const loaded = await loadAuthorizedVendor(actor, vendorRef, "manage_vendor_ownership");
  if (!loaded.ok) return loaded.error;

  const parsed = setOwnerTeamInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  let ownerUid: string | null = null;
  if (input.ownerUserRef) {
    const owner = await findActiveUserByRef(input.ownerUserRef);
    if (!owner) return vendorsInvalidInputResult("ownerUserRef does not resolve to a real, active user.");
    ownerUid = owner.uid;
  }

  const result = await runVendorMutation(loaded.vendor.uid, input.expectedVersion, (current) => ({
    ...current,
    ownerUid,
    teamIds: input.teamIds,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Vendor not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Vendor was changed elsewhere. Reload and try again." };

  await writeVendorEvent({ vendorUid: loaded.vendor.uid, kind: "owner_team_changed", actorUserRef: actor!.userRef, metadata: { assigned: Boolean(ownerUid), teamCount: input.teamIds.length }, requestId });
  return { ok: true, data: await toVendorDto(result.doc) };
}

// ---- Lifecycle (ACTIVE <-> INACTIVE, ordinary reversible toggle) ----

const setStatusInputSchema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE"]),
  expectedVersion: z.number().int().min(1),
});
export type SetVendorStatusInput = z.input<typeof setStatusInputSchema>;

export async function setVendorStatus(actor: ActorContext | null, vendorRef: unknown, rawInput: unknown, requestId: string): Promise<VendorsServiceResult<VendorDto>> {
  const loaded = await loadAuthorizedVendor(actor, vendorRef, "transition_vendor_lifecycle");
  if (!loaded.ok) return loaded.error;

  const parsed = setStatusInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (loaded.vendor.status !== "ACTIVE" && loaded.vendor.status !== "INACTIVE") {
    return vendorsInvalidInputResult(`Cannot set status directly while ${loaded.vendor.status} - restore the Vendor first.`);
  }

  const result = await runVendorMutation(loaded.vendor.uid, input.expectedVersion, (current) => ({
    ...current,
    status: input.status,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Vendor not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Vendor was changed elsewhere. Reload and try again." };

  await writeVendorEvent({ vendorUid: loaded.vendor.uid, kind: "status_changed", actorUserRef: actor!.userRef, metadata: { to: input.status }, requestId });
  return { ok: true, data: await toVendorDto(result.doc) };
}

// ---- History ----

const listVendorHistoryInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.object({ createdAt: z.string().min(1), id: z.string().min(1) }).optional(),
});
export type ListVendorHistoryInput = z.input<typeof listVendorHistoryInputSchema>;
export type VendorHistoryEventDto = VendorEvent & { id: string; actorDisplayName: string | null };

export async function getVendorHistory(
  actor: ActorContext | null,
  vendorRef: unknown,
  rawInput: unknown,
): Promise<VendorsServiceResult<{ events: VendorHistoryEventDto[]; nextCursor: VendorEventListCursor | null }>> {
  const gate = await requireVendorsFeatureAccess(actor);
  if (!gate.ok) return vendorsUnauthorizedResult(gate.reason);

  if (typeof vendorRef !== "string" || vendorRef.length === 0) return vendorsInvalidInputResult("Missing vendorRef.");
  const vendor = await getVendorDocByRef(vendorRef);
  if (!vendor) return { ok: false, code: "not_found", message: "Vendor not found." };

  const scopeCheck = await requireVendorInScope(actor!, vendor);
  if (!scopeCheck.ok) return vendorsUnauthorizedResult(scopeCheck.reason);

  const parsed = listVendorHistoryInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const page = await listVendorEvents(vendor.uid, { limit: parsed.data.limit ?? 20, cursor: parsed.data.cursor });

  // Resolve each distinct actor's display name once - same idiom as
  // Partners' own getPartnerHistory.
  const uniqueActorRefs = [...new Set(page.events.map((e) => e.actorUserRef))];
  const actorEntries = await Promise.all(uniqueActorRefs.map(async (ref) => [ref, (await getUserDocByRef(ref))?.displayName ?? null] as const));
  const actorNames = new Map(actorEntries);

  return { ok: true, data: { events: page.events.map((e) => ({ ...e, actorDisplayName: actorNames.get(e.actorUserRef) ?? null })), nextCursor: page.nextCursor } };
}
