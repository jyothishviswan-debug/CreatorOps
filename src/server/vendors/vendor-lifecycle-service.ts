import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { toVendorDto, type VendorDto } from "./client-dto";
import { getVendorDocByRef, runVendorMutation, vendorPartnerLinksCollection } from "./firestore";
import { writeVendorEvent } from "./vendor-events";
import { requireVendorInScope, requireVendorsAccess } from "./vendors-gate";
import { VENDOR_GOVERNANCE_STATUSES, vendorsInvalidInputResult, vendorsNotReadyResult, vendorsUnauthorizedResult, type VendorDependencyResult, type VendorDoc, type VendorsServiceResult } from "./types";

// Step 8A section 3: the dependency-check contract, mirroring Partners'
// checkPartnerDependencies exactly - implemented against the one real,
// current collection that can actually reference a Vendor today (its own
// relationship links), built as a small, pluggable checklist so future
// Agreement/Payable adapters can extend the same function instead of
// each module inventing its own gate. Unknown/error MUST block - never
// fabricate "safe to archive" on a failed lookup.
export async function checkVendorDependencies(vendor: Pick<VendorDoc, "uid" | "vendorRef">): Promise<VendorDependencyResult> {
  const blockers: string[] = [];
  try {
    // Two equality filters, no orderBy - Firestore's automatic per-field
    // indexes cover this via merge join, no composite index required
    // (certified Step 8A.1 - this is why vendorPartnerLinks does NOT
    // carry a vendorRef+status composite entry in firestore.indexes.json,
    // unlike its two genuinely-required vendorRef/partnerRef+createdAt
    // entries below).
    const activeLinks = await vendorPartnerLinksCollection().where("vendorRef", "==", vendor.vendorRef).where("status", "==", "ACTIVE").limit(1).get();
    if (!activeLinks.empty) blockers.push("This Vendor has at least one active Partner relationship - end it first.");

    // Future adapters plug in here, e.g.:
    // const activeAgreements = await agreementsCollection().where("vendorRef", "==", vendor.vendorRef).where("status", "==", "ACTIVE").limit(1).get();
    // if (!activeAgreements.empty) blockers.push("...");

    return { status: blockers.length > 0 ? "blocked" : "clear", blockers };
  } catch {
    return { status: "unknown", blockers: ["Dependency lookup failed - cannot confirm this Vendor is safe to archive."] };
  }
}

async function loadForGovernance(actor: ActorContext | null, vendorRef: unknown, action: "archive_vendor" | "restore_vendor"): Promise<{ ok: true; vendor: VendorDoc } | { ok: false; error: VendorsServiceResult<never> }> {
  const gate = await requireVendorsAccess(actor, action);
  if (!gate.ok) return { ok: false, error: vendorsUnauthorizedResult(gate.reason) };

  if (typeof vendorRef !== "string" || vendorRef.length === 0) return { ok: false, error: vendorsInvalidInputResult("Missing vendorRef.") };
  const vendor = await getVendorDocByRef(vendorRef);
  if (!vendor) return { ok: false, error: { ok: false, code: "not_found", message: "Vendor not found." } };

  const scopeCheck = await requireVendorInScope(actor!, vendor);
  if (!scopeCheck.ok) return { ok: false, error: vendorsUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, vendor };
}

const reasonedInputSchema = z.object({ reason: z.string().min(1).max(1000), expectedVersion: z.number().int().min(1) });
export type ArchiveVendorInput = z.input<typeof reasonedInputSchema>;

// FROM ACTIVE or INACTIVE only - already-ARCHIVED must be restored
// first, never re-archived over itself (that would silently discard the
// original previousStatus/reason). Archive never cascades to Partners -
// it only ever touches this Vendor's own document and its own links
// remain exactly as they were (an ARCHIVED Vendor with no active links,
// since that's a precondition, simply has whatever ENDED/historical
// links it already had).
export async function archiveVendor(actor: ActorContext | null, vendorRef: unknown, rawInput: unknown, requestId: string): Promise<VendorsServiceResult<VendorDto>> {
  const loaded = await loadForGovernance(actor, vendorRef, "archive_vendor");
  if (!loaded.ok) return loaded.error;

  const parsed = reasonedInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (VENDOR_GOVERNANCE_STATUSES.includes(loaded.vendor.status as (typeof VENDOR_GOVERNANCE_STATUSES)[number])) {
    return vendorsInvalidInputResult(`Cannot archive a Vendor that is already ${loaded.vendor.status} - restore it first.`);
  }

  const dependencies = await checkVendorDependencies(loaded.vendor);
  if (dependencies.status !== "clear") {
    return vendorsNotReadyResult("This Vendor cannot be archived yet.", dependencies.blockers.map((message, i) => ({ code: `DEPENDENCY_${i}`, message })));
  }

  const result = await runVendorMutation(loaded.vendor.uid, input.expectedVersion, (current) => ({
    ...current,
    previousStatus: current.status,
    status: "ARCHIVED",
    statusReason: input.reason,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Vendor not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Vendor was changed elsewhere. Reload and try again." };

  await writeVendorEvent({ vendorUid: loaded.vendor.uid, kind: "archived", actorUserRef: actor!.userRef, metadata: { reason: input.reason, from: loaded.vendor.status }, requestId });
  return { ok: true, data: await toVendorDto(result.doc) };
}

const restoreInputSchema = z.object({ expectedVersion: z.number().int().min(1) });
export type RestoreVendorInput = z.input<typeof restoreInputSchema>;

// Conservative, history-preserving restore: returns to whatever status
// preceded the governance transition (never a fixed "back to ACTIVE"),
// clears previousStatus/statusReason, and always succeeds without a
// dependency check - reversing a restriction is never itself unsafe. The
// archived event this is reversing is never erased or rewritten, only
// appended to. Restore never rewrites prior Finance/commercial history -
// it only ever touches this Vendor's own status fields.
export async function restoreVendor(actor: ActorContext | null, vendorRef: unknown, rawInput: unknown, requestId: string): Promise<VendorsServiceResult<VendorDto>> {
  const loaded = await loadForGovernance(actor, vendorRef, "restore_vendor");
  if (!loaded.ok) return loaded.error;

  const parsed = restoreInputSchema.safeParse(rawInput);
  if (!parsed.success) return vendorsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (!VENDOR_GOVERNANCE_STATUSES.includes(loaded.vendor.status as (typeof VENDOR_GOVERNANCE_STATUSES)[number]) || !loaded.vendor.previousStatus) {
    return vendorsInvalidInputResult("This Vendor is not in a restorable governance state.");
  }
  const restoredStatus = loaded.vendor.previousStatus;
  const restoredFrom = loaded.vendor.status;

  const result = await runVendorMutation(loaded.vendor.uid, input.expectedVersion, (current) => ({
    ...current,
    status: restoredStatus,
    previousStatus: null,
    statusReason: null,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Vendor not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Vendor was changed elsewhere. Reload and try again." };

  await writeVendorEvent({ vendorUid: loaded.vendor.uid, kind: "restored", actorUserRef: actor!.userRef, metadata: { from: restoredFrom, to: restoredStatus }, requestId });
  return { ok: true, data: await toVendorDto(result.doc) };
}
