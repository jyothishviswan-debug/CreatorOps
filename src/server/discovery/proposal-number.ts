// Step 6B.1: compact per-platform proposal numbering, used to name each
// Lead's KYC-document Drive subfolder (e.g. "IG_60_Mrinal Jha"). A
// number is allocated exactly once per Lead, the first time its
// Agreement evidence is confirmed - see lead-service.ts's
// saveDiscoveryAgreement, which reads/writes this counter inside the
// SAME transaction as the Agreement save.

// Instagram/YouTube are explicit per the brief; anything else falls
// back to a short deterministic abbreviation so every Lead still gets a
// real code, never a blank one. Extend this table as new platforms come
// up - it is intentionally a plain lookup, not a schema-level enum,
// since Lead.platform itself is free text.
const PLATFORM_CODES: Record<string, string> = {
  instagram: "IG",
  youtube: "YT",
  facebook: "FB",
  twitter: "X",
  x: "X",
  tiktok: "TT",
  linkedin: "LI",
  snapchat: "SC",
  pinterest: "PN",
};

export function platformCodeFor(platform: string | null): string {
  const normalized = (platform ?? "").trim().toLowerCase();
  if (!normalized) return "GEN";
  const known = PLATFORM_CODES[normalized];
  if (known) return known;
  const letters = normalized.replace(/[^a-z0-9]/g, "").slice(0, 3).toUpperCase();
  return letters || "GEN";
}

export const PROPOSAL_COUNTERS_COLLECTION = "discoveryProposalCounters";

// Reads the given platform code's counter document and returns the next
// number to allocate WITHOUT writing anything - the caller (already
// inside a transaction) is responsible for writing the incremented
// value back via `nextProposalCounterWrite`, once all of that
// transaction's other reads are also done (Firestore requires every
// transaction read before any write).
export async function readNextProposalNumber(tx: FirebaseFirestore.Transaction, db: FirebaseFirestore.Firestore, code: string): Promise<{ next: number; ref: FirebaseFirestore.DocumentReference }> {
  const ref = db.collection(PROPOSAL_COUNTERS_COLLECTION).doc(code);
  const snap = await tx.get(ref);
  const current = snap.exists ? (snap.data()?.next as number | undefined) : undefined;
  return { next: current ?? 1, ref };
}
