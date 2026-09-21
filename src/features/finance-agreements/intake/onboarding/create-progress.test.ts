import { describe, expect, it } from "vitest";

import { outcomeDto } from "./onboarding-fixtures";
import { applicableSteps, completionAnnouncement, describeOutcome, keptRecords, outcomeAnnouncement, stepRows } from "./create-progress";

const PARTNER = { type: "PARTNER", mode: "CREATE_NEW", accountCount: 2 } as const;
const states = (rows: ReturnType<typeof stepRows>) => rows.map((row) => `${row.step}:${row.state}`);

describe("applicable steps", () => {
  it("a new Partner with accounts runs all four; without accounts, a Vendor, or USE_EXISTING skips Accounts", () => {
    expect(applicableSteps(PARTNER)).toEqual(["VALIDATED", "COUNTERPARTY_CREATED", "ACCOUNTS_CREATED", "AGREEMENT_DRAFT_CREATED"]);
    expect(applicableSteps({ ...PARTNER, accountCount: 0 })).not.toContain("ACCOUNTS_CREATED");
    expect(applicableSteps({ type: "VENDOR", mode: "CREATE_NEW", accountCount: 0 })).toEqual(["VALIDATED", "COUNTERPARTY_CREATED", "AGREEMENT_DRAFT_CREATED"]);
    expect(applicableSteps({ ...PARTNER, mode: "USE_EXISTING" })).not.toContain("ACCOUNTS_CREATED");
  });
});

describe("step rows from the outcome", () => {
  it("while the request is in flight the first step is current", () => {
    expect(states(stepRows(null, { ...PARTNER, running: true }))).toEqual(["VALIDATED:current", "COUNTERPARTY_CREATED:pending", "ACCOUNTS_CREATED:pending", "AGREEMENT_DRAFT_CREATED:pending"]);
    expect(states(stepRows(null, PARTNER)).every((row) => row.endsWith(":pending"))).toBe(true);
  });

  it("COMPLETED marks every step done, with the past-tense labels", () => {
    const rows = stepRows(outcomeDto(), PARTNER);
    expect(rows.map((row) => row.state)).toEqual(["done", "done", "done", "done"]);
    expect(rows.map((row) => row.label)).toEqual(["Details validated", "Partner created", "Partner Accounts created", "Agreement draft created"]);
  });

  it("FAILED shows what finished, where it stopped, and the rest as pending", () => {
    const outcome = outcomeDto({ outcome: "FAILED", completedSteps: ["VALIDATED", "COUNTERPARTY_CREATED"], failedStep: "ACCOUNTS_CREATED", retryable: true, code: "account_create_failed", message: "The Partner Account could not be created right now. Try again to resume.", agreementRef: null, accounts: [] });
    expect(states(stepRows(outcome, PARTNER))).toEqual(["VALIDATED:done", "COUNTERPARTY_CREATED:done", "ACCOUNTS_CREATED:failed", "AGREEMENT_DRAFT_CREATED:pending"]);
  });

  it("IN_PROGRESS marks the first unfinished step as current", () => {
    const outcome = outcomeDto({ outcome: "IN_PROGRESS", completedSteps: ["VALIDATED"], code: "onboarding_in_progress", agreementRef: null, counterparty: null, accounts: [] });
    expect(states(stepRows(outcome, PARTNER))).toEqual(["VALIDATED:done", "COUNTERPARTY_CREATED:current", "ACCOUNTS_CREATED:pending", "AGREEMENT_DRAFT_CREATED:pending"]);
  });

  it("USE_EXISTING labels the second step as confirming the existing record, never as a creation", () => {
    const rows = stepRows(outcomeDto({ mode: "USE_EXISTING" }), { type: "VENDOR", mode: "USE_EXISTING", accountCount: 0 });
    expect(rows.map((row) => row.label)).toEqual(["Details validated", "Existing Vendor confirmed", "Agreement draft created"]);
  });
});

describe("outcome view", () => {
  it("COMPLETED: continue; a replay says nothing new was created", () => {
    expect(describeOutcome(outcomeDto())).toMatchObject({ tone: "success", action: "CONTINUE", title: "Partner created and Agreement draft started", canStartAgain: false });
    expect(describeOutcome(outcomeDto({ replayed: true })).message).toMatch(/Nothing new was created/);
    expect(describeOutcome(outcomeDto({ mode: "USE_EXISTING", counterparty: { type: "PARTNER", ref: "prt_x", displayName: "Asha Rao", created: false } })).title).toBe("Agreement draft started");
  });

  it("a retryable FAILED offers Retry (same request) and says nothing is created twice", () => {
    const view = describeOutcome(outcomeDto({ outcome: "FAILED", completedSteps: ["VALIDATED"], failedStep: "COUNTERPARTY_CREATED", retryable: true, message: "The Partner could not be created right now. Try again to resume.", counterparty: null, accounts: [], agreementRef: null }));
    expect(view).toMatchObject({ tone: "error", action: "RETRY", actionLabel: "Retry", title: "Creating the Partner did not finish", canStartAgain: true });
    expect(view.message).toMatch(/Nothing is created twice/);
  });

  it("after the record exists a retryable failure can only be retried (changing the details would create a second record)", () => {
    const view = describeOutcome(outcomeDto({ outcome: "FAILED", completedSteps: ["VALIDATED", "COUNTERPARTY_CREATED"], failedStep: "AGREEMENT_DRAFT_CREATED", retryable: true, message: "x", agreementRef: null, accounts: [] }));
    expect(view.canStartAgain).toBe(false);
    expect(view.keptRecords).toEqual(["Partner created: Asha Rao"]);
  });

  it("a non-retryable failure offers a fresh start; an account collision is named a strong duplicate signal", () => {
    const view = describeOutcome(outcomeDto({ outcome: "FAILED", completedSteps: ["VALIDATED", "COUNTERPARTY_CREATED"], failedStep: "ACCOUNTS_CREATED", retryable: false, code: "account_identity_collision", message: "This account already belongs to another Partner.", duplicateSignal: true, agreementRef: null, accounts: [] }));
    expect(view).toMatchObject({ action: "START_AGAIN", canStartAgain: true, duplicateSignal: true, title: "A matching Partner account already exists" });
  });

  it("IN_PROGRESS offers Check again", () => {
    expect(describeOutcome(outcomeDto({ outcome: "IN_PROGRESS", message: null }))).toMatchObject({ tone: "info", action: "CHECK_AGAIN", actionLabel: "Check again" });
  });

  it("names the records that exist so nothing is created twice by accident", () => {
    expect(keptRecords(outcomeDto())).toEqual(["Partner created: Asha Rao", "1 Partner Account created", "Agreement draft created"]);
    expect(keptRecords(outcomeDto({ mode: "USE_EXISTING", counterparty: { type: "PARTNER", ref: "p", displayName: "Asha", created: false }, accounts: [] }))).toEqual(["Existing Partner: Asha", "Agreement draft created"]);
  });
});

describe("announcements", () => {
  it("announces progress, the outcome, and the hand-off with the provenance sentence", () => {
    expect(outcomeAnnouncement(null, true)?.text).toMatch(/Creating the record/);
    expect(outcomeAnnouncement(null, false)).toBeNull();
    expect(outcomeAnnouncement(outcomeDto({ outcome: "FAILED", failedStep: "COUNTERPARTY_CREATED", retryable: true, message: "Nope." }), false)?.tone).toBe("error");
    expect(completionAnnouncement(outcomeDto(), { fileHeld: true })).toBe("Partner created from Finance Agreement onboarding, and the Agreement draft started. Adding the signed Agreement to the draft…");
    expect(completionAnnouncement(outcomeDto(), { fileHeld: false })).toMatch(/Choose the signed Agreement file again in Contract source/);
    expect(completionAnnouncement(outcomeDto({ mode: "USE_EXISTING", counterpartyType: "VENDOR" }), { fileHeld: true })).toMatch(/existing Vendor/);
  });
});
