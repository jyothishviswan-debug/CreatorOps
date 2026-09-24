import { describe, expect, it } from "vitest";

import { deriveReminderEffectiveStatus, isTaskOverdue } from "./client-dto";

describe("isTaskOverdue (section 5: overdue is derived, not priority)", () => {
  const now = "2026-06-15T12:00:00.000Z";

  it("is false when there is no due date", () => {
    expect(isTaskOverdue({ status: "OPEN", display: { dueAt: null } as never }, now)).toBe(false);
  });

  it("is true when the due date is in the past and the task is still active", () => {
    expect(isTaskOverdue({ status: "OPEN", display: { dueAt: "2026-06-01T00:00:00.000Z" } as never }, now)).toBe(true);
    expect(isTaskOverdue({ status: "IN_PROGRESS", display: { dueAt: "2026-06-01T00:00:00.000Z" } as never }, now)).toBe(true);
    expect(isTaskOverdue({ status: "BLOCKED", display: { dueAt: "2026-06-01T00:00:00.000Z" } as never }, now)).toBe(true);
  });

  it("is false once the due date is in the future", () => {
    expect(isTaskOverdue({ status: "OPEN", display: { dueAt: "2026-07-01T00:00:00.000Z" } as never }, now)).toBe(false);
  });

  it("is false for a DONE or CANCELLED task regardless of the due date - closing a task always clears overdue", () => {
    expect(isTaskOverdue({ status: "DONE", display: { dueAt: "2026-06-01T00:00:00.000Z" } as never }, now)).toBe(false);
    expect(isTaskOverdue({ status: "CANCELLED", display: { dueAt: "2026-06-01T00:00:00.000Z" } as never }, now)).toBe(false);
  });
});

describe("deriveReminderEffectiveStatus (section 7: DUE is derived at read time, never stored)", () => {
  const now = "2026-06-15T12:00:00.000Z";

  it("overlays DUE onto a SCHEDULED reminder once reminderAt has passed", () => {
    expect(deriveReminderEffectiveStatus({ status: "SCHEDULED", reminderAt: "2026-06-01T00:00:00.000Z" }, now)).toBe("DUE");
    expect(deriveReminderEffectiveStatus({ status: "SCHEDULED", reminderAt: now }, now)).toBe("DUE");
  });

  it("stays SCHEDULED while reminderAt has not yet passed", () => {
    expect(deriveReminderEffectiveStatus({ status: "SCHEDULED", reminderAt: "2026-07-01T00:00:00.000Z" }, now)).toBe("SCHEDULED");
  });

  it("passes every terminal status through unchanged - a terminal reminder is never overlaid as DUE", () => {
    for (const status of ["DISMISSED", "COMPLETED", "CANCELLED"] as const) {
      expect(deriveReminderEffectiveStatus({ status, reminderAt: "2020-01-01T00:00:00.000Z" }, now)).toBe(status);
    }
  });
});
