import { getAdminFirestore } from "@/server/firebase/admin";

import { partnerReviewsCollection } from "./firestore";
import type { PartnerReviewFreshness, PartnerReviewHeadDoc, PartnerReviewVersionDoc } from "./types";

// Step 13B: the best-effort "freshness hint" written onto the head whenever
// the trusted backend ALREADY computed freshness (a single-review read, the
// freshness endpoint, or right after a mutation). It exists ONLY so list /
// overview / Partner-history views can say "as of <date>" without running the
// evidence collector once per row.
//
// Semantics, exactly:
//   - it describes the head's DEFAULT version (open, else current finalized,
//     else newest). Freshness computed for any other (historical) version is
//     never written;
//   - it is written only when the head has no hint yet or the observed state
//     DIFFERS from the recorded one. A read that re-observes the same state
//     writes nothing, so a plain read stays byte-identical on the stored head
//     (the accepted Step 13A read invariant). `checkedAt` is therefore the time
//     THAT state was recorded, and lists label it "as of <date>" - never live;
//   - it is a single-field update() of `freshnessHint` - it never touches
//     docVersion, updatedAt or any other field, so it can never make a client's
//     optimistic expectedDocVersion stale;
//   - the update runs in a transaction that RE-READS the head and writes only if
//     the head is still the very revision (docVersion) the freshness was computed
//     against and does not already record this state. Every lifecycle mutation
//     bumps the head's docVersion, so a slow reader that loaded the head before a
//     mutation can never stamp its now-outdated verdict onto the mutated head, and
//     concurrent readers of an unchanged head write at most once;
//   - failure is non-fatal: the caller's read/mutation result never depends on it;
//   - it is a HINT, never live and never authorization truth.
export async function recordFreshnessHint(head: PartnerReviewHeadDoc, version: PartnerReviewVersionDoc, freshness: PartnerReviewFreshness): Promise<void> {
  // (same rule as partner-review-service.ts's defaultVersionNumber - inlined to keep this module dependency-free.)
  if (version.version !== (head.openVersion ?? head.currentFinalizedVersion ?? head.latestVersion)) return;
  if (head.freshnessHint && head.freshnessHint.state === freshness.state) return;
  try {
    const headRef = partnerReviewsCollection().doc(head.reviewRef);
    await getAdminFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(headRef);
      if (!snap.exists) return;
      const stored = snap.data() as { docVersion?: unknown; freshnessHint?: { state?: unknown } | null } | undefined;
      // The head moved on since this freshness was computed (a lifecycle mutation bumped docVersion): the verdict
      // describes a superseded head, so it is dropped rather than recorded.
      if (stored?.docVersion !== head.docVersion) return;
      // Another reader already recorded this very state: nothing to write.
      if (stored.freshnessHint?.state === freshness.state) return;
      tx.update(headRef, { freshnessHint: { state: freshness.state, checkedAt: new Date().toISOString() } });
    });
  } catch {
    // Best-effort by design: a hint that could not be written is simply absent/older.
  }
}
