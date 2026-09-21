import { financeAgreementsCollection } from "@/server/finance-agreements/firestore";
import { registerCounterpartyDependencyGuard, type CounterpartyDependencyGuardResult, type GuardedCounterpartyType } from "@/server/shared/counterparty-dependency-guards";

// Step 14C section 3: the Finance Agreements side of the Partner / Vendor dependency guard.
//
// A Partner / Vendor that has an ACTIVE or SUSPENDED Agreement must not be ARCHIVED or (Partner only) BLACKLISTED: the Agreement is
// the live commercial contract for that record (and, for a Partner, the source of the commercial policy Partner Reviews read), so
// archiving/blacklisting would orphan it. The owning lifecycle services block with the reason below and NEVER end, supersede or
// otherwise touch the Agreement - resolving it is a deliberate Finance action (end, or supersede with a revision).
//
// What is NOT blocked, on purpose:
//   - DRAFT (never operational, nothing to orphan - an unactivated draft stays a plain record),
//   - ENDED (the contract is over; its history stays readable) and SUPERSEDED versions (history),
//   - the reversible INACTIVE deactivation (owning modules never consult a guard for it: the record and all Agreement provenance
//     stay intact and one click undoes it) and restore.
//
// This file lives in the composition folder (NOT in Partners / Vendors, which must not import Finance) and is registered by
// registerServerProviders(). One bounded, single-field equality query per check (audited in firestore-indexes.test.ts - no
// composite index): the heads whose counterparty ref equals the record's ref. The status is filtered in code, on the RAW stored
// value, so a head that no longer parses against the current schema still blocks if it says ACTIVE / SUSPENDED. It deliberately does
// NOT compare the head's scope snapshot against the live record (a mismatch is an integrity anomaly, and a guard must fail safe).
// Any lookup failure - a Firestore error, more Agreements than can be scanned, an unrecognisable status - is `unknown`, which blocks.

export const FINANCE_GUARD_SCAN_LIMIT = 50;
export const FINANCE_PARTNER_GUARD_ID = "finance-agreements.partner-agreements";
export const FINANCE_VENDOR_GUARD_ID = "finance-agreements.vendor-agreements";

const KNOWN_HEAD_STATUSES = new Set(["DRAFT", "ACTIVE", "SUSPENDED", "ENDED"]);

function label(type: GuardedCounterpartyType): "Partner" | "Vendor" {
  return type === "PARTNER" ? "Partner" : "Vendor";
}

export function agreementBlockedReason(type: GuardedCounterpartyType, kind: "ACTIVE" | "SUSPENDED", action: "archive" | "blacklist"): string {
  const gerund = action === "blacklist" ? "blacklisting" : "archiving";
  return `This ${label(type)} has ${kind === "ACTIVE" ? "an active" : "a suspended"} Agreement. End or supersede the Agreement in Finance before ${gerund}.`;
}

export async function checkFinanceAgreementDependency(type: GuardedCounterpartyType, ref: string, action: "archive" | "blacklist"): Promise<CounterpartyDependencyGuardResult> {
  const unknown = (): CounterpartyDependencyGuardResult => ({ status: "unknown", reason: `Agreement lookup failed - cannot confirm this ${label(type)} has no active Agreement.` });
  try {
    if (!ref) return unknown();
    const field = type === "PARTNER" ? "counterparty.partnerRef" : "counterparty.vendorRef";
    const snapshot = await financeAgreementsCollection()
      .where(field, "==", ref)
      .limit(FINANCE_GUARD_SCAN_LIMIT + 1)
      .get();

    let hasActive = false;
    let hasSuspended = false;
    let unrecognised = false;
    for (const doc of snapshot.docs) {
      const data = doc.data() as { status?: unknown };
      if (data.status === "ACTIVE") hasActive = true;
      else if (data.status === "SUSPENDED") hasSuspended = true;
      else if (typeof data.status !== "string" || !KNOWN_HEAD_STATUSES.has(data.status)) unrecognised = true;
    }

    if (hasActive || hasSuspended) {
      const reasons = [...(hasActive ? [agreementBlockedReason(type, "ACTIVE", action)] : []), ...(hasSuspended ? [agreementBlockedReason(type, "SUSPENDED", action)] : [])];
      return { status: "blocked", reason: reasons.join(" ") };
    }
    // Nothing blocking among what was read - but that only proves "clear" if EVERYTHING was read and understood.
    if (snapshot.docs.length > FINANCE_GUARD_SCAN_LIMIT) return { status: "unknown", reason: `This ${label(type)} has too many Agreements to verify that none is active - resolve them in Finance first.` };
    if (unrecognised) return unknown();
    return { status: "clear" };
  } catch {
    return unknown();
  }
}

// Registers the Partner and Vendor guards (idempotent: the same ids replace themselves).
export function registerFinanceDependencyGuards(): void {
  registerCounterpartyDependencyGuard({ id: FINANCE_PARTNER_GUARD_ID, counterpartyType: "PARTNER", check: (ref, context) => checkFinanceAgreementDependency("PARTNER", ref, context.action) });
  registerCounterpartyDependencyGuard({ id: FINANCE_VENDOR_GUARD_ID, counterpartyType: "VENDOR", check: (ref, context) => checkFinanceAgreementDependency("VENDOR", ref, context.action) });
}
