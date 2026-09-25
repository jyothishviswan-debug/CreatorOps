import { describe, expect, it } from "vitest";

import { mapSourceError } from "./source-errors";

describe("mapSourceError", () => {
  it("maps a source unauthorized denial to a Reports unauthorized denial with a KNOWN reason", () => {
    expect(mapSourceError({ code: "unauthorized", message: "Denied.", reason: "feature_denied" })).toEqual({ ok: false, code: "unauthorized", message: "Denied.", reason: "feature_denied" });
    expect(mapSourceError({ code: "unauthorized", message: "Denied.", reason: "scope_denied" })).toEqual({ ok: false, code: "unauthorized", message: "Denied.", reason: "scope_denied" });
  });

  it("normalizes a source-module-specific reason Reports does not itself model (e.g. 'sensitive_denied', 'not_active') down to scope_denied - never leaked verbatim", () => {
    expect(mapSourceError({ code: "unauthorized", message: "Denied.", reason: "sensitive_denied" })).toEqual({ ok: false, code: "unauthorized", message: "Denied.", reason: "scope_denied" });
    expect(mapSourceError({ code: "unauthorized", message: "Denied.", reason: "not_active" })).toEqual({ ok: false, code: "unauthorized", message: "Denied.", reason: "scope_denied" });
    expect(mapSourceError({ code: "unauthorized", message: "Denied." })).toEqual({ ok: false, code: "unauthorized", message: "Denied.", reason: "scope_denied" });
  });

  it("maps every other source error code (not_found, invalid_input, stale_write, conflict, not_ready, internal) to source_unavailable - Reports never asserts a more specific foreign-module error taxonomy", () => {
    for (const code of ["not_found", "invalid_input", "stale_write", "conflict", "not_ready", "internal"]) {
      const result = mapSourceError({ code, message: "Something." });
      expect(result.ok, code).toBe(false);
      expect((result as { code: string }).code, code).toBe("source_unavailable");
    }
  });
});
