import type { OnboardingOutcomeDto } from "@/server/finance-agreements/onboarding-dto";
import type { OnboardingRequest } from "@/server/finance-agreements/onboarding-input";
import type { CounterpartyType } from "@/server/finance-agreements/types";

import type { FinanceApiResult } from "../../api-client";
import type { AgreementForChoice } from "../../agreement-for";
import { isValidClientRequestId } from "./create-request";

// Step 14B.1 onboarding: RETRY / RESUME across a reload (pure + a defensive storage wrapper).
//
// The server's step ledger already makes the SAME request idempotent and resumable. The browser's job is to still HAVE that request after a
// reload or a lost connection: right before the first send it remembers { clientRequestId, the request body, which card was chosen } in
// sessionStorage (this tab only, never shared, cleared when the onboarding completes or is deliberately restarted). It holds the reviewed
// profile the person typed (name, contact, region, account links) and NO identity value - none exists in this flow.
//
// On the next load the wizard asks the server `getOnboardingStatus(clientRequestId)`:
//   COMPLETED     the records exist: go straight to the Agreement (the File is gone, so Contract source asks for it again)
//   FAILED /      show the create step again, locked to the remembered request, with Retry (or Check again)
//   IN_PROGRESS
//   not found     the request never reached the server (or is not this person's): forget it - nothing was created
// sessionStorage can be missing, full or blocked: every access is guarded and the wizard works without it (it just cannot resume).

export const ONBOARDING_STORAGE_KEY = "creatorops.finance.agreements.onboarding.v1";

export type PersistedOnboarding = {
  v: 1;
  clientRequestId: string;
  type: CounterpartyType;
  choice: AgreementForChoice;
  request: OnboardingRequest;
  savedAt: string;
};

const CHOICES: readonly string[] = ["INSTAGRAM_PARTNER", "YOUTUBE_PARTNER", "IG_YT_PARTNER", "VENDOR"];

export function serializePersisted(record: PersistedOnboarding): string {
  return JSON.stringify(record);
}

// Anything malformed (a hand-edited or older value) is dropped, never trusted.
export function parsePersisted(text: string | null | undefined): PersistedOnboarding | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const request = record.request as Record<string, unknown> | undefined;
  if (record.v !== 1 || typeof record.clientRequestId !== "string" || !isValidClientRequestId(record.clientRequestId)) return null;
  if (record.type !== "PARTNER" && record.type !== "VENDOR") return null;
  if (typeof record.choice !== "string" || !CHOICES.includes(record.choice)) return null;
  if (!request || typeof request !== "object" || request.clientRequestId !== record.clientRequestId || request.type !== record.type) return null;
  if (!request.reviewedProfile || typeof request.reviewedProfile !== "object" || !request.duplicateDecision || typeof request.duplicateDecision !== "object") return null;
  return { v: 1, clientRequestId: record.clientRequestId, type: record.type, choice: record.choice as AgreementForChoice, request: request as unknown as OnboardingRequest, savedAt: typeof record.savedAt === "string" ? record.savedAt : "" };
}

// --- Storage (guarded) ---------------------------------------------------------------------------------------------------------------
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function browserSessionStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function readPersisted(storage: StorageLike | null): PersistedOnboarding | null {
  if (!storage) return null;
  try {
    return parsePersisted(storage.getItem(ONBOARDING_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writePersisted(storage: StorageLike | null, record: PersistedOnboarding): boolean {
  if (!storage) return false;
  try {
    storage.setItem(ONBOARDING_STORAGE_KEY, serializePersisted(record));
    return true;
  } catch {
    return false;
  }
}

export function clearPersisted(storage: StorageLike | null): void {
  if (!storage) return;
  try {
    storage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    // nothing to clear
  }
}

// --- What a status answer means ---------------------------------------------------------------------------------------------------------
export type ResumeDecision =
  | { kind: "redirect"; agreementRef: string; outcome: OnboardingOutcomeDto }
  | { kind: "restore"; outcome: OnboardingOutcomeDto }
  | { kind: "discard" }
  // The status could not be read (network / server): keep the remembered request and let the person retry; never discard on a transient error.
  | { kind: "unavailable"; message: string };

export function decideResume(status: FinanceApiResult<OnboardingOutcomeDto>): ResumeDecision {
  if (!status.ok) {
    if (status.kind === "not_found") return { kind: "discard" };
    return { kind: "unavailable", message: status.message };
  }
  const outcome = status.data;
  if (outcome.outcome === "COMPLETED" && outcome.agreementRef) return { kind: "redirect", agreementRef: outcome.agreementRef, outcome };
  return { kind: "restore", outcome };
}
