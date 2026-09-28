import { afterEach, describe, expect, it, vi } from "vitest";

// Production hardening (base spec section 29 - health/readiness): "Add tests." Mocks the Admin
// SDK/env boundary rather than requiring real Firebase config in a plain unit-test run - readiness
// itself is proven live against a running dev server (see next.config.ts's/the completion report's
// own note); this proves the handler's own success/failure branching and its promise never to leak
// a config value, provider detail, or stack trace either way.
vi.mock("@/server/firebase/admin", () => ({
  getAdminFirestore: vi.fn(),
  getAdminAuth: vi.fn(),
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: vi.fn(),
}));

describe("GET /api/ready", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns 200 ready when config parses and the Admin SDK clients construct", async () => {
    const { GET } = await import("./route");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });

  it("returns 503 not_ready, with no stack/config leak, when config validation throws", async () => {
    const env = await import("@/lib/env/server");
    vi.mocked(env.getServerEnv).mockImplementation(() => {
      throw new Error("FIREBASE_PROJECT_ID is not set - contains a real path/secret detail that must never reach the response body");
    });

    const { GET } = await import("./route");
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ status: "not_ready" });
    expect(JSON.stringify(body)).not.toContain("FIREBASE_PROJECT_ID");
  });

  it("returns 503 not_ready when an Admin SDK client fails to construct", async () => {
    const admin = await import("@/server/firebase/admin");
    vi.mocked(admin.getAdminFirestore).mockImplementation(() => {
      throw new Error("credential file not found at /secrets/service-account.json");
    });

    const { GET } = await import("./route");
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ status: "not_ready" });
    expect(JSON.stringify(body)).not.toContain("/secrets/service-account.json");
  });
});
