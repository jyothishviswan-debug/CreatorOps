import type { OnboardingDuplicateCandidateDto, OnboardingDuplicateSignal, OnboardingDuplicatesDto } from "@/server/finance-agreements/onboarding-dto";
import type { OnboardingRequest } from "@/server/finance-agreements/onboarding-input";
import type { CounterpartyType } from "@/server/finance-agreements/types";

// Step 14B.1 onboarding: what the DUPLICATE CHECK result means for the next step (pure).
//
// The server returns only records the actor may see (with STRONG / SUPPORTING evidence) plus one neutral flag for a strong match outside
// the actor's access. From that the UI must decide, deliberately and never by fuzzy guessing:
//   - the heading and copy (`Possible existing Partner found`),
//   - which actions exist (`Use existing` per candidate, `Continue creating new`),
//   - what `Continue creating new` requires (a STRONG match or an UNKNOWN check needs an explicit acknowledgement AND a reason),
//   - what BLOCKS creating a new record (a strong match outside access; an Account that already belongs to a Partner).
// Nothing here auto-merges, and `unknown` is never read as "none". The server re-checks every one of these rules.

const noun = (type: CounterpartyType): string => (type === "PARTNER" ? "Partner" : "Vendor");

export const DUPLICATE_REASON_MIN = 3;
export const DUPLICATE_REASON_MAX = 1000;

export type DuplicateKind = "none" | "possible" | "unknown";

export type DuplicateSummary = {
  kind: DuplicateKind;
  // The section heading ("Possible existing Partner found" / "No existing Partner found" / "Could not check for an existing Partner").
  heading: string;
  // One plain sentence under the heading.
  message: string;
  hasStrong: boolean;
  // A strong match exists that the actor cannot see. Blocks `create new`; carries nothing else.
  outsideAccess: boolean;
  // An Account named in the form already belongs to an existing Partner (a strong duplicate signal); blocks `create new`.
  accountCollision: boolean;
  // Creating a new record despite the result needs the acknowledgement checkbox AND a reason (a STRONG candidate, or an unknown check).
  requiresAcknowledgement: boolean;
  blocksCreateNew: boolean;
  blockMessage: string | null;
  candidateCount: number;
};

export const OUTSIDE_ACCESS_MESSAGE = (type: CounterpartyType): string => `A matching ${noun(type)} already exists outside your access. Ask an administrator to check it before creating a new one.`;
export const ACCOUNT_COLLISION_MESSAGE = "One of these accounts already belongs to an existing Partner. Use that Partner, or remove the account.";

export function summarizeDuplicates(dto: OnboardingDuplicatesDto): DuplicateSummary {
  const name = noun(dto.type);
  const hasStrong = dto.candidates.some((candidate) => candidate.strength === "STRONG");
  const accountCollision = dto.candidates.some((candidate) => candidate.signals.includes("ACCOUNT_IDENTITY"));
  const outsideAccess = dto.strongMatchOutsideYourAccess;
  const unknown = dto.status === "unknown";
  const kind: DuplicateKind = unknown ? "unknown" : dto.candidates.length > 0 || outsideAccess ? "possible" : "none";

  let heading: string;
  let message: string;
  if (kind === "unknown") {
    heading = `Could not check for an existing ${name}`;
    message = `The check for an existing ${name} could not be completed, so a match cannot be ruled out. Try again, or confirm that you want to create a new one anyway.`;
  } else if (kind === "possible") {
    heading = `Possible existing ${name} found`;
    message = dto.candidates.length > 0 ? `Check ${dto.candidates.length === 1 ? "this record" : "these records"} before creating anything. Use an existing ${name} if it is the same person or business.` : `A matching ${name} exists, but not in your access.`;
  } else {
    heading = `No existing ${name} found`;
    message = `Nothing in CreatorOps matched these details. A new ${name} can be created.`;
  }

  const blocksCreateNew = outsideAccess || accountCollision;
  const blockMessage = outsideAccess ? OUTSIDE_ACCESS_MESSAGE(dto.type) : accountCollision ? ACCOUNT_COLLISION_MESSAGE : null;
  return { kind, heading, message, hasStrong, outsideAccess, accountCollision, requiresAcknowledgement: unknown || hasStrong, blocksCreateNew, blockMessage, candidateCount: dto.candidates.length };
}

// --- Candidate cards ------------------------------------------------------------------------------------------------------------------
export const STRENGTH_LABELS = { STRONG: "Strong match", SUPPORTING: "Supporting match" } as const;

export function describeSignal(signal: OnboardingDuplicateSignal): string {
  switch (signal) {
    case "EMAIL":
      return "Same email address";
    case "PHONE":
      return "Same phone number";
    case "ACCOUNT_IDENTITY":
      return "Same Partner Account (page or handle)";
    case "DISPLAY_NAME":
      return "Same name";
  }
}

export type CandidateCard = {
  ref: string;
  displayName: string;
  regionsText: string;
  strength: "STRONG" | "SUPPORTING";
  strengthLabel: string;
  signals: string[];
  inactive: boolean;
};

// Strong first, then by name (deterministic); the ref breaks ties.
export function candidateCards(dto: OnboardingDuplicatesDto): CandidateCard[] {
  const order = (candidate: OnboardingDuplicateCandidateDto) => (candidate.strength === "STRONG" ? 0 : 1);
  return [...dto.candidates]
    .sort((a, b) => order(a) - order(b) || a.displayName.localeCompare(b.displayName) || a.ref.localeCompare(b.ref))
    .map((candidate) => ({
      ref: candidate.ref,
      displayName: candidate.displayName,
      regionsText: candidate.regions.length > 0 ? candidate.regions.join(", ") : "No region recorded",
      strength: candidate.strength,
      strengthLabel: STRENGTH_LABELS[candidate.strength],
      signals: candidate.signals.map(describeSignal),
      inactive: candidate.status !== "ACTIVE",
    }));
}

// --- The decision ---------------------------------------------------------------------------------------------------------------------
export type WizardDecision = { kind: "NONE" } | { kind: "USE_EXISTING"; ref: string } | { kind: "CREATE_NEW"; acknowledged: boolean; reason: string };
export const NO_DECISION: WizardDecision = { kind: "NONE" };

// `none` needs no click: a new record is the only thing left to do. Every other result waits for the person's own choice.
export function effectiveDecision(summary: DuplicateSummary | null, decision: WizardDecision): WizardDecision {
  if (summary && summary.kind === "none" && decision.kind === "NONE") return { kind: "CREATE_NEW", acknowledged: false, reason: "" };
  return decision;
}

export type DecisionReadiness = { ok: true } | { ok: false; message: string };

// Whether the decision may go to the server as it stands. Mirrors the server's own blockers so the person is told before the round trip.
export function decisionReadiness(dto: OnboardingDuplicatesDto, decision: WizardDecision): DecisionReadiness {
  const summary = summarizeDuplicates(dto);
  const name = noun(dto.type);
  const decided = effectiveDecision(summary, decision);
  if (decided.kind === "NONE") return { ok: false, message: summary.kind === "none" ? "" : `Choose an existing ${name}, or continue creating a new one.` };
  if (decided.kind === "USE_EXISTING") {
    return dto.candidates.some((candidate) => candidate.ref === decided.ref) ? { ok: true } : { ok: false, message: `Choose one of the ${name} records listed above.` };
  }
  if (summary.blocksCreateNew) return { ok: false, message: summary.blockMessage ?? "A new record cannot be created." };
  if (summary.requiresAcknowledgement) {
    if (!decided.acknowledged) return { ok: false, message: summary.kind === "unknown" ? "Confirm that you want to create a new record anyway." : `Confirm that you want to create a new ${name} even though a very likely match exists.` };
    const reason = decided.reason.trim();
    if (reason.length < DUPLICATE_REASON_MIN) return { ok: false, message: `Give a short reason (at least ${DUPLICATE_REASON_MIN} characters) for creating a new record.` };
    if (reason.length > DUPLICATE_REASON_MAX) return { ok: false, message: `The reason can be at most ${DUPLICATE_REASON_MAX} characters.` };
  }
  return { ok: true };
}

// The wire form of a decision (the caller has already checked decisionReadiness). CREATE_NEW carries the reason only when there is one.
export function toDuplicateDecision(decision: WizardDecision): OnboardingRequest["duplicateDecision"] | null {
  if (decision.kind === "USE_EXISTING") return { kind: "USE_EXISTING", ref: decision.ref };
  if (decision.kind === "CREATE_NEW") {
    const reason = decision.reason.trim();
    return { kind: "CREATE_NEW", acknowledgedDuplicates: decision.acknowledged, ...(decision.acknowledged && reason ? { reason } : {}) };
  }
  return null;
}

// --- Refusals from the create command ---------------------------------------------------------------------------------------------------
// The server re-runs the duplicate check and every right at create time. When it refuses with one of these blocker codes the earlier
// result no longer holds (a record appeared, or the rule changed): the person must check again.
const RECHECK_CODES: ReadonlySet<string> = new Set(["strong_match_outside_access", "duplicate_acknowledgement_required", "duplicate_reason_required", "account_identity_collision", "use_existing_not_a_candidate"]);

export function refusalNeedsRecheck(code: string | null): boolean {
  return code !== null && RECHECK_CODES.has(code);
}
