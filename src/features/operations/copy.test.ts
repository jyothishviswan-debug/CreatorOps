import { describe, expect, it } from "vitest";

import { deriveDueState, displayNameOrRef, formatDateTimeInputValue, toIsoFromLocalInput } from "./copy";

// Step 18B: pure view-model tests for the Operations UI's own derived display logic - the same
// "server/logic-only" convention every other feature directory in this codebase uses (see
// src/features/finance-payments/workspace/workspace-view-model.test.ts; this repo has no React
// component-render test infrastructure configured - vitest.config.mts runs environment "node" and
// only includes *.test.ts, never *.tsx - so the actual rendered-DOM proof belongs in Playwright).

describe("deriveDueState (spec: 'Overdue is not a stored lifecycle status')", () => {
  const now = "2026-06-15T12:00:00.000Z";

  it("is no_due_date when dueAt is null", () => {
    expect(deriveDueState({ dueAt: null, isOverdue: false, status: "OPEN" }, now)).toBe("no_due_date");
  });

  it("is overdue whenever the server already says isOverdue, regardless of the exact gap", () => {
    expect(deriveDueState({ dueAt: "2026-06-01T00:00:00.000Z", isOverdue: true, status: "OPEN" }, now)).toBe("overdue");
    expect(deriveDueState({ dueAt: "2026-06-14T00:00:00.000Z", isOverdue: true, status: "IN_PROGRESS" }, now)).toBe("overdue");
  });

  it("is due_today when the due date falls on the same calendar day, not overdue", () => {
    expect(deriveDueState({ dueAt: "2026-06-15T18:00:00.000Z", isOverdue: false, status: "OPEN" }, now)).toBe("due_today");
  });

  it("is due_soon within the 48h window but not the same day", () => {
    expect(deriveDueState({ dueAt: "2026-06-17T10:00:00.000Z", isOverdue: false, status: "OPEN" }, now)).toBe("due_soon");
  });

  it("is scheduled once the due date is further out than the due-soon window", () => {
    expect(deriveDueState({ dueAt: "2026-07-01T00:00:00.000Z", isOverdue: false, status: "OPEN" }, now)).toBe("scheduled");
  });

  it("is scheduled (never overdue/due_today/due_soon) once a task is DONE or CANCELLED, even with a past due date - closing a task always clears its due pressure", () => {
    expect(deriveDueState({ dueAt: "2026-01-01T00:00:00.000Z", isOverdue: false, status: "DONE" }, now)).toBe("scheduled");
    expect(deriveDueState({ dueAt: "2026-01-01T00:00:00.000Z", isOverdue: false, status: "CANCELLED" }, now)).toBe("scheduled");
  });
});

describe("displayNameOrRef (Step 18B follow-up: a resolved display name always wins over the raw ref)", () => {
  it("prefers a non-blank display name", () => {
    expect(displayNameOrRef("Manager (Test)", "user_1")).toBe("Manager (Test)");
  });

  it("falls back to the ref when the display name is null, undefined, or blank", () => {
    expect(displayNameOrRef(null, "user_1")).toBe("user_1");
    expect(displayNameOrRef(undefined, "user_1")).toBe("user_1");
    expect(displayNameOrRef("   ", "user_1")).toBe("user_1");
  });
});

describe("date/time local-input round trip", () => {
  it("formatDateTimeInputValue returns an empty string for null, a datetime-local-shaped string otherwise", () => {
    expect(formatDateTimeInputValue(null)).toBe("");
    expect(formatDateTimeInputValue("2026-10-01T09:00:00.000Z")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("toIsoFromLocalInput returns null for an empty value and a real ISO string otherwise", () => {
    expect(toIsoFromLocalInput("")).toBeNull();
    expect(toIsoFromLocalInput("2026-10-01T09:00")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("round-trips through both directions without losing the wall-clock minute", () => {
    const iso = "2026-10-01T09:00:00.000Z";
    const inputValue = formatDateTimeInputValue(iso);
    const backToIso = toIsoFromLocalInput(inputValue);
    expect(backToIso).not.toBeNull();
    // Re-formatting the round-tripped ISO must reproduce the exact same local input value - proves
    // no drift across the two conversions regardless of the runner's own timezone.
    expect(formatDateTimeInputValue(backToIso)).toBe(inputValue);
  });
});
