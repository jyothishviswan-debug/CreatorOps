import type { OnboardingRequest } from "@/server/finance-agreements/onboarding-input";
import type { CounterpartyType } from "@/server/finance-agreements/types";

import { CLIENT_REQUEST_ID_PATTERN } from "../intake-logic";
import { toDuplicateDecision, type WizardDecision } from "./duplicate-rules";
import { buildAccounts, buildReviewedProfile, emptyForm, type OnboardingForm } from "./wizard-form";

// Step 14B.1 onboarding: the CREATE request and its idempotency key (pure).
//
// ONE clientRequestId belongs to ONE request body. The server keys its resumable step ledger on it: the same id with the same body resumes or
// replays (no second Partner / Vendor / Account / Agreement), the same id with a DIFFERENT body is a 409. So:
//   - the id is minted once per wizard mount and reused for every retry of the same body;
//   - it is replaced only on an INTENTIONAL new start (`startAgain`), or after a success (a later onboarding is a new one);
//   - once a request has been sent the inputs are read-only, so the body cannot drift under a live id.

export type BuiltRequest = { request: OnboardingRequest; signature: string };

// The request body WITHOUT the id. With USE_EXISTING the accounts (and email / phone / name) are sent unchanged: the server re-runs the same
// duplicate check and only accepts a record that check returns.
export function buildOnboardingRequest(input: { clientRequestId: string; type: CounterpartyType; form: OnboardingForm; decision: WizardDecision }): OnboardingRequest | null {
  const duplicateDecision = toDuplicateDecision(input.decision);
  if (!duplicateDecision) return null;
  const accounts = input.type === "PARTNER" ? buildAccounts(input.form) : [];
  return {
    clientRequestId: input.clientRequestId,
    type: input.type,
    reviewedProfile: buildReviewedProfile(input.form, input.type),
    ...(accounts.length > 0 ? { accounts } : {}),
    duplicateDecision,
  };
}

// A stable text of the body (sorted keys) without the id: two requests with the same signature are the same request.
export function requestSignature(request: Omit<OnboardingRequest, "clientRequestId"> | OnboardingRequest): string {
  const { clientRequestId: _ignored, ...rest } = request as OnboardingRequest;
  void _ignored;
  return stableStringify(rest);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// --- The id -------------------------------------------------------------------------------------------------------------------------
export function newOnboardingRequestId(random: () => number = Math.random): string {
  const uuid = typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function" ? globalThis.crypto.randomUUID() : null;
  if (uuid) return `onboard-${uuid}`;
  let text = "";
  for (let index = 0; index < 24; index += 1) text += Math.floor(random() * 36).toString(36);
  return `onboard-${text}`;
}

export const isValidClientRequestId = (id: string): boolean => CLIENT_REQUEST_ID_PATTERN.test(id);

// What the wizard keeps between attempts: the id and the signature of the body it was minted for.
export type RequestIdHolder = { id: string; signature: string } | null;

// The id to send for a body. The SAME body reuses the held id (a retry); a body that differs from the held one is only reachable through
// an intentional restart (the holder was cleared) - if it ever is not, a fresh id is minted, never the old one (so it can never be a 409).
export function idForRequest(holder: RequestIdHolder, signature: string, mint: () => string = newOnboardingRequestId): { id: string; signature: string } {
  return holder && holder.signature === signature ? holder : { id: mint(), signature };
}

// --- The inverse: a remembered request back into form + decision (resume after a reload) -------------------------------------------------
// The remembered request came from THIS browser tab's own earlier send, but it is still treated as untrusted text: every field is picked
// explicitly and typed, and anything unexpected simply leaves the form field blank.
export function formFromRequest(request: OnboardingRequest, platforms: readonly string[]): OnboardingForm {
  const base = emptyForm(request.type, platforms);
  const profile = request.reviewedProfile;
  const accounts = request.accounts ?? [];
  return {
    ...base,
    displayName: typeof profile.displayName === "string" ? profile.displayName : "",
    legalName: typeof profile.legalName === "string" ? profile.legalName : "",
    email: typeof profile.email === "string" ? profile.email : "",
    phone: typeof profile.phone === "string" ? profile.phone : "",
    regionId: Array.isArray(profile.regionIds) && typeof profile.regionIds[0] === "string" ? profile.regionIds[0] : "",
    vendorType: typeof profile.vendorType === "string" ? profile.vendorType : "",
    accounts: base.accounts.map((row) => {
      const saved = accounts.find((account) => typeof account.platform === "string" && account.platform.trim().toLowerCase() === row.platform);
      if (!saved) return row;
      const byLink = typeof saved.profileUrl === "string" && saved.profileUrl.length > 0;
      return { platform: row.platform, locatorKind: byLink ? ("LINK" as const) : ("HANDLE" as const), locator: (byLink ? saved.profileUrl : saved.handle) ?? "", pageName: saved.displayName ?? "" };
    }),
  };
}

export function decisionFromRequest(request: OnboardingRequest): WizardDecision {
  const decision = request.duplicateDecision;
  if (decision.kind === "USE_EXISTING") return { kind: "USE_EXISTING", ref: decision.ref };
  return { kind: "CREATE_NEW", acknowledged: decision.acknowledgedDuplicates, reason: decision.reason ?? "" };
}
