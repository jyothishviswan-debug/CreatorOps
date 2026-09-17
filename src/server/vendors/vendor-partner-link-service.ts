import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { getPartnerDocByRef } from "@/server/partners/firestore";
import { requirePartnerInScope } from "@/server/partners/partners-gate";
import { toPartnerSafeLabelDto } from "@/server/partners/client-dto";
import { toVendorPartnerLinkDto, toVendorSafeLabelDto, type PartnerVendorLinkDto, type VendorPartnerLinkDto, type VendorPartnerLinkWithPartnerDto } from "./client-dto";
import { getVendorDocByRef, getVendorPartnerLinkDocByRef, listVendorPartnerLinkDocsForPartner, listVendorPartnerLinkDocsForVendor, runVendorPartnerLinkMutation, vendorPartnerLinksCollection } from "./firestore";
import { generateVendorPartnerLinkRef } from "./ids";
import { requireVendorInScope, requireVendorsAccess } from "./vendors-gate";
import {
  relationshipTypeSchema,
  vendorPartnerLinkDocSchema,
  vendorsInvalidInputResult,
  vendorsUnauthorizedResult,
  type VendorDoc,
  type VendorPartnerLinkDoc,
  type VendorsServiceResult,
} from "./types";
import { writeVendorEvent } from "./vendor-events";

async function loadAuthorizedVendorForLinks(actor: ActorContext | null, vendorRef: unknown): Promise<{ ok: true; vendor: VendorDoc } | { ok: false; error: VendorsServiceResult<never> }> {
  const gate = await requireVendorsAccess(actor, "manage_vendor_partner_relationships");
  if (!gate.ok) return { ok: false, error: vendorsUnauthorizedResult(gate.reason) };

  if (typeof vendorRef !== "string" || vendorRef.length === 0) return { ok: false, error: vendorsInvalidInputResult("Missing vendorRef.") };
  const vendor = await getVendorDocByRef(vendorRef);
  if (!vendor) return { ok: false, error: { ok: false, code: "not_found", message: "Vendor not found." } };

  const scopeCheck = await requireVendorInScope(actor!, vendor);
  if (!scopeCheck.ok) return { ok: false, error: vendorsUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, vendor };
}

// Loads a link and authorizes it via its OWNING VENDOR's scope - a link
// is always a Vendor-side-managed record (see the module doc comment on
// listLinksForPartner for the deliberately separate Partner-side read
// path, which never reuses this).
async function loadAuthorizedLink(actor: ActorContext | null, linkRef: unknown): Promise<{ ok: true; link: VendorPartnerLinkDoc; vendor: VendorDoc } | { ok: false; error: VendorsServiceResult<never> }> {
  const gate = await requireVendorsAccess(actor, "manage_vendor_partner_relationships");
  if (!gate.ok) return { ok: false, error: vendorsUnauthorizedResult(gate.reason) };

  if (typeof linkRef !== "string" || linkRef.length === 0) return { ok: false, error: vendorsInvalidInputResult("Missing vendorPartnerLinkRef.") };
  const link = await getVendorPartnerLinkDocByRef(linkRef);
  if (!link) return { ok: false, error: { ok: false, code: "not_found", message: "Vendor-Partner relationship not found." } };

  const vendor = await getVendorDocByRef(link.vendorRef);
  if (!vendor) return { ok: false, error: { ok: false, code: "not_found", message: "Owning Vendor not found." } };

  const scopeCheck = await requireVendorInScope(actor!, vendor);
  if (!scopeCheck.ok) return { ok: false, error: vendorsUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, link, vendor };
}

function validateEffectiveDates(effectiveFrom: string, effectiveTo: string | null | undefined): string | null {
  if (effectiveTo && effectiveTo < effectiveFrom) return "effectiveTo cannot be before effectiveFrom.";
  return null;
}

// ---- Create ----

const createLinkInputSchema = z
  .object({
    partnerRef: z.string().min(1),
    relationshipType: relationshipTypeSchema,
    effectiveFrom: z.string().min(1),
    effectiveTo: z.string().min(1).optional(),
  })
  .strict();
export type CreateVendorPartnerLinkInput = z.input<typeof createLinkInputSchema>;

// Company policy: a Partner may have at most ONE ACTIVE Vendor
// relationship at a time - the one Vendor handles that Partner's
// operations and payments in full, never split across simultaneous
// Vendors. Enforced here, not by a Firestore-level constraint: a bounded
// equality-only query (partnerRef==+status=="ACTIVE", no orderBy - no
// composite index required, same discipline as
// checkVendorDependencies'/checkPartnerDependencies' own dependency
// checks) run BEFORE the write, inside the same request. This is a
// policy precondition, not a concurrency-safe uniqueness lock (two
// simultaneous creates could theoretically both pass the check before
// either writes) - acceptable here the same way Partner Account primary-
// account selection already accepts that same narrow window, since a
// human operator, not a high-frequency system, drives this action. The
// Vendor-side (a Vendor may have many simultaneously-active Partners) is
// deliberately unrestricted - only the Partner-side is policy-limited.
// The Partner side is validated for real existence only
// (getPartnerDocByRef) - creating a link does not require the actor to
// independently hold Partner-side scope, only Vendor-side
// manage_vendor_partner_relationships on the owning Vendor.
export async function createVendorPartnerLink(actor: ActorContext | null, vendorRef: unknown, rawInput: unknown, requestId: string): Promise<VendorsServiceResult<VendorPartnerLinkDto>> {
  const loaded = await loadAuthorizedVendorForLinks(actor, vendorRef);
  if (!loaded.ok) return loaded.error;

  const parsed = createLinkInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const dateError = validateEffectiveDates(input.effectiveFrom, input.effectiveTo);
  if (dateError) return vendorsInvalidInputResult(dateError);

  const partner = await getPartnerDocByRef(input.partnerRef);
  if (!partner) return vendorsInvalidInputResult("partnerRef does not resolve to a real Partner.");

  const existingActive = await vendorPartnerLinksCollection().where("partnerRef", "==", partner.partnerRef).where("status", "==", "ACTIVE").limit(1).get();
  if (!existingActive.empty) {
    const existingVendorRef = existingActive.docs[0]!.data().vendorRef as string;
    const existingVendor = existingVendorRef === loaded.vendor.vendorRef ? loaded.vendor : await getVendorDocByRef(existingVendorRef);
    return {
      ok: false,
      code: "conflict",
      message: `This Partner already has an active Vendor relationship (${existingVendor?.displayName ?? "another Vendor"}). End it before linking a new one.`,
    };
  }

  const now = new Date().toISOString();
  const uid = vendorPartnerLinksCollection().doc().id;

  const doc: VendorPartnerLinkDoc = vendorPartnerLinkDocSchema.parse({
    uid,
    vendorPartnerLinkRef: generateVendorPartnerLinkRef(),
    version: 1,
    vendorRef: loaded.vendor.vendorRef,
    partnerRef: partner.partnerRef,
    relationshipType: input.relationshipType,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    status: "ACTIVE",
    createdAt: now,
    createdByUserRef: actor!.userRef,
    updatedAt: now,
    updatedByUserRef: actor!.userRef,
  });
  await vendorPartnerLinksCollection().doc(uid).set(doc);

  await writeVendorEvent({
    vendorUid: loaded.vendor.uid,
    kind: "link_created",
    actorUserRef: actor!.userRef,
    metadata: { partnerRef: partner.partnerRef, relationshipType: input.relationshipType },
    requestId,
  });

  return { ok: true, data: toVendorPartnerLinkDto(doc) };
}

// ---- Edit safe metadata ----

const editLinkInputSchema = z
  .object({
    relationshipType: relationshipTypeSchema.optional(),
    effectiveFrom: z.string().min(1).optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type EditVendorPartnerLinkInput = z.input<typeof editLinkInputSchema>;

export async function editVendorPartnerLink(actor: ActorContext | null, linkRef: unknown, rawInput: unknown, requestId: string): Promise<VendorsServiceResult<VendorPartnerLinkDto>> {
  const loaded = await loadAuthorizedLink(actor, linkRef);
  if (!loaded.ok) return loaded.error;

  const parsed = editLinkInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const effectiveFrom = input.effectiveFrom ?? loaded.link.effectiveFrom;
  const dateError = validateEffectiveDates(effectiveFrom, loaded.link.effectiveTo);
  if (dateError) return vendorsInvalidInputResult(dateError);

  const result = await runVendorPartnerLinkMutation(loaded.link.uid, input.expectedVersion, (current) => ({
    ...current,
    relationshipType: input.relationshipType ?? current.relationshipType,
    effectiveFrom,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Vendor-Partner relationship not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This relationship was changed elsewhere. Reload and try again." };

  await writeVendorEvent({ vendorUid: loaded.vendor.uid, kind: "link_edited", actorUserRef: actor!.userRef, metadata: { vendorPartnerLinkRef: loaded.link.vendorPartnerLinkRef, partnerRef: loaded.link.partnerRef }, requestId });
  return { ok: true, data: toVendorPartnerLinkDto(result.doc) };
}

// ---- End relationship ----

const endLinkInputSchema = z.object({ effectiveTo: z.string().min(1), expectedVersion: z.number().int().min(1) });
export type EndVendorPartnerLinkInput = z.input<typeof endLinkInputSchema>;

// Never a hard delete - the row is preserved exactly, only status/
// effectiveTo change. Historical Agreement/Invoice/Payment/tax/Discovery
// provenance that referenced this relationship is never rewritten by
// this (this service never touches any Finance record, which doesn't
// exist yet - see Step 8A section 12).
export async function endVendorPartnerLink(actor: ActorContext | null, linkRef: unknown, rawInput: unknown, requestId: string): Promise<VendorsServiceResult<VendorPartnerLinkDto>> {
  const loaded = await loadAuthorizedLink(actor, linkRef);
  if (!loaded.ok) return loaded.error;

  const parsed = endLinkInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (loaded.link.status === "ENDED") return vendorsInvalidInputResult("This relationship has already ended.");

  const dateError = validateEffectiveDates(loaded.link.effectiveFrom, input.effectiveTo);
  if (dateError) return vendorsInvalidInputResult(dateError);

  const result = await runVendorPartnerLinkMutation(loaded.link.uid, input.expectedVersion, (current) => ({
    ...current,
    status: "ENDED",
    effectiveTo: input.effectiveTo,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Vendor-Partner relationship not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This relationship was changed elsewhere. Reload and try again." };

  await writeVendorEvent({ vendorUid: loaded.vendor.uid, kind: "link_ended", actorUserRef: actor!.userRef, metadata: { vendorPartnerLinkRef: loaded.link.vendorPartnerLinkRef, partnerRef: loaded.link.partnerRef, effectiveTo: input.effectiveTo }, requestId });
  return { ok: true, data: toVendorPartnerLinkDto(result.doc) };
}

// ---- Restore / reopen ----

const restoreLinkInputSchema = z.object({ expectedVersion: z.number().int().min(1) });
export type RestoreVendorPartnerLinkInput = z.input<typeof restoreLinkInputSchema>;

// Reopens an ENDED relationship - clears effectiveTo (the relationship is
// ongoing again) while the fact that it was once ended stays permanently
// in the append-only event history (the earlier link_ended event is
// never erased or rewritten), same history-preserving discipline as
// Partner/Vendor status restore.
export async function restoreVendorPartnerLink(actor: ActorContext | null, linkRef: unknown, rawInput: unknown, requestId: string): Promise<VendorsServiceResult<VendorPartnerLinkDto>> {
  const loaded = await loadAuthorizedLink(actor, linkRef);
  if (!loaded.ok) return loaded.error;

  const parsed = restoreLinkInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (loaded.link.status !== "ENDED") return vendorsInvalidInputResult("Only an ended relationship can be restored.");

  const result = await runVendorPartnerLinkMutation(loaded.link.uid, input.expectedVersion, (current) => ({
    ...current,
    status: "ACTIVE",
    effectiveTo: null,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Vendor-Partner relationship not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This relationship was changed elsewhere. Reload and try again." };

  await writeVendorEvent({ vendorUid: loaded.vendor.uid, kind: "link_restored", actorUserRef: actor!.userRef, metadata: { vendorPartnerLinkRef: loaded.link.vendorPartnerLinkRef, partnerRef: loaded.link.partnerRef }, requestId });
  return { ok: true, data: toVendorPartnerLinkDto(result.doc) };
}

// ---- Read: Vendor side ----

// Resolves each link's safe Partner label (name/regionIds only, never
// the full PartnerDto) via the existing getPartnerDocByRef, batched so
// each distinct partnerRef is read at most once regardless of link
// count - mirrors listVendorLinksForPartner's own Vendor-label
// resolution exactly, in the reverse direction. Deliberately never
// routed through Partner-side scope: a Vendor-scoped actor managing this
// Vendor's own relationships must see every linked Partner's safe label
// even without independently holding Partner-side scope for it (Step 8A
// section 7's scope-escalation-bridge rule cuts both ways).
export async function listLinksForVendor(actor: ActorContext | null, vendorRef: unknown): Promise<VendorsServiceResult<VendorPartnerLinkWithPartnerDto[]>> {
  const gate = await requireVendorsAccess(actor, "manage_vendor_partner_relationships");
  // Reads use feature access, not a mutation action - but this function
  // is only ever called from the Vendor's own detail surface, which
  // already requires real Vendor access to reach; kept consistent with
  // requireVendorsFeatureAccess for a read would also be reasonable, but
  // gating on the same action as writes here is a deliberate, narrower
  // choice since relationship rows are more operationally sensitive than
  // an ordinary Vendor profile view.
  if (!gate.ok) return vendorsUnauthorizedResult(gate.reason);

  if (typeof vendorRef !== "string" || vendorRef.length === 0) return vendorsInvalidInputResult("Missing vendorRef.");
  const vendor = await getVendorDocByRef(vendorRef);
  if (!vendor) return { ok: false, code: "not_found", message: "Vendor not found." };

  const scopeCheck = await requireVendorInScope(actor!, vendor);
  if (!scopeCheck.ok) return vendorsUnauthorizedResult(scopeCheck.reason);

  const links = await listVendorPartnerLinkDocsForVendor(vendor.vendorRef);

  const uniquePartnerRefs = [...new Set(links.map((l) => l.partnerRef))];
  const partnerEntries = await Promise.all(uniquePartnerRefs.map(async (ref) => [ref, await getPartnerDocByRef(ref)] as const));
  const partnersByRef = new Map(partnerEntries);

  const result: VendorPartnerLinkWithPartnerDto[] = [];
  for (const link of links) {
    const partner = partnersByRef.get(link.partnerRef);
    if (!partner) continue; // A dangling link (its Partner was somehow removed) is simply omitted, never fabricated.
    result.push({ ...toVendorPartnerLinkDto(link), partner: toPartnerSafeLabelDto(partner) });
  }
  return { ok: true, data: result };
}

// ---- Read: Partner side (Step 8A section 10) ----

// The safe Partner-side relationship query. Gated ENTIRELY by the
// PARTNER's own scope (requirePartnerInScope, reused directly from
// Partners' own module) - never Vendor scope. Returns only this one
// Partner's own link rows, each with a safe minimal Vendor label
// (name/type/status) resolved individually - never the Vendor's other
// links, never anything that would require Vendor-side access. This is
// the one deliberate exception to "link reads require Vendor scope"
// above, and it is exactly the exception Step 8A section 10 asks for.
export async function listVendorLinksForPartner(actor: ActorContext | null, partnerRef: unknown): Promise<VendorsServiceResult<PartnerVendorLinkDto[]>> {
  if (!actor) return vendorsUnauthorizedResult("not_authenticated");
  if (typeof partnerRef !== "string" || partnerRef.length === 0) return vendorsInvalidInputResult("Missing partnerRef.");

  const partner = await getPartnerDocByRef(partnerRef);
  if (!partner) return { ok: false, code: "not_found", message: "Partner not found." };

  const scopeCheck = await requirePartnerInScope(actor, partner);
  if (!scopeCheck.ok) return vendorsUnauthorizedResult(scopeCheck.reason);

  const links = await listVendorPartnerLinkDocsForPartner(partner.partnerRef);

  const uniqueVendorRefs = [...new Set(links.map((l) => l.vendorRef))];
  const vendorEntries = await Promise.all(uniqueVendorRefs.map(async (ref) => [ref, await getVendorDocByRef(ref)] as const));
  const vendorsByRef = new Map(vendorEntries);

  const result: PartnerVendorLinkDto[] = [];
  for (const link of links) {
    const vendor = vendorsByRef.get(link.vendorRef);
    if (!vendor) continue; // A dangling link (its Vendor was somehow removed) is simply omitted, never fabricated.
    result.push({ ...toVendorPartnerLinkDto(link), vendor: toVendorSafeLabelDto(vendor) });
  }
  return { ok: true, data: result };
}
