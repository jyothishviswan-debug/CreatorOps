import { describe, expect, it, vi, afterEach } from "vitest";

import { friendlyDriveError } from "./drive-error";

// Production hardening (base spec section 24 / 40): the Drive diagnostic surface must never leak a
// raw provider exception message, stack, or SDK-internal detail into the message it returns - only a
// safe fixed classification plus a correlation id. This is exactly the class of "error leakage"
// regression the security regression corpus (base spec section 40) requires.
describe("friendlyDriveError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never includes the raw exception message text in the returned string", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secretish = "insider-detail request=abc123 authorization=Bearer sekrit path=/etc/service-account.json";
    const error = new Error(secretish);
    const message = friendlyDriveError("test/scope", error);
    expect(message).not.toContain(secretish);
    expect(message).not.toContain("sekrit");
    expect(message).not.toContain("/etc/service-account.json");
  });

  it("classifies a structured 403 as access_denied with a safe, actionable message", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = { response: { status: 403 }, message: "raw upstream text that must never leak" };
    const message = friendlyDriveError("test/scope", error);
    expect(message).toContain("Drive denied access");
    expect(message).not.toContain("raw upstream text");
  });

  it("classifies a structured 404 as not_found with a safe message", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = { response: { status: 404 }, message: "raw upstream text that must never leak" };
    const message = friendlyDriveError("test/scope", error);
    expect(message).toContain("could not be found");
    expect(message).not.toContain("raw upstream text");
  });

  it("classifies a quota-exceeded reason as quota_exceeded", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = { errors: [{ reason: "userRateLimitExceeded" }], message: "raw upstream text" };
    const message = friendlyDriveError("test/scope", error);
    expect(message).toContain("quota or rate limit");
  });

  it("recognizes the locally-authored not-configured message (never a passthrough of provider text)", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("GOOGLE_APPLICATION_CREDENTIALS is not set - Drive uploads need a service-account key file path in .env.local (see .env.example).");
    const message = friendlyDriveError("test/scope", error);
    expect(message).toContain("not configured");
  });

  it("includes a correlation id in the safe message so it can be matched to the sanitized log line", () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const message = friendlyDriveError("test/scope", new Error("anything"));
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(message).toMatch(uuidPattern);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const loggedArgs = logSpy.mock.calls[0];
    const loggedPayload = loggedArgs[1] as { correlationId?: string };
    expect(message).toContain(loggedPayload.correlationId ?? "__missing__");
  });

  it("never logs the raw error message/stack to the console, only a safe classification", () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secretish = "super secret upstream detail";
    friendlyDriveError("test/scope", new Error(secretish));
    const loggedArgs = logSpy.mock.calls[0];
    expect(JSON.stringify(loggedArgs)).not.toContain(secretish);
  });
});
