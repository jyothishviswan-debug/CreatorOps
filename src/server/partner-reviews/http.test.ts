import { describe, expect, it, vi } from "vitest";

// The actor/session helpers pull in next/headers; the mapper itself is pure.
vi.mock("@/server/administration/http", () => ({ resolveRequestActor: vi.fn(), newRequestId: vi.fn(), parseJsonBody: vi.fn() }));

import { toPartnerReviewsHttpResponse } from "./http";
import { partnerReviewsConflictResult, partnerReviewsInvalidInputResult, partnerReviewsNotFoundResult, partnerReviewsNotReadyResult, partnerReviewsStaleResult, partnerReviewsUnauthorizedResult } from "./types";

async function respond(result: Parameters<typeof toPartnerReviewsHttpResponse>[0], status?: number) {
  const response = toPartnerReviewsHttpResponse(result, status);
  return { status: response.status, body: await response.json() };
}

describe("toPartnerReviewsHttpResponse - the same 401/403/404/400/409 mapping as Assignments", () => {
  it("maps success (default 200 or an explicit status)", async () => {
    expect(await respond({ ok: true, data: { a: 1 } })).toEqual({ status: 200, body: { a: 1 } });
    expect((await respond({ ok: true, data: {} }, 201)).status).toBe(201);
  });

  it("maps unauthenticated to 401 and every other denial to an indistinguishable 403 'Forbidden.'", async () => {
    expect(await respond(partnerReviewsUnauthorizedResult("not_authenticated"))).toEqual({ status: 401, body: { error: "Forbidden." } });
    for (const reason of ["feature_denied", "action_denied", "scope_denied"] as const) {
      expect(await respond(partnerReviewsUnauthorizedResult(reason))).toEqual({ status: 403, body: { error: "Forbidden." } });
    }
  });

  it("maps not_found 404, invalid_input 400, stale_write 409, conflict 409, and not_ready 409 with its blockers", async () => {
    expect((await respond(partnerReviewsNotFoundResult("x"))).status).toBe(404);
    expect((await respond(partnerReviewsInvalidInputResult("x"))).status).toBe(400);
    expect((await respond(partnerReviewsStaleResult())).status).toBe(409);
    expect((await respond(partnerReviewsConflictResult("x"))).status).toBe(409);
    expect(await respond(partnerReviewsNotReadyResult("no", [{ code: "REVISION_NOT_NEEDED", message: "m" }]))).toEqual({ status: 409, body: { error: "no", blockers: [{ code: "REVISION_NOT_NEEDED", message: "m" }] } });
  });
});
