import { describe, expect, it } from "vitest";

import { MAX_AMOUNT_MINOR, findAmounts, findDates, findIndianMobiles, findStates, parseAmountToMinor, verhoeffIsValid } from "./parsers";

describe("parseAmountToMinor", () => {
  it("parses western and Indian grouping to paise", () => {
    expect(parseAmountToMinor("25,000")).toBe(2_500_000);
    expect(parseAmountToMinor("25000")).toBe(2_500_000);
    expect(parseAmountToMinor("2,50,000")).toBe(25_000_000);
    expect(parseAmountToMinor("1,250,000")).toBe(125_000_000);
    expect(parseAmountToMinor("1,25,00,000")).toBe(1_250_000_000);
    expect(parseAmountToMinor("1,200.50")).toBe(120_050);
  });

  it("parses lakh / crore multipliers exactly", () => {
    expect(parseAmountToMinor("2.5", "lakh")).toBe(25_000_000);
    expect(parseAmountToMinor("1", "lakhs")).toBe(10_000_000);
    expect(parseAmountToMinor("1.2", "crore")).toBe(1_200_000_000);
    expect(parseAmountToMinor("0.75", "lac")).toBe(7_500_000);
  });

  it("rejects malformed grouping, over-precise paise and implausible sizes", () => {
    expect(parseAmountToMinor("25,00,0")).toBeNull();
    expect(parseAmountToMinor("2,5000")).toBeNull();
    expect(parseAmountToMinor("1,2345,678")).toBeNull();
    expect(parseAmountToMinor("100.555")).toBeNull();
    expect(parseAmountToMinor("101", "crore")).toBeNull(); // > 100 crore
    expect(parseAmountToMinor("10000000000")).toBeNull();
    expect(MAX_AMOUNT_MINOR).toBe(100_000_000_000);
    expect(parseAmountToMinor("abc")).toBeNull();
  });
});

describe("findAmounts", () => {
  it("requires an explicit money marker", () => {
    expect(findAmounts("Rs. 25,000/-").map((a) => a.amountMinor)).toEqual([2_500_000]);
    expect(findAmounts("INR 25000").map((a) => a.amountMinor)).toEqual([2_500_000]);
    expect(findAmounts("₹2,50,000").map((a) => a.amountMinor)).toEqual([25_000_000]);
    expect(findAmounts("2.5 lakh").map((a) => a.amountMinor)).toEqual([25_000_000]);
    expect(findAmounts("25,000 rupees").map((a) => a.amountMinor)).toEqual([2_500_000]);
  });

  it("never treats bare numbers, counts, percentages or phone numbers as money", () => {
    expect(findAmounts("Deliver 12 reels")).toEqual([]);
    expect(findAmounts("5% of net revenue")).toEqual([]);
    expect(findAmounts("Call 9876543210")).toEqual([]);
    expect(findAmounts("Rs. 5%")).toEqual([]);
  });

  it("skips amounts with malformed grouping instead of guessing", () => {
    expect(findAmounts("Rs. 25,00,0")).toEqual([]);
  });
});

describe("findDates", () => {
  it("reads named-month, ordinal and ISO formats unambiguously", () => {
    expect(findDates("5th day of March, 2025")[0]).toMatchObject({ iso: "2025-03-05", dayMonthOrderAssumed: false });
    expect(findDates("31 March 2026")[0]?.iso).toBe("2026-03-31");
    expect(findDates("March 5, 2025")[0]?.iso).toBe("2025-03-05");
    expect(findDates("Sept 9 2025")[0]?.iso).toBe("2025-09-09");
    expect(findDates("2025-03-05")[0]?.iso).toBe("2025-03-05");
  });

  it("reads numeric dates as DD/MM/YYYY and flags the ambiguous ones", () => {
    expect(findDates("15/03/2025")[0]).toMatchObject({ iso: "2025-03-15", dayMonthOrderAssumed: false });
    expect(findDates("01/04/2025")[0]).toMatchObject({ iso: "2025-04-01", dayMonthOrderAssumed: true });
    expect(findDates("05.03.2025")[0]).toMatchObject({ iso: "2025-03-05", dayMonthOrderAssumed: true });
    expect(findDates("11/11/2025")[0]).toMatchObject({ iso: "2025-11-11", dayMonthOrderAssumed: false });
  });

  it("rejects impossible dates, MM/DD-only strings and two-digit years", () => {
    expect(findDates("31/02/2025")).toEqual([]);
    expect(findDates("03/25/2025")).toEqual([]);
    expect(findDates("01/04/25")).toEqual([]);
    expect(findDates("30 Feb 2025")).toEqual([]);
    expect(findDates("01/04/1850")).toEqual([]);
  });
});

describe("findIndianMobiles", () => {
  it("normalizes to +91 and reports whether a prefix was present", () => {
    expect(findIndianMobiles("+91 98765 43210")[0]).toMatchObject({ e164: "+919876543210", prefixed: true });
    expect(findIndianMobiles("98765-43210")[0]).toMatchObject({ e164: "+919876543210", prefixed: false });
    expect(findIndianMobiles("09876543210")[0]?.e164).toBe("+919876543210");
    expect(findIndianMobiles("+91-9876543210")[0]?.e164).toBe("+919876543210");
    expect(findIndianMobiles("987 654 3210")[0]?.e164).toBe("+919876543210");
  });

  it("rejects numbers that are not Indian mobiles or are part of longer digit runs", () => {
    expect(findIndianMobiles("1234567890")).toEqual([]); // does not start 6-9
    expect(findIndianMobiles("98765432101234")).toEqual([]);
    expect(findIndianMobiles("234123412346")).toEqual([]); // an Aadhaar-shaped number
  });
});

describe("verhoeffIsValid", () => {
  it("accepts a valid check digit and rejects a wrong one", () => {
    expect(verhoeffIsValid("234123412346")).toBe(true);
    expect(verhoeffIsValid("234123412345")).toBe(false);
    expect(verhoeffIsValid("2341x3412346")).toBe(false);
  });
});

describe("findStates", () => {
  it("returns canonical REGION_ZONES names, including ampersand and alias spellings", () => {
    expect(findStates("Bengaluru, karnataka 560001")).toEqual(["Karnataka"]);
    expect(findStates("Jammu and Kashmir")).toEqual(["Jammu & Kashmir"]);
    expect(findStates("J&K")).toEqual(["Jammu & Kashmir"]);
    expect(findStates("Andaman and Nicobar Islands")).toEqual(["Andaman & Nicobar"]);
    expect(findStates("New Delhi")).toEqual(["Delhi"]);
    expect(findStates("Pondicherry")).toEqual(["Puducherry"]);
    expect(findStates("Orissa")).toEqual(["Odisha"]);
    expect(findStates("Mumbai, Maharashtra and Goa")).toEqual(["Maharashtra", "Goa"]);
  });

  it("does not match inside other words or invent states outside the canonical list", () => {
    expect(findStates("Assamese food")).toEqual([]);
    expect(findStates("Telangana")).toEqual([]);
  });
});
