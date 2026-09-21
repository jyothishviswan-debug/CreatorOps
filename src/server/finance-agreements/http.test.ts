import { describe, expect, it, vi } from "vitest";

// The actor/session helpers pull in next/headers; the mapper itself is pure.
vi.mock("@/server/administration/http", () => ({ resolveRequestActor: vi.fn(), newRequestId: vi.fn(), parseJsonBody: vi.fn() }));

import { optionalIntegerParam, optionalStringParam, toFinanceAgreementsHttpResponse } from "./http";
import {
  financeAgreementsConflictResult,
  financeAgreementsInternalResult,
  financeAgreementsInvalidInputResult,
  financeAgreementsNotFoundResult,
  financeAgreementsNotReadyResult,
  financeAgreementsStaleResult,
  financeAgreementsUnauthorizedResult,
  NEUTRAL_NOT_FOUND_MESSAGE,
} from "./types";

async function respond(result: Parameters<typeof toFinanceAgreementsHttpResponse>[0], status?: number) {
  const response = toFinanceAgreementsHttpResponse(result, status);
  return { status: response.status, body: await response.json() };
}

describe("toFinanceAgreementsHttpResponse - the same 401/403/404/400/409/500 mapping as Partner Reviews", () => {
  it("maps success (default 200 or an explicit 201)", async () => {
    expect(await respond({ ok: true, data: { a: 1 } })).toEqual({ status: 200, body: { a: 1 } });
    expect((await respond({ ok: true, data: {} }, 201)).status).toBe(201);
  });

  it("maps unauthenticated to 401 and EVERY other denial (incl. sensitive) to an indistinguishable 403 'Forbidden.'", async () => {
    expect(await respond(financeAgreementsUnauthorizedResult("not_authenticated"))).toEqual({ status: 401, body: { error: "Forbidden." } });
    for (const reason of ["feature_denied", "action_denied", "scope_denied", "sensitive_denied"] as const) {
      expect(await respond(financeAgreementsUnauthorizedResult(reason))).toEqual({ status: 403, body: { error: "Forbidden." } });
    }
  });

  it("maps not_found 404, invalid_input 400, stale_write 409, conflict 409, internal 500", async () => {
    expect(await respond(financeAgreementsNotFoundResult())).toEqual({ status: 404, body: { error: NEUTRAL_NOT_FOUND_MESSAGE } });
    expect((await respond(financeAgreementsInvalidInputResult("x"))).status).toBe(400);
    expect((await respond(financeAgreementsStaleResult())).status).toBe(409);
    expect((await respond(financeAgreementsConflictResult("x"))).status).toBe(409);
    expect((await respond(financeAgreementsInternalResult())).status).toBe(500);
  });

  it("maps not_ready to 409 with its blockers", async () => {
    expect(await respond(financeAgreementsNotReadyResult("no", [{ code: "field_pending", message: "m", fieldKey: "currency" }]))).toEqual({
      status: 409,
      body: { error: "no", blockers: [{ code: "field_pending", message: "m", fieldKey: "currency" }] },
    });
  });
});

describe("query-string helpers (routes never interpret, clamp or repair a value)", () => {
  const params = (query: string) => new URLSearchParams(query);

  it("optionalIntegerParam: absent => undefined; a plain non-negative integer => the number; anything else => NaN (which the service's strict schema rejects as 400)", () => {
    expect(optionalIntegerParam(params(""), "version")).toBeUndefined();
    expect(optionalIntegerParam(params("version=2"), "version")).toBe(2);
    expect(optionalIntegerParam(params("version=0"), "version")).toBe(0);
    for (const bad of ["", "abc", "-1", "1.5", "1e3", " 2", "2 ", "0x10", "9999999999"]) expect(optionalIntegerParam(params(`version=${bad}`), "version"), bad).toBeNaN();
    // the first of repeated params is used, never an array
    expect(optionalIntegerParam(params("version=1&version=2"), "version")).toBe(1);
  });

  it("optionalStringParam: absent => undefined, otherwise passed through verbatim for the service to validate", () => {
    expect(optionalStringParam(params(""), "runRef")).toBeUndefined();
    expect(optionalStringParam(params("runRef=run_abc"), "runRef")).toBe("run_abc");
    expect(optionalStringParam(params("runRef="), "runRef")).toBe("");
  });
});
