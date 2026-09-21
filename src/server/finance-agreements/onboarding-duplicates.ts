import { z } from "zod";

import { getActorScopeGrants } from "@/server/authz/scope";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import { checkForPartnerDuplicates, normalizeDisplayName as normalizePartnerDisplayName, normalizeEmail as normalizePartnerEmail, normalizePhone as normalizePartnerPhone } from "@/server/partners/duplicate-check";
import { findPartnerDocsByDisplayNameLower, getPartnerDocsByRefs } from "@/server/partners/firestore";
import { isPartnerDocInScope } from "@/server/partners/partners-gate";
import { checkForVendorDuplicates, normalizeDisplayName as normalizeVendorDisplayName, normalizeEmail as normalizeVendorEmail, normalizePhone as normalizeVendorPhone } from "@/server/vendors/duplicate-check";
import { getVendorDocsByRefs } from "@/server/vendors/firestore";
import { isVendorDocInScope } from "@/server/vendors/vendors-gate";

import { requireFinanceAgreementsAccess } from "./finance-agreements-gate";
import type { OnboardingDuplicateCandidateDto, OnboardingDuplicateSignal, OnboardingDuplicateStrength, OnboardingDuplicatesDto } from "./onboarding-dto";
import { formatIssues } from "./service-common";
import { counterpartyTypeSchema, financeAgreementsInvalidInputResult, financeAgreementsUnauthorizedResult, type CounterpartyType, type FinanceAgreementsServiceResult } from "./types";

// Step 14B.1: the Finance WRAPPER over the owning modules' duplicate checks, run before a counterparty is created from an Agreement.
//
//   gate         finance + manage_agreements (a duplicate lookup is part of starting an Agreement; it needs no partners / vendors feature)
//   normalize    with the OWNING module's own normalizers (email lower-trim, phone /[^\d+]/g - never the reconciliation normalizer),
//                so a value is compared exactly the way the owning module stores and checks it
//   evidence     the owning checks (email, phone, Partner Account identity / Vendor name) PLUS an exact normalized display-name
//                match. A display-name match is SUPPORTING evidence only: it is never fuzzy, and never alone a STRONG duplicate
//   strength     STRONG = an email match or an Account identity match, or a phone match together with an exact name match;
//                anything else is SUPPORTING. Nothing is ever merged automatically
//   scope        every hit is re-verified against the actor's LIVE Record Scope (loaded by ref):
//                  in scope        -> a candidate {type, ref, displayName, regions, status, signals, strength}
//                  outside scope   -> a STRONG hit becomes ONLY the neutral flag `strongMatchOutsideYourAccess` (no ref, name,
//                                     count or signal); a SUPPORTING hit is dropped without a trace
//                  not loadable    -> treated as outside scope (fail closed)
//   unknown      if any lookup could not run the status is `unknown` - never `none`
//
// The DTO carries no identity value and nothing about a record the actor cannot see. Bounded: at most 10 candidates, and every
// lookup is itself bounded by the owning module (5 hits per signal).

export const MAX_ONBOARDING_ACCOUNTS = 6;
export const MAX_ONBOARDING_DUPLICATE_CANDIDATES = 10;

const optionalText = (max: number) => z.string().trim().max(max).optional();

const accountProbeSchema = z
  .object({ platform: z.string().trim().min(1).max(60), handle: optionalText(120), profileUrl: optionalText(500), platformAccountId: optionalText(200) })
  .strict();

export const onboardingDuplicatesInputSchema = z
  .object({
    type: counterpartyTypeSchema,
    displayName: z.string().trim().min(1).max(200),
    email: optionalText(300),
    phone: optionalText(40),
    accounts: z.array(accountProbeSchema).max(MAX_ONBOARDING_ACCOUNTS).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.type === "VENDOR" && input.accounts && input.accounts.length > 0) ctx.addIssue({ code: "custom", path: ["accounts"], message: "A Vendor has no Partner Accounts." });
  });
export type OnboardingDuplicatesInput = z.infer<typeof onboardingDuplicatesInputSchema>;

// --- Pure: normalization, evidence, strength ---------------------------------------------------------------------------------------
// The owning module's normalizers (the two modules' are identical; each type uses its own).
export function normalizeOnboardingName(type: CounterpartyType, value: string): string {
  return type === "PARTNER" ? normalizePartnerDisplayName(value) : normalizeVendorDisplayName(value);
}
export function normalizeOnboardingEmail(type: CounterpartyType, value: string | undefined): string | undefined {
  const normalized = value === undefined ? "" : type === "PARTNER" ? normalizePartnerEmail(value) : normalizeVendorEmail(value);
  return normalized.length > 0 ? normalized : undefined;
}
export function normalizeOnboardingPhone(type: CounterpartyType, value: string | undefined): string | undefined {
  const normalized = value === undefined ? "" : type === "PARTNER" ? normalizePartnerPhone(value) : normalizeVendorPhone(value);
  return normalized.length > 0 ? normalized : undefined;
}

export type DuplicateEvidence = { ref: string; signal: OnboardingDuplicateSignal };

const SIGNAL_ORDER: readonly OnboardingDuplicateSignal[] = ["EMAIL", "ACCOUNT_IDENTITY", "PHONE", "DISPLAY_NAME"];

// STRONG = an email or Account identity match, or a phone match corroborated by an exact name match. A name alone is never STRONG.
export function strengthOf(signals: readonly OnboardingDuplicateSignal[]): OnboardingDuplicateStrength {
  if (signals.includes("EMAIL") || signals.includes("ACCOUNT_IDENTITY")) return "STRONG";
  if (signals.includes("PHONE") && signals.includes("DISPLAY_NAME")) return "STRONG";
  return "SUPPORTING";
}

export function groupEvidence(evidence: readonly DuplicateEvidence[]): Map<string, OnboardingDuplicateSignal[]> {
  const byRef = new Map<string, Set<OnboardingDuplicateSignal>>();
  for (const item of evidence) {
    const signals = byRef.get(item.ref) ?? new Set<OnboardingDuplicateSignal>();
    signals.add(item.signal);
    byRef.set(item.ref, signals);
  }
  return new Map([...byRef.entries()].map(([ref, signals]) => [ref, SIGNAL_ORDER.filter((signal) => signals.has(signal))] as const));
}

// What the live scope check reports for one referenced record: a record the actor may see (with its display data) or a hidden one.
export type ResolvedDuplicateRecord = { visible: true; displayName: string; regions: string[]; status: string } | { visible: false };

// Pure: evidence + the resolved records + the lookup outcome -> the DTO. An out-of-scope STRONG record contributes only the flag.
export function buildDuplicatesDto(input: { type: CounterpartyType; evidence: readonly DuplicateEvidence[]; lookupUnknown: boolean; resolved: ReadonlyMap<string, ResolvedDuplicateRecord>; checkedAt: string }): OnboardingDuplicatesDto {
  const candidates: OnboardingDuplicateCandidateDto[] = [];
  let strongOutside = false;
  for (const [ref, signals] of groupEvidence(input.evidence)) {
    const strength = strengthOf(signals);
    const record = input.resolved.get(ref) ?? { visible: false as const };
    if (!record.visible) {
      if (strength === "STRONG") strongOutside = true;
      continue;
    }
    candidates.push({ type: input.type, ref, displayName: record.displayName, regions: [...record.regions], status: record.status, signals, strength });
  }
  candidates.sort((a, b) => (a.strength === b.strength ? a.displayName.localeCompare(b.displayName) || a.ref.localeCompare(b.ref) : a.strength === "STRONG" ? -1 : 1));
  const bounded = candidates.slice(0, MAX_ONBOARDING_DUPLICATE_CANDIDATES);
  const status = input.lookupUnknown ? "unknown" : bounded.length > 0 || strongOutside ? "possible" : "none";
  return { type: input.type, status, candidates: bounded, strongMatchOutsideYourAccess: strongOutside, checkedAt: input.checkedAt };
}

// --- I/O ---------------------------------------------------------------------------------------------------------------------------
// The lookups behind the wrapper, injectable so a failing lookup can be exercised without touching the owning modules.
export type OnboardingDuplicateDeps = {
  checkPartners: typeof checkForPartnerDuplicates;
  checkVendors: typeof checkForVendorDuplicates;
  findPartnersByName: typeof findPartnerDocsByDisplayNameLower;
  loadPartners: typeof getPartnerDocsByRefs;
  loadVendors: typeof getVendorDocsByRefs;
  loadGrants: (actor: ActorContext) => Promise<ScopeGrant[]>;
};

const DEFAULT_DEPS: OnboardingDuplicateDeps = {
  checkPartners: checkForPartnerDuplicates,
  checkVendors: checkForVendorDuplicates,
  findPartnersByName: findPartnerDocsByDisplayNameLower,
  loadPartners: getPartnerDocsByRefs,
  loadVendors: getVendorDocsByRefs,
  loadGrants: getActorScopeGrants,
};

// One locator per probe: the owning Account identity uses key priority id > url > handle, so probing each provided form on its own
// also catches an Account the owning module stored under a different form of the same page.
function accountProbes(accounts: NonNullable<OnboardingDuplicatesInput["accounts"]>): Array<{ platform: string; platformAccountId?: string; profileUrl?: string; handle?: string }> {
  const probes: Array<{ platform: string; platformAccountId?: string; profileUrl?: string; handle?: string }> = [];
  for (const account of accounts) {
    if (account.platformAccountId) probes.push({ platform: account.platform, platformAccountId: account.platformAccountId });
    if (account.profileUrl) probes.push({ platform: account.platform, profileUrl: account.profileUrl });
    if (account.handle) probes.push({ platform: account.platform, handle: account.handle });
  }
  return probes;
}

async function gatherEvidence(input: OnboardingDuplicatesInput, deps: OnboardingDuplicateDeps): Promise<{ evidence: DuplicateEvidence[]; unknown: boolean }> {
  const evidence: DuplicateEvidence[] = [];
  let unknown = false;
  const email = normalizeOnboardingEmail(input.type, input.email);
  const phone = normalizeOnboardingPhone(input.type, input.phone);

  if (input.type === "VENDOR") {
    const result = await deps.checkVendors({ displayName: input.displayName, email, phone }).catch(() => ({ status: "unknown" as const, matches: [] }));
    if (result.status === "unknown") unknown = true;
    for (const match of result.matches) {
      if (match.type === "email") evidence.push({ ref: match.ref, signal: "EMAIL" });
      else if (match.type === "phone") evidence.push({ ref: match.ref, signal: "PHONE" });
      else if (match.type === "displayName") evidence.push({ ref: match.ref, signal: "DISPLAY_NAME" });
    }
    return { evidence, unknown };
  }

  if (email || phone) {
    const result = await deps.checkPartners({ email, phone }).catch(() => ({ status: "unknown" as const, matches: [] }));
    if (result.status === "unknown") unknown = true;
    for (const match of result.matches) {
      if (match.type === "email") evidence.push({ ref: match.ref, signal: "EMAIL" });
      else if (match.type === "phone") evidence.push({ ref: match.ref, signal: "PHONE" });
    }
  }
  for (const probe of accountProbes(input.accounts ?? [])) {
    const result = await deps.checkPartners({ accountIdentity: probe }).catch(() => ({ status: "unknown" as const, matches: [] }));
    if (result.status === "unknown") unknown = true;
    for (const match of result.matches) if (match.type === "accountIdentity") evidence.push({ ref: match.ref, signal: "ACCOUNT_IDENTITY" });
  }
  // The Partner module has no name signal of its own: an EXACT normalized-name equality (bounded), supporting evidence only.
  try {
    const named = await deps.findPartnersByName(normalizeOnboardingName("PARTNER", input.displayName));
    for (const doc of named) evidence.push({ ref: doc.partnerRef, signal: "DISPLAY_NAME" });
  } catch {
    unknown = true;
  }
  return { evidence, unknown };
}

async function resolveRecords(actor: ActorContext, type: CounterpartyType, refs: readonly string[], deps: OnboardingDuplicateDeps): Promise<Map<string, ResolvedDuplicateRecord>> {
  const resolved = new Map<string, ResolvedDuplicateRecord>();
  if (refs.length === 0) return resolved;
  const grants = await deps.loadGrants(actor);
  try {
    if (type === "PARTNER") {
      const docs = await deps.loadPartners([...refs]);
      for (const ref of refs) {
        const doc = docs.get(ref);
        resolved.set(ref, doc && isPartnerDocInScope(grants, actor.uid, doc) ? { visible: true, displayName: doc.displayName, regions: doc.regionIds, status: doc.status } : { visible: false });
      }
    } else {
      const docs = await deps.loadVendors([...refs]);
      for (const ref of refs) {
        const doc = docs.get(ref);
        resolved.set(ref, doc && isVendorDocInScope(grants, actor.uid, doc) ? { visible: true, displayName: doc.displayName, regions: doc.regionIds, status: doc.status } : { visible: false });
      }
    }
  } catch {
    // Could not load the records to verify scope: fail closed (every reference stays hidden), never expose an unverified record.
    for (const ref of refs) resolved.set(ref, { visible: false });
  }
  return resolved;
}

// Internal (gate and shape already checked by the caller): the live-scope-filtered duplicate DTO.
export async function evaluateOnboardingDuplicates(actor: ActorContext, input: OnboardingDuplicatesInput, deps: OnboardingDuplicateDeps = DEFAULT_DEPS): Promise<OnboardingDuplicatesDto> {
  const checkedAt = new Date().toISOString();
  const { evidence, unknown } = await gatherEvidence(input, deps);
  const refs = [...new Set(evidence.map((item) => item.ref))];
  const resolved = await resolveRecords(actor, input.type, refs, deps);
  return buildDuplicatesDto({ type: input.type, evidence, lookupUnknown: unknown, resolved, checkedAt });
}

// POST /api/finance/onboarding/duplicates.
export async function checkOnboardingDuplicates(actor: ActorContext | null, rawInput: unknown, deps: OnboardingDuplicateDeps = DEFAULT_DEPS): Promise<FinanceAgreementsServiceResult<OnboardingDuplicatesDto>> {
  const access = await requireFinanceAgreementsAccess(actor, "manage_agreements");
  if (!access.ok) return financeAgreementsUnauthorizedResult(access.reason);

  const parsed = onboardingDuplicatesInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeAgreementsInvalidInputResult(formatIssues(parsed.error));

  return { ok: true, data: await evaluateOnboardingDuplicates(actor!, parsed.data, deps) };
}
