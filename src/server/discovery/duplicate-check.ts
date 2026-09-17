import { leadsCollection, partnerAccountsCollection, partnersCollection } from "./firestore";
import type { DuplicateCheckResult, DuplicateMatch } from "./types";

// Bounded per-field lookup limit - "check relevant existing records", not
// "fetch everything and filter". Five is enough to report a handful of
// matches without ever becoming an unbounded scan.
const MATCH_QUERY_LIMIT = 5;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/g, "");
}

function normalizeUrl(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, "");
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "");
}

function normalizeDisplayName(value: string): string {
  return value.trim().toLowerCase();
}

export type DuplicateCheckInput = {
  email?: string;
  phone?: string;
  profileUrl?: string;
  handle?: string;
  displayName?: string;
  // Excludes the Lead being re-checked from its own match set (a Lead
  // always "matches itself" trivially on identity fields, which is not
  // a duplicate).
  excludeLeadUid?: string;
};

async function matchLeadsByField(field: "email" | "phone" | "profileUrl" | "handle", value: string, excludeLeadUid: string | undefined, confidence: DuplicateMatch["confidence"]): Promise<DuplicateMatch[]> {
  const snapshot = await leadsCollection().where(field, "==", value).limit(MATCH_QUERY_LIMIT).get();
  const matches: DuplicateMatch[] = [];
  for (const doc of snapshot.docs) {
    if (doc.id === excludeLeadUid) continue;
    const leadRef = doc.data().leadRef;
    if (typeof leadRef === "string") matches.push({ type: field, source: "lead", ref: leadRef, confidence });
  }
  return matches;
}

// Name alone is never unique (two different creators can share a
// name), so this is deliberately "low" confidence only and, unlike the
// other fields, only checked against existing Leads - Partners have no
// normalized/lowercased name field to query against.
async function matchLeadsByDisplayName(value: string, excludeLeadUid: string | undefined): Promise<DuplicateMatch[]> {
  const snapshot = await leadsCollection().where("displayNameLower", "==", value).limit(MATCH_QUERY_LIMIT).get();
  const matches: DuplicateMatch[] = [];
  for (const doc of snapshot.docs) {
    if (doc.id === excludeLeadUid) continue;
    const leadRef = doc.data().leadRef;
    if (typeof leadRef === "string") matches.push({ type: "displayName", source: "lead", ref: leadRef, confidence: "low" });
  }
  return matches;
}

async function matchPartnersByField(field: "email" | "phone", value: string, confidence: DuplicateMatch["confidence"]): Promise<DuplicateMatch[]> {
  const snapshot = await partnersCollection().where(field, "==", value).limit(MATCH_QUERY_LIMIT).get();
  const matches: DuplicateMatch[] = [];
  for (const doc of snapshot.docs) {
    const partnerRef = doc.data().partnerRef;
    if (typeof partnerRef === "string") matches.push({ type: field, source: "partner", ref: partnerRef, confidence });
  }
  return matches;
}

async function matchPartnerAccountsByField(field: "profileUrl" | "handle", value: string, confidence: DuplicateMatch["confidence"]): Promise<DuplicateMatch[]> {
  const snapshot = await partnerAccountsCollection().where(field, "==", value).limit(MATCH_QUERY_LIMIT).get();
  const matches: DuplicateMatch[] = [];
  for (const doc of snapshot.docs) {
    const partnerAccountRef = doc.data().partnerAccountRef;
    if (typeof partnerAccountRef === "string") matches.push({ type: field, source: "partner_account", ref: partnerAccountRef, confidence });
  }
  return matches;
}

// Step 6A section 6: bounded normalized duplicate lookup across email,
// phone, profile URL, handle/platform identity, and display name -
// checked against existing Leads and canonical Partner/Partner Account
// records where evidence supports it. A failed lookup is "unknown/error", NEVER "no
// duplicate" - the caller must never treat a thrown error here as a
// clean bill of health. This does not and cannot claim a global
// uniqueness lock; it is a best-effort signal with explicit
// confidence/type/source per match.
export async function checkForDuplicates(input: DuplicateCheckInput): Promise<DuplicateCheckResult> {
  const checkedAt = new Date().toISOString();

  try {
    const matches: DuplicateMatch[] = [];

    if (input.email) {
      const email = normalizeEmail(input.email);
      matches.push(...(await matchLeadsByField("email", email, input.excludeLeadUid, "high")));
      matches.push(...(await matchPartnersByField("email", email, "high")));
    }
    if (input.phone) {
      const phone = normalizePhone(input.phone);
      matches.push(...(await matchLeadsByField("phone", phone, input.excludeLeadUid, "medium")));
      matches.push(...(await matchPartnersByField("phone", phone, "medium")));
    }
    if (input.profileUrl) {
      const url = normalizeUrl(input.profileUrl);
      matches.push(...(await matchLeadsByField("profileUrl", url, input.excludeLeadUid, "high")));
      matches.push(...(await matchPartnerAccountsByField("profileUrl", url, "high")));
    }
    if (input.handle) {
      const handle = normalizeHandle(input.handle);
      matches.push(...(await matchLeadsByField("handle", handle, input.excludeLeadUid, "high")));
      matches.push(...(await matchPartnerAccountsByField("handle", handle, "high")));
    }
    if (input.displayName) {
      const displayName = normalizeDisplayName(input.displayName);
      matches.push(...(await matchLeadsByDisplayName(displayName, input.excludeLeadUid)));
    }

    const bounded = matches.slice(0, 10);
    const status = bounded.some((m) => m.confidence === "high") ? "confirmed" : bounded.length > 0 ? "possible" : "none";

    return { status, matches: bounded, checkedAt };
  } catch {
    // Any Firestore/read failure - never silently reported as "none".
    return { status: "unknown", matches: [], checkedAt };
  }
}
