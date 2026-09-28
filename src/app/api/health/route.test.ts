import { describe, expect, it } from "vitest";

import { GET } from "./route";

// Production hardening (base spec section 29 - health/readiness): "Add tests." Liveness must never
// depend on anything external - this asserts the handler returns 200 with no imports/mocks of
// Firestore/Auth/env at all, which is itself the proof it has no such dependency.
describe("GET /api/health", () => {
  it("returns 200 ok with no secrets/config in the body", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });
});
