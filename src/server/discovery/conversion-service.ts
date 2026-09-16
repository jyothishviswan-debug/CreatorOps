import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import type { ActorContext } from "@/server/authz/types";
import { requireDiscoveryAccess, requireDiscoveryFeatureAccess, requireLeadInScope } from "./discovery-gate";
import { checkForDuplicates } from "./duplicate-check";
import { getLeadDocByRef, getPartnerAccountDocByRef, leadsCollection, partnerAccountsCollection, partnersCollection } from "./firestore";
import { generatePartnerAccountRef, generatePartnerRef } from "./ids";
import { writeLeadEvent } from "./lead-events";
import { evaluateLeadReadiness } from "./readiness";
import {
  discoveryInvalidInputResult,
  discoveryUnauthorizedResult,
  leadDocSchema,
  partnerAccountDocSchema,
  partnerDocSchema,
  type DiscoveryServiceResult,
  type LeadDoc,
  type ReadinessResult,
} from "./types";

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
  | { kind: "ok"; dto: ConversionDto }
  | { kind: "stale" }
  | { kind: "not_ready"; blockers: { code: string; message: string }[] }
  | { kind: "not_found" }
  | { kind: "account_not_found" };

// Step 6A section 10: trusted-server-only, idempotent conversion. Every
// attempt reloads the Lead, re-checks authentication/effective action
// permission/scope, re-checks lifecycle/version, recomputes readiness,
// and reruns duplicate/canonical-account resolution - nothing about a
// prior check is trusted to still hold. If the Lead is ALREADY
// CONVERTED, this returns the exact same stored result instead of
// re-evaluating anything or creating a second Partner - true for ANY
// retry, whether or not the supplied idempotencyKey matches the one
// recorded the first time, since the actually-enforced guarantee is "a
// Lead converts at most once", not "one idempotency key produces one
// result".
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
    // hard Firestore requirement, not just a style preference (see
    // users-service.ts for the same discipline).
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

    const now = new Date().toISOString();

    const partnerDoc = partnerDocSchema.parse({
      uid: newPartnerUid,
      partnerRef: newPartnerRef,
      version: 1,
      displayName: freshLead.displayName,
      email: freshLead.email,
      phone: freshLead.phone,
      region: freshLead.region,
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
    });
    tx.set(partnersCollection().doc(newPartnerUid), partnerDoc);

    let partnerAccountRef: string | null = null;
    if (freshLead.assetDecision.decision !== "NEW_ACCOUNT") {
      if (accountRef && existingAccount) {
        // Reuse the existing canonical Partner Account - reassign it to
        // the new Partner.
        tx.update(accountRef, { partnerRef: newPartnerRef, version: existingAccount.version + 1 });
        partnerAccountRef = existingAccount.partnerAccountRef;
      } else if (freshLead.platform) {
        // Create a new canonical Partner Account from the Lead's own
        // confirmed platform/handle/profile evidence - only when that
        // evidence actually exists on the Lead.
        const newAccountUid = partnerAccountsCollection().doc().id;
        const newAccountRef = generatePartnerAccountRef();
        const accountDoc = partnerAccountDocSchema.parse({
          uid: newAccountUid,
          partnerAccountRef: newAccountRef,
          version: 1,
          partnerRef: newPartnerRef,
          platform: freshLead.platform,
          handle: freshLead.handle,
          profileUrl: freshLead.profileUrl,
          assetPath: freshLead.assetDecision.decision,
          createdAt: now,
          createdByUserRef: actor!.userRef,
        });
        tx.set(partnerAccountsCollection().doc(newAccountUid), accountDoc);
        partnerAccountRef = newAccountRef;
      }
    }

    const conversion = { convertedAt: now, convertedByUserRef: actor!.userRef, partnerRef: newPartnerRef, partnerAccountRef, idempotencyKey: input.idempotencyKey };
    const updatedLead: LeadDoc = { ...freshLead, lifecycle: "CONVERTED", previousLifecycle: freshLead.lifecycle, conversion, duplicateCheck: freshDuplicateCheck, version: freshLead.version + 1, updatedAt: now, updatedByUserRef: actor!.userRef };
    tx.set(leadDocRef, updatedLead);

    return {
      kind: "ok",
      dto: { leadRef: freshLead.leadRef, partnerRef: newPartnerRef, partnerAccountRef, pendingPartnerAccountSetup: freshLead.assetDecision.decision === "NEW_ACCOUNT", convertedAt: now },
    };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };
  if (result.kind === "account_not_found") return discoveryInvalidInputResult("The referenced existing Partner Account no longer resolves.");
  if (result.kind === "not_ready") return { ok: false, code: "not_ready", message: "This Lead is not ready for conversion.", blockers: result.blockers };

  await writeLeadEvent({
    leadUid: lead.uid,
    kind: "converted",
    actorUserRef: actor.userRef,
    metadata: { partnerRef: result.dto.partnerRef, partnerAccountRef: result.dto.partnerAccountRef, pendingPartnerAccountSetup: result.dto.pendingPartnerAccountSetup },
    requestId,
  });

  return { ok: true, data: result.dto };
}
