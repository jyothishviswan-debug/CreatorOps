// Step 12B: bounded, bulk, N+1-safe ref -> safe display label resolution
// for the Data Explorer. Explorer's raw source records only ever carry
// opaque refs (matchedContentRef/matchedCampaignRef/matchedPartnerRef/
// matchedPartnerAccountRef) - this is the one place those are turned
// into safe labels for the browser. Deliberately kept separate from the
// frozen /api/analytics/records route (explorer-service.ts's
// listAnalyticsSourceRecords is reused unchanged, never modified) so the
// SAME resolution works for both the server-rendered first page and
// every client-side re-fetch afterward (the client calls this endpoint
// once per fetched page, with that page's own already-authorized refs).
import { z } from "zod";

import { getCampaignDocsByRefs } from "@/server/campaigns/firestore";
import { getContentDocsByRefs } from "@/server/content/firestore";
import { getPartnerAccountDocsByRefs, getPartnerDocsByRefs } from "@/server/partners/firestore";
import type { ActorContext } from "@/server/authz/types";

import { requireAnalyticsExploreAccess } from "./analytics-gate";
import { getAnalyticsImportBatchByRef } from "./firestore";
import { analyticsInvalidInputResult, analyticsUnauthorizedResult, type AnalyticsServiceResult } from "./types";

const MAX_REFS = 50; // one bounded Explorer page is at most 100 rows; refs are deduped and never exceed that.
const refArray = z.array(z.string().min(1)).max(MAX_REFS).optional();
const inputSchema = z.object({
  contentRefs: refArray,
  campaignRefs: refArray,
  partnerRefs: refArray,
  partnerAccountRefs: refArray,
  batchRefs: refArray,
});
export type ResolveAnalyticsLabelsInput = z.input<typeof inputSchema>;

export type AnalyticsLabelMaps = {
  content: Record<string, string>;
  campaigns: Record<string, string>;
  partners: Record<string, string>;
  partnerAccounts: Record<string, string>;
  // Safe "{sourceFilename} · sheet {sheetName}"-style batch label - the
  // sheet/row are already known to the caller per-record, so this map
  // only needs to carry the batch's own real filename.
  batches: Record<string, string>;
};

function safeContentLabel(doc: { currentLinks: { platform: string }[]; currentRevisionNumber: number }): string {
  if (doc.currentLinks.length === 0) return "Content thread (no links yet)";
  const platforms = [...new Set(doc.currentLinks.map((l) => l.platform))].map((p) => (p.length > 0 ? p[0]!.toUpperCase() + p.slice(1) : p));
  return `${platforms.join(", ")} content · rev ${doc.currentRevisionNumber}`;
}

function safeAccountLabel(doc: { displayName: string | null; handle: string | null; platformAccountId: string | null }): string {
  return doc.displayName ?? doc.handle ?? doc.platformAccountId ?? "Unnamed account";
}

export async function resolveAnalyticsLabels(actor: ActorContext | null, rawInput: unknown): Promise<AnalyticsServiceResult<AnalyticsLabelMaps>> {
  const gate = await requireAnalyticsExploreAccess(actor);
  if (!gate.ok) return analyticsUnauthorizedResult(gate.reason);

  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) return analyticsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const { contentRefs = [], campaignRefs = [], partnerRefs = [], partnerAccountRefs = [], batchRefs = [] } = parsed.data;

  const [contentDocs, campaignDocs, partnerDocs, partnerAccountDocs, batchDocs] = await Promise.all([
    getContentDocsByRefs(contentRefs),
    getCampaignDocsByRefs(campaignRefs),
    getPartnerDocsByRefs(partnerRefs),
    getPartnerAccountDocsByRefs(partnerAccountRefs),
    Promise.all([...new Set(batchRefs)].map(async (ref) => [ref, await getAnalyticsImportBatchByRef(ref)] as const)),
  ]);

  const content: Record<string, string> = {};
  for (const [ref, doc] of contentDocs) content[ref] = safeContentLabel(doc);
  const campaigns: Record<string, string> = {};
  for (const [ref, doc] of campaignDocs) campaigns[ref] = doc.name;
  const partners: Record<string, string> = {};
  for (const [ref, doc] of partnerDocs) partners[ref] = doc.displayName;
  const partnerAccounts: Record<string, string> = {};
  for (const [ref, doc] of partnerAccountDocs) partnerAccounts[ref] = safeAccountLabel(doc);
  const batches: Record<string, string> = {};
  for (const [ref, doc] of batchDocs) if (doc) batches[ref] = doc.sourceFilename;

  return { ok: true, data: { content, campaigns, partners, partnerAccounts, batches } };
}
