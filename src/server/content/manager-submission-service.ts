import { z } from "zod";

import { requireAssignmentInScope } from "@/server/assignments/assignments-gate";
import { submissionRowsInputSchema, type SubmissionRow } from "@/server/assignments/external-submission-types";
import { getAssignmentDocByRef } from "@/server/assignments/firestore";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { normalizePlatformIdentifier } from "@/server/shared/platform";

import { toContentDto, type ContentDto } from "./client-dto";
import { writeContentEvent } from "./content-events";
import { requireContentAccess } from "./content-gate";
import { ASSIGNMENT_STATES_ALLOWING_CONTENT_GENERATION, resolveOrCreateContentThread } from "./content-service";
import { contentCollection, contentPublicationClaimsCollection, contentPublicationClaimId, contentRevisionsCollection } from "./firestore";
import { normalizeContentUrl, publicationUrlIdentityKey } from "./publication-identity";
import {
  contentDocSchema,
  contentInvalidInputResult,
  contentNotFoundResult,
  contentPublicationClaimDocSchema,
  contentRevisionDocSchema,
  contentUnauthorizedResult,
  type ContentDoc,
  type ContentServiceResult,
} from "./types";

// Finding #44 (user-decided): a Manager recording content links ON THE PARTNER'S BEHALF - a real,
// authenticated-actor write, mirroring external-submission-service.ts's own submitExternalLinks
// transaction shape EXACTLY (same revision numbering, same publication-identity claim-conflict handling
// - see that function's own header comment for why each of those choices exists), gated by real
// authorization (record_content_links) instead of a public bearer token.
//
// REQUIRES an Assignment context - there is no "unassigned Content" path here, matching the canonical
// Assignment -> Content lifecycle everywhere else in this codebase. A spontaneous, unassigned post with
// no Assignment counts commercially through finding #30's Analytics-post path instead; this function is
// never a backdoor into creating orphan Content records.

const recordContentLinksInputSchema = z
  .object({
    assignmentRef: z.string().min(1),
    rows: submissionRowsInputSchema,
  })
  .strict();
export type RecordContentLinksOnBehalfInput = z.input<typeof recordContentLinksInputSchema>;

type RecordTxResult = { kind: "ok"; doc: ContentDoc; revisionNumber: number } | { kind: "unusable" } | { kind: "conflict" };

export async function recordContentLinksOnBehalf(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<ContentServiceResult<ContentDto>> {
  const gate = await requireContentAccess(actor, "record_content_links");
  if (!gate.ok) return contentUnauthorizedResult(gate.reason);

  const parsed = recordContentLinksInputSchema.safeParse(rawInput);
  if (!parsed.success) return contentInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const assignment = await getAssignmentDocByRef(input.assignmentRef);
  if (!assignment) return contentInvalidInputResult("assignmentRef does not resolve to a real Assignment.");

  // Production hardening (base spec section 4): a scoped-out Assignment collapses into the same neutral
  // not-found outcome as a missing one - same discipline as every other loadAuthorized* helper.
  const scopeCheck = await requireAssignmentInScope(actor!, assignment);
  if (!scopeCheck.ok) return contentNotFoundResult();

  if (!ASSIGNMENT_STATES_ALLOWING_CONTENT_GENERATION.has(assignment.status)) {
    return contentInvalidInputResult(`Content links cannot be recorded while the Assignment is ${assignment.status}.`);
  }

  const rows: SubmissionRow[] = input.rows.map((row) => ({ platform: normalizePlatformIdentifier(row.platform), url: row.url }));

  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.platform}::${row.url}`;
    if (seen.has(key)) return contentInvalidInputResult("Duplicate platform+URL rows are not allowed in the same submission.");
    seen.add(key);
  }

  // Same rule the public path enforces: every platform must be one this Assignment's own brief allows -
  // always re-derived live, never trusted from any client-supplied context.
  const permittedPlatforms = new Set(assignment.brief.platforms);
  const notPermitted = rows.filter((row) => !permittedPlatforms.has(row.platform));
  if (notPermitted.length > 0) return contentInvalidInputResult(`Platform(s) ${notPermitted.map((r) => r.platform).join(", ")} are not permitted for this Assignment.`);

  // Idempotent get-or-create of the Assignment's CURRENT non-terminal thread (finding #50-safe - reuses
  // an open cycle, or starts a genuinely new one only once the prior cycle reached a terminal status).
  const thread = await resolveOrCreateContentThread(assignment.assignmentRef, actor!.userRef, requestId);
  if (thread.status !== "OPEN" && thread.status !== "REVISION_REQUESTED") {
    return contentInvalidInputResult("This Assignment's current submission cycle is not open for new links (it is already under review, approved, or cancelled).");
  }

  const db = getAdminFirestore();
  const contentDocRef = contentCollection().doc(thread.uid);
  const now = new Date().toISOString();

  const claimEntries = rows.map((row) => {
    const normalizedUrl = normalizeContentUrl(row.url);
    const key = publicationUrlIdentityKey(row.platform, normalizedUrl);
    return { platform: row.platform, originalUrl: row.url, normalizedUrl, key, ref: contentPublicationClaimsCollection().doc(contentPublicationClaimId(key)) };
  });

  // The transactional core, mirroring submitExternalLinks: every read via tx.getAll() before any write,
  // re-checking the thread's live status (a concurrent decision or resubmit may land between the
  // resolveOrCreateContentThread call above and this transaction), and the same cross-thread publication-
  // identity collision check (same-thread re-claim is fine; a claim owned by a DIFFERENT thread fails the
  // whole write atomically, never a partial accept).
  const txResult = await db.runTransaction<RecordTxResult>(async (tx) => {
    const refs = [contentDocRef, ...claimEntries.map((c) => c.ref)];
    const snaps = await tx.getAll(...refs);
    const contentSnap = snaps[0]!;
    const claimSnaps = snaps.slice(1);

    if (!contentSnap.exists) return { kind: "unusable" };
    const parsedContent = contentDocSchema.safeParse(contentSnap.data());
    if (!parsedContent.success) return { kind: "unusable" };
    const freshThread = parsedContent.data;
    if (freshThread.status !== "OPEN" && freshThread.status !== "REVISION_REQUESTED") return { kind: "unusable" };

    for (let i = 0; i < claimEntries.length; i += 1) {
      const snap = claimSnaps[i];
      if (!snap?.exists) continue;
      const parsedClaim = contentPublicationClaimDocSchema.safeParse(snap.data());
      if (parsedClaim.success && parsedClaim.data.contentUid !== freshThread.uid) return { kind: "conflict" };
    }

    const revisionNumber = freshThread.currentRevisionNumber + 1;
    const revisionUid = contentRevisionsCollection(freshThread.uid).doc().id;
    const revisionDoc = contentRevisionDocSchema.parse({
      uid: revisionUid,
      revisionNumber,
      rows: claimEntries.map((c) => ({ platform: c.platform, originalUrl: c.originalUrl, normalizedUrl: c.normalizedUrl })),
      // Finding #44: MANAGER - a real, honest recipientType. The Manager recorded this on the Partner's
      // behalf; it is never misrepresented as a PARTNER or VENDOR self-submission.
      recipientType: "MANAGER",
      recipientRef: actor!.userRef,
      submittedAt: now,
    });
    tx.set(contentRevisionsCollection(freshThread.uid).doc(revisionUid), revisionDoc);

    const updatedThread: ContentDoc = {
      ...freshThread,
      status: "UNDER_REVIEW",
      statusReason: null,
      currentRevisionNumber: revisionNumber,
      reviewedRevisionNumber: revisionNumber,
      currentLinks: claimEntries.map((c) => ({ platform: c.platform, originalUrl: c.originalUrl, normalizedUrl: c.normalizedUrl, recordedAt: now })),
      firstSubmittedAt: freshThread.firstSubmittedAt ?? now,
      lastSubmittedAt: now,
      version: freshThread.version + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    tx.set(contentDocRef, updatedThread);

    for (const entry of claimEntries) {
      tx.set(entry.ref, contentPublicationClaimDocSchema.parse({ key: entry.key, contentRef: freshThread.contentRef, contentUid: freshThread.uid, revisionNumber, claimedAt: now }));
    }

    return { kind: "ok", doc: updatedThread, revisionNumber };
  });

  if (txResult.kind === "unusable") return contentInvalidInputResult("This Assignment's current submission cycle is no longer open for new links.");
  if (txResult.kind === "conflict") return contentInvalidInputResult("One or more of these links already belong to a different Content record.");

  await writeContentEvent({
    contentUid: txResult.doc.uid,
    kind: "submitted",
    actorUserRef: actor!.userRef,
    metadata: { assignmentRef: assignment.assignmentRef, revisionNumber: txResult.revisionNumber, recordedOnBehalf: true },
    requestId,
  });

  return { ok: true, data: await toContentDto(txResult.doc) };
}
