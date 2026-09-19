import { z } from "zod";

import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { platformIdentifierSchema } from "@/server/shared/platform";

import { requireAnalyticsExploreAccess } from "./analytics-gate";
import {
  listAnalyticsChannelSourceRecordDocs,
  listAnalyticsContentSourceRecordDocs,
  type AnalyticsSourceRecordListCursor,
} from "./firestore";
import { analyticsInvalidInputResult, analyticsUnauthorizedResult, type AnalyticsChannelSourceRecordDoc, type AnalyticsContentSourceRecordDoc, type AnalyticsServiceResult } from "./types";

// Step 12A section 15: Data Explorer server contract -
// listAnalyticsSourceRecords. Lists RAW imported source records (never
// read-model aggregates - see read-models.ts for those), scope-
// constrained BEFORE retrieval via the exact same scoped-list.ts pattern
// every other domain uses (see firestore.ts's
// planAnalyticsSourceRecordListQuery/listScopedAnalyticsSourceRecords),
// bounded page size, cursor pagination, deterministic order (createdAt
// desc). No fetch-all-then-filter, no raw-ID fallback for authorization.
// Filters: record kind (content vs channel - queries the right
// collection), platform, match state, Campaign/Partner/Partner Account/
// Content ref (once matched), import batch ref/source revision lineage
// (batchRef). Missing metric values stay `null`/absent in the DTO -
// never `0` - rendered later (Explorer UI, out of scope for this step)
// as "Unavailable".
const listInputSchema = z.object({
  recordKind: z.enum(["content", "channel"]),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.record(z.string(), z.unknown()).optional(),
  matchState: z.enum(["MATCHED", "UNMATCHED", "AMBIGUOUS"]).optional(),
  // Step 12D: normalized with the ONE shared platform-identifier contract
  // (trim + lowercase) BEFORE it reaches the query, because stored source
  // records only ever carry the normalized id - a raw "Instagram" / " YOUTUBE "
  // filter would otherwise silently match nothing. Whitespace-only / over-long
  // values are rejected as invalid input rather than quietly matching nothing.
  platform: platformIdentifierSchema.optional(),
  batchRef: z.string().min(1).optional(),
  matchedCampaignRef: z.string().min(1).optional(),
  matchedPartnerRef: z.string().min(1).optional(),
  matchedPartnerAccountRef: z.string().min(1).optional(),
  matchedContentRef: z.string().min(1).optional(),
});
export type ListAnalyticsSourceRecordsInput = z.input<typeof listInputSchema>;

export type ListAnalyticsSourceRecordsResult =
  | { recordKind: "content"; records: AnalyticsContentSourceRecordDoc[]; nextCursor: AnalyticsSourceRecordListCursor | null }
  | { recordKind: "channel"; records: AnalyticsChannelSourceRecordDoc[]; nextCursor: AnalyticsSourceRecordListCursor | null };

export async function listAnalyticsSourceRecords(actor: ActorContext | null, rawInput: unknown): Promise<AnalyticsServiceResult<ListAnalyticsSourceRecordsResult>> {
  const gate = await requireAnalyticsExploreAccess(actor);
  if (!gate.ok) return analyticsUnauthorizedResult(gate.reason);

  const parsed = listInputSchema.safeParse(rawInput);
  if (!parsed.success) return analyticsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const grants = await getActorScopeGrants(actor!);
  const options = {
    actorUid: actor!.uid,
    grants,
    hasGlobal: hasGlobalScope(grants),
    limit: input.limit ?? 20,
    cursor: input.cursor as AnalyticsSourceRecordListCursor | undefined,
    matchState: input.matchState,
    platform: input.platform,
    batchRef: input.batchRef,
    matchedCampaignRef: input.matchedCampaignRef,
    matchedPartnerRef: input.matchedPartnerRef,
    matchedPartnerAccountRef: input.matchedPartnerAccountRef,
    matchedContentRef: input.matchedContentRef,
  };

  if (input.recordKind === "content") {
    const page = await listAnalyticsContentSourceRecordDocs(options);
    return { ok: true, data: { recordKind: "content", records: page.records, nextCursor: page.nextCursor } };
  }

  const page = await listAnalyticsChannelSourceRecordDocs(options);
  return { ok: true, data: { recordKind: "channel", records: page.records, nextCursor: page.nextCursor } };
}
