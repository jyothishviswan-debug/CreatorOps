import { describe, expect, it } from "vitest";

import { completedStepsOf, toOnboardingOutcomeDto } from "./onboarding-service";
import { onboardingLedgerDocSchema, onboardingLedgerId, type OnboardingLedgerDoc } from "./onboarding-ledger";

// The pure half of the orchestration: how a step ledger reads as a response. The runner itself (owning services, retries, faults) is
// exercised against real emulators in onboarding.emulator.test.ts.

const KEY_IG = "1".repeat(64);
const KEY_YT = "2".repeat(64);
const T = "2026-09-01T00:00:00.000Z";

function ledger(over: Omit<Partial<OnboardingLedgerDoc>, "steps"> & { steps?: Partial<OnboardingLedgerDoc["steps"]> } = {}): OnboardingLedgerDoc {
  const { steps, ...rest } = over;
  return onboardingLedgerDocSchema.parse({
    kind: "ONBOARDING",
    onboardingRef: onboardingLedgerId("actor-1", "onb-req-12345678"),
    clientRequestId: "onb-req-12345678",
    actorUserRef: "usr-1",
    counterpartyType: "PARTNER",
    mode: "CREATE_NEW",
    createdVia: "FINANCE_AGREEMENT_ONBOARDING",
    inputFingerprint: "a".repeat(64),
    status: "IN_PROGRESS",
    attempts: 1,
    lease: null,
    duplicateDecision: { kind: "CREATE_NEW", acknowledgedDuplicates: false, reasonRecorded: false },
    steps: { validatedAt: T, counterparty: null, plannedAccountKeys: [KEY_IG, KEY_YT], accounts: [], agreement: null, ...steps },
    failure: null,
    startedAt: T,
    updatedAt: T,
    ...rest,
  });
}

const counterparty = { intentAt: T, ref: "partner-ref-1", displayName: "Asha Studio", created: true, adopted: false, resolvedAt: T };
const igDone = { key: KEY_IG, platform: "instagram", intentAt: T, partnerAccountRef: "acc-ig", resolvedAt: T };
const ytDone = { key: KEY_YT, platform: "youtube", intentAt: T, partnerAccountRef: "acc-yt", resolvedAt: T };

describe("completed steps", () => {
  it("reads VALIDATED, then the counterparty, then the accounts only once EVERY planned account is done, then the draft", () => {
    expect(completedStepsOf(ledger())).toEqual(["VALIDATED"]);
    expect(completedStepsOf(ledger({ steps: { counterparty: { ...counterparty, ref: null, displayName: null, resolvedAt: null } } }))).toEqual(["VALIDATED"]);
    expect(completedStepsOf(ledger({ steps: { counterparty } }))).toEqual(["VALIDATED", "COUNTERPARTY_CREATED"]);
    expect(completedStepsOf(ledger({ steps: { counterparty, accounts: [igDone] } }))).toEqual(["VALIDATED", "COUNTERPARTY_CREATED"]);
    expect(completedStepsOf(ledger({ steps: { counterparty, accounts: [igDone, { ...ytDone, resolvedAt: null, partnerAccountRef: null }] } }))).toEqual(["VALIDATED", "COUNTERPARTY_CREATED"]);
    expect(completedStepsOf(ledger({ steps: { counterparty, accounts: [igDone, ytDone] } }))).toEqual(["VALIDATED", "COUNTERPARTY_CREATED", "ACCOUNTS_CREATED"]);
    expect(completedStepsOf(ledger({ steps: { counterparty, accounts: [igDone, ytDone], agreement: { agreementRef: "agr_x", at: T } } }))).toEqual(["VALIDATED", "COUNTERPARTY_CREATED", "ACCOUNTS_CREATED", "AGREEMENT_DRAFT_CREATED"]);
  });

  it("with no accounts planned (Vendor / USE_EXISTING) the accounts step is done as soon as the counterparty is", () => {
    expect(completedStepsOf(ledger({ steps: { plannedAccountKeys: [], counterparty } }))).toEqual(["VALIDATED", "COUNTERPARTY_CREATED", "ACCOUNTS_CREATED"]);
  });
});

describe("outcome DTO", () => {
  it("COMPLETED names the counterparty, the accounts and the Agreement, and is not retryable", () => {
    const done = ledger({ status: "COMPLETED", steps: { counterparty, accounts: [igDone, ytDone], agreement: { agreementRef: "agr_x", at: T } } });
    expect(toOnboardingOutcomeDto(done)).toMatchObject({
      outcome: "COMPLETED",
      retryable: false,
      code: null,
      message: null,
      failedStep: null,
      counterparty: { type: "PARTNER", ref: "partner-ref-1", displayName: "Asha Studio", created: true },
      accounts: [{ platform: "instagram", partnerAccountRef: "acc-ig", created: true }, { platform: "youtube", partnerAccountRef: "acc-yt", created: true }],
      agreementRef: "agr_x",
      replayed: false,
      createdVia: "FINANCE_AGREEMENT_ONBOARDING",
    });
    expect(toOnboardingOutcomeDto(done, { replayed: true }).replayed).toBe(true);
  });

  it("FAILED carries completedSteps, failedStep, retryable, code and message - and the partial refs already created", () => {
    const failed = ledger({
      status: "FAILED",
      steps: { counterparty, accounts: [igDone] },
      failure: { step: "ACCOUNTS_CREATED", code: "account_create_failed", message: "The Partner Account could not be created right now. Try again to resume.", retryable: true, duplicateSignal: false, at: T },
    });
    expect(toOnboardingOutcomeDto(failed)).toMatchObject({
      outcome: "FAILED",
      completedSteps: ["VALIDATED", "COUNTERPARTY_CREATED"],
      failedStep: "ACCOUNTS_CREATED",
      retryable: true,
      code: "account_create_failed",
      duplicateSignal: false,
      counterparty: { ref: "partner-ref-1" },
      accounts: [{ partnerAccountRef: "acc-ig" }],
      agreementRef: null,
    });
  });

  it("an Account identity collision is a strong duplicate signal and not retryable as-is", () => {
    const collided = ledger({ status: "FAILED", steps: { counterparty }, failure: { step: "ACCOUNTS_CREATED", code: "account_identity_collision", message: "x", retryable: false, duplicateSignal: true, at: T } });
    expect(toOnboardingOutcomeDto(collided)).toMatchObject({ outcome: "FAILED", retryable: false, duplicateSignal: true, code: "account_identity_collision" });
  });

  it("IN_PROGRESS (running, interrupted, or a newer runner holds it) is retryable with the neutral code", () => {
    expect(toOnboardingOutcomeDto(ledger())).toMatchObject({ outcome: "IN_PROGRESS", retryable: true, code: "onboarding_in_progress", failedStep: null });
    const failed = ledger({ status: "FAILED", failure: { step: "COUNTERPARTY_CREATED", code: "x", message: "y", retryable: false, duplicateSignal: false, at: T } });
    expect(toOnboardingOutcomeDto(failed, { inProgress: true })).toMatchObject({ outcome: "IN_PROGRESS", retryable: true, code: "onboarding_in_progress" });
  });

  it("carries refs, names and step states only - no contact detail, identity value, uid or fingerprint", () => {
    const dto = toOnboardingOutcomeDto(ledger({ status: "COMPLETED", steps: { counterparty, accounts: [igDone, ytDone], agreement: { agreementRef: "agr_x", at: T } } }));
    const text = JSON.stringify(dto);
    expect(text).not.toContain("a".repeat(64));
    expect(text).not.toContain("actor-1");
    expect(text).not.toContain(KEY_IG);
    expect(Object.keys(dto).sort()).toEqual(["accounts", "agreementRef", "clientRequestId", "code", "completedSteps", "counterparty", "counterpartyType", "createdVia", "duplicateSignal", "failedStep", "message", "mode", "onboardingRef", "outcome", "replayed", "retryable"]);
  });
});
