import type { PayableHeadDoc, PayableSourceCurrencyState } from "./types";

// Step 15A section 16: SOURCE-REVISION DETECTION.
//
// A WARNING ONLY. Comparing a Payable's pinned source versions against the versions that govern
// the same commercial basis today never mutates the Payable, never recalculates money and never
// re-pins anything. Financial history stays exactly as it was determined; acting on the warning is
// an explicit, audited, human decision (revise the Payable with refreshSource).
//
// This module is PURE so the comparison itself is unit-testable without Firestore; the service
// supplies "what governs today" by re-running the ordinary source resolution.

export type PinnedSourceVersions = Pick<PayableHeadDoc, "agreementRef" | "agreementVersion" | "sourceReviewRef" | "sourceReviewVersion">;

export type CurrentSourceVersions = { agreementRef: string; agreementVersion: number; reviewRef: string | null; reviewVersion: number | null };

export type SourceRevisionComparison = {
  state: PayableSourceCurrencyState;
  agreementRevisionAvailable: boolean;
  reviewRevisionAvailable: boolean;
};

// A newer Agreement version, a newer Review version, both, or neither.
//
// A DIFFERENT Agreement ref (not merely a newer version of the same one) also counts as an
// Agreement revision: the commercial authority for the period has changed, which is exactly the
// thing a Payable must never absorb silently.
//
// When `current` is null the current source cannot be resolved at all right now (for example the
// Review was never finalized, or the Agreements now overlap). That is NOT a revision to offer, so
// the state stays CURRENT and the service explains the situation in its message - the closed state
// set of section 16 has no "unknown" member and nothing is invented to fill one in.
export function compareSourceVersions(pinned: PinnedSourceVersions, current: CurrentSourceVersions | null): SourceRevisionComparison {
  if (!current) return { state: "CURRENT", agreementRevisionAvailable: false, reviewRevisionAvailable: false };

  const agreementRevisionAvailable = current.agreementRef !== pinned.agreementRef || current.agreementVersion !== pinned.agreementVersion;
  const reviewRevisionAvailable = current.reviewRef !== pinned.sourceReviewRef || current.reviewVersion !== pinned.sourceReviewVersion;

  const state: PayableSourceCurrencyState =
    agreementRevisionAvailable && reviewRevisionAvailable
      ? "MULTIPLE_SOURCE_REVISIONS_AVAILABLE"
      : agreementRevisionAvailable
        ? "AGREEMENT_REVISION_AVAILABLE"
        : reviewRevisionAvailable
          ? "REVIEW_REVISION_AVAILABLE"
          : "CURRENT";

  return { state, agreementRevisionAvailable, reviewRevisionAvailable };
}

export const SOURCE_REVISION_MESSAGES: Record<PayableSourceCurrencyState, string> = {
  CURRENT: "This payable is based on the source versions that govern this period today.",
  AGREEMENT_REVISION_AVAILABLE: "A different Agreement version now governs this period. This payable still uses the version it was built from; create a revised payable version to adopt the newer one.",
  REVIEW_REVISION_AVAILABLE: "A newer finalized Partner Review is available for this period. This payable still uses the review version it was built from; create a revised payable version to adopt the newer one.",
  MULTIPLE_SOURCE_REVISIONS_AVAILABLE:
    "Both the governing Agreement version and the finalized Partner Review have changed since this payable was built. It still uses the versions it was built from; create a revised payable version to adopt the newer ones.",
};
