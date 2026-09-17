import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { toPartnerDto, type PartnerDto } from "./client-dto";
import { getPartnerDocByRef, partnerAccountsCollection, runPartnerMutation } from "./firestore";
import { writePartnerEvent } from "./partner-events";
import { requirePartnerInScope, requirePartnersAccess } from "./partners-gate";
import { PARTNER_GOVERNANCE_STATUSES, partnersInvalidInputResult, partnersNotReadyResult, partnersUnauthorizedResult, type PartnerDependencyResult, type PartnerDoc, type PartnersServiceResult } from "./types";

// Step 7A section 11: the dependency-check contract, implemented now
// against the one real, current collection that can actually reference a
// Partner today (its own Partner Accounts) - built as a small, pluggable
// checklist so future Campaign/Assignment/Finance adapters can extend
// the same function instead of each module inventing its own gate.
// Unknown/error MUST block - never fabricate "safe to archive" on a
// failed lookup.
export async function checkPartnerDependencies(partner: Pick<PartnerDoc, "uid" | "partnerRef">): Promise<PartnerDependencyResult> {
  const blockers: string[] = [];
  try {
    const activeAccounts = await partnerAccountsCollection().where("partnerRef", "==", partner.partnerRef).where("status", "==", "ACTIVE").limit(1).get();
    if (!activeAccounts.empty) blockers.push("This Partner has at least one active Partner Account - inactivate it first.");

    // Future adapters plug in here, e.g.:
    // const activeCampaigns = await campaignsCollection().where("partnerRef", "==", partner.partnerRef).where("status", "==", "ACTIVE").limit(1).get();
    // if (!activeCampaigns.empty) blockers.push("...");

    return { status: blockers.length > 0 ? "blocked" : "clear", blockers };
  } catch {
    return { status: "unknown", blockers: ["Dependency lookup failed - cannot confirm this Partner is safe to archive/blacklist."] };
  }
}

async function loadForGovernance(actor: ActorContext | null, partnerRef: unknown): Promise<{ ok: true; partner: PartnerDoc } | { ok: false; error: PartnersServiceResult<never> }> {
  const gate = await requirePartnersAccess(actor, "manage_partner_governance");
  if (!gate.ok) return { ok: false, error: partnersUnauthorizedResult(gate.reason) };

  if (typeof partnerRef !== "string" || partnerRef.length === 0) return { ok: false, error: partnersInvalidInputResult("Missing partnerRef.") };
  const partner = await getPartnerDocByRef(partnerRef);
  if (!partner) return { ok: false, error: { ok: false, code: "not_found", message: "Partner not found." } };

  const scopeCheck = await requirePartnerInScope(actor!, partner);
  if (!scopeCheck.ok) return { ok: false, error: partnersUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, partner };
}

const reasonedInputSchema = z.object({ reason: z.string().min(1).max(1000), expectedVersion: z.number().int().min(1) });
export type BlacklistPartnerInput = z.input<typeof reasonedInputSchema>;
export type ArchivePartnerInput = z.input<typeof reasonedInputSchema>;

// FROM ACTIVE or INACTIVE only - already-BLACKLISTED/ARCHIVED must be
// restored first, never re-blacklisted/re-archived over itself (that
// would silently discard the original previousStatus/reason).
export async function blacklistPartner(actor: ActorContext | null, partnerRef: unknown, rawInput: unknown, requestId: string): Promise<PartnersServiceResult<PartnerDto>> {
  const loaded = await loadForGovernance(actor, partnerRef);
  if (!loaded.ok) return loaded.error;

  const parsed = reasonedInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (PARTNER_GOVERNANCE_STATUSES.includes(loaded.partner.status as (typeof PARTNER_GOVERNANCE_STATUSES)[number])) {
    return partnersInvalidInputResult(`Cannot blacklist a Partner that is already ${loaded.partner.status} - restore it first.`);
  }

  const dependencies = await checkPartnerDependencies(loaded.partner);
  if (dependencies.status !== "clear") {
    return partnersNotReadyResult("This Partner cannot be blacklisted yet.", dependencies.blockers.map((message, i) => ({ code: `DEPENDENCY_${i}`, message })));
  }

  const result = await runPartnerMutation(loaded.partner.uid, input.expectedVersion, (current) => ({
    ...current,
    previousStatus: current.status,
    status: "BLACKLISTED",
    statusReason: input.reason,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Partner not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Partner was changed elsewhere. Reload and try again." };

  await writePartnerEvent({ partnerUid: loaded.partner.uid, kind: "blacklisted", actorUserRef: actor!.userRef, metadata: { reason: input.reason, from: loaded.partner.status }, requestId });
  return { ok: true, data: await toPartnerDto(result.doc) };
}

// FROM ACTIVE, INACTIVE, or BLACKLISTED - never re-archiving an
// already-ARCHIVED Partner over itself.
export async function archivePartner(actor: ActorContext | null, partnerRef: unknown, rawInput: unknown, requestId: string): Promise<PartnersServiceResult<PartnerDto>> {
  const loaded = await loadForGovernance(actor, partnerRef);
  if (!loaded.ok) return loaded.error;

  const parsed = reasonedInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (loaded.partner.status === "ARCHIVED") {
    return partnersInvalidInputResult("This Partner is already archived - restore it first.");
  }

  const dependencies = await checkPartnerDependencies(loaded.partner);
  if (dependencies.status !== "clear") {
    return partnersNotReadyResult("This Partner cannot be archived yet.", dependencies.blockers.map((message, i) => ({ code: `DEPENDENCY_${i}`, message })));
  }

  const result = await runPartnerMutation(loaded.partner.uid, input.expectedVersion, (current) => ({
    ...current,
    previousStatus: current.status,
    status: "ARCHIVED",
    statusReason: input.reason,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Partner not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Partner was changed elsewhere. Reload and try again." };

  await writePartnerEvent({ partnerUid: loaded.partner.uid, kind: "archived", actorUserRef: actor!.userRef, metadata: { reason: input.reason, from: loaded.partner.status }, requestId });
  return { ok: true, data: await toPartnerDto(result.doc) };
}

const restoreInputSchema = z.object({ expectedVersion: z.number().int().min(1) });
export type RestorePartnerInput = z.input<typeof restoreInputSchema>;

// Conservative, history-preserving restore: returns to whatever status
// preceded the governance transition (never a fixed "back to ACTIVE"),
// clears previousStatus/statusReason, and always succeeds without a
// dependency check - reversing a restriction is never itself unsafe. The
// blacklisted/archived event this is reversing is never erased or
// rewritten, only appended to.
export async function restorePartner(actor: ActorContext | null, partnerRef: unknown, rawInput: unknown, requestId: string): Promise<PartnersServiceResult<PartnerDto>> {
  const loaded = await loadForGovernance(actor, partnerRef);
  if (!loaded.ok) return loaded.error;

  const parsed = restoreInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (!PARTNER_GOVERNANCE_STATUSES.includes(loaded.partner.status as (typeof PARTNER_GOVERNANCE_STATUSES)[number]) || !loaded.partner.previousStatus) {
    return partnersInvalidInputResult("This Partner is not in a restorable governance state.");
  }
  const restoredStatus = loaded.partner.previousStatus;
  const restoredFrom = loaded.partner.status;

  const result = await runPartnerMutation(loaded.partner.uid, input.expectedVersion, (current) => ({
    ...current,
    status: restoredStatus,
    previousStatus: null,
    statusReason: null,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Partner not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Partner was changed elsewhere. Reload and try again." };

  await writePartnerEvent({ partnerUid: loaded.partner.uid, kind: "restored", actorUserRef: actor!.userRef, metadata: { from: restoredFrom, to: restoredStatus }, requestId });
  return { ok: true, data: await toPartnerDto(result.doc) };
}
