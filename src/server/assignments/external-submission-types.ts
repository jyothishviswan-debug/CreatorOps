import { z } from "zod";

import type { ContentStatus } from "@/server/content/types";
import { assignmentPlatformsArraySchema, platformIdentifierSchema } from "./types";

// Step 10A section 8-14: the secure, token-scoped external submission
// contract. Deliberately a SEPARATE type module from types.ts - this is a
// distinct security surface (the one place in the whole app with a
// genuinely unauthenticated, bearer-token-only entry point), and keeping
// its schemas apart makes that boundary easy to audit in one place.

// Finding #44 (user-decided): "MANAGER" is a real, honest third value - a Manager recording content
// links on the Partner's behalf (an authenticated-actor write, never the public bearer-token page) is
// neither the Partner nor a Vendor submitting for themselves; content-revision provenance must say so
// truthfully, not misrepresent the recorder as one of the other two. Never offered by the external-
// submission share dialog itself (that UI only ever creates PARTNER/VENDOR sessions) - only used by
// content/manager-submission-service.ts's own internal write.
export const SUBMISSION_RECIPIENT_TYPES = ["PARTNER", "VENDOR", "MANAGER"] as const;
export const submissionRecipientTypeSchema = z.enum(SUBMISSION_RECIPIENT_TYPES);
export type SubmissionRecipientType = z.infer<typeof submissionRecipientTypeSchema>;

// Step 11A.1: "USED" is retired - the session itself is now REUSABLE
// across the whole revision loop. It is the linked Content THREAD's own
// status (see resolveExternalSubmission/submitExternalLinks) that governs
// whether the public page is currently editable, never the session's own
// state. A session only ever leaves ACTIVE by explicit staff revocation,
// or by its own expiresAt passing.
export const SUBMISSION_SESSION_STATES = ["ACTIVE", "REVOKED"] as const;
export const submissionSessionStateSchema = z.enum(SUBMISSION_SESSION_STATES);
export type SubmissionSessionState = z.infer<typeof submissionSessionStateSchema>;

export const MIN_SESSION_EXPIRY_MS = 60 * 60 * 1000; // 1 hour - reject an expiry in the past/too-soon-to-be-useful
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days - judgment call #6
export const MAX_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days cap

// --- Session document (assignmentSubmissionSessions/{sha256(token)}) -----
// Doc id IS the token's sha256 hash - deterministic O(1) lookup for the
// hot public-resolve path, no query/index needed, and the doc id itself
// never reveals the raw token (sha256 is one-way). `sessionRef` is the
// separate, opaque, randomUUID handle used for STAFF-facing addressing
// (create response, revoke) - the tokenHash/doc id is never exposed to
// any staff-facing DTO, only ever used internally by the public routes.
// The raw bearer token itself is NEVER stored anywhere, per section 9's
// explicit rule - only this one-way fingerprint.
export const assignmentSubmissionSessionDocSchema = z.object({
  tokenHash: z.string().min(1),
  sessionRef: z.string().min(1),
  assignmentRef: z.string().min(1),
  campaignRef: z.string().min(1),
  partnerRef: z.string().min(1),
  recipientType: submissionRecipientTypeSchema,
  // partnerRef (must equal the Assignment's own partnerRef) if PARTNER;
  // vendorRef (must be the Partner's current active Vendor at creation
  // time) if VENDOR - see external-submission-service.ts's recipient
  // validation.
  recipientRef: z.string().min(1),
  state: submissionSessionStateSchema,
  // Step 11A.1: links this session to its Assignment's one canonical
  // Content thread - resolved/created via resolveOrCreateContentThread at
  // session-creation time (a one-directional assignments -> content
  // dependency, mirroring content's own existing content -> assignments
  // dependency). The public resolve/submit routes load the thread via
  // this ref, never via a second slot-claim lookup.
  contentRef: z.string().min(1),
  createdAt: z.string().min(1),
  createdByUserRef: z.string().min(1),
  expiresAt: z.string().min(1),
  // The Assignment.version this session was created against - a
  // reference, not a duplicated copy, since the Assignment's own brief is
  // already frozen/stable once issued (see types.ts's own comment) - the
  // public resolve endpoint re-reads the live Assignment by assignmentRef
  // rather than duplicating its content here.
  briefVersion: z.number().int().min(1),
  // Snapshot of the Assignment's allowed platforms AT SESSION CREATION,
  // kept only for display convenience on the public resolve DTO - actual
  // submission-time platform validation always re-derives from the LIVE
  // Assignment (see submitExternalLinks), never trusts this snapshot for
  // authorization.
  allowedPlatforms: assignmentPlatformsArraySchema,
  // Renamed from consumedAt (Step 11A.1) - display-only, updated on every
  // successful submit/resubmit, never gates authorization (the session
  // stays ACTIVE and reusable across the whole revision loop; only the
  // linked Content thread's own status controls editability).
  lastSubmittedAt: z.string().min(1).nullable().default(null),
  revokedAt: z.string().min(1).nullable().default(null),
  version: z.number().int().min(1),
});
export type AssignmentSubmissionSessionDoc = z.infer<typeof assignmentSubmissionSessionDocSchema>;

// --- Immutable submission batch (assignmentExternalSubmissions/{uid}) ----
// Intake evidence pending Content mapping (Step 10A section 14) - NOT
// canonical Content lifecycle truth. Append-only; nothing ever writes to
// an existing doc here.
export const MAX_SUBMISSION_ROWS = 10;

// Strict https:// validation - the first place in the repo that needs
// real URL-safety checking (Campaign's own resource `url` field is only
// bounded-length, never format-checked - see the Step 10A plan's own
// research note). Deliberately narrow: no arbitrary scheme, no
// server-side fetch/metadata-scraping anywhere near this value.
export const httpsUrlSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Must be a valid https:// URL." },
  );

export const submissionRowSchema = z
  .object({
    platform: platformIdentifierSchema,
    url: httpsUrlSchema,
  })
  .strict();
export type SubmissionRow = z.infer<typeof submissionRowSchema>;

export const submissionRowsInputSchema = z.array(submissionRowSchema).min(1).max(MAX_SUBMISSION_ROWS);

export const assignmentExternalSubmissionDocSchema = z.object({
  uid: z.string().min(1),
  submissionRef: z.string().min(1),
  // The session's own doc id (tokenHash) - never the raw token. Kept as
  // an opaque provenance ref, same "internal id, never the secret" rule
  // as everywhere else in this codebase.
  sessionRef: z.string().min(1),
  assignmentRef: z.string().min(1),
  campaignRef: z.string().min(1),
  partnerRef: z.string().min(1),
  recipientType: submissionRecipientTypeSchema,
  recipientRef: z.string().min(1),
  rows: z.array(submissionRowSchema).min(1).max(MAX_SUBMISSION_ROWS),
  submittedAt: z.string().min(1),
});
export type AssignmentExternalSubmissionDoc = z.infer<typeof assignmentExternalSubmissionDocSchema>;

// --- Safe public DTO (section 12's exact allowlist) -----------------------
// The ONLY shape the unauthenticated public resolve route ever returns -
// no internal ids, no scope, no restricted identity, no Finance, no
// history, no secret.
// Finding #47: exactly the 3 creator-safe Campaign Resource types (LINK/UPLOAD/TEXT) ever reach the
// public page - the legacy DOCUMENT/BRIEF/ASSET/OTHER types (still readable internally for old
// Campaigns, per findings #36/#37) are omitted here as "unavailable" for this surface. `url` is
// already the safe, resolved value for both LINK (external URL) and UPLOAD (the storage layer's own
// creator-facing view link) - never a raw bucket/storage path (campaigns/types.ts's own
// campaignResourceSchema guarantees this at the source; nothing here re-derives or re-authorizes a
// path). `content` is TEXT's plain body, rendered as text, never treated as or turned into a URL.
export type PublicCampaignResource = { label: string; type: "LINK" | "UPLOAD" | "TEXT"; url: string | null; content: string | null };

export type PublicAssignmentSubmissionDto = {
  campaignName: string;
  // Finding #47: the Campaign's own Objective, snapshotted onto the brief at Assignment creation
  // (types.ts's own documented frozen-snapshot policy - never re-synced by a later Campaign edit).
  campaignObjective: string | null;
  // Finding #47: the owning Campaign's own CURRENT active Resources, read live (the same
  // live-join precedent finding #38 already established for the internal, authenticated
  // AssignmentDto's own campaignResources - deliberately NOT snapshotted, so a Resource removed
  // from the Campaign after this Assignment was created is never shown here; disclosed as a
  // considered choice between two real existing precedents, not a default).
  campaignResources: PublicCampaignResource[];
  instructions: string | null;
  // Finding #47/#52: a genuinely optional Assignment-specific override/clarification - no longer
  // pretends to carry inherited Campaign context (never falls back to campaignName), and the public
  // page only renders a section for it when it is actually populated.
  contentRequirementSummary: string | null;
  dueAt: string | null;
  language: string | null;
  hashtags: string[];
  formats: string[];
  allowedPlatforms: string[];
  resourceLinks: { label: string; url: string }[];
  reviewPolicyNote: string | null;
  // Finding #50: the number of published links this Assignment's one
  // submission thread needs before it can fulfill the obligation - so the
  // submitter knows the real target, not just "at least one". Always a
  // small positive integer (MAX_ASSIGNMENT_REQUIRED_COUNT, 10) - never
  // the Agreement's own separate monthly deliverable requirement.
  requiredCount: number;
  // Step 11A.1: drives the public page's own state machine (Section 10) -
  // see src/features/assignments/public/PublicSubmissionPage.tsx. Only
  // ever the thread's own status/statusReason/currentLinks, mapped down
  // to a safe shape - never an internal field.
  threadStatus: ContentStatus;
  // The thread's statusReason, shown only when threadStatus ===
  // "REVISION_REQUESTED".
  revisionNote: string | null;
  // The thread's currentLinks, mapped down to just {platform, url} -
  // never normalizedUrl/recordedAt/anything internal.
  currentLinks: { platform: string; url: string }[];
};
