import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import type { ActorContext } from "@/server/authz/types";
import { getPartnerDocByRef } from "@/server/partners/firestore";
import { vendorPartnerActiveClaimsCollection } from "@/server/vendors/firestore";
import { vendorPartnerActiveClaimDocSchema } from "@/server/vendors/types";
import { normalizePlatformIdentifier } from "@/server/shared/platform";
import { loadAuthorizedAssignment } from "./assignment-service";
import { writeAssignmentEvent } from "./assignment-events";
import {
  assignmentExternalSubmissionsCollection,
  assignmentSubmissionSessionsCollection,
  getAssignmentDocByRef,
  getSubmissionSessionDocByRef,
} from "./firestore";
import { generateSubmissionRef, generateSubmissionSessionRef } from "./ids";
import { assignmentsConflictResult, assignmentsInvalidInputResult, type AssignmentDoc, type AssignmentsServiceResult } from "./types";
import {
  assignmentExternalSubmissionDocSchema,
  assignmentSubmissionSessionDocSchema,
  submissionRecipientTypeSchema,
  submissionRowsInputSchema,
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS,
  MIN_SESSION_EXPIRY_MS,
  type AssignmentExternalSubmissionDoc,
  type AssignmentSubmissionSessionDoc,
  type PublicAssignmentSubmissionDto,
  type SubmissionRow,
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
// excluded (nothing has been issued yet to submit against); COMPLETED/
// CANCELLED are excluded (submission is already done or moot).
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
  consumedAt: string | null;
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
    consumedAt: doc.consumedAt,
    revokedAt: doc.revokedAt,
  };
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

  const now = Date.now();
  const expiresAt = new Date(now + (input.expiresInMs ?? DEFAULT_SESSION_TTL_MS)).toISOString();
  const nowIso = new Date(now).toISOString();

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
    createdAt: nowIso,
    createdByUserRef: actor!.userRef,
    expiresAt,
    briefVersion: assignment.version,
    allowedPlatforms: assignment.brief.platforms,
    consumedAt: null,
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

  if (!updated) return assignmentsConflictResult("This submission session is already used, revoked, or no longer exists.");

  await writeAssignmentEvent({ assignmentUid: loaded.assignment.uid, kind: "external_submission_link_revoked", actorUserRef: actor!.userRef, metadata: { recipientType: session.recipientType }, requestId });

  return { ok: true, data: toSafeSessionDto(updated) };
}

// ---- Public: resolve token -> safe DTO -----------------------------------
// The unauthenticated allowlist (Step 10A section 12) - built entirely
// from the Assignment's own already-frozen brief (see types.ts), never a
// fresh Campaign read, since campaignName/campaignObjective/reviewPolicy
// are already snapshotted there.
type PublicResolveResult = { ok: true; data: PublicAssignmentSubmissionDto } | { ok: false };

async function loadValidSession(rawToken: string): Promise<{ session: AssignmentSubmissionSessionDoc; assignment: AssignmentDoc } | null> {
  const tokenHash = hashSubmissionToken(rawToken);
  const snapshot = await assignmentSubmissionSessionsCollection().doc(tokenHash).get();
  if (!snapshot.exists) return null;
  const parsed = assignmentSubmissionSessionDocSchema.safeParse(snapshot.data());
  if (!parsed.success) return null;
  const session = parsed.data;

  if (session.state !== "ACTIVE") return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;

  const assignment = await getAssignmentDocByRef(session.assignmentRef);
  if (!assignment || !ASSIGNMENT_STATES_ACCEPTING_SUBMISSION.has(assignment.status)) return null;

  if (session.recipientType === "VENDOR") {
    const claimSnap = await vendorPartnerActiveClaimsCollection().doc(session.partnerRef).get();
    const claim = claimSnap.exists ? vendorPartnerActiveClaimDocSchema.safeParse(claimSnap.data()) : null;
    if (!claim?.success || claim.data.vendorRef !== session.recipientRef) return null;
  }

  return { session, assignment };
}

export async function resolveExternalSubmission(rawToken: unknown): Promise<PublicResolveResult> {
  if (typeof rawToken !== "string" || rawToken.length === 0) return { ok: false };

  const loaded = await loadValidSession(rawToken);
  if (!loaded) return { ok: false };
  const { assignment } = loaded;

  const dto: PublicAssignmentSubmissionDto = {
    campaignName: assignment.brief.campaignName,
    assignmentDisplayContext: assignment.brief.contentRequirementSummary ?? assignment.brief.campaignName,
    instructions: assignment.brief.instructions,
    dueAt: assignment.brief.dueAt,
    language: assignment.brief.language,
    hashtags: assignment.brief.hashtags,
    formats: assignment.brief.formats,
    allowedPlatforms: assignment.brief.platforms,
    resourceLinks: assignment.brief.resourceLinks,
    reviewPolicyNote: assignment.brief.reviewPolicy === "REVIEW_REQUIRED" ? "Content from this Assignment is reviewed before it is considered final." : null,
  };
  return { ok: true, data: dto };
}

// ---- Public: submit rows --------------------------------------------------
type SubmitResult = { ok: true; data: { submissionRef: string } } | { ok: false; code: "invalid" | "unusable"; message: string };

type SubmitTxResult = { kind: "ok"; doc: AssignmentExternalSubmissionDoc } | { kind: "unusable" };

export async function submitExternalLinks(rawToken: unknown, rawRows: unknown): Promise<SubmitResult> {
  if (typeof rawToken !== "string" || rawToken.length === 0) return { ok: false, code: "unusable", message: "This submission link is no longer valid." };

  const loaded = await loadValidSession(rawToken);
  if (!loaded) return { ok: false, code: "unusable", message: "This submission link is no longer valid." };
  const { session, assignment } = loaded;

  // Row validation happens entirely BEFORE the token-consuming
  // transaction - Step 10A section 11's "invalid form validation must NOT
  // consume the token".
  const parsedRows = submissionRowsInputSchema.safeParse(rawRows);
  if (!parsedRows.success) return { ok: false, code: "invalid", message: parsedRows.error.issues.map((issue) => issue.message).join("; ") };

  const rows: SubmissionRow[] = parsedRows.data.map((row) => ({ platform: normalizePlatformIdentifier(row.platform), url: row.url }));

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
  const submissionUid = assignmentExternalSubmissionsCollection().doc().id;
  const submissionRef = generateSubmissionRef();
  const now = new Date().toISOString();

  const submissionDoc: AssignmentExternalSubmissionDoc = assignmentExternalSubmissionDocSchema.parse({
    uid: submissionUid,
    submissionRef,
    sessionRef: session.tokenHash,
    assignmentRef: assignment.assignmentRef,
    campaignRef: assignment.campaignRef,
    partnerRef: assignment.partnerRef,
    recipientType: session.recipientType,
    recipientRef: session.recipientRef,
    rows,
    submittedAt: now,
  });

  // The transactional core of "single-use": re-read the session's live
  // state inside the transaction and only mark it USED + write the
  // submission batch if it is still ACTIVE. Under a concurrent
  // double-submit, the Admin SDK's automatic optimistic-transaction retry
  // guarantees exactly one caller observes state==="ACTIVE" and wins; the
  // loser's retry re-reads state==="USED" and correctly returns
  // "unusable" - exactly one immutable submission batch ever exists for
  // this session, matching Step 10A section 14's own requirement.
  const txResult = await db.runTransaction<SubmitTxResult>(async (tx) => {
    const snap = await tx.get(sessionDocRef);
    if (!snap.exists) return { kind: "unusable" };
    const parsed = assignmentSubmissionSessionDocSchema.safeParse(snap.data());
    if (!parsed.success || parsed.data.state !== "ACTIVE") return { kind: "unusable" };

    const next: typeof parsed.data = { ...parsed.data, state: "USED", consumedAt: now, version: parsed.data.version + 1 };
    tx.set(sessionDocRef, next);
    tx.set(assignmentExternalSubmissionsCollection().doc(submissionUid), submissionDoc);
    return { kind: "ok", doc: submissionDoc };
  });

  if (txResult.kind === "unusable") return { ok: false, code: "unusable", message: "This submission link is no longer valid." };

  // Never the raw URLs - platform + row count only, per this event
  // module's own redaction discipline and Step 10A section 18's "no
  // private recipient contact data" spirit applied conservatively here.
  await writeAssignmentEvent({
    assignmentUid: assignment.uid,
    kind: "external_links_submitted",
    actorUserRef: session.createdByUserRef,
    metadata: { recipientType: session.recipientType, rowCount: rows.length, platforms: [...new Set(rows.map((r) => r.platform))] },
    requestId: submissionRef,
  });

  return { ok: true, data: { submissionRef } };
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
