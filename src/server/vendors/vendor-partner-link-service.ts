import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import type { ActorContext } from "@/server/authz/types";
import { getPartnerDocByRef } from "@/server/partners/firestore";
import { requirePartnerInScope } from "@/server/partners/partners-gate";
import { toPartnerSafeLabelDto } from "@/server/partners/client-dto";
import { toVendorPartnerLinkDto, toVendorSafeLabelDto, type PartnerVendorLinkDto, type VendorPartnerLinkDto, type VendorPartnerLinkWithPartnerDto } from "./client-dto";
import {
  getVendorDocByRef,
  getVendorPartnerLinkDocByRef,
  listVendorPartnerLinkDocsForPartner,
  listVendorPartnerLinkDocsForVendor,
  runVendorPartnerLinkMutation,
  vendorPartnerActiveClaimsCollection,
  vendorPartnerLinksCollection,
} from "./firestore";
import { generateVendorPartnerLinkRef } from "./ids";
import { requireVendorInScope, requireVendorsAccess, requireVendorsFeatureAccess } from "./vendors-gate";
import {
  relationshipTypeSchema,
  vendorPartnerActiveClaimDocSchema,
  vendorPartnerLinkDocSchema,
  vendorsInvalidInputResult,
  vendorsUnauthorizedResult,
  type VendorDoc,
  type VendorPartnerActiveClaimDoc,
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
    payeeRole: z.boolean().optional(),
    effectiveFrom: z.string().min(1),
    effectiveTo: z.string().min(1).optional(),
  })
  .strict();
export type CreateVendorPartnerLinkInput = z.input<typeof createLinkInputSchema>;

async function conflictMessageFor(actingVendor: VendorDoc, claim: VendorPartnerActiveClaimDoc): Promise<string> {
  const existingVendor = claim.vendorRef === actingVendor.vendorRef ? actingVendor : await getVendorDocByRef(claim.vendorRef);
  return `This Partner already has an active Vendor relationship (${existingVendor?.displayName ?? "another Vendor"}). End it before linking a new one.`;
}

type CreateLinkTxResult =
  | { kind: "created"; doc: VendorPartnerLinkDoc }
  | { kind: "idempotent"; doc: VendorPartnerLinkDoc }
  | { kind: "conflict"; claim: VendorPartnerActiveClaimDoc };

// Step 8B.1 REVISED section 1/2: company policy - a Partner may have at
// most ONE ACTIVE Vendor relationship at a time (the one Vendor handles
// that Partner's operations and payments in full, never split across
// simultaneous Vendors) - and that invariant must be race-safe, not just
// a pre-query precondition. Enforced via vendorPartnerActiveClaims: a
// deterministic claim doc keyed by partnerRef whose EXISTENCE is the
// lock. ALL transaction reads (the claim, and, on an idempotent-retry
// path, the existing link) happen before the ONLY writes (the new link +
// the new claim, both staged together) - the hard Firestore transaction
// requirement. If two concurrent creates race for the same Partner, the
// Admin SDK's automatic optimistic-transaction retry guarantees exactly
// one observes an empty claim and wins; the loser's retried attempt
// re-reads the now-existing claim and correctly reports conflict - no
// separate locking primitive needed beyond the transaction itself. The
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

  const db = getAdminFirestore();
  const claimRef = vendorPartnerActiveClaimsCollection().doc(partner.partnerRef);
  const newLinkRef = vendorPartnerLinksCollection().doc();
  const now = new Date().toISOString();

  const doc: VendorPartnerLinkDoc = vendorPartnerLinkDocSchema.parse({
    uid: newLinkRef.id,
    vendorPartnerLinkRef: generateVendorPartnerLinkRef(),
    version: 1,
    vendorRef: loaded.vendor.vendorRef,
    partnerRef: partner.partnerRef,
    relationshipType: input.relationshipType,
    payeeRole: input.payeeRole ?? false,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    status: "ACTIVE",
    createdAt: now,
    createdByUserRef: actor!.userRef,
    updatedAt: now,
    updatedByUserRef: actor!.userRef,
  });

  const txResult = await db.runTransaction<CreateLinkTxResult>(async (tx) => {
    const claimSnap = await tx.get(claimRef);
    if (claimSnap.exists) {
      const claim = vendorPartnerActiveClaimDocSchema.safeParse(claimSnap.data());
      // A same-Vendor retry (e.g. a double-submit/network retry) is a
      // supported idempotent path: the desired end state ("this
      // Partner's active Vendor is X") is already true, so read and
      // return the existing link rather than erroring. All reads still
      // precede all writes - this branch performs no writes at all.
      if (claim.success && claim.data.vendorRef === loaded.vendor.vendorRef) {
        const existingLinkSnap = await tx.get(vendorPartnerLinksCollection().doc(claim.data.vendorPartnerLinkUid));
        const existingLink = existingLinkSnap.exists ? vendorPartnerLinkDocSchema.safeParse(existingLinkSnap.data()) : null;
        if (existingLink?.success) return { kind: "idempotent", doc: existingLink.data };
      }
      return { kind: "conflict", claim: claim.success ? claim.data : { partnerRef: partner.partnerRef, vendorRef: "unknown", vendorPartnerLinkRef: "unknown", vendorPartnerLinkUid: "unknown", claimedAt: now } };
    }

    tx.set(newLinkRef, doc);
    tx.set(claimRef, vendorPartnerActiveClaimDocSchema.parse({ partnerRef: partner.partnerRef, vendorRef: loaded.vendor.vendorRef, vendorPartnerLinkRef: doc.vendorPartnerLinkRef, vendorPartnerLinkUid: doc.uid, claimedAt: now }));
    return { kind: "created", doc };
  });

  if (txResult.kind === "conflict") return { ok: false, code: "conflict", message: await conflictMessageFor(loaded.vendor, txResult.claim) };

  if (txResult.kind === "created") {
    await writeVendorEvent({
      vendorUid: loaded.vendor.uid,
      kind: "link_created",
      actorUserRef: actor!.userRef,
      metadata: { partnerRef: partner.partnerRef, relationshipType: input.relationshipType },
      requestId,
    });
  }

  return { ok: true, data: toVendorPartnerLinkDto(txResult.doc) };
}

// ---- Edit safe metadata ----

const editLinkInputSchema = z
  .object({
    relationshipType: relationshipTypeSchema.optional(),
    payeeRole: z.boolean().optional(),
    effectiveFrom: z.string().min(1).optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type EditVendorPartnerLinkInput = z.input<typeof editLinkInputSchema>;

// Metadata-only - never touches status or the active-Vendor claim, so it
// can never create a second active relationship (Step 8B.1 REVISED
// section 1's "Editing" requirement) - the generic optimistic-version
// mutation primitive is sufficient here.
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
    payeeRole: input.payeeRole ?? current.payeeRole,
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

type EndLinkTxResult = { kind: "ok"; doc: VendorPartnerLinkDoc } | { kind: "stale" } | { kind: "not_found" } | { kind: "already_ended" };

// Never a hard delete - the row is preserved exactly, only status/
// effectiveTo change. Historical Agreement/Invoice/Payment/tax/Discovery
// provenance that referenced this relationship is never rewritten by
// this (this service never touches any Finance record, which doesn't
// exist yet - see Step 8A section 12). Also atomically releases this
// Partner's vendorPartnerActiveClaims doc in the SAME transaction as the
// status write - this is what frees the Partner up for a new active
// Vendor link (Step 8B.1 REVISED section 1's "Changing Vendor" two-step
// workflow's first step). The claim is only deleted when it still points
// at THIS exact link (defensive - it always should, since the invariant
// guarantees at most one ACTIVE link/claim pair per Partner at a time);
// otherwise ending this link still succeeds, the mismatched claim is
// simply left alone rather than risking freeing a different relationship.
export async function endVendorPartnerLink(actor: ActorContext | null, linkRef: unknown, rawInput: unknown, requestId: string): Promise<VendorsServiceResult<VendorPartnerLinkDto>> {
  const loaded = await loadAuthorizedLink(actor, linkRef);
  if (!loaded.ok) return loaded.error;

  const parsed = endLinkInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const dateError = validateEffectiveDates(loaded.link.effectiveFrom, input.effectiveTo);
  if (dateError) return vendorsInvalidInputResult(dateError);

  const db = getAdminFirestore();
  const linkDocRef = vendorPartnerLinksCollection().doc(loaded.link.uid);
  const claimRef = vendorPartnerActiveClaimsCollection().doc(loaded.link.partnerRef);

  const txResult = await db.runTransaction<EndLinkTxResult>(async (tx) => {
    const linkSnap = await tx.get(linkDocRef);
    if (!linkSnap.exists) return { kind: "not_found" };
    const parsedLink = vendorPartnerLinkDocSchema.safeParse(linkSnap.data());
    if (!parsedLink.success) return { kind: "not_found" };
    const current = parsedLink.data;

    if (current.version !== input.expectedVersion) return { kind: "stale" };
    if (current.status === "ENDED") return { kind: "already_ended" };

    const claimSnap = await tx.get(claimRef);

    const next: VendorPartnerLinkDoc = {
      ...current,
      status: "ENDED",
      effectiveTo: input.effectiveTo,
      updatedAt: new Date().toISOString(),
      updatedByUserRef: actor!.userRef,
      version: current.version + 1,
    };
    tx.set(linkDocRef, next);

    if (claimSnap.exists) {
      const claim = vendorPartnerActiveClaimDocSchema.safeParse(claimSnap.data());
      if (claim.success && claim.data.vendorPartnerLinkUid === current.uid) tx.delete(claimRef);
    }

    return { kind: "ok", doc: next };
  });

  if (txResult.kind === "not_found") return { ok: false, code: "not_found", message: "Vendor-Partner relationship not found." };
  if (txResult.kind === "stale") return { ok: false, code: "stale_write", message: "This relationship was changed elsewhere. Reload and try again." };
  if (txResult.kind === "already_ended") return vendorsInvalidInputResult("This relationship has already ended.");

  await writeVendorEvent({ vendorUid: loaded.vendor.uid, kind: "link_ended", actorUserRef: actor!.userRef, metadata: { vendorPartnerLinkRef: loaded.link.vendorPartnerLinkRef, partnerRef: loaded.link.partnerRef, effectiveTo: input.effectiveTo }, requestId });
  return { ok: true, data: toVendorPartnerLinkDto(txResult.doc) };
}

// ---- Restore / reopen ----

const restoreLinkInputSchema = z.object({ expectedVersion: z.number().int().min(1) });
export type RestoreVendorPartnerLinkInput = z.input<typeof restoreLinkInputSchema>;

type RestoreLinkTxResult = { kind: "ok"; doc: VendorPartnerLinkDoc } | { kind: "stale" } | { kind: "not_found" } | { kind: "not_ended" } | { kind: "conflict"; claim: VendorPartnerActiveClaimDoc };

// Reopens an ENDED relationship - clears effectiveTo (the relationship is
// ongoing again) while the fact that it was once ended stays permanently
// in the append-only event history (the earlier link_ended event is
// never erased or rewritten), same history-preserving discipline as
// Partner/Vendor status restore. Step 8B.1 REVISED section 1/3: allowed
// ONLY when the Partner currently has no other active Vendor - checked
// transactionally against the same vendorPartnerActiveClaims doc
// createVendorPartnerLink guards, so this can never race past a
// concurrent create/restore for the same Partner either. If a claim
// exists (any active Vendor, including a different one), restore fails
// safely with conflict rather than silently creating a second active
// relationship.
export async function restoreVendorPartnerLink(actor: ActorContext | null, linkRef: unknown, rawInput: unknown, requestId: string): Promise<VendorsServiceResult<VendorPartnerLinkDto>> {
  const loaded = await loadAuthorizedLink(actor, linkRef);
  if (!loaded.ok) return loaded.error;

  const parsed = restoreLinkInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const db = getAdminFirestore();
  const linkDocRef = vendorPartnerLinksCollection().doc(loaded.link.uid);
  const claimRef = vendorPartnerActiveClaimsCollection().doc(loaded.link.partnerRef);

  const txResult = await db.runTransaction<RestoreLinkTxResult>(async (tx) => {
    const linkSnap = await tx.get(linkDocRef);
    if (!linkSnap.exists) return { kind: "not_found" };
    const parsedLink = vendorPartnerLinkDocSchema.safeParse(linkSnap.data());
    if (!parsedLink.success) return { kind: "not_found" };
    const current = parsedLink.data;

    if (current.version !== input.expectedVersion) return { kind: "stale" };
    if (current.status !== "ENDED") return { kind: "not_ended" };

    const claimSnap = await tx.get(claimRef);
    if (claimSnap.exists) {
      const claim = vendorPartnerActiveClaimDocSchema.safeParse(claimSnap.data());
      return { kind: "conflict", claim: claim.success ? claim.data : { partnerRef: current.partnerRef, vendorRef: "unknown", vendorPartnerLinkRef: "unknown", vendorPartnerLinkUid: "unknown", claimedAt: current.updatedAt } };
    }

    const next: VendorPartnerLinkDoc = { ...current, status: "ACTIVE", effectiveTo: null, updatedAt: new Date().toISOString(), updatedByUserRef: actor!.userRef, version: current.version + 1 };
    tx.set(linkDocRef, next);
    tx.set(claimRef, vendorPartnerActiveClaimDocSchema.parse({ partnerRef: current.partnerRef, vendorRef: current.vendorRef, vendorPartnerLinkRef: current.vendorPartnerLinkRef, vendorPartnerLinkUid: current.uid, claimedAt: next.updatedAt }));
    return { kind: "ok", doc: next };
  });

  if (txResult.kind === "not_found") return { ok: false, code: "not_found", message: "Vendor-Partner relationship not found." };
  if (txResult.kind === "stale") return { ok: false, code: "stale_write", message: "This relationship was changed elsewhere. Reload and try again." };
  if (txResult.kind === "not_ended") return vendorsInvalidInputResult("Only an ended relationship can be restored.");
  if (txResult.kind === "conflict") return { ok: false, code: "conflict", message: await conflictMessageFor(loaded.vendor, txResult.claim) };

  await writeVendorEvent({ vendorUid: loaded.vendor.uid, kind: "link_restored", actorUserRef: actor!.userRef, metadata: { vendorPartnerLinkRef: loaded.link.vendorPartnerLinkRef, partnerRef: loaded.link.partnerRef }, requestId });
  return { ok: true, data: toVendorPartnerLinkDto(txResult.doc) };
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

  // Step 8B.1 REVISED section 8: canOpenVendor replaces the old N+1
  // client-side per-row probe (a fetch(`/api/vendors/${ref}`) per link).
  // Computed here, once per distinct Vendor, using the EXACT same gate
  // pair the real Vendor-detail endpoint itself uses (see
  // vendor-service.ts's getVendor: requireVendorsFeatureAccess +
  // requireVendorInScope) - never exposing role/grant/scope internals,
  // just a plain boolean. The direct Vendor detail endpoint still
  // independently re-authorizes when actually opened; this field only
  // controls whether the browser renders the "Open Vendor" link at all.
  // Partner scope alone (having reached this function) never grants
  // Vendor access - each Vendor is checked on its own genuine scope.
  const featureGate = await requireVendorsFeatureAccess(actor);
  const canOpenByVendorRef = new Map<string, boolean>();
  if (featureGate.ok) {
    for (const [ref, vendor] of vendorsByRef) {
      if (!vendor) {
        canOpenByVendorRef.set(ref, false);
        continue;
      }
      const scopeCheck = await requireVendorInScope(actor, vendor);
      canOpenByVendorRef.set(ref, scopeCheck.ok);
    }
  }

  const result: PartnerVendorLinkDto[] = [];
  for (const link of links) {
    const vendor = vendorsByRef.get(link.vendorRef);
    if (!vendor) continue; // A dangling link (its Vendor was somehow removed) is simply omitted, never fabricated.
    result.push({ ...toVendorPartnerLinkDto(link), vendor: toVendorSafeLabelDto(vendor), canOpenVendor: canOpenByVendorRef.get(link.vendorRef) ?? false });
  }
  return { ok: true, data: result };
}
