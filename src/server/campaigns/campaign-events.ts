import { randomUUID } from "node:crypto";

import { campaignEventsCollection } from "./firestore";
import { campaignEventSchema, type CampaignEvent, type CampaignEventKind } from "./types";

// Same defense-in-depth redaction discipline as Vendors'/Partners' own
// events modules - Campaign never handles restricted identity, but future
// Agreement/Finance text must never leak into this durable, append-only
// collection either, even by a future caller's mistake.
const FORBIDDEN_METADATA_KEY_SUBSTRINGS = ["password", "token", "secret", "credential", "cookie", "pan", "bank", "ifsc", "iban", "account_number", "accountnumber", "gst", "amount", "rate"];

function redact(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_METADATA_KEY_SUBSTRINGS.some((bad) => lower.includes(bad))) continue;
    clean[key] = value;
  }
  return clean;
}

export type WriteCampaignEventInput = {
  campaignUid: string;
  kind: CampaignEventKind;
  actorUserRef: string;
  metadata: Record<string, unknown> | null;
  requestId: string;
};

// The append-only per-Campaign event/audit history - same pattern as
// Vendors'/Partners' own event modules. Never deleted, never rewritten -
// a lifecycle transition only ever appends its own event.
export async function writeCampaignEvent(input: WriteCampaignEventInput): Promise<void> {
  const event: CampaignEvent = {
    kind: input.kind,
    actorUserRef: input.actorUserRef,
    metadata: redact(input.metadata),
    requestId: input.requestId,
    createdAt: new Date().toISOString(),
  };
  const parsed = campaignEventSchema.parse(event);
  await campaignEventsCollection(input.campaignUid).doc(randomUUID()).set(parsed);
}

export type CampaignEventListCursor = { createdAt: string; id: string };

// Deterministic (newest first, doc id as tiebreak), bounded cursor
// pagination over one Campaign's own event history - never a whole-
// subcollection fetch.
export async function listCampaignEvents(campaignUid: string, options: { limit: number; cursor?: CampaignEventListCursor }): Promise<{ events: (CampaignEvent & { id: string })[]; nextCursor: CampaignEventListCursor | null }> {
  const pageSize = Math.max(1, Math.min(options.limit, 100));

  let query = campaignEventsCollection(campaignUid).orderBy("createdAt", "desc").orderBy("__name__").limit(pageSize + 1);
  if (options.cursor) query = query.startAfter(options.cursor.createdAt, options.cursor.id);

  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const hasMore = snapshot.docs.length > pageSize;

  const events: (CampaignEvent & { id: string })[] = [];
  for (const doc of pageDocs) {
    const result = campaignEventSchema.safeParse(doc.data());
    if (result.success) events.push({ ...result.data, id: doc.id });
  }

  const last = events[events.length - 1];
  const nextCursor = hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;

  return { events, nextCursor };
}
