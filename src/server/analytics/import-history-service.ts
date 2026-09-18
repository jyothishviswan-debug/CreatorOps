import { z } from "zod";

import { getUserDocByRef } from "@/server/authz/firestore";
import type { ActorContext } from "@/server/authz/types";

import { requireAnalyticsExploreAccess } from "./analytics-gate";
import { analyticsImportBatchesCollection, findAnalyticsImportBatchSupersededBy, getAnalyticsImportBatchByRef } from "./firestore";
import { analyticsImportBatchDocSchema, analyticsInvalidInputResult, analyticsNotFoundResult, analyticsUnauthorizedResult, type AnalyticsImportBatchDoc, type AnalyticsServiceResult } from "./types";

// Step 12A section 16: Import History server contract. Batches are
// global governance/provenance records (not per-record region/team
// scoped the way Content/Partner are) - visibility is gated purely on
// the Analytics "explore" feature/action, same as every other read-only
// Analytics surface. Never exposes a raw actor uid, a stack trace, a
// filesystem path, or a storage secret - actorUserRef is always resolved
// to a safe display name before leaving this module.

export type AnalyticsImportBatchListItemDto = AnalyticsImportBatchDoc & { actorDisplayName: string | null };

const MAX_BATCH_PAGE_SIZE = 100;

const listInputSchema = z.object({
  limit: z.number().int().min(1).max(MAX_BATCH_PAGE_SIZE).optional(),
  cursor: z.object({ createdAt: z.string().min(1), uid: z.string().min(1) }).optional(),
  targetKind: z.enum(["campaign_content", "channel_account"]).optional(),
  status: z.string().min(1).optional(),
});
export type ListAnalyticsImportBatchesInput = z.input<typeof listInputSchema>;
export type AnalyticsImportBatchListCursor = { createdAt: string; uid: string };

async function resolveActorDisplayNames(batches: AnalyticsImportBatchDoc[]): Promise<Map<string, string | null>> {
  const uniqueRefs = [...new Set(batches.map((b) => b.actorUserRef))];
  const entries = await Promise.all(uniqueRefs.map(async (ref) => [ref, (await getUserDocByRef(ref))?.displayName ?? null] as const));
  return new Map(entries);
}

export async function listAnalyticsImportBatches(
  actor: ActorContext | null,
  rawInput: unknown,
): Promise<AnalyticsServiceResult<{ batches: AnalyticsImportBatchListItemDto[]; nextCursor: AnalyticsImportBatchListCursor | null }>> {
  const gate = await requireAnalyticsExploreAccess(actor);
  if (!gate.ok) return analyticsUnauthorizedResult(gate.reason);

  const parsed = listInputSchema.safeParse(rawInput);
  if (!parsed.success) return analyticsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;
  const pageSize = input.limit ?? 20;

  let query = analyticsImportBatchesCollection().orderBy("createdAt", "desc").orderBy("uid").limit(pageSize + 1) as FirebaseFirestore.Query;
  if (input.targetKind) query = query.where("targetKind", "==", input.targetKind);
  if (input.status) query = query.where("status", "==", input.status);
  if (input.cursor) query = query.startAfter(input.cursor.createdAt, input.cursor.uid);

  const snapshot = await query.get();
  const rawDocs = snapshot.docs.slice(0, pageSize);
  const batches: AnalyticsImportBatchDoc[] = [];
  for (const doc of rawDocs) {
    const result = analyticsImportBatchDocSchema.safeParse(doc.data());
    if (result.success) batches.push(result.data);
  }

  const names = await resolveActorDisplayNames(batches);
  const items = batches.map((b) => ({ ...b, actorDisplayName: names.get(b.actorUserRef) ?? null }));

  const hasMore = snapshot.docs.length > pageSize;
  const last = rawDocs[rawDocs.length - 1];
  const nextCursor = hasMore && last ? { createdAt: (last.data() as AnalyticsImportBatchDoc).createdAt, uid: last.id } : null;

  return { ok: true, data: { batches: items, nextCursor } };
}

export type AnalyticsImportBatchDetailDto = AnalyticsImportBatchListItemDto & {
  supersededByBatchRef: string | null; // set when a LATER batch supersedes this one
  correctionEligible: boolean; // true only when nothing else already supersedes this batch
};

export async function getAnalyticsImportBatchDetail(actor: ActorContext | null, batchRef: unknown): Promise<AnalyticsServiceResult<AnalyticsImportBatchDetailDto>> {
  const gate = await requireAnalyticsExploreAccess(actor);
  if (!gate.ok) return analyticsUnauthorizedResult(gate.reason);

  if (typeof batchRef !== "string" || batchRef.length === 0) return analyticsInvalidInputResult("Missing batchRef.");
  const batch = await getAnalyticsImportBatchByRef(batchRef);
  if (!batch) return analyticsNotFoundResult("Import batch not found.");

  const [names, supersededBy] = await Promise.all([resolveActorDisplayNames([batch]), findAnalyticsImportBatchSupersededBy(batchRef)]);

  return {
    ok: true,
    data: {
      ...batch,
      actorDisplayName: names.get(batch.actorUserRef) ?? null,
      supersededByBatchRef: supersededBy?.batchRef ?? null,
      // A batch already superseded by a newer revision is no longer a
      // valid target for a FURTHER correction (see import-service.ts's
      // own stale-correction guard) - surfaced here so a caller can
      // decide whether to even offer a "correct this batch" action.
      correctionEligible: !supersededBy,
    },
  };
}
