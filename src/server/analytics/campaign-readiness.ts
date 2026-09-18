import { contentCollection } from "@/server/content/firestore";
import type { ContentDoc } from "@/server/content/types";

import { analyticsContentSourceRecordsCollection, MAX_CAMPAIGN_READINESS_RECORDS } from "./firestore";
import type { AnalyticsContentSourceRecordDoc } from "./types";

// Step 12A section 24: the ONE new Campaign-facing function this step
// builds - purely additive, called by nobody yet in this step except its
// own tests. NOT wired into src/app/campaigns/page.tsx's "Tracking
// Readiness" slot or anywhere else in Campaign UI - that wiring is
// explicitly out of scope here; this exists only so a later Campaign
// integration step doesn't need to rescan raw Analytics data itself.
//
// "Readiness" here means: of this Campaign's own Content threads (the
// real, canonical obligations a Campaign actually has), how many already
// have at least one Analytics source record matched to them, versus how
// many don't yet. This is a genuinely more useful readiness signal than
// literally counting UNMATCHED analytics rows tagged with this Campaign
// - an unmatched row can never carry a matchedCampaignRef in the first
// place (matchedCampaignRef is only ever populated once a row is
// MATCHED - see content-matcher.ts), so "how many unmatched rows does
// this campaign have" is not a coherent question against this data
// model; "how many of this campaign's own Content threads still have no
// analytics data linked" is.
export type CampaignAnalyticsReadiness = {
  hasLinkedSourceRecords: boolean;
  matchedCount: number;
  unmatchedCount: number;
  lastDataAt: string | null;
};

const MAX_IN_CHUNK = 30; // Firestore's own `in` operator cap.

export async function evaluateCampaignAnalyticsReadiness(campaignRef: string): Promise<CampaignAnalyticsReadiness> {
  const threadsSnapshot = await contentCollection().where("campaignRef", "==", campaignRef).limit(MAX_CAMPAIGN_READINESS_RECORDS).get();
  const contentRefs = threadsSnapshot.docs.map((doc) => (doc.data() as ContentDoc).contentRef);

  if (contentRefs.length === 0) {
    return { hasLinkedSourceRecords: false, matchedCount: 0, unmatchedCount: 0, lastDataAt: null };
  }

  const matchedContentRefs = new Set<string>();
  let lastDataAt: string | null = null;

  for (let i = 0; i < contentRefs.length; i += MAX_IN_CHUNK) {
    const chunk = contentRefs.slice(i, i + MAX_IN_CHUNK);
    const snapshot = await analyticsContentSourceRecordsCollection().where("matchedContentRef", "in", chunk).get();
    for (const doc of snapshot.docs) {
      const record = doc.data() as AnalyticsContentSourceRecordDoc;
      if (record.matchedContentRef) matchedContentRefs.add(record.matchedContentRef);
      if (!lastDataAt || record.createdAt > lastDataAt) lastDataAt = record.createdAt;
    }
  }

  const matchedCount = matchedContentRefs.size;
  const unmatchedCount = contentRefs.length - matchedCount;

  return { hasLinkedSourceRecords: matchedCount > 0, matchedCount, unmatchedCount, lastDataAt };
}
