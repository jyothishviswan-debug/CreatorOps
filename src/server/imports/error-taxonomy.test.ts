import { describe, expect, it } from "vitest";

import { classifyImportReasonCode, classifyOnboardingBlockerCode, classifyServiceErrorCode, classifySystemError, IMPORT_ERROR_CATEGORIES } from "./error-taxonomy";

describe("classifyImportReasonCode", () => {
  it("classifies a file-level reason code as FILE", () => {
    expect(classifyImportReasonCode("FILE_TOO_LARGE", "too big").category).toBe("FILE");
    expect(classifyImportReasonCode("DECOMPRESSION_LIMIT_EXCEEDED", "bomb").category).toBe("FILE");
    expect(classifyImportReasonCode("CELL_VALUE_TOO_LARGE", "cell").category).toBe("FILE");
  });

  it("classifies a structure-level reason code as STRUCTURE", () => {
    expect(classifyImportReasonCode("TOO_MANY_SHEETS", "many sheets").category).toBe("STRUCTURE");
    expect(classifyImportReasonCode("RESTRICTED_FIELD_REJECTED", "restricted").category).toBe("STRUCTURE");
  });

  it("falls back to ROW for an unknown reason code (never SYSTEM by default)", () => {
    expect(classifyImportReasonCode("SOME_UNKNOWN_CODE", "x").category).toBe("ROW");
  });

  it("marks a non-correctable reason code as such", () => {
    expect(classifyImportReasonCode("RESUME_FILE_MISMATCH", "x").correctable).toBe(false);
  });

  it("never echoes anything beyond the given safe message", () => {
    const result = classifyImportReasonCode("FILE_TOO_LARGE", "The file is too large.");
    expect(result.message).toBe("The file is too large.");
  });
});

describe("classifyServiceErrorCode", () => {
  it("maps unauthorized/not_found to AUTHORIZATION", () => {
    expect(classifyServiceErrorCode("unauthorized", "denied").category).toBe("AUTHORIZATION");
    expect(classifyServiceErrorCode("not_found", "missing").category).toBe("AUTHORIZATION");
  });

  it("maps invalid_input/conflict/stale_write to ROW and marks them correctable", () => {
    for (const code of ["invalid_input", "conflict", "stale_write"] as const) {
      const result = classifyServiceErrorCode(code, "x");
      expect(result.category).toBe("ROW");
      expect(result.correctable).toBe(true);
    }
  });

  it("never leaks the internal message for an internal error - uses a fixed safe sentence", () => {
    const result = classifyServiceErrorCode("internal", "Firestore: 7 PERMISSION_DENIED at doc users/abc123");
    expect(result.category).toBe("SYSTEM");
    expect(result.message).not.toContain("Firestore");
    expect(result.message).not.toContain("users/abc123");
  });
});

describe("classifyOnboardingBlockerCode", () => {
  it("maps a permission blocker to AUTHORIZATION (never correctable by the uploader)", () => {
    const result = classifyOnboardingBlockerCode("counterparty_create_not_permitted", "x");
    expect(result.category).toBe("AUTHORIZATION");
    expect(result.correctable).toBe(false);
  });

  it("maps a duplicate-decision blocker to ROW (correctable - resolve via the normal onboarding screen)", () => {
    const result = classifyOnboardingBlockerCode("strong_match_outside_access", "x");
    expect(result.category).toBe("ROW");
    expect(result.correctable).toBe(true);
  });
});

describe("classifySystemError", () => {
  it("never includes anything but a fixed safe sentence, optionally with a correlation id", () => {
    const withoutId = classifySystemError();
    expect(withoutId.category).toBe("SYSTEM");
    expect(withoutId.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);

    const withId = classifySystemError("req-abc-123");
    expect(withId.message).toContain("req-abc-123");
  });
});

describe("IMPORT_ERROR_CATEGORIES", () => {
  it("is the closed five-category taxonomy", () => {
    expect([...IMPORT_ERROR_CATEGORIES].sort()).toEqual(["AUTHORIZATION", "FILE", "ROW", "STRUCTURE", "SYSTEM"].sort());
  });
});
