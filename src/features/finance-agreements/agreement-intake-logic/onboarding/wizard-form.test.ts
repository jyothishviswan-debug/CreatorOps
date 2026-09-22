import { describe, expect, it } from "vitest";

import { VENDOR_TYPES } from "@/server/vendors/types";

import { previewDto, previewField } from "./onboarding-fixtures";
import {
  accountFieldKey,
  buildAccounts,
  buildDuplicatesRequest,
  buildReviewedProfile,
  detectPlatformFromLink,
  duplicateSignature,
  emptyForm,
  issueFor,
  locatorRowIndex,
  ONBOARDING_VENDOR_TYPES,
  prefillFromPreview,
  prefillNotes,
  reshapeAccounts,
  setFormField,
  suggestPageNameFromLink,
  validateForm,
  type OnboardingForm,
} from "./wizard-form";

const filled = (over: Partial<OnboardingForm> = {}): OnboardingForm => ({ ...emptyForm("PARTNER", ["instagram"]), displayName: "Asha Rao", regionId: "Karnataka", accounts: [{ platform: "instagram", locatorKind: "LINK", locator: "https://www.instagram.com/asha", pageName: "" }], ...over });

describe("form shape", () => {
  it("has one Partner Account row per selected platform (none for a Vendor)", () => {
    expect(emptyForm("PARTNER", ["instagram", "youtube"]).accounts.map((row) => row.platform)).toEqual(["instagram", "youtube"]);
    expect(emptyForm("PARTNER", ["instagram"]).accounts[0]).toEqual({ platform: "instagram", locatorKind: "LINK", locator: "", pageName: "" });
    expect(emptyForm("VENDOR", []).accounts).toEqual([]);
  });
  it("offers exactly the owning module's Vendor types", () => {
    expect(ONBOARDING_VENDOR_TYPES.map((option) => option.value)).toEqual([...VENDOR_TYPES]);
  });
  it("sets simple and account fields, ignoring unknown keys and bad locator kinds", () => {
    let form = emptyForm("PARTNER", ["instagram", "youtube"]);
    form = setFormField(form, "displayName", "Asha");
    form = setFormField(form, accountFieldKey(1, "locator"), "https://youtu.be/x");
    form = setFormField(form, accountFieldKey(1, "locatorKind"), "HANDLE");
    form = setFormField(form, accountFieldKey(1, "locatorKind"), "BOGUS");
    expect(form.displayName).toBe("Asha");
    expect(form.accounts[1]).toMatchObject({ locator: "https://youtu.be/x", locatorKind: "HANDLE" });
    expect(setFormField(form, accountFieldKey(5, "locator"), "x")).toBe(form);
    expect(setFormField(form, "accounts" as never, "x")).toBe(form);
  });
});

describe("account rows follow the platform choice", () => {
  const typed = filled({ accounts: [{ platform: "instagram", locatorKind: "HANDLE", locator: "@asha", pageName: "Asha" }] });

  it("keeps a row's typed values when its platform stays, and adds a blank row for a new platform", () => {
    const both = reshapeAccounts(typed, "PARTNER", ["instagram", "youtube"]);
    expect(both.accounts).toEqual([typed.accounts[0], { platform: "youtube", locatorKind: "LINK", locator: "", pageName: "" }]);
    expect(reshapeAccounts(both, "PARTNER", ["youtube"]).accounts).toEqual([{ platform: "youtube", locatorKind: "LINK", locator: "", pageName: "" }]);
  });

  it("a Vendor never has account rows", () => {
    expect(reshapeAccounts(typed, "VENDOR", []).accounts).toEqual([]);
    const already = emptyForm("VENDOR", []);
    expect(reshapeAccounts(already, "VENDOR", [])).toBe(already);
  });
});

describe("prefill from the extraction preview", () => {
  it("fills name, contact, region and the page of the detected platform", () => {
    const form = prefillFromPreview(emptyForm("PARTNER", ["instagram"]), previewDto(), []);
    expect(form).toMatchObject({ displayName: "Asha Rao", email: "asha@example.com", phone: "+91 98765 43210", regionId: "Karnataka" });
    expect(form.accounts[0]).toEqual({ platform: "instagram", locatorKind: "LINK", locator: "https://www.instagram.com/asha.travels", pageName: "Asha Travels" });
  });

  it("puts the page on the row of the platform its link names when two platforms are selected", () => {
    const form = prefillFromPreview(emptyForm("PARTNER", ["instagram", "youtube"]), previewDto({ detectedPlatform: "youtube" }, { collaboratorPageLink: previewField("https://youtube.com/@asha") }), []);
    expect(form.accounts[0]!.locator).toBe("");
    expect(form.accounts[1]!.locator).toBe("https://youtube.com/@asha");
  });

  it("never guesses which of two platforms an unrecognised link belongs to", () => {
    const preview = previewDto({ detectedPlatform: null }, { collaboratorPageLink: previewField("https://example.com/asha") });
    const form = prefillFromPreview(emptyForm("PARTNER", ["instagram", "youtube"]), preview, []);
    expect(form.accounts.map((row) => row.locator)).toEqual(["", ""]);
    expect(prefillNotes(preview, form).join(" ")).toMatch(/not which platform/);
  });

  it("does not use a link that belongs to a platform this Agreement is not for, and says so", () => {
    const preview = previewDto({ detectedPlatform: "youtube" }, { collaboratorPageLink: previewField("https://youtube.com/@asha") });
    const form = prefillFromPreview(emptyForm("PARTNER", ["instagram"]), preview, []);
    expect(form.accounts[0]!.locator).toBe("");
    expect(prefillNotes(preview, form).join(" ")).toMatch(/looks like a YouTube page/);
  });

  it("keeps what the reviewer already typed (touched fields) and leaves an unmatched state empty with a note", () => {
    const typed = setFormField(emptyForm("PARTNER", ["instagram"]), "displayName", "Asha R.");
    const preview = previewDto({}, { state: previewField("Bengalooru") });
    const form = prefillFromPreview(typed, preview, ["displayName"]);
    expect(form.displayName).toBe("Asha R.");
    expect(form.regionId).toBe("");
    expect(prefillNotes(preview, form)[0]).toMatch(/Bengalooru/);
  });

  it("a scanned Agreement (nothing extracted) leaves the form blank", () => {
    const blank = previewDto({ extraction: { status: "MANUAL_REVIEW_REQUIRED", reasons: [], pageCount: 2 }, detectedPlatform: null }, { counterpartyName: null, contactNumber: null, emailAddress: null, state: null, collaboratorPageName: null, collaboratorPageLink: null });
    expect(prefillFromPreview(emptyForm("PARTNER", ["instagram"]), blank, [])).toEqual(emptyForm("PARTNER", ["instagram"]));
  });
});

describe("validation", () => {
  it("a complete Partner form has no issues", () => {
    expect(validateForm(filled(), "PARTNER")).toEqual([]);
  });

  it("requires a name, a canonical region and a locator per account", () => {
    const issues = validateForm(emptyForm("PARTNER", ["instagram", "youtube"]), "PARTNER");
    expect(issueFor(issues, "displayName")).toMatch(/Partner’s name/);
    expect(issueFor(issues, "regionId")).toMatch(/Choose the region/);
    expect(issueFor(issues, accountFieldKey(0, "locator"))).toMatch(/Instagram page link/);
    expect(issueFor(issues, accountFieldKey(1, "locator"))).toMatch(/YouTube page link/);
    expect(issueFor(validateForm(filled({ regionId: "Atlantis" }), "PARTNER"), "regionId")).toMatch(/from the list/);
  });

  it("checks email and phone shape with the shared validators, both optional", () => {
    expect(validateForm(filled({ email: "", phone: "" }), "PARTNER")).toEqual([]);
    expect(issueFor(validateForm(filled({ email: "not-an-email" }), "PARTNER"), "email")).toMatch(/valid email/);
    expect(issueFor(validateForm(filled({ phone: "12" }), "PARTNER"), "phone")).toMatch(/phone number/);
    expect(validateForm(filled({ email: "a@b.co", phone: "+91 98765 43210" }), "PARTNER")).toEqual([]);
  });

  it("checks the account locator by the kind chosen: link shape and platform, or a handle without spaces", () => {
    const row = (over: Partial<OnboardingForm["accounts"][number]>): OnboardingForm => filled({ accounts: [{ platform: "instagram", locatorKind: "LINK", locator: "", pageName: "", ...over }] });
    expect(issueFor(validateForm(row({ locator: "not a link" }), "PARTNER"), accountFieldKey(0, "locator"))).toMatch(/valid Instagram page link/);
    expect(issueFor(validateForm(row({ locator: "https://youtube.com/@x" }), "PARTNER"), accountFieldKey(0, "locator"))).toMatch(/looks like a YouTube page/);
    expect(validateForm(row({ locator: "instagram.com/asha" }), "PARTNER")).toEqual([]);
    expect(validateForm(row({ locator: "https://example.com/asha" }), "PARTNER")).toEqual([]);
    expect(issueFor(validateForm(row({ locatorKind: "HANDLE", locator: "as ha" }), "PARTNER"), accountFieldKey(0, "locator"))).toMatch(/no spaces/);
    expect(validateForm(row({ locatorKind: "HANDLE", locator: "@asha" }), "PARTNER")).toEqual([]);
    expect(issueFor(validateForm(row({ locatorKind: "HANDLE", locator: "" }), "PARTNER"), accountFieldKey(0, "locator"))).toMatch(/handle/);
  });

  it("a Vendor needs a Vendor type and has no accounts", () => {
    const vendor = { ...emptyForm("VENDOR", []), displayName: "Acme Media", regionId: "Kerala" };
    expect(issueFor(validateForm(vendor, "VENDOR"), "vendorType")).toMatch(/Vendor type/);
    expect(validateForm({ ...vendor, vendorType: "AGENCY" }, "VENDOR")).toEqual([]);
    expect(issueFor(validateForm({ ...vendor, vendorType: "BOGUS" }, "VENDOR"), "vendorType")).toBeTruthy();
  });
});

describe("requests", () => {
  it("sends ONE canonical locator per account: the link, or the handle (never both)", () => {
    const form = filled({ accounts: [{ platform: "instagram", locatorKind: "LINK", locator: " https://www.instagram.com/asha ", pageName: " Asha " }, { platform: "youtube", locatorKind: "HANDLE", locator: "@ashatv", pageName: "" }] });
    expect(buildAccounts(form)).toEqual([
      { platform: "Instagram", profileUrl: "https://www.instagram.com/asha", displayName: "Asha" },
      { platform: "YouTube", handle: "@ashatv" },
    ]);
  });

  it("builds the reviewed profile: trimmed, optional fields omitted, one region, vendor type for a Vendor only", () => {
    expect(buildReviewedProfile(filled({ legalName: " Asha Rao Pvt ", email: "", phone: " +91 1 " }), "PARTNER")).toEqual({ displayName: "Asha Rao", legalName: "Asha Rao Pvt", phone: "+91 1", regionIds: ["Karnataka"] });
    expect(buildReviewedProfile({ ...emptyForm("VENDOR", []), displayName: "Acme", regionId: "Kerala", vendorType: "AGENCY" }, "VENDOR")).toEqual({ displayName: "Acme", regionIds: ["Kerala"], vendorType: "AGENCY" });
  });

  it("the duplicate probe carries the name, contact and account locators only (no region, no identity)", () => {
    const request = buildDuplicatesRequest(filled({ email: "a@b.co" }), "PARTNER");
    expect(request).toEqual({ type: "PARTNER", displayName: "Asha Rao", email: "a@b.co", accounts: [{ platform: "Instagram", profileUrl: "https://www.instagram.com/asha" }] });
    expect(buildDuplicatesRequest({ ...emptyForm("VENDOR", []), displayName: "Acme" }, "VENDOR")).toEqual({ type: "VENDOR", displayName: "Acme" });
  });

  it("a duplicate result stays good for region / legal-name / vendor-type edits, and goes stale for name, contact or account edits", () => {
    const base = filled({ email: "A@B.co", phone: "+91 98765 43210" });
    const signature = duplicateSignature(base, "PARTNER");
    expect(duplicateSignature({ ...base, regionId: "Kerala", legalName: "X", displayName: "asha rao", email: "a@b.co", phone: "+919876543210" }, "PARTNER")).toBe(signature);
    expect(duplicateSignature({ ...base, displayName: "Asha Rao Two" }, "PARTNER")).not.toBe(signature);
    expect(duplicateSignature({ ...base, email: "other@b.co" }, "PARTNER")).not.toBe(signature);
    expect(duplicateSignature({ ...base, accounts: [{ ...base.accounts[0]!, locator: "https://www.instagram.com/other" }] }, "PARTNER")).not.toBe(signature);
  });

  it("recognises the platform of a link from its host only", () => {
    expect(detectPlatformFromLink("https://www.instagram.com/x")).toBe("instagram");
    expect(detectPlatformFromLink("youtu.be/abc")).toBe("youtube");
    expect(detectPlatformFromLink("https://notinstagram.com/x")).toBeNull();
    expect(detectPlatformFromLink("")).toBeNull();
  });
});

describe("suggesting a page/account name from a page link", () => {
  it("takes an Instagram profile's own path segment", () => {
    expect(suggestPageNameFromLink("https://www.instagram.com/_mrinal_speaks")).toBe("_mrinal_speaks");
    expect(suggestPageNameFromLink("https://www.instagram.com/_mrinal_speaks/")).toBe("_mrinal_speaks");
    expect(suggestPageNameFromLink("instagram.com/_mrinal_speaks")).toBe("_mrinal_speaks"); // no scheme typed
    expect(suggestPageNameFromLink("https://instagr.am/_mrinal_speaks")).toBe("_mrinal_speaks");
  });

  it("never guesses a name from a non-profile Instagram link (a post, a reel, a story...)", () => {
    for (const path of ["p/Cabc123", "reel/Cabc123", "stories/someone", "explore/tags/x", "accounts/login"]) expect(suggestPageNameFromLink(`https://www.instagram.com/${path}`)).toBeNull();
  });

  it("reads a YouTube handle or a /c, /channel, /user path; never /watch or a bare host", () => {
    expect(suggestPageNameFromLink("https://www.youtube.com/@somechannel")).toBe("@somechannel");
    expect(suggestPageNameFromLink("https://youtube.com/c/SomeChannel")).toBe("SomeChannel");
    expect(suggestPageNameFromLink("https://youtube.com/channel/UC12345")).toBe("UC12345");
    expect(suggestPageNameFromLink("https://youtube.com/user/SomeUser")).toBe("SomeUser");
    expect(suggestPageNameFromLink("https://www.youtube.com/watch?v=abc123")).toBeNull();
    expect(suggestPageNameFromLink("https://youtu.be/abc123")).toBeNull(); // a video link, not a channel
    expect(suggestPageNameFromLink("https://youtube.com")).toBeNull();
  });

  it("gives no suggestion for an unrecognised host, a handle (not a link), or blank/unparseable text", () => {
    expect(suggestPageNameFromLink("https://example.com/someone")).toBeNull();
    expect(suggestPageNameFromLink("_mrinal_speaks")).toBeNull(); // a bare handle has no path to read
    expect(suggestPageNameFromLink("")).toBeNull();
    expect(suggestPageNameFromLink("   ")).toBeNull();
  });

  it("decodes a percent-encoded path segment", () => {
    expect(suggestPageNameFromLink("https://www.instagram.com/caf%C3%A9.reviews")).toBe("café.reviews");
  });
});

describe("locatorRowIndex", () => {
  it("names the row of a 'locator' field key only - not 'locatorKind', 'pageName', or a non-account field", () => {
    expect(locatorRowIndex(accountFieldKey(0, "locator"))).toBe(0);
    expect(locatorRowIndex(accountFieldKey(2, "locator"))).toBe(2);
    expect(locatorRowIndex(accountFieldKey(0, "locatorKind"))).toBeNull();
    expect(locatorRowIndex(accountFieldKey(0, "pageName"))).toBeNull();
    expect(locatorRowIndex("displayName")).toBeNull();
  });
});
