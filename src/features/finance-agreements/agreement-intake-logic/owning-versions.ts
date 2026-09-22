import { getPartner, getPartnerRestrictedIdentity } from "@/features/partners/api-client";
import { getVendor, getVendorRestrictedIdentity } from "@/features/vendors/api-client";
import type { CounterpartyType } from "@/server/finance-agreements/types";

// Step 14B intake: the two concurrency counters the Agreement screens do not carry, read through the OWNING module when (and only when)
// a person confirms an action that needs one. Nothing else is taken from those responses.
//
//   counterparty version     the Partner's / Vendor's own `version` (the master-data command's expectedCounterpartyVersion).
//   identity record version  the restricted identity record's `version` (evidence links / uploads: expectedVersion).
//                            The owning read also returns the record's values. They are NEVER stored, rendered or logged here: only
//                            the number is read, at submit time, by an actor the owning module already authorizes to manage it.
//                            (A status-only version would remove the need for this read: see the completion report.)
export type OwningVersionResult = { ok: true; version: number } | { ok: false; message: string };

const DENIED = "You do not have access to read this record.";
const UNREADABLE = "The current record could not be read. Try again.";

function failure(result: { status: number; error: string }): OwningVersionResult {
  return { ok: false, message: result.status === 401 || result.status === 403 ? DENIED : result.error || UNREADABLE };
}

export async function readCounterpartyVersion(type: CounterpartyType, ref: string): Promise<OwningVersionResult> {
  try {
    if (type === "PARTNER") {
      const result = await getPartner(ref);
      return result.ok ? { ok: true, version: result.data.version } : failure(result);
    }
    const result = await getVendor(ref);
    return result.ok ? { ok: true, version: result.data.version } : failure(result);
  } catch {
    return { ok: false, message: UNREADABLE };
  }
}

// 0 = the counterparty has no identity record yet.
export async function readIdentityRecordVersion(type: CounterpartyType, ref: string): Promise<OwningVersionResult> {
  try {
    if (type === "PARTNER") {
      const result = await getPartnerRestrictedIdentity(ref);
      return result.ok ? { ok: true, version: result.data?.version ?? 0 } : failure(result);
    }
    const result = await getVendorRestrictedIdentity(ref);
    return result.ok ? { ok: true, version: result.data?.version ?? 0 } : failure(result);
  } catch {
    return { ok: false, message: UNREADABLE };
  }
}
