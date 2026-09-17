import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import type { ActorContext } from "@/server/authz/types";
import { getPartnerAccountDocByRef, partnerAccountIdentityClaimsCollection, partnerAccountsCollection, partnersCollection } from "@/server/partners/firestore";
import { claimIdFor, computeNormalizedIdentity } from "@/server/partners/identity";
import { generatePartnerAccountRef, generatePartnerRef } from "@/server/partners/ids";
import { writePartnerEvent } from "@/server/partners/partner-events";
import { partnerAccountDocSchema, partnerAccountIdentityClaimDocSchema, partnerDocSchema, type PartnerAccountDoc, type PartnerDoc } from "@/server/partners/types";
import { requireDiscoveryAccess, requireDiscoveryFeatureAccess, requireLeadInScope } from "./discovery-gate";
import { checkForDuplicates } from "./duplicate-check";
import { getLeadDocByRef, leadsCollection } from "./firestore";
import { writeLeadEvent } from "./lead-events";
import { evaluateLeadReadiness } from "./readiness";
import { discoveryInvalidInputResult, discoveryUnauthorizedResult, leadDocSchema, type DiscoveryServiceResult, type LeadDoc, type ReadinessResult } from "./types";

// ---- Readiness endpoint ----
// Read-only - gated by Feature Access + Record Scope, same as get/list.
// Calls the exact same evaluateLeadReadiness convertLead itself uses
// below (Step 6A section 9: exactly one place this logic lives).
export async function getLeadReadiness(actor: ActorContext | null, leadRef: unknown): Promise<DiscoveryServiceResult<ReadinessResult & { leadRef: string; version: number; lifecycle: LeadDoc["lifecycle"] }>> {
  if (!actor) return discoveryUnauthorizedResult("not_authenticated");
  const gate = await requireDiscoveryFeatureAccess(actor);
  if (!gate.ok) return discoveryUnauthorizedResult(gate.reason);

  if (typeof leadRef !== "string" || leadRef.length === 0) return discoveryInvalidInputResult("Missing leadRef.");
  const lead = await getLeadDocByRef(leadRef);
  if (!lead) return { ok: false, code: "not_found", message: "Lead not found." };

  const scopeCheck = await requireLeadInScope(actor, lead);
  if (!scopeCheck.ok) return discoveryUnauthorizedResult(scopeCheck.reason);

  const readiness = await evaluateLeadReadiness(lead);
  return { ok: true, data: { ...readiness, leadRef: lead.leadRef, version: lead.version, lifecycle: lead.lifecycle } };
}

// ---- Conversion ----

const convertLeadInputSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  expectedVersion: z.number().int().min(1),
});
export type ConvertLeadInput = z.input<typeof convertLeadInputSchema>;

export type ConversionDto = {
  leadRef: string;
  partnerRef: string;
  partnerAccountRef: string | null;
  pendingPartnerAccountSetup: boolean;
  convertedAt: string;
};

type ConvertTxResult =
  | { kind: "ok"; dto: ConversionDto; newPartnerDoc: PartnerDoc | null }
  | { kind: "stale" }
  | { kind: "not_ready"; blockers: { code: string; message: string }[] }
  | { kind: "not_found" }
  | { kind: "account_not_found" }
  | { kind: "account_identity_collision" };

// Step 6A section 10 / Step 7A section 4: trusted-server-only, idempotent
// conversion. Every attempt reloads the Lead, re-checks authentication/
// effective action permission/scope, re-checks lifecycle/version,
// recomputes readiness, and reruns duplicate/canonical-account
// resolution - nothing about a prior check is trusted to still hold. If
// the Lead is ALREADY CONVERTED, this returns the exact same stored
// result instead of re-evaluating anything or creating a second Partner
// - true for ANY retry, whether or not the supplied idempotencyKey
// matches the one recorded the first time, since the actually-enforced
// guarantee is "a Lead converts at most once", not "one idempotency key
// produces one result".
//
// This is the SAME canonical Partner/Partner Account schema, id
// generators, and identity-claim collection direct Partner/account
// creation uses (partner-service.ts / partner-account-service.ts) -
// there is deliberately no separate "conversion-only" Partner shape.
export async function convertLead(actor: ActorContext | null, leadRef: unknown, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<ConversionDto>> {
  if (!actor) return discoveryUnauthorizedResult("not_authenticated");
  const gate = await requireDiscoveryAccess(actor, "convert_lead");
  if (!gate.ok) return discoveryUnauthorizedResult(gate.reason);

  if (typeof leadRef !== "string" || leadRef.length === 0) return discoveryInvalidInputResult("Missing leadRef.");
  const parsed = convertLeadInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const lead = await getLeadDocByRef(leadRef);
  if (!lead) return { ok: false, code: "not_found", message: "Lead not found." };

  const scopeCheck = await requireLeadInScope(actor, lead);
  if (!scopeCheck.ok) return discoveryUnauthorizedResult(scopeCheck.reason);

  // Idempotent replay: already converted, return the same result -
  // never touch readiness/duplicate checks or create anything.
  if (lead.lifecycle === "CONVERTED" && lead.conversion) {
    return {
      ok: true,
      data: {
        leadRef: lead.leadRef,
        partnerRef: lead.conversion.partnerRef,
        partnerAccountRef: lead.conversion.partnerAccountRef,
        pendingPartnerAccountSetup: lead.assetDecision?.decision === "NEW_ACCOUNT",
        convertedAt: lead.conversion.convertedAt,
      },
    };
  }

  if (lead.lifecycle !== "CONVERSION_READY") {
    return discoveryInvalidInputResult(`Cannot convert a Lead in ${lead.lifecycle} - it must be CONVERSION_READY.`);
  }
  if (lead.version !== input.expectedVersion) {
    return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };
  }

  const readiness = await evaluateLeadReadiness(lead);
  if (!readiness.ready) {
    return { ok: false, code: "not_ready", message: "This Lead is not ready for conversion.", blockers: readiness.blockers };
  }

  // Rerun duplicate resolution fresh, right before committing - a
  // duplicate could have appeared since the last stored check.
  const freshDuplicateCheck = await checkForDuplicates({
    email: lead.email ?? undefined,
    phone: lead.phone ?? undefined,
    profileUrl: lead.profileUrl ?? undefined,
    handle: lead.handle ?? undefined,
    excludeLeadUid: lead.uid,
  });
  if (freshDuplicateCheck.status === "unknown" || freshDuplicateCheck.status === "confirmed") {
    return {
      ok: false,
      code: "not_ready",
      message: "Duplicate resolution changed since this Lead was last checked.",
      blockers: [{ code: "DUPLICATE_UNRESOLVED", message: `Fresh duplicate check returned "${freshDuplicateCheck.status}".` }],
    };
  }

  if (!lead.assetDecision) {
    return discoveryInvalidInputResult("An asset decision is required before conversion.");
  }

  const db = getAdminFirestore();
  const leadDocRef = leadsCollection().doc(lead.uid);
  const newPartnerRef = generatePartnerRef();
  const newPartnerUid = partnersCollection().doc().id;

  // For MAINTAIN_EXISTING/TRANSFER_AND_MAINTAIN with a known existing
  // canonical Partner Account, resolve it OUTSIDE the transaction first
  // (Firestore requires all transactional reads before any transactional
  // write) - it's re-read again inside the transaction for the actual
  // reassignment.
  let existingAccountUid: string | null = null;
  if (lead.assetDecision.decision !== "NEW_ACCOUNT" && lead.assetDecision.existingPartnerAccountRef) {
    const existing = await getPartnerAccountDocByRef(lead.assetDecision.existingPartnerAccountRef);
    if (!existing) return discoveryInvalidInputResult("The referenced existing Partner Account no longer resolves.");
    existingAccountUid = existing.uid;
  }

  // For a NEW canonical Partner Account created from the Lead's own
  // confirmed platform/handle/profile evidence - computed outside the
  // transaction (pure), the identity-claim lock itself is what's
  // actually checked/written transactionally below.
  const willCreateNewAccount = lead.assetDecision.decision === "NEW_ACCOUNT" ? false : !existingAccountUid && Boolean(lead.platform);
  const newAccountNormalizedIdentity = willCreateNewAccount && lead.platform ? computeNormalizedIdentity({ platform: lead.platform, profileUrl: lead.profileUrl, handle: lead.handle }) : null;
  const newAccountClaimId = newAccountNormalizedIdentity ? claimIdFor(newAccountNormalizedIdentity) : null;
  const newAccountUid = willCreateNewAccount ? partnerAccountsCollection().doc().id : null;
  const newAccountRef = willCreateNewAccount ? generatePartnerAccountRef() : null;

  const result = await db.runTransaction<ConvertTxResult>(async (tx) => {
    const leadSnap = await tx.get(leadDocRef);
    if (!leadSnap.exists) return { kind: "not_found" };
    const parsedLead = leadDocSchema.safeParse(leadSnap.data());
    if (!parsedLead.success) return { kind: "not_found" };
    const freshLead = parsedLead.data;

    // Idempotent replay re-checked inside the transaction too, in case a
    // concurrent request already converted it between the read above and
    // this transaction acquiring its lock.
    if (freshLead.lifecycle === "CONVERTED" && freshLead.conversion) {
      return {
        kind: "ok",
        newPartnerDoc: null,
        dto: {
          leadRef: freshLead.leadRef,
          partnerRef: freshLead.conversion.partnerRef,
          partnerAccountRef: freshLead.conversion.partnerAccountRef,
          pendingPartnerAccountSetup: freshLead.assetDecision?.decision === "NEW_ACCOUNT",
          convertedAt: freshLead.conversion.convertedAt,
        },
      };
    }
    if (freshLead.lifecycle !== "CONVERSION_READY" || freshLead.version !== input.expectedVersion) return { kind: "stale" };
    if (!freshLead.assetDecision) return { kind: "not_ready", blockers: [{ code: "ASSET_DECISION_MISSING", message: "An asset decision is required." }] };

    // All transactional reads happen before any transactional write - a
    // hard Firestore requirement, not just a style preference.
    let accountRef: FirebaseFirestore.DocumentReference | null = null;
    let existingAccount: { partnerAccountRef: string; version: number } | null = null;
    if (existingAccountUid) {
      accountRef = partnerAccountsCollection().doc(existingAccountUid);
      const snap = await tx.get(accountRef);
      if (!snap.exists) return { kind: "account_not_found" };
      const existingParsed = partnerAccountDocSchema.safeParse(snap.data());
      if (!existingParsed.success) return { kind: "account_not_found" };
      existingAccount = { partnerAccountRef: existingParsed.data.partnerAccountRef, version: existingParsed.data.version };
    }

    let newAccountClaimExists = false;
    if (newAccountClaimId) {
      const claimSnap = await tx.get(partnerAccountIdentityClaimsCollection().doc(newAccountClaimId));
      newAccountClaimExists = claimSnap.exists;
    }
    if (newAccountClaimExists) return { kind: "account_identity_collision" };

    const now = new Date().toISOString();

    const partnerDoc: PartnerDoc = partnerDocSchema.parse({
      uid: newPartnerUid,
      partnerRef: newPartnerRef,
      version: 1,
      displayName: freshLead.displayName,
      displayNameLower: freshLead.displayName.toLowerCase(),
      legalName: null,
      status: "ACTIVE",
      previousStatus: null,
      statusReason: null,
      regionIds: freshLead.regionIds,
      languageIds: [],
      categoryIds: [],
      tier: null,
      priority: null,
      // Carried over verbatim from Discovery's own Research evidence when
      // present - the origin Lead already captured it, so conversion
      // never leaves it blank only to make the operator retype it.
      targetAudience: freshLead.research?.targetAudience ?? null,
      email: freshLead.email,
      phone: freshLead.phone,
      ownerUid: freshLead.ownerUid,
      teamIds: freshLead.teamId ? [freshLead.teamId] : [],
      originLeadRefs: [freshLead.leadRef],
      sourceDiscovery: {
        leadRef: freshLead.leadRef,
        convertedAt: now,
        snapshot: {
          displayName: freshLead.displayName,
          email: freshLead.email,
          phone: freshLead.phone,
          profileUrl: freshLead.profileUrl,
          platform: freshLead.platform,
          handle: freshLead.handle,
          source: freshLead.source,
        },
      },
      pendingPartnerAccountSetup: freshLead.assetDecision.decision === "NEW_ACCOUNT",
      createdAt: now,
      createdByUserRef: actor!.userRef,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    tx.set(partnersCollection().doc(newPartnerUid), partnerDoc);

    let partnerAccountRef: string | null = null;
    if (freshLead.assetDecision.decision !== "NEW_ACCOUNT") {
      if (accountRef && existingAccount) {
        // Reuse the existing canonical Partner Account - reassign it to
        // the new Partner. normalizedIdentity is never touched by this
        // (or any) edit - identity is claimed once, at that account's
        // own creation, and this is a reassignment of ownership, not a
        // re-derivation of identity.
        tx.update(accountRef, { partnerRef: newPartnerRef, primary: true, version: existingAccount.version + 1, updatedAt: now, updatedByUserRef: actor!.userRef });
        partnerAccountRef = existingAccount.partnerAccountRef;
      } else if (newAccountUid && newAccountRef && newAccountNormalizedIdentity && newAccountClaimId) {
        const accountDoc: PartnerAccountDoc = partnerAccountDocSchema.parse({
          uid: newAccountUid,
          partnerAccountRef: newAccountRef,
          version: 1,
          partnerRef: newPartnerRef,
          platform: freshLead.platform,
          handle: freshLead.handle,
          displayName: freshLead.displayName,
          profileUrl: freshLead.profileUrl,
          platformAccountId: null,
          normalizedIdentity: newAccountNormalizedIdentity,
          primary: true,
          status: "ACTIVE",
          followerSnapshot: null,
          originAssetDecision: freshLead.assetDecision.decision,
          originLeadRef: freshLead.leadRef,
          createdAt: now,
          createdByUserRef: actor!.userRef,
          updatedAt: now,
          updatedByUserRef: actor!.userRef,
        });
        tx.set(partnerAccountsCollection().doc(newAccountUid), accountDoc);
        tx.set(
          partnerAccountIdentityClaimsCollection().doc(newAccountClaimId),
          partnerAccountIdentityClaimDocSchema.parse({ normalizedIdentity: newAccountNormalizedIdentity, partnerAccountUid: newAccountUid, partnerAccountRef: newAccountRef, claimedAt: now }),
        );
        partnerAccountRef = newAccountRef;
      }
    }

    const conversion = { convertedAt: now, convertedByUserRef: actor!.userRef, partnerRef: newPartnerRef, partnerAccountRef, idempotencyKey: input.idempotencyKey };
    const updatedLead: LeadDoc = { ...freshLead, lifecycle: "CONVERTED", previousLifecycle: freshLead.lifecycle, conversion, duplicateCheck: freshDuplicateCheck, version: freshLead.version + 1, updatedAt: now, updatedByUserRef: actor!.userRef };
    tx.set(leadDocRef, updatedLead);

    return {
      kind: "ok",
      newPartnerDoc: partnerDoc,
      dto: { leadRef: freshLead.leadRef, partnerRef: newPartnerRef, partnerAccountRef, pendingPartnerAccountSetup: freshLead.assetDecision.decision === "NEW_ACCOUNT", convertedAt: now },
    };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };
  if (result.kind === "account_not_found") return discoveryInvalidInputResult("The referenced existing Partner Account no longer resolves.");
  if (result.kind === "account_identity_collision") {
    return {
      ok: false,
      code: "not_ready",
      message: "This Lead's own platform account is already claimed by another Partner Account.",
      blockers: [{ code: "ACCOUNT_IDENTITY_COLLISION", message: "Resolve the conflicting Partner Account before converting, or choose an existing-account asset decision instead." }],
    };
  }
  if (result.kind === "not_ready") return { ok: false, code: "not_ready", message: "This Lead is not ready for conversion.", blockers: result.blockers };

  await writeLeadEvent({
    leadUid: lead.uid,
    kind: "converted",
    actorUserRef: actor.userRef,
    metadata: { partnerRef: result.dto.partnerRef, partnerAccountRef: result.dto.partnerAccountRef, pendingPartnerAccountSetup: result.dto.pendingPartnerAccountSetup },
    requestId,
  });

  if (result.newPartnerDoc) {
    await writePartnerEvent({ partnerUid: result.newPartnerDoc.uid, kind: "created", actorUserRef: actor.userRef, metadata: { displayName: result.newPartnerDoc.displayName, fromDiscoveryLead: lead.leadRef }, requestId });
    if (result.dto.partnerAccountRef && !result.dto.pendingPartnerAccountSetup) {
      await writePartnerEvent({ partnerUid: result.newPartnerDoc.uid, kind: "account_created", actorUserRef: actor.userRef, metadata: { partnerAccountRef: result.dto.partnerAccountRef, fromDiscoveryLead: lead.leadRef }, requestId });
    }
  }

  return { ok: true, data: result.dto };
}
