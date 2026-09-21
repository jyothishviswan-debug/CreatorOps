import { vendorsCollection } from "./firestore";
import type { VendorDuplicateMatch } from "./types";

const MATCH_QUERY_LIMIT = 5;

// Step 14B.1: exported (pure, unchanged) so the Finance Agreement onboarding duplicate wrapper normalizes exactly as this check does.
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/g, "");
}

export function normalizeDisplayName(value: string): string {
  return value.trim().toLowerCase();
}

export type VendorDuplicateCheckInput = {
  displayName?: string;
  email?: string;
  phone?: string;
  // Excludes the Vendor being re-checked from its own match set.
  excludeVendorUid?: string;
};

// Step 8A section 6: bounded, normalized, advisory duplicate lookup
// before a direct Vendor create - deliberately NOT a uniqueness lock for
// name/email/phone (two real businesses can legitimately share a contact
// email, and a name match alone is never grounds for an automatic
// merge). Restricted GST/tax identifiers are never checked here - any
// exact-collision detection on those stays inside
// restricted-identity-service.ts's own trusted save path (Step 8A
// section 6's own boundary).
//
// A failed lookup is "unknown/error", never "no duplicate" - the caller
// must never treat a thrown error here as a clean bill of health.
export async function checkForVendorDuplicates(input: VendorDuplicateCheckInput): Promise<{ status: "unknown" | "none" | "possible" | "confirmed"; matches: VendorDuplicateMatch[]; checkedAt: string }> {
  const checkedAt = new Date().toISOString();

  try {
    const matches: VendorDuplicateMatch[] = [];

    if (input.email) {
      const email = normalizeEmail(input.email);
      const snapshot = await vendorsCollection().where("email", "==", email).limit(MATCH_QUERY_LIMIT).get();
      for (const doc of snapshot.docs) {
        if (doc.id === input.excludeVendorUid) continue;
        const vendorRef = doc.data().vendorRef;
        if (typeof vendorRef === "string") matches.push({ type: "email", ref: vendorRef, confidence: "high" });
      }
    }

    if (input.phone) {
      const phone = normalizePhone(input.phone);
      const snapshot = await vendorsCollection().where("phone", "==", phone).limit(MATCH_QUERY_LIMIT).get();
      for (const doc of snapshot.docs) {
        if (doc.id === input.excludeVendorUid) continue;
        const vendorRef = doc.data().vendorRef;
        if (typeof vendorRef === "string") matches.push({ type: "phone", ref: vendorRef, confidence: "medium" });
      }
    }

    // displayNameLower is a full-equality match here (not a prefix range
    // scan like the Workspace search) - a real name-collision signal,
    // still only ever "low" confidence since names alone aren't unique.
    if (input.displayName) {
      const displayNameLower = normalizeDisplayName(input.displayName);
      const snapshot = await vendorsCollection().where("displayNameLower", "==", displayNameLower).limit(MATCH_QUERY_LIMIT).get();
      for (const doc of snapshot.docs) {
        if (doc.id === input.excludeVendorUid) continue;
        const vendorRef = doc.data().vendorRef;
        if (typeof vendorRef === "string") matches.push({ type: "displayName", ref: vendorRef, confidence: "low" });
      }
    }

    const bounded = matches.slice(0, 10);
    const status = bounded.some((m) => m.confidence === "high") ? "confirmed" : bounded.length > 0 ? "possible" : "none";

    return { status, matches: bounded, checkedAt };
  } catch {
    return { status: "unknown", matches: [], checkedAt };
  }
}
