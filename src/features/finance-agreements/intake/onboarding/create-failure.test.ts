import { describe, expect, it } from "vitest";

import type { FinanceApiFailure } from "../../api-client";
import { classifyCreateFailure, LOST_ANSWER_MESSAGE, REQUEST_CONFLICT_CODE } from "./create-failure";

const failure = (over: Partial<FinanceApiFailure>): FinanceApiFailure => ({ ok: false, status: 500, kind: "error", message: "Something went wrong.", ...over });

describe("classifying a failed create call", () => {
  it("a typed blocker is a refusal carrying its code and message; duplicate-rule blockers void the earlier check", () => {
    expect(classifyCreateFailure(failure({ status: 409, kind: "not_ready", message: "x", blockers: [{ code: "counterparty_create_not_permitted", message: "You can review this Agreement, but you do not have permission to create a new Partner." }] }))).toEqual({
      kind: "refused",
      message: "You can review this Agreement, but you do not have permission to create a new Partner.",
      code: "counterparty_create_not_permitted",
      recheck: false,
    });
    expect(classifyCreateFailure(failure({ status: 409, kind: "not_ready", message: "x", blockers: [{ code: "strong_match_outside_access", message: "outside" }] }))).toMatchObject({ code: "strong_match_outside_access", recheck: true });
    expect(classifyCreateFailure(failure({ status: 409, kind: "not_ready", message: "fallback", blockers: [] }))).toMatchObject({ kind: "refused", message: "fallback", code: null });
  });

  it("a denial or a field problem is a refusal with the server's neutral text", () => {
    expect(classifyCreateFailure(failure({ status: 403, kind: "forbidden", message: "You do not have access to this." }))).toEqual({ kind: "refused", message: "You do not have access to this.", code: null, recheck: false });
    expect(classifyCreateFailure(failure({ status: 400, kind: "invalid", message: "Choose a region you have access to: the new Partner must be visible to you." }))).toMatchObject({ kind: "refused", recheck: false, message: expect.stringMatching(/Choose a region/) });
  });

  it("a record that is no longer visible sends the person back to the duplicate check", () => {
    expect(classifyCreateFailure(failure({ status: 404, kind: "not_found", message: "Not found." }))).toMatchObject({ kind: "refused", recheck: true });
  });

  it("the same id with a different body (409) says so and offers a fresh start", () => {
    const view = classifyCreateFailure(failure({ status: 409, kind: "conflict", message: "This clientRequestId was already used for a different onboarding request." }));
    expect(view).toMatchObject({ kind: "refused", code: REQUEST_CONFLICT_CODE });
    expect(view.kind === "refused" && view.message).toMatch(/start again/);
    expect(classifyCreateFailure(failure({ status: 409, kind: "stale", message: "changed elsewhere" }))).toMatchObject({ code: REQUEST_CONFLICT_CODE });
  });

  it("a network or server error is a LOST answer: the request may have reached the server, so retry the same one", () => {
    expect(classifyCreateFailure(failure({ status: 0, kind: "network", message: "Could not reach the server." }))).toEqual({ kind: "lost", message: LOST_ANSWER_MESSAGE });
    expect(classifyCreateFailure(failure({ status: 500, kind: "error" }))).toEqual({ kind: "lost", message: LOST_ANSWER_MESSAGE });
    expect(LOST_ANSWER_MESSAGE).toMatch(/nothing is created twice/);
  });
});
