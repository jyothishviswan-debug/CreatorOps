import { getPartnerAccountDocByRef, partnerAccountIdentityClaimsCollection, partnersCollection } from "./firestore";
import { claimIdFor, computeNormalizedIdentity } from "./identity";
import type { PartnerDuplicateMatch } from "./types";

const MATCH_QUERY_LIMIT = 5;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/g, "");
}

export type PartnerDuplicateCheckInput = {
  email?: string;
  phone?: string;
  // Account-identity evidence, same shape createPartnerAccount takes -
  // an exact claim-collection lookup, not a query, so this is O(1)
  // regardless of how many Partner Accounts exist.
  accountIdentity?: { platform: string; platformAccountId?: string | null; profileUrl?: string | null; handle?: string | null };
  // Discovery provenance, when the caller already knows which Lead this
  // would-be Partner came from - a Lead converts to at most one Partner,
  // so a hit here is near-certain.
  originLeadRef?: string;
  // Excludes the Partner being re-checked from its own match set.
  excludePartnerUid?: string;
};

// Step 7A section 6: bounded, normalized, advisory duplicate lookup
// before a direct Partner create. Deliberately NOT a global uniqueness
// lock for email/phone/name (two real people can legitimately share an
// email inbox or phone number in edge cases, and this is a person-level
// signal, not a cryptographic key) - confidence-graded like Discovery's
// own checkForDuplicates. Partner Account normalized identity is the one
// dimension that IS concurrency-safe unique (enforced by the identity
// claim collection itself, not by this check - see
// partner-account-service.ts); this function only reports it here so a
// direct-create flow gets the same advisory signal before attempting a
// create that the transactional claim would reject anyway.
//
// A failed lookup is "unknown/error", never "no duplicate" - the caller
// must never treat a thrown error here as a clean bill of health.
export async function checkForPartnerDuplicates(input: PartnerDuplicateCheckInput): Promise<{ status: "unknown" | "none" | "possible" | "confirmed"; matches: PartnerDuplicateMatch[]; checkedAt: string }> {
  const checkedAt = new Date().toISOString();

  try {
    const matches: PartnerDuplicateMatch[] = [];

    if (input.email) {
      const email = normalizeEmail(input.email);
      const snapshot = await partnersCollection().where("email", "==", email).limit(MATCH_QUERY_LIMIT).get();
      for (const doc of snapshot.docs) {
        if (doc.id === input.excludePartnerUid) continue;
        const partnerRef = doc.data().partnerRef;
        if (typeof partnerRef === "string") matches.push({ type: "email", ref: partnerRef, confidence: "high" });
      }
    }

    if (input.phone) {
      const phone = normalizePhone(input.phone);
      const snapshot = await partnersCollection().where("phone", "==", phone).limit(MATCH_QUERY_LIMIT).get();
      for (const doc of snapshot.docs) {
        if (doc.id === input.excludePartnerUid) continue;
        const partnerRef = doc.data().partnerRef;
        if (typeof partnerRef === "string") matches.push({ type: "phone", ref: partnerRef, confidence: "medium" });
      }
    }

    if (input.accountIdentity) {
      const normalizedIdentity = computeNormalizedIdentity(input.accountIdentity);
      if (normalizedIdentity) {
        const claimSnap = await partnerAccountIdentityClaimsCollection().doc(claimIdFor(normalizedIdentity)).get();
        if (claimSnap.exists) {
          const claim = claimSnap.data();
          const partnerAccountRef = claim?.partnerAccountRef;
          // The claim names the Partner Account, not the Partner
          // directly - resolve it so the reported ref is always a
          // partnerRef, consistent with the other match types. A
          // dangling claim (its account was somehow removed) resolves to
          // nothing and is simply not reported as a match.
          if (typeof partnerAccountRef === "string") {
            // Not exclusion-filtered - this check only ever runs before
            // a Partner (and so before any of its own accounts) exists,
            // so there is nothing of the excluded Partner's own to
            // accidentally match here.
            const account = await getPartnerAccountDocByRef(partnerAccountRef);
            if (account) matches.push({ type: "accountIdentity", ref: account.partnerRef, confidence: "high" });
          }
        }
      }
    }

    if (input.originLeadRef) {
      const snapshot = await partnersCollection().where("originLeadRefs", "array-contains", input.originLeadRef).limit(MATCH_QUERY_LIMIT).get();
      for (const doc of snapshot.docs) {
        if (doc.id === input.excludePartnerUid) continue;
        const partnerRef = doc.data().partnerRef;
        if (typeof partnerRef === "string") matches.push({ type: "originLeadRef", ref: partnerRef, confidence: "high" });
      }
    }

    const bounded = matches.slice(0, 10);
    const status = bounded.some((m) => m.confidence === "high") ? "confirmed" : bounded.length > 0 ? "possible" : "none";

    return { status, matches: bounded, checkedAt };
  } catch {
    return { status: "unknown", matches: [], checkedAt };
  }
}
