import { describe, expect, it } from "vitest";

import { compareAddresses, compareBankIdentifiers, compareNames, compareTaxIds, maskBankIdentifierLast4, normalizeAddress, normalizeBankIdentifier, normalizeName, normalizeTaxId } from "./normalization";

// Step 16C section 23: unit tests for the pure normalization/comparison helpers.

describe("normalizeName", () => {
  it("collapses whitespace and lowercases", () => {
    expect(normalizeName("  Acme   Studios  ")).toBe("acme studios");
  });

  it("strips safe punctuation", () => {
    expect(normalizeName("Acme, Studios. (India)")).toBe("acme studios india");
  });

  it("strips exactly one trailing corporate suffix", () => {
    expect(normalizeName("Acme Studios Private Limited")).toBe("acme studios");
    expect(normalizeName("Acme Studios Pvt Ltd")).toBe("acme studios");
    expect(normalizeName("Acme Studios LLP")).toBe("acme studios");
  });

  it("never strips a suffix word that is not trailing", () => {
    expect(normalizeName("Limited Editions Studio")).toBe("limited editions studio");
  });
});

describe("compareNames", () => {
  it("EXACT for byte-identical raw strings", () => {
    expect(compareNames("Acme Studios", "Acme Studios").status).toBe("EXACT");
  });

  it("NORMALIZED_MATCH for case/whitespace-only differences", () => {
    expect(compareNames("Acme Studios", "  acme   studios  ").status).toBe("NORMALIZED_MATCH");
  });

  it("NORMALIZED_MATCH for punctuation/suffix-only differences", () => {
    expect(compareNames("Acme Studios Private Limited", "Acme Studios").status).toBe("NORMALIZED_MATCH");
  });

  it("MISMATCH for a clearly different legal name", () => {
    expect(compareNames("Acme Studios", "Zenith Media Ventures").status).toBe("MISMATCH");
  });

  it("REVIEW_REQUIRED for a partially-overlapping ambiguous name (advisory similarity only)", () => {
    const result = compareNames("Acme Global Studios", "Acme Studios");
    expect(result.status).toBe("REVIEW_REQUIRED");
  });

  it("UNAVAILABLE when either side is missing", () => {
    expect(compareNames(null, "Acme Studios").status).toBe("UNAVAILABLE");
    expect(compareNames("Acme Studios", null).status).toBe("UNAVAILABLE");
    expect(compareNames(null, null).status).toBe("UNAVAILABLE");
    expect(compareNames("   ", "Acme Studios").status).toBe("UNAVAILABLE");
  });
});

describe("normalizeTaxId", () => {
  it("strips spaces and hyphens and uppercases", () => {
    expect(normalizeTaxId(" 29-abcde 1234f 1z5 ")).toBe("29ABCDE1234F1Z5");
  });
});

describe("compareTaxIds", () => {
  it("EXACT for a normalized match (spacing/case differences only)", () => {
    expect(compareTaxIds("29ABCDE1234F1Z5", "29-abcde-1234f-1z5").status).toBe("EXACT");
  });

  it("MISMATCH for a genuinely different identifier", () => {
    expect(compareTaxIds("29ABCDE1234F1Z5", "27ZZZZZ9999Z1Z1").status).toBe("MISMATCH");
  });

  it("UNAVAILABLE when one side is missing", () => {
    expect(compareTaxIds(null, "29ABCDE1234F1Z5").status).toBe("UNAVAILABLE");
    expect(compareTaxIds("29ABCDE1234F1Z5", null).status).toBe("UNAVAILABLE");
  });

  it("never fuzzy-matches a near-identical but not-equal identifier", () => {
    // Off by one character - must NOT be treated as a match under any circumstance.
    expect(compareTaxIds("29ABCDE1234F1Z5", "29ABCDE1234F1Z6").status).toBe("MISMATCH");
  });
});

describe("normalizeAddress", () => {
  it("collapses whitespace/line-breaks/punctuation and lowercases", () => {
    expect(normalizeAddress("12, MG Road,\nBengaluru - 560001")).toBe("12 mg road bengaluru 560001");
  });
});

describe("compareAddresses", () => {
  it("NORMALIZED_MATCH for a full normalized match", () => {
    expect(compareAddresses("12 MG Road, Bengaluru", "12 mg road bengaluru").status).toBe("NORMALIZED_MATCH");
  });

  it("REVIEW_REQUIRED (partial) for meaningful but incomplete overlap - never claimed as exact", () => {
    const result = compareAddresses("12 MG Road, Bengaluru, Karnataka", "MG Road, Bengaluru");
    expect(result.status).toBe("REVIEW_REQUIRED");
  });

  it("MISMATCH for unrelated addresses", () => {
    expect(compareAddresses("12 MG Road, Bengaluru", "44 Marine Drive, Mumbai").status).toBe("MISMATCH");
  });

  it("UNAVAILABLE when either side is missing", () => {
    expect(compareAddresses(null, "12 MG Road").status).toBe("UNAVAILABLE");
    expect(compareAddresses("12 MG Road", null).status).toBe("UNAVAILABLE");
  });
});

describe("normalizeBankIdentifier", () => {
  it("strips spaces/hyphens and uppercases", () => {
    expect(normalizeBankIdentifier(" 1234 5678-9012 ")).toBe("123456789012");
  });
});

describe("compareBankIdentifiers", () => {
  it("EXACT (section 5 'MATCH') for a normalized-equal identifier", () => {
    expect(compareBankIdentifiers("1234567890", "1234-567-890").status).toBe("EXACT");
  });

  it("MISMATCH for a different identifier", () => {
    expect(compareBankIdentifiers("1234567890", "1234567891").status).toBe("MISMATCH");
  });

  it("UNAVAILABLE when either side is missing", () => {
    expect(compareBankIdentifiers(null, "1234567890").status).toBe("UNAVAILABLE");
    expect(compareBankIdentifiers("1234567890", null).status).toBe("UNAVAILABLE");
  });

  it("never fuzzy-matches a near-identical bank identifier", () => {
    expect(compareBankIdentifiers("1234567890", "1234567899").status).toBe("MISMATCH");
  });
});

describe("maskBankIdentifierLast4", () => {
  it("returns only the last 4 characters, masked - never the full value", () => {
    const masked = maskBankIdentifierLast4("1234567890");
    expect(masked).toBe("•••• 7890");
    expect(masked).not.toContain("123456");
  });

  it("null when the value is missing", () => {
    expect(maskBankIdentifierLast4(null)).toBeNull();
    expect(maskBankIdentifierLast4("   ")).toBeNull();
  });
});
