import { isCanonicalRegion, matchCanonicalRegion } from "@/features/shared/canonical-regions";
import type { OnboardingDuplicatesRequest, OnboardingPreviewDto } from "@/server/finance-agreements/onboarding-dto";
import type { CounterpartyType } from "@/server/finance-agreements/types";

import { formatPlatformName } from "../../format";
import { validateEmailShape, validatePhoneShape } from "../../terms-validators";

// Step 14B.1 onboarding: the PROPOSED NEW MASTER RECORD the reviewer edits (pure).
//
//   Extracted Agreement values (preview)  ->  this form (editable, prefilled)  ->  duplicate check  ->  confirmed onboarding values
//
// The form holds only what the owning Partner / Vendor create needs: name, legal name, email, phone, ONE region (state), the Vendor type,
// and (Partner) one Partner Account row per selected platform. No identity value (PAN, Aadhaar, GSTIN, bank) is ever collected or held
// here - those are completed later by the canonical KYC section, server-side.

export const LEGAL_NAME_MAX = 200;
export const NAME_MAX = 200;
export const EMAIL_MAX = 300;
export const PHONE_MAX = 40;
export const PAGE_LINK_MAX = 500;
export const HANDLE_MAX = 120;
export const PAGE_NAME_MAX = 200;

// Vendor types (the owning module's closed set; a test compares this list with the owning module's).
export const ONBOARDING_VENDOR_TYPES = [
  { value: "AGENCY", label: "Agency" },
  { value: "MANAGEMENT_COMPANY", label: "Management company" },
  { value: "MANAGER_REPRESENTATIVE", label: "Manager / representative" },
  { value: "PAYEE_BUSINESS", label: "Payee business" },
  { value: "OTHER", label: "Other" },
] as const;
export type OnboardingVendorType = (typeof ONBOARDING_VENDOR_TYPES)[number]["value"];

// One Partner Account is identified by ONE canonical locator, chosen deliberately: the page link (preferred) or the handle.
export type LocatorKind = "LINK" | "HANDLE";
export type AccountRow = { platform: string; locatorKind: LocatorKind; locator: string; pageName: string };

export type OnboardingForm = {
  displayName: string;
  legalName: string;
  email: string;
  phone: string;
  // ONE canonical region (state); "" until chosen.
  regionId: string;
  vendorType: string;
  accounts: AccountRow[];
};

export function emptyForm(type: CounterpartyType, platforms: readonly string[]): OnboardingForm {
  return {
    displayName: "",
    legalName: "",
    email: "",
    phone: "",
    regionId: "",
    vendorType: "",
    accounts: type === "PARTNER" ? platforms.map((platform) => ({ platform, locatorKind: "LINK" as const, locator: "", pageName: "" })) : [],
  };
}

// The Partner Account rows for a (changed) platform choice: rows of platforms that stay keep what was typed; new platforms get a blank row.
export function reshapeAccounts(form: OnboardingForm, type: CounterpartyType, platforms: readonly string[]): OnboardingForm {
  if (type !== "PARTNER") return form.accounts.length === 0 ? form : { ...form, accounts: [] };
  return { ...form, accounts: platforms.map((platform) => form.accounts.find((row) => row.platform === platform) ?? { platform, locatorKind: "LINK" as const, locator: "", pageName: "" }) };
}

// --- Field addressing ----------------------------------------------------------------------------------------------------------------
export type FormFieldKey = "displayName" | "legalName" | "email" | "phone" | "regionId" | "vendorType" | `account.${number}.locator` | `account.${number}.locatorKind` | `account.${number}.pageName`;

const SIMPLE_FIELDS = ["displayName", "legalName", "email", "phone", "regionId", "vendorType"] as const;
const ACCOUNT_FIELD = /^account\.(\d+)\.(locator|locatorKind|pageName)$/;

export function accountFieldKey(index: number, part: "locator" | "locatorKind" | "pageName"): FormFieldKey {
  return `account.${index}.${part}`;
}

// The row index a "locator" field key names, or null for anything else (a different account part, or a non-account field).
export function locatorRowIndex(key: FormFieldKey): number | null {
  const match = ACCOUNT_FIELD.exec(key);
  return match && match[2] === "locator" ? Number(match[1]) : null;
}

export function setFormField(form: OnboardingForm, key: FormFieldKey, value: string): OnboardingForm {
  const account = ACCOUNT_FIELD.exec(key);
  if (account) {
    const index = Number(account[1]);
    const part = account[2] as "locator" | "locatorKind" | "pageName";
    if (!form.accounts[index]) return form;
    if (part === "locatorKind" && value !== "LINK" && value !== "HANDLE") return form;
    return { ...form, accounts: form.accounts.map((row, position) => (position === index ? { ...row, [part]: value } : row)) };
  }
  if (!(SIMPLE_FIELDS as readonly string[]).includes(key)) return form;
  return { ...form, [key]: value };
}

// --- Platform detection (a SUGGESTION from a link's host; the reviewer's platform choice is what counts) ------------------------------
export function detectPlatformFromLink(link: string): "instagram" | "youtube" | null {
  const text = link.trim();
  if (text.length === 0) return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase();
    if (host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am") return "instagram";
    if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return "youtube";
  } catch {
    // not a URL: no suggestion
  }
  return null;
}

// A page/account NAME suggested from a page LINK's own path (e.g. instagram.com/_mrinal_speaks -> "_mrinal_speaks"). A
// suggestion only - it fills the "Page or account name" field while the reviewer hasn't typed into it themselves (see
// the `touched` gating around every call site below), and is silently withdrawn the moment they do. Unknown hosts, a
// path this repo does not recognise as a profile (a single post, a reel, a video, a playlist...), or no path at all
// give null - never a guess.
const INSTAGRAM_NON_PROFILE_SEGMENTS = new Set(["p", "reel", "reels", "stories", "tv", "explore", "accounts", "direct", "graphql"]);

export function suggestPageNameFromLink(link: string): string | null {
  const text = link.trim();
  if (text.length === 0) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const decode = (segment: string) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  };
  const first = decode(segments[0]!);
  if (host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am") {
    return INSTAGRAM_NON_PROFILE_SEGMENTS.has(first.toLowerCase()) ? null : first;
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (first.startsWith("@")) return first;
    if ((first === "c" || first === "channel" || first === "user") && segments[1]) return decode(segments[1]!);
    return null; // /watch, /playlist, ... or a shape this repo does not recognise as a channel link
  }
  return null;
}

function parsesAsLink(text: string): boolean {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

// --- Prefill from the extraction preview --------------------------------------------------------------------------------------------------
// Only fields the reviewer has NOT touched are prefilled, so a second extraction never overwrites what they typed.
export type TouchedSet = readonly string[];

export function prefillFromPreview(form: OnboardingForm, preview: OnboardingPreviewDto, touched: TouchedSet): OnboardingForm {
  const untouched = (key: FormFieldKey) => !touched.includes(key);
  let next = form;
  const apply = (key: FormFieldKey, value: string | null | undefined) => {
    if (untouched(key) && value) next = setFormField(next, key, value);
  };
  const { profile } = preview;
  apply("displayName", profile.counterpartyName?.value);
  apply("email", profile.emailAddress?.value);
  apply("phone", profile.contactNumber?.value);
  apply("regionId", matchCanonicalRegion(profile.state?.value));

  // The Agreement names ONE page. It belongs to the row of the platform its link names; with a single-platform choice and no
  // recognisable link it can only be that platform's. With two platforms and no recognisable link nothing is guessed.
  const platforms = next.accounts.map((row) => row.platform);
  const link = profile.collaboratorPageLink?.value ?? null;
  const name = profile.collaboratorPageName?.value ?? null;
  const detected = preview.detectedPlatform;
  const target = detected ? (platforms.includes(detected) ? detected : null) : platforms.length === 1 ? platforms[0]! : null;
  const index = target ? platforms.indexOf(target) : -1;
  if (index >= 0) {
    if (link) {
      apply(accountFieldKey(index, "locator"), link);
      if (untouched(accountFieldKey(index, "locator"))) next = setFormField(next, accountFieldKey(index, "locatorKind"), "LINK");
    }
    apply(accountFieldKey(index, "pageName"), name);
  }
  return next;
}

// Plain-language notes about what the prefill could NOT do (shown beside the form, never blocking).
export function prefillNotes(preview: OnboardingPreviewDto, form: OnboardingForm): string[] {
  const notes: string[] = [];
  const state = preview.profile.state?.value;
  if (state && matchCanonicalRegion(state) === null) notes.push(`The Agreement states the state as “${state}”. Choose the matching region.`);
  const platforms = form.accounts.map((row) => row.platform);
  const detected = preview.detectedPlatform;
  if (detected && platforms.length > 0 && !platforms.includes(detected)) {
    notes.push(`The page link in the Agreement looks like a ${formatPlatformName(detected)} page, but this Agreement is for ${platforms.map(formatPlatformName).join(" + ")}. Check the link before using it.`);
  }
  if (!detected && platforms.length > 1 && (preview.profile.collaboratorPageLink || preview.profile.collaboratorPageName)) {
    notes.push("The Agreement names one page but not which platform it is on. Enter each platform’s page below.");
  }
  return notes;
}

// --- Validation ----------------------------------------------------------------------------------------------------------------------
export type FormIssue = { field: FormFieldKey; message: string };

export function validateForm(form: OnboardingForm, type: CounterpartyType): FormIssue[] {
  const issues: FormIssue[] = [];
  const add = (field: FormFieldKey, message: string) => issues.push({ field, message });

  const name = form.displayName.trim();
  if (name.length === 0) add("displayName", type === "PARTNER" ? "Enter the Partner’s name." : "Enter the Vendor’s name.");
  else if (name.length > NAME_MAX) add("displayName", `The name can be at most ${NAME_MAX} characters.`);

  if (form.legalName.trim().length > LEGAL_NAME_MAX) add("legalName", `The legal name can be at most ${LEGAL_NAME_MAX} characters.`);

  const email = form.email.trim();
  if (email.length > 0) {
    if (email.length > EMAIL_MAX) add("email", `The email address can be at most ${EMAIL_MAX} characters.`);
    else {
      const result = validateEmailShape(email);
      if (!result.ok) add("email", result.errors[0]!);
    }
  }
  const phone = form.phone.trim();
  if (phone.length > 0) {
    if (phone.length > PHONE_MAX) add("phone", `The phone number can be at most ${PHONE_MAX} characters.`);
    else {
      const result = validatePhoneShape(phone);
      if (!result.ok) add("phone", result.errors[0]!);
    }
  }

  if (form.regionId.trim().length === 0) add("regionId", "Choose the region (state) for the new record.");
  else if (!isCanonicalRegion(form.regionId)) add("regionId", "Choose a region from the list.");

  if (type === "VENDOR") {
    if (!ONBOARDING_VENDOR_TYPES.some((option) => option.value === form.vendorType)) add("vendorType", "Choose the Vendor type.");
  } else {
    form.accounts.forEach((row, index) => {
      const platform = formatPlatformName(row.platform);
      const locatorKey = accountFieldKey(index, "locator");
      const text = row.locator.trim();
      if (text.length === 0) add(locatorKey, row.locatorKind === "LINK" ? `Enter the ${platform} page link.` : `Enter the ${platform} handle.`);
      else if (row.locatorKind === "LINK") {
        if (text.length > PAGE_LINK_MAX) add(locatorKey, `The page link can be at most ${PAGE_LINK_MAX} characters.`);
        else if (!parsesAsLink(text)) add(locatorKey, `Enter a valid ${platform} page link, for example https://www.instagram.com/name.`);
        else {
          const detected = detectPlatformFromLink(text);
          if (detected && detected !== row.platform) add(locatorKey, `This link looks like a ${formatPlatformName(detected)} page, not ${platform}.`);
        }
      } else if (/\s/.test(text)) add(locatorKey, "A handle has no spaces.");
      else if (text.length > HANDLE_MAX) add(locatorKey, `The handle can be at most ${HANDLE_MAX} characters.`);
      if (row.pageName.trim().length > PAGE_NAME_MAX) add(accountFieldKey(index, "pageName"), `The page name can be at most ${PAGE_NAME_MAX} characters.`);
    });
  }
  return issues;
}

export const issueFor = (issues: readonly FormIssue[], field: FormFieldKey): string | null => issues.find((issue) => issue.field === field)?.message ?? null;

// --- Requests ------------------------------------------------------------------------------------------------------------------------
// The Partner Accounts as the server takes them: the platform in the owning module's spelling and ONE locator each.
export function buildAccounts(form: OnboardingForm): Array<{ platform: string; handle?: string; profileUrl?: string; displayName?: string }> {
  return form.accounts.map((row) => ({
    platform: formatPlatformName(row.platform),
    ...(row.locatorKind === "LINK" ? { profileUrl: row.locator.trim() } : { handle: row.locator.trim() }),
    ...(row.pageName.trim() ? { displayName: row.pageName.trim() } : {}),
  }));
}

export function buildReviewedProfile(form: OnboardingForm, type: CounterpartyType): { displayName: string; legalName?: string; email?: string; phone?: string; regionIds: string[]; vendorType?: OnboardingVendorType } {
  return {
    displayName: form.displayName.trim(),
    ...(form.legalName.trim() ? { legalName: form.legalName.trim() } : {}),
    ...(form.email.trim() ? { email: form.email.trim() } : {}),
    ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
    regionIds: form.regionId.trim() ? [form.regionId.trim()] : [],
    ...(type === "VENDOR" && form.vendorType ? { vendorType: form.vendorType as OnboardingVendorType } : {}),
  };
}

// The duplicate probe: exactly the values the create command re-checks with (USE_EXISTING is only accepted for a record THIS check returns).
export function buildDuplicatesRequest(form: OnboardingForm, type: CounterpartyType): OnboardingDuplicatesRequest {
  const accounts = type === "PARTNER" ? buildAccounts(form).map(({ platform, handle, profileUrl }) => ({ platform, ...(handle ? { handle } : {}), ...(profileUrl ? { profileUrl } : {}) })) : [];
  return {
    type,
    displayName: form.displayName.trim(),
    ...(form.email.trim() ? { email: form.email.trim() } : {}),
    ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
    ...(accounts.length > 0 ? { accounts } : {}),
  };
}

// What a duplicate check covers. A result is only good for THIS signature: change the name, email, phone or an account and the person must
// check again. (The region, legal name and Vendor type are not part of the check, so editing them keeps the result.)
export function duplicateSignature(form: OnboardingForm, type: CounterpartyType): string {
  const request = buildDuplicatesRequest(form, type);
  return JSON.stringify({
    t: request.type,
    n: request.displayName.toLowerCase(),
    e: (request.email ?? "").toLowerCase(),
    p: (request.phone ?? "").replace(/[^\d+]/g, ""),
    a: (request.accounts ?? []).map((account) => [account.platform.toLowerCase(), (account.handle ?? "").toLowerCase(), (account.profileUrl ?? "").toLowerCase()]),
  });
}
