import { describe, expect, it } from "vitest";

import { isIdentityField, maskIdentityInText, maskIdentityValue, maskTail } from "./identity-mask";

const SAMPLE = { pan: "ABCPE1234F", gstin: "29ABCPE1234F1Z5", aadhaar: "2341 2341 2346", account: "123456789012", ifsc: "HDFC0001234" };

describe("maskTail", () => {
  it("keeps only the last four characters", () => {
    expect(maskTail("ABCPE1234F")).toBe("••••••234F");
    expect(maskTail("123456789012")).toBe("••••••••9012");
  });
  it("drops whitespace inside a number first", () => {
    expect(maskTail("2341 2341 2346")).toBe("••••••••2346");
  });
  it("masks a value of four characters or fewer completely", () => {
    expect(maskTail("1234")).toBe("••••");
    expect(maskTail("ab")).toBe("••");
    expect(maskTail("")).toBe("");
  });
});

describe("maskIdentityValue", () => {
  it("masks every identity field and never prints the full value", () => {
    expect(maskIdentityValue("panNumber", SAMPLE.pan)).toBe("••••••234F");
    expect(maskIdentityValue("gstin", SAMPLE.gstin)).toBe("•".repeat(11) + "F1Z5");
    expect(maskIdentityValue("aadhaarNumber", SAMPLE.aadhaar)).toBe("••••••••2346");
    expect(maskIdentityValue("bankAccountNumber", SAMPLE.account)).toBe("••••••••9012");
    expect(maskIdentityValue("ifsc", SAMPLE.ifsc)).toBe("•••••••1234");
    for (const [key, value] of [["panNumber", SAMPLE.pan], ["gstin", SAMPLE.gstin], ["aadhaarNumber", SAMPLE.aadhaar], ["bankAccountNumber", SAMPLE.account], ["ifsc", SAMPLE.ifsc]] as const) {
      expect(maskIdentityValue(key, value)).not.toContain(value.replace(/\s/g, "").slice(0, 8));
    }
  });
  it("reads null / undefined / blank as no value", () => {
    expect(maskIdentityValue("panNumber", null)).toBe("—");
    expect(maskIdentityValue("panNumber", undefined)).toBe("—");
    expect(maskIdentityValue("panNumber", "  ")).toBe("—");
  });
  it("leaves a non-identity field's value alone", () => {
    expect(maskIdentityValue("emailAddress", "hello@example.test")).toBe("hello@example.test");
    expect(maskIdentityValue("platforms", ["instagram", "youtube"])).toBe("instagram, youtube");
    expect(isIdentityField("panNumber")).toBe(true);
    expect(isIdentityField("emailAddress")).toBe(false);
  });
});

describe("maskIdentityInText (raw contract snippets)", () => {
  it("masks every identity-shaped token and keeps the surrounding words", () => {
    const text = `PAN: ${SAMPLE.pan} Name as per PAN: Sample Creator GSTIN: ${SAMPLE.gstin} Aadhaar No: ${SAMPLE.aadhaar} Account Number: ${SAMPLE.account} IFSC: ${SAMPLE.ifsc}`;
    const masked = maskIdentityInText(text);
    for (const value of [SAMPLE.pan, SAMPLE.gstin, SAMPLE.aadhaar, SAMPLE.aadhaar.replace(/ /g, ""), SAMPLE.account, SAMPLE.ifsc]) expect(masked).not.toContain(value);
    expect(masked).toContain("Name as per PAN: Sample Creator");
    expect(masked).toContain("Account Number: ••••••••9012");
    expect(masked).toContain("PAN: ••••••234F");
  });
  it("masks a number a snippet window cut short (8+ characters with four or more digits) but not ordinary words or dates", () => {
    expect(maskIdentityInText("PAN: ABCPE1234")).not.toContain("ABCPE1234");
    expect(maskIdentityInText("Effective Date: 01/04/2025 Termination Date: 31 March 2026")).toBe("Effective Date: 01/04/2025 Termination Date: 31 March 2026");
    expect(maskIdentityInText("Agreement No: CO/2025/0042")).toBe("Agreement No: CO/2025/0042");
  });
});
