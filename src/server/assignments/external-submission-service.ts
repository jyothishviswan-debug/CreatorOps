import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import type { ActorContext } from "@/server/authz/types";
import { getPartnerDocByRef } from "@/server/partners/firestore";
import { getVendorDocByRef, vendorPartnerActiveClaimsCollection } from "@/server/vendors/firestore";
import { vendorPartnerActiveClaimDocSchema } from "@/server/vendors/types";
import { normalizePlatformIdentifier } from "@/server/shared/platform";
import { resolveOrCreateContentThread } from "@/server/content/content-service";
import { writeContentEvent } from "@/server/content/content-events";
import { contentCollection, contentPublicationClaimId, contentPublicationClaimsCollection, contentRevisionsCollection, getContentDocByRef } from "@/server/content/firestore";
import { normalizeContentUrl, publicationUrlIdentityKey } from "@/server/content/publication-identity";
import { contentDocSchema, contentPublicationClaimDocSchema, contentRevisionDocSchema, type ContentDoc } from "@/server/content/types";
import { loadAuthorizedAssignment } from "./assignment-service";
import { writeAssignmentEvent } from "./assignment-events";
import { assignmentsCollection, assignmentSubmissionSessionsCollection, getAssignmentDocByRef, getSubmissionSessionDocByRef } from "./firestore";
import { generateSubmissionSessionRef } from "./ids";
import { assignmentDocSchema, assignmentsConflictResult, assignmentsInvalidInputResult, type AssignmentDoc, type AssignmentsServiceResult } from "./types";
import {
  assignmentSubmissionSessionDocSchema,
  submissionRecipientTypeSchema,
  submissionRowsInputSchema,
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS,
  MIN_SESSION_EXPIRY_MS,
  type AssignmentSubmissionSessionDoc,
  type PublicAssignmentSubmissionDto,
  type SubmissionRecipientType,
} from "./external-submission-types";

// ---- Token generation/hashing --------------------------------------------
// 256-bit CSPRNG token, base64url-encoded (safe to embed directly in a
// URL). Only the sha256 fingerprint is ever persisted (Step 10A section
// 9's explicit rule: "never store the raw bearer token after creation").
// createHash("sha256") mirrors the one existing precedent in this repo
// (src/server/partners/identity.ts's normalized-identity claim id).
function generateSubmissionToken(): string {
  return randomBytes(32).toString("base64url");
}
function hashSubmissionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

// The Assignment states a submission session may be created for, and that
// public access/submission re-checks against - Step 10A section 11's
// "Assignment cancellation/non-accepting state invalidates use". DRAFT is
// excluded (nothing has been issued yet to submit against); COMPLETED is
// excluded from CREATION (nothing new should be issued once the
// Assignment's one thread has already been approved and closed it) -
// but NOT from public resolution/rendering, see loadValidSession below.
const ASSIGNMENT_STATES_ACCEPTING_SUBMISSION: ReadonlySet<AssignmentDoc["status"]> = new Set(["ASSIGNED", "ACCEPTED", "IN_PROGRESS"]);

// The one safe shape a session is ever handed back to STAFF in - never
// the tokenHash/doc id (see external-submission-types.ts's own comment).
export type SafeSubmissionSessionDto = {
  sessionRef: string;
  assignmentRef: string;
  recipientType: AssignmentSubmissionSessionDoc["recipientType"];
  recipientRef: string;
  state: AssignmentSubmissionSessionDoc["state"];
  createdAt: string;
  expiresAt: string;
  lastSubmittedAt: string | null;
  revokedAt: string | null;
};

function toSafeSessionDto(doc: AssignmentSubmissionSessionDoc): SafeSubmissionSessionDto {
  return {
    sessionRef: doc.sessionRef,
    assignmentRef: doc.assignmentRef,
    recipientType: doc.recipientType,
    recipientRef: doc.recipientRef,
    state: doc.state,
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
    lastSubmittedAt: doc.lastSubmittedAt,
    revokedAt: doc.revokedAt,
  };
}

// A session is eligible for reuse (Section 12's "for the same Assignment
// + intended recipient + active canonical submission thread, do not
// create competing public revision links") when it is still ACTIVE, not
// time-expired, and its linked Content thread has not yet reached a
// closed state (APPROVED/CANCELLED) - OPEN/UNDER_REVIEW/REVISION_REQUESTED
// are all still "the same live conversation" the same page should keep
// serving.
async function findEligibleActiveSession(assignmentRef: string, recipientType: SubmissionRecipientType, recipientRef: string): Promise<AssignmentSubmissionSessionDoc | null> {
  const snapshot = await assignmentSubmissionSessionsCollection()
    .where("assignmentRef", "==", assignmentRef)
    .where("recipientType", "==", recipientType)
    .where("recipientRef", "==", recipientRef)
    .where("state", "==", "ACTIVE")
    .get();

  const now = Date.now();
  for (const doc of snapshot.docs) {
    const parsed = assignmentSubmissionSessionDocSchema.safeParse(doc.data());
    if (!parsed.success) continue;
    const session = parsed.data;
    if (new Date(session.expiresAt).getTime() <= now) continue;
    const thread = await getContentDocByRef(session.contentRef);
    if (!thread) continue;
    if (thread.status === "APPROVED" || thread.status === "CANCELLED") continue;
    return session;
  }
  return null;
}

// ---- Read: does an eligible active session already exist? ---------------
// Section 12's "the Share dialog should proactively check BEFORE
// attempting creation" - a new small trusted read, same action gate as
// session creation/revoke, so the dialog can adjust its own UI instead of
// blind create-then-fail.
export async function getActiveSubmissionSessionForRecipient(
  actor: ActorContext | null,
  assignmentRef: unknown,
  recipientType: unknown,
  recipientRef: unknown,
): Promise<AssignmentsServiceResult<{ session: SafeSubmissionSessionDto | null }>> {
  const loaded = await loadAuthorizedAssignment(actor, assignmentRef, "manage_assignment_external_submission");
  if (!loaded.ok) return loaded.error;

  const parsedRecipientType = submissionRecipientTypeSchema.safeParse(recipientType);
  if (!parsedRecipientType.success) return assignmentsInvalidInputResult("Invalid recipientType.");
  const resolvedRecipientRef = parsedRecipientType.data === "PARTNER" ? loaded.assignment.partnerRef : recipientRef;
  if (typeof resolvedRecipientRef !== "string" || resolvedRecipientRef.length === 0) return assignmentsInvalidInputResult("Missing recipientRef.");

  const existing = await findEligibleActiveSession(loaded.assignment.assignmentRef, parsedRecipientType.data, resolvedRecipientRef);
  return { ok: true, data: { session: existing ? toSafeSessionDto(existing) : null } };
}

// ---- Create session (internal, staff-triggered ONLY - never automatic) --
// Step 10A's own correction: nothing anywhere calls this merely because
// an Assignment exists or because a share surface is available. It is
// exposed as its own explicit trusted operation, gated by
// manage_assignment_external_submission, called only when a human
// deliberately asks for a submission link.
const createSessionInputSchema = z
  .object({
    recipientType: submissionRecipientTypeSchema,
    recipientRef: z.string().min(1).optional(),
    expiresInMs: z.number().int().min(MIN_SESSION_EXPIRY_MS).max(MAX_SESSION_TTL_MS).optional(),
  })
  .strict();
export type CreateExternalSubmissionSessionInput = z.input<typeof createSessionInputSchema>;

export async function createExternalSubmissionSession(
  actor: ActorContext | null,
  assignmentRef: unknown,
  rawInput: unknown,
  requestId: string,
): Promise<AssignmentsServiceResult<{ session: SafeSubmissionSessionDto; rawToken: string }>> {
  const loaded = await loadAuthorizedAssignment(actor, assignmentRef, "manage_assignment_external_submission");
  if (!loaded.ok) return loaded.error;
  const assignment = loaded.assignment;

  const parsed = createSessionInputSchema.safeParse(rawInput);
  if (!parsed.success) return assignmentsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (!ASSIGNMENT_STATES_ACCEPTING_SUBMISSION.has(assignment.status)) {
    return assignmentsInvalidInputResult(`Cannot create a submission session while the Assignment is ${assignment.status}.`);
  }

  // ---- Recipient rules (Step 10A section 10) ----
  let recipientRef: string;
  if (input.recipientType === "PARTNER") {
    // The Partner recipient is always the Assignment's own partnerRef -
    // never client-chosen independently.
    recipientRef = assignment.partnerRef;
    if (input.recipientRef && input.recipientRef !== assignment.partnerRef) {
      return assignmentsInvalidInputResult("A PARTNER session's recipient must be this Assignment's own Partner.");
    }
  } else {
    if (!input.recipientRef) return assignmentsInvalidInputResult("recipientRef (a vendorRef) is required for a VENDOR session.");
    const partner = await getPartnerDocByRef(assignment.partnerRef);
    if (!partner) return { ok: false, code: "not_found", message: "This Assignment's Partner no longer resolves." };
    const claimSnap = await vendorPartnerActiveClaimsCollection().doc(partner.partnerRef).get();
    const claim = claimSnap.exists ? vendorPartnerActiveClaimDocSchema.safeParse(claimSnap.data()) : null;
    if (!claim?.success || claim.data.vendorRef !== input.recipientRef) {
      return assignmentsInvalidInputResult("This Vendor is not the Partner's current active Vendor relationship. This feature never depends on payeeRole - only current active representation.");
    }
    recipientRef = input.recipientRef;
  }

  // Section 12: reuse rule - never mint a second competing token/session
  // for the same Assignment + recipient while an eligible one is still
  // live. Since the raw token cannot be re-derived from its stored hash
  // (one-way, Step 10A's own "never store the raw bearer token" rule),
  // "reuse" here means returning a typed conflict result identifying the
  // existing session only by sessionRef - the caller (the Share dialog)
  // either re-shares its own already-known link from this browser
  // session, or explicitly revokes-and-reissues.
  const existing = await findEligibleActiveSession(assignment.assignmentRef, input.recipientType, recipientRef);
  if (existing) {
    return assignmentsConflictResult(`An active submission link already exists for this recipient (sessionRef ${existing.sessionRef}). Revoke it before issuing a new one.`);
  }

  const now = Date.now();
  const expiresAt = new Date(now + (input.expiresInMs ?? DEFAULT_SESSION_TTL_MS)).toISOString();
  const nowIso = new Date(now).toISOString();

  // Resolve-or-create the Assignment's own single canonical Content
  // thread - the ONLY place a Content thread is ever created (no manual
  // "Plan Content" operation exists anymore).
  const thread = await resolveOrCreateContentThread(assignment.assignmentRef, actor!.userRef, requestId);

  const rawToken = generateSubmissionToken();
  const tokenHash = hashSubmissionToken(rawToken);

  const doc: AssignmentSubmissionSessionDoc = assignmentSubmissionSessionDocSchema.parse({
    tokenHash,
    sessionRef: generateSubmissionSessionRef(),
    assignmentRef: assignment.assignmentRef,
    campaignRef: assignment.campaignRef,
    partnerRef: assignment.partnerRef,
    recipientType: input.recipientType,
    recipientRef,
    state: "ACTIVE",
    contentRef: thread.contentRef,
    createdAt: nowIso,
    createdByUserRef: actor!.userRef,
    expiresAt,
    briefVersion: assignment.version,
    allowedPlatforms: assignment.brief.platforms,
    lastSubmittedAt: null,
    revokedAt: null,
    version: 1,
  });

  // .create() (not .set()) so a - cryptographically negligible, but not
  // impossible - tokenHash collision fails loudly instead of silently
  // overwriting an existing session.
  await assignmentSubmissionSessionsCollection().doc(tokenHash).create(doc);

  // Never the tokenHash, never the raw token - only safe, already-known
  // context (Step 10A section 18's "do not record raw bearer token" /
  // "token hash if unnecessary for user audit").
  await writeAssignmentEvent({
    assignmentUid: assignment.uid,
    kind: "external_submission_link_issued",
    actorUserRef: actor!.userRef,
    metadata: { recipientType: input.recipientType, expiresAt },
    requestId,
  });

  return { ok: true, data: { session: toSafeSessionDto(doc), rawToken } };
}

// ---- Revoke session (internal) -------------------------------------------
export async function revokeExternalSubmissionSession(
  actor: ActorContext | null,
  assignmentRef: unknown,
  sessionRef: unknown,
  requestId: string,
): Promise<AssignmentsServiceResult<SafeSubmissionSessionDto>> {
  const loaded = await loadAuthorizedAssignment(actor, assignmentRef, "manage_assignment_external_submission");
  if (!loaded.ok) return loaded.error;

  if (typeof sessionRef !== "string" || sessionRef.length === 0) return assignmentsInvalidInputResult("Missing sessionRef.");
  const session = await getSubmissionSessionDocByRef(sessionRef);
  if (!session || session.assignmentRef !== loaded.assignment.assignmentRef) return { ok: false, code: "not_found", message: "Submission session not found." };

  if (session.state !== "ACTIVE") return assignmentsConflictResult(`This submission session is already ${session.state.toLowerCase()}.`);

  const db = getAdminFirestore();
  const docRef = assignmentSubmissionSessionsCollection().doc(session.tokenHash);
  const now = new Date().toISOString();

  const updated = await db.runTransaction<AssignmentSubmissionSessionDoc | null>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return null;
    const parsed = assignmentSubmissionSessionDocSchema.safeParse(snap.data());
    if (!parsed.success || parsed.data.state !== "ACTIVE") return null;
    const next: AssignmentSubmissionSessionDoc = { ...parsed.data, state: "REVOKED", revokedAt: now, version: parsed.data.version + 1 };
    tx.set(docRef, next);
    return next;
  });

  if (!updated) return assignmentsConflictResult("This submission session is already revoked or no longer exists.");

  await writeAssignmentEvent({ assignmentUid: loaded.assignment.uid, kind: "external_submission_link_revoked", actorUserRef: actor!.userRef, metadata: { recipientType: session.recipientType }, requestId });

  return { ok: true, data: toSafeSessionDto(updated) };
}

// ---- Current active Vendor (internal, read-only) --------------------------
// Step 10C section 17: a bounded, Assignment-scoped read so the WhatsApp
// share dialog can offer a Vendor recipient option without ever fetching
// a broad Vendor list or exposing raw refs. Same action gate as session
// creation/revoke - this is purely supporting data for that flow, never
// useful on its own. Returns only a safe display label + the opaque
// vendorRef the dialog needs to pass back into
// createExternalSubmissionSession - no contact/bank/tax/payee fields.
export type SafeVendorOption = { vendorRef: string; displayName: string };

export async function getAssignmentCurrentVendorOption(
  actor: ActorContext | null,
  assignmentRef: unknown,
): Promise<AssignmentsServiceResult<{ vendor: SafeVendorOption | null }>> {
  const loaded = await loadAuthorizedAssignment(actor, assignmentRef, "manage_assignment_external_submission");
  if (!loaded.ok) return loaded.error;

  const claimSnap = await vendorPartnerActiveClaimsCollection().doc(loaded.assignment.partnerRef).get();
  const claim = claimSnap.exists ? vendorPartnerActiveClaimDocSchema.safeParse(claimSnap.data()) : null;
  if (!claim?.success) return { ok: true, data: { vendor: null } };

  const vendor = await getVendorDocByRef(claim.data.vendorRef);
  if (!vendor) return { ok: true, data: { vendor: null } };

  return { ok: true, data: { vendor: { vendorRef: vendor.vendorRef, displayName: vendor.displayName } } };
}

// ---- Public: resolve token -> safe DTO -----------------------------------
// The unauthenticated allowlist (Step 10A section 12) - built entirely
// from the Assignment's own already-frozen brief (see types.ts) plus the
// linked Content thread's own safe status/links, never a fresh Campaign
// read.
type PublicResolveResult = { ok: true; data: PublicAssignmentSubmissionDto } | { ok: false };

type ValidSession = { session: AssignmentSubmissionSessionDoc; assignment: AssignmentDoc; thread: ContentDoc };

// Step 11A.1: a session/Assignment/thread triple is valid whenever the
// session itself is ACTIVE and not expired, the Assignment is not
// CANCELLED (COMPLETED is fine - it is reachable the instant the
// Assignment's one thread is approved, and must still resolve to the
// real "closed" view, never the generic unavailable card), the linked
// Content thread is not CANCELLED (APPROVED is fine, same reasoning),
// and - for a VENDOR recipient - the Vendor relationship is still the
// Partner's current active one. Shared by both the public resolve (GET)
// and submit (POST) paths - what differs between them is only whether
// the thread's CURRENT status additionally permits accepting new rows
// (see submitExternalLinks's own extra check).
async function loadValidSession(rawToken: string): Promise<ValidSession | null> {
  const tokenHash = hashSubmissionToken(rawToken);
  const snapshot = await assignmentSubmissionSessionsCollection().doc(tokenHash).get();
  if (!snapshot.exists) return null;
  const parsed = assignmentSubmissionSessionDocSchema.safeParse(snapshot.data());
  if (!parsed.success) return null;
  const session = parsed.data;

  if (session.state !== "ACTIVE") return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;

  const assignment = await getAssignmentDocByRef(session.assignmentRef);
  if (!assignment || assignment.status === "CANCELLED") return null;

  const thread = await getContentDocByRef(session.contentRef);
  if (!thread || thread.status === "CANCELLED") return null;

  if (session.recipientType === "VENDOR") {
    const claimSnap = await vendorPartnerActiveClaimsCollection().doc(session.partnerRef).get();
    const claim = claimSnap.exists ? vendorPartnerActiveClaimDocSchema.safeParse(claimSnap.data()) : null;
    if (!claim?.success || claim.data.vendorRef !== session.recipientRef) return null;
  }

  return { session, assignment, thread };
}

export async function resolveExternalSubmission(rawToken: unknown): Promise<PublicResolveResult> {
  if (typeof rawToken !== "string" || rawToken.length === 0) return { ok: false };

  const loaded = await loadValidSession(rawToken);
  if (!loaded) return { ok: false };
  const { assignment, thread } = loaded;

  const dto: PublicAssignmentSubmissionDto = {
    campaignName: assignment.brief.campaignName,
    assignmentDisplayContext: assignment.brief.contentRequirementSummary ?? assignment.brief.campaignName,
    instructions: assignment.brief.instructions,
    dueAt: assignment.brief.dueAt,
    language: assignment.brief.language,
    hashtags: assignment.brief.hashtags,
    formats: assignment.brief.formats,
    allowedPlatforms: assignment.brief.platforms,
    // Step 10A.1 section 4: fail-closed - only links explicitly marked
    // shareExternally reach the public DTO, and even those are stripped
    // down to {label, url} only (the flag itself is an internal
    // authoring detail, never useful to the external recipient).
    resourceLinks: assignment.brief.resourceLinks.filter((link) => link.shareExternally).map((link) => ({ label: link.label, url: link.url })),
    reviewPolicyNote: assignment.brief.reviewPolicy === "REVIEW_REQUIRED" ? "Content from this Assignment is reviewed before it is considered final." : null,
    threadStatus: thread.status,
    revisionNote: thread.status === "REVISION_REQUESTED" ? thread.statusReason : null,
    currentLinks: thread.currentLinks.map((link) => ({ platform: link.platform, url: link.originalUrl })),
  };
  return { ok: true, data: dto };
}

// ---- Public: submit rows --------------------------------------------------
type SubmitResult = { ok: true; data: { revisionNumber: number } } | { ok: false; code: "invalid" | "unusable"; message: string };

type SubmitTxResult = { kind: "ok"; revisionNumber: number } | { kind: "unusable" } | { kind: "conflict" };

// Step 11A.1: the SAME token/session is reused across the WHOLE revision
// loop - this function never mints a new token, never marks the session
// "used". It is the linked Content THREAD's own status that governs
// editability: only OPEN (first submit) or REVISION_REQUESTED (a
// correction after a Manager's decision) accept new rows; UNDER_REVIEW/
// APPROVED/CANCELLED do not. Each successful call appends exactly one new
// immutable revision doc under content/{uid}/revisions - revision 1 is
// never overwritten or deleted by revision 2, etc. No longer writes to
// the old assignmentExternalSubmissions collection at all (that
// collection's pre-existing rows stay as historical evidence only - see
// this step's own completion report for why).
export async function submitExternalLinks(rawToken: unknown, rawRows: unknown): Promise<SubmitResult> {
  if (typeof rawToken !== "string" || rawToken.length === 0) return { ok: false, code: "unusable", message: "This submission link is no longer valid." };

  const loaded = await loadValidSession(rawToken);
  if (!loaded) return { ok: false, code: "unusable", message: "This submission link is no longer valid." };
  const { session, assignment, thread } = loaded;

  // Fast, pre-transaction check - matches "no editable form" for
  // UNDER_REVIEW/APPROVED. Re-verified again, for real, inside the
  // transaction below (a concurrent Manager decision or resubmit may
  // land between this check and the transaction).
  if (thread.status !== "OPEN" && thread.status !== "REVISION_REQUESTED") {
    return { ok: false, code: "unusable", message: "This submission is not open for edits." };
  }

  // Row validation happens entirely BEFORE the transaction - Step 10A
  // section 11's "invalid form validation must NOT consume the token".
  const parsedRows = submissionRowsInputSchema.safeParse(rawRows);
  if (!parsedRows.success) return { ok: false, code: "invalid", message: parsedRows.error.issues.map((issue) => issue.message).join("; ") };

  const rows = parsedRows.data.map((row) => ({ platform: normalizePlatformIdentifier(row.platform), url: row.url }));

  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.platform}::${row.url}`;
    if (seen.has(key)) return { ok: false, code: "invalid", message: "Duplicate platform+URL rows are not allowed in the same submission." };
    seen.add(key);
  }

  // "Each platform must be permitted by the Assignment" - always
  // re-derived from the LIVE Assignment brief, never the session's own
  // (display-only) allowedPlatforms snapshot.
  const permittedPlatforms = new Set(assignment.brief.platforms);
  const notPermitted = rows.filter((row) => !permittedPlatforms.has(row.platform));
  if (notPermitted.length > 0) {
    return { ok: false, code: "invalid", message: `Platform(s) ${notPermitted.map((r) => r.platform).join(", ")} are not permitted for this Assignment.` };
  }

  const db = getAdminFirestore();
  const sessionDocRef = assignmentSubmissionSessionsCollection().doc(session.tokenHash);
  const assignmentDocRef = assignmentsCollection().doc(assignment.uid);
  const contentDocRef = contentCollection().doc(thread.uid);
  const now = new Date().toISOString();

  const claimEntries = rows.map((row) => {
    const normalizedUrl = normalizeContentUrl(row.url);
    const key = publicationUrlIdentityKey(row.platform, normalizedUrl);
    return { platform: row.platform, originalUrl: row.url, normalizedUrl, key, ref: contentPublicationClaimsCollection().doc(contentPublicationClaimId(key)) };
  });

  // The transactional core: every read via tx.getAll() before any write
  // (mirrors this same file's own long-standing discipline). ALSO
  // re-reads the live Assignment doc inside this same transaction (not
  // just via the earlier, non-transactional loadValidSession above) so
  // this transaction and a concurrent CANCELLED transition (which writes
  // to this exact Assignment doc) properly serialize - whichever commits
  // first is what the other observes on its forced retry.
  const txResult = await db.runTransaction<SubmitTxResult>(async (tx) => {
    const refs = [sessionDocRef, assignmentDocRef, contentDocRef, ...claimEntries.map((c) => c.ref)];
    const snaps = await tx.getAll(...refs);
    const sessionSnap = snaps[0]!;
    const assignmentSnap = snaps[1]!;
    const contentSnap = snaps[2]!;
    const claimSnaps = snaps.slice(3);

    if (!sessionSnap.exists) return { kind: "unusable" };
    const parsedSession = assignmentSubmissionSessionDocSchema.safeParse(sessionSnap.data());
    if (!parsedSession.success || parsedSession.data.state !== "ACTIVE") return { kind: "unusable" };
    if (new Date(parsedSession.data.expiresAt).getTime() <= Date.now()) return { kind: "unusable" };

    const parsedAssignment = assignmentSnap.exists ? assignmentDocSchema.safeParse(assignmentSnap.data()) : null;
    if (!parsedAssignment?.success || parsedAssignment.data.status === "CANCELLED") return { kind: "unusable" };

    if (!contentSnap.exists) return { kind: "unusable" };
    const parsedContent = contentDocSchema.safeParse(contentSnap.data());
    if (!parsedContent.success) return { kind: "unusable" };
    const freshThread = parsedContent.data;
    // The real, race-safe gate: only OPEN/REVISION_REQUESTED accept a
    // new revision. This is what makes a decision-vs-resubmit race and a
    // concurrent double-resubmit both serialize safely - whichever
    // transaction commits first moves the thread to UNDER_REVIEW (or
    // APPROVED), and every loser's forced retry observes that fresh
    // status and correctly returns "unusable".
    if (freshThread.status !== "OPEN" && freshThread.status !== "REVISION_REQUESTED") return { kind: "unusable" };

    // Publication-identity claim check - same-thread re-claim allowed
    // (this thread revising its own link across revisions is not a
    // collision), cross-thread collision blocked. A genuine cross-thread
    // collision fails the WHOLE submit atomically - never a partial
    // accept.
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
      recipientType: parsedSession.data.recipientType,
      recipientRef: parsedSession.data.recipientRef,
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
      updatedByUserRef: parsedSession.data.createdByUserRef,
    };
    tx.set(contentDocRef, updatedThread);

    for (const entry of claimEntries) {
      tx.set(entry.ref, contentPublicationClaimDocSchema.parse({ key: entry.key, contentRef: freshThread.contentRef, contentUid: freshThread.uid, revisionNumber, claimedAt: now }));
    }

    const nextSession: AssignmentSubmissionSessionDoc = { ...parsedSession.data, lastSubmittedAt: now, version: parsedSession.data.version + 1 };
    tx.set(sessionDocRef, nextSession);

    return { kind: "ok", revisionNumber };
  });

  if (txResult.kind === "unusable") return { ok: false, code: "unusable", message: "This submission link is no longer valid." };
  if (txResult.kind === "conflict") return { ok: false, code: "invalid", message: "One or more of these links is already claimed by a different submission." };

  const requestId = `public-submit-${thread.uid}-r${txResult.revisionNumber}`;

  await writeContentEvent({ contentUid: thread.uid, kind: "submitted", actorUserRef: session.createdByUserRef, metadata: { revisionNumber: txResult.revisionNumber }, requestId });

  // Never the raw URLs - platform + row count only, per this event
  // module's own redaction discipline.
  await writeAssignmentEvent({
    assignmentUid: assignment.uid,
    kind: "external_links_submitted",
    actorUserRef: session.createdByUserRef,
    metadata: { recipientType: session.recipientType, rowCount: rows.length, platforms: [...new Set(rows.map((r) => r.platform))], revisionNumber: txResult.revisionNumber },
    requestId,
  });

  return { ok: true, data: { revisionNumber: txResult.revisionNumber } };
}

// ---- WhatsApp/share DTO-only contract (Step 10A section 15) -------------
// Pure, token-free helper - never creates a session, never sends any
// network request. Works correctly with `submissionUrl` omitted (the
// later UI's unchecked "Include public submission link" state); the later
// UI's checked state is what will call createExternalSubmissionSession
// first and pass its resulting URL in here. This function itself never
// decides whether to create a session - that decision belongs entirely to
// the future UI.
export function buildAssignmentSubmissionShareContext(params: { campaignName: string; assignmentSummary: string | null; dueAt: string | null; submissionUrl?: string }): {
  whatsappMessage: string;
  whatsappDeepLink: string;
} {
  const lines = [`New content assignment: ${params.campaignName}.`];
  if (params.assignmentSummary) lines.push(params.assignmentSummary);
  if (params.dueAt) lines.push(`Due: ${params.dueAt}`);
  if (params.submissionUrl) lines.push(`Submit your links here: ${params.submissionUrl}`);

  const whatsappMessage = lines.join("\n");
  const whatsappDeepLink = `https://wa.me/?text=${encodeURIComponent(whatsappMessage)}`;
  return { whatsappMessage, whatsappDeepLink };
}
