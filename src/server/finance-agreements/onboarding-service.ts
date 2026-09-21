import { randomUUID } from "node:crypto";

import { z } from "zod";

import { getActorScopeGrants } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { createPartnerAccount } from "@/server/partners/partner-account-service";
import { createPartner } from "@/server/partners/partner-service";
import { findPartnerDocsCreatedByUser, getPartnerAccountDocByRef, getPartnerAccountIdentityClaim } from "@/server/partners/firestore";
import { isPartnerDocInScope, requirePartnersAccess } from "@/server/partners/partners-gate";
import { FINANCE_AGREEMENT_ONBOARDING_PROVENANCE } from "@/server/shared/onboarding-provenance";
import { createVendor } from "@/server/vendors/vendor-service";
import { findVendorDocsCreatedByUser } from "@/server/vendors/firestore";
import { isVendorDocInScope, requireVendorsAccess } from "@/server/vendors/vendors-gate";

import { createAgreementDraftWithProvenance } from "./agreement-service";
import { loadAuthorizedCounterparty, requireFinanceAgreementsAccess } from "./finance-agreements-gate";
import { ONBOARDING_STEPS, type OnboardingBlockerCode, type OnboardingOutcomeDto, type OnboardingStepName } from "./onboarding-dto";
import { evaluateOnboardingDuplicates, type OnboardingDuplicateDeps } from "./onboarding-duplicates";
import { accountCreateInput, accountKey, normalizeProfile, onboardingInputFingerprint, onboardingInputSchema, type NormalizedProfile, type OnboardingInput } from "./onboarding-input";
import {
  acquireOnboardingLease,
  createOnboardingLedger,
  getOnboardingLedger,
  LedgerLeaseLostError,
  onboardingAgreementClientRequestId,
  onboardingLedgerId,
  onboardingStepRequestId,
  updateOnboardingLedger,
  ONBOARDING_LEASE_MS,
  type OnboardingLedgerDoc,
} from "./onboarding-ledger";
import { formatIssues } from "./service-common";
import {
  financeAgreementsConflictResult,
  financeAgreementsInternalResult,
  financeAgreementsInvalidInputResult,
  financeAgreementsNotFoundResult,
  financeAgreementsNotReadyResult,
  financeAgreementsUnauthorizedResult,
  type AgreementCounterpartyInput,
  type CounterpartyType,
  type FinanceAgreementsErrorResult,
  type FinanceAgreementsServiceResult,
} from "./types";

// Step 14B.1: AGREEMENT-LED COUNTERPARTY ONBOARDING - the orchestration command.
//
// A signed Agreement can name a Partner / Vendor that does not exist yet. This command creates it - through the OWNING module's own
// services with the SAME actor (createPartner / createVendor / createPartnerAccount, each applying its own gate, scope, validation and
// audit) - and then starts the Agreement draft for it. Finance never writes a Partner, Vendor, Partner Account or KYC document itself,
// and creates no Finance-only identity: the canonical record is the owning module's, marked `createdVia: FINANCE_AGREEMENT_ONBOARDING`.
//
// Authorization, in order, all BEFORE anything is written:
//   finance feature -> manage_agreements  AND  (a new record) the owning create right (partners:create / vendors:create)
//   AND (Partner Accounts) partners:manage_partner_accounts.  An actor who may manage Agreements but not create the record gets the typed
//   blocker `counterparty_create_not_permitted`; they may still preview, review and use an existing record.
//
// Validation, before the ledger exists:
//   the input is strict; a NEW record needs at least one region and must be visible to the person creating it (live scope, evaluated on the
//   would-be record); a Vendor needs its type; Partner Accounts need a locator each, with no account listed twice; the duplicate decision is
//   checked against a FRESH, live-scope-filtered duplicate check (never the client's word):
//     USE_EXISTING  the ref must be one the check itself returned for this actor
//     CREATE_NEW    a strongMatchOutsideYourAccess blocks (strong_match_outside_access); an Account identity that already belongs to a
//                   Partner blocks (account_identity_collision - an identity cannot be created twice); a STRONG or unknown result needs
//                   acknowledgedDuplicates:true AND a reason
//
// Execution is a RESUMABLE STEP LEDGER (onboarding-ledger.ts): VALIDATED -> COUNTERPARTY_CREATED -> ACCOUNTS_CREATED ->
// AGREEMENT_DRAFT_CREATED. Each step is idempotent and recorded; a failure returns {completedSteps, failedStep, retryable, code, message}
// and the SAME request resumes it. A retry never creates a second Partner / Vendor / Account / Agreement:
//   - the intent is written before the owning create; if the process dies in between, the retry ADOPTS the record THIS actor created
//     since the ledger started (same normalized name, email, phone, regions) instead of creating another;
//   - an Account replay finds its identity claim: a claim that belongs to THIS Partner is "already created"; a claim that belongs to another
//     Partner is the failure `account_identity_collision` and is reported as a strong duplicate signal;
//   - the Agreement draft uses a deterministic clientRequestId, so createAgreementDraft's own claim returns the same Agreement.
// A Vendor Agreement never creates a represented-Partner link. USE_EXISTING creates no counterparty and no Account (still through the ledger).

// --- Test seam ------------------------------------------------------------------------------------------------------------------------
// A test can make the run fail at a named point (before / after each owning call), simulating an interruption exactly where the ledger is
// weakest. Refused outside a test run.
type FaultHook = (point: string) => void | Promise<void>;
let faultHook: FaultHook | null = null;

export function setOnboardingFaultHookForTests(hook: FaultHook | null): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) throw new Error("setOnboardingFaultHookForTests may only be called from a test run.");
  faultHook = hook;
}

async function fault(point: string): Promise<void> {
  if (faultHook) await faultHook(point);
}

// --- Helpers ----------------------------------------------------------------------------------------------------------------------------
const label = (type: CounterpartyType) => (type === "PARTNER" ? "Partner" : "Vendor");

function blocked(code: OnboardingBlockerCode, message: string): FinanceAgreementsErrorResult {
  return financeAgreementsNotReadyResult(message, [{ code, message }]);
}

const nowIso = () => new Date().toISOString();

type StepFailure = { step: OnboardingStepName; code: string; message: string; retryable: boolean; duplicateSignal?: boolean };

const UNEXPECTED: Omit<StepFailure, "step"> = { code: "unexpected_error", message: "Something went wrong. Try again to resume from where it stopped.", retryable: true };

// --- Outcome DTO ------------------------------------------------------------------------------------------------------------------------
export function completedStepsOf(ledger: OnboardingLedgerDoc): OnboardingStepName[] {
  const steps = ledger.steps;
  const done: OnboardingStepName[] = [];
  if (steps.validatedAt) done.push("VALIDATED");
  if (steps.counterparty?.resolvedAt) {
    done.push("COUNTERPARTY_CREATED");
    if (steps.plannedAccountKeys.every((key) => steps.accounts.some((account) => account.key === key && account.resolvedAt))) done.push("ACCOUNTS_CREATED");
  }
  if (steps.agreement) done.push("AGREEMENT_DRAFT_CREATED");
  return ONBOARDING_STEPS.filter((step) => done.includes(step));
}

export function toOnboardingOutcomeDto(ledger: OnboardingLedgerDoc, options: { replayed?: boolean; inProgress?: boolean } = {}): OnboardingOutcomeDto {
  const counterparty = ledger.steps.counterparty;
  const failure = ledger.failure;
  // COMPLETED always wins; a recorded failure is FAILED unless a newer runner holds the ledger (`inProgress`); everything else is still running
  // (or was interrupted - the same request resumes it).
  const outcome: OnboardingOutcomeDto["outcome"] = ledger.status === "COMPLETED" ? "COMPLETED" : failure && options.inProgress !== true ? "FAILED" : "IN_PROGRESS";
  const shown = outcome === "FAILED" ? failure : null;
  return {
    outcome,
    onboardingRef: ledger.onboardingRef,
    clientRequestId: ledger.clientRequestId,
    counterpartyType: ledger.counterpartyType,
    mode: ledger.mode,
    createdVia: ledger.createdVia,
    completedSteps: completedStepsOf(ledger),
    failedStep: shown ? shown.step : null,
    retryable: outcome === "COMPLETED" ? false : shown ? shown.retryable : true,
    code: shown ? shown.code : outcome === "IN_PROGRESS" ? "onboarding_in_progress" : null,
    message: shown ? shown.message : outcome === "IN_PROGRESS" ? "This onboarding is still running, or it was interrupted. Send the same request again to resume it." : null,
    duplicateSignal: shown ? shown.duplicateSignal : false,
    counterparty: counterparty?.resolvedAt && counterparty.ref && counterparty.displayName ? { type: ledger.counterpartyType, ref: counterparty.ref, displayName: counterparty.displayName, created: counterparty.created } : null,
    accounts: ledger.steps.accounts.flatMap((account) => (account.partnerAccountRef && account.resolvedAt ? [{ platform: account.platform, partnerAccountRef: account.partnerAccountRef, created: true }] : [])),
    agreementRef: ledger.steps.agreement ? ledger.steps.agreement.agreementRef : null,
    replayed: options.replayed === true,
  };
}

// --- Authorization + validation (before any write) --------------------------------------------------------------------------------------
// The owning create right(s) the steps still to run need. Checked through the OWNING gates (feature + action), never a role.
async function checkCreateRights(actor: ActorContext, type: CounterpartyType, needs: { counterparty: boolean; accounts: boolean }): Promise<FinanceAgreementsErrorResult | null> {
  if (needs.counterparty) {
    const gate = type === "PARTNER" ? await requirePartnersAccess(actor, "create") : await requireVendorsAccess(actor, "create");
    if (!gate.ok) {
      return blocked(
        "counterparty_create_not_permitted",
        `You can review this Agreement, but you do not have permission to create a new ${label(type)}. Select an existing ${label(type)}, or ask someone with access to create it.`,
      );
    }
  }
  if (needs.accounts && type === "PARTNER") {
    const gate = await requirePartnersAccess(actor, "manage_partner_accounts");
    if (!gate.ok) return blocked("account_management_not_permitted", "You do not have permission to add Partner Accounts. Remove the accounts, or ask someone with access to add them.");
  }
  return null;
}

function existingCounterpartyInput(input: OnboardingInput, partnerAccountRefs?: string[]): AgreementCounterpartyInput {
  if (input.duplicateDecision.kind !== "USE_EXISTING") throw new Error("Not an existing-counterparty decision.");
  return input.type === "PARTNER" ? { type: "PARTNER", partnerRef: input.duplicateDecision.ref, ...(partnerAccountRefs && partnerAccountRefs.length > 0 ? { partnerAccountRefs } : {}) } : { type: "VENDOR", vendorRef: input.duplicateDecision.ref };
}

async function validateNewOnboarding(actor: ActorContext, input: OnboardingInput, profile: NormalizedProfile, deps: OnboardingDuplicateDeps | undefined): Promise<FinanceAgreementsErrorResult | null> {
  const creating = input.duplicateDecision.kind === "CREATE_NEW";
  const accounts = input.accounts ?? [];

  const rights = await checkCreateRights(actor, input.type, { counterparty: creating, accounts: creating && accounts.length > 0 });
  if (rights) return rights;

  // The creator must be able to see what it creates (a record created into a region outside its own scope would be unreachable to it).
  if (creating) {
    const grants = await getActorScopeGrants(actor);
    const wouldBe = { uid: "__onboarding_new_record__", ownerUid: null, regionIds: profile.regionIds, teamIds: [] as string[] };
    const visible = input.type === "PARTNER" ? isPartnerDocInScope(grants, actor.uid, wouldBe) : isVendorDocInScope(grants, actor.uid, wouldBe);
    if (!visible) return financeAgreementsInvalidInputResult(`Choose a region you have access to: the new ${label(input.type)} must be visible to you.`);
  }

  const duplicates = await evaluateOnboardingDuplicates(
    actor,
    { type: input.type, displayName: input.reviewedProfile.displayName, email: input.reviewedProfile.email, phone: input.reviewedProfile.phone, accounts: accounts.map((account) => ({ platform: account.platform, handle: account.handle, profileUrl: account.profileUrl, platformAccountId: account.platformAccountId })) },
    deps,
  );

  if (input.duplicateDecision.kind === "USE_EXISTING") {
    const chosen = input.duplicateDecision;
    if (!duplicates.candidates.some((candidate) => candidate.ref === chosen.ref)) return blocked("use_existing_not_a_candidate", `That ${label(input.type)} was not among the possible matches for this Agreement. Search for it in the normal Agreement form instead.`);
    // Live scope of the chosen record (and of any Accounts named on it): the same neutral not_found as everywhere else.
    const loaded = await loadAuthorizedCounterparty(actor, existingCounterpartyInput(input, chosen.partnerAccountRefs));
    return loaded.ok ? null : loaded.error;
  }

  const decision = input.duplicateDecision;
  if (duplicates.strongMatchOutsideYourAccess) return blocked("strong_match_outside_access", `A matching ${label(input.type)} already exists outside your access. Ask an administrator to check it before creating a new one.`);
  if (duplicates.candidates.some((candidate) => candidate.signals.includes("ACCOUNT_IDENTITY"))) {
    return blocked("account_identity_collision", "One of these accounts already belongs to an existing Partner. Use that Partner, or remove the account.");
  }
  const needsAcknowledgement = duplicates.status === "unknown" || duplicates.candidates.some((candidate) => candidate.strength === "STRONG");
  if (needsAcknowledgement) {
    if (!decision.acknowledgedDuplicates) {
      return blocked("duplicate_acknowledgement_required", duplicates.status === "unknown" ? "The duplicate check could not be completed. Confirm that you want to create a new record anyway." : `A very likely match already exists. Use it, or confirm that you want to create a new ${label(input.type)} anyway.`);
    }
    if (!decision.reason) return blocked("duplicate_reason_required", "Give a short reason for creating a new record despite the possible match.");
  }
  return null;
}

// --- Step runners -----------------------------------------------------------------------------------------------------------------------
type RunContext = {
  actor: ActorContext;
  input: OnboardingInput;
  profile: NormalizedProfile;
  ledgerId: string;
  token: string;
  requestId: string;
  ledger: OnboardingLedgerDoc;
};

async function patch(ctx: RunContext, mutate: (current: OnboardingLedgerDoc) => OnboardingLedgerDoc): Promise<void> {
  ctx.ledger = await updateOnboardingLedger(ctx.ledgerId, ctx.token, mutate);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

// The crash-recovery lookup: the record THIS actor created since the ledger started, with exactly this normalized name, email, phone
// and regions. Only used when an earlier attempt had already recorded its intent (the retry after an interruption).
async function findAdoptableCounterparty(ctx: RunContext): Promise<{ ref: string; displayName: string } | null> {
  const { actor, profile, ledger } = ctx;
  if (ctx.input.type === "PARTNER") {
    const docs = await findPartnerDocsCreatedByUser(actor.userRef, profile.displayNameLower);
    const match = docs
      .filter((doc) => doc.createdAt >= ledger.startedAt && (doc.email ?? null) === profile.email && (doc.phone ?? null) === profile.phone && sameSet(doc.regionIds, profile.regionIds))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    return match ? { ref: match.partnerRef, displayName: match.displayName } : null;
  }
  const docs = await findVendorDocsCreatedByUser(actor.userRef, profile.displayNameLower);
  const match = docs
    .filter((doc) => doc.createdAt >= ledger.startedAt && (doc.email ?? null) === profile.email && (doc.phone ?? null) === profile.phone && sameSet(doc.regionIds, profile.regionIds) && doc.vendorType === profile.vendorType)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return match ? { ref: match.vendorRef, displayName: match.displayName } : null;
}

function owningFailure(step: OnboardingStepName, type: CounterpartyType, failure: { code: string; message: string }, codes: { failed: string }): StepFailure {
  if (failure.code === "unauthorized") return { step, code: type === "PARTNER" && step === "ACCOUNTS_CREATED" ? "account_management_not_permitted" : "counterparty_create_not_permitted", message: `You do not have permission to create this ${step === "ACCOUNTS_CREATED" ? "Partner Account" : label(type)}.`, retryable: false };
  if (failure.code === "invalid_input") return { step, code: codes.failed, message: failure.message.slice(0, 400) || "The record could not be created with these details.", retryable: false };
  return { step, code: codes.failed, message: `The ${step === "ACCOUNTS_CREATED" ? "Partner Account" : label(type)} could not be created right now. Try again to resume.`, retryable: true };
}

async function runCounterpartyStep(ctx: RunContext): Promise<StepFailure | null> {
  const { actor, input, profile } = ctx;
  if (ctx.ledger.steps.counterparty?.resolvedAt) return null;
  const step: OnboardingStepName = "COUNTERPARTY_CREATED";

  if (input.duplicateDecision.kind === "USE_EXISTING") {
    const loaded = await loadAuthorizedCounterparty(actor, existingCounterpartyInput(input, input.duplicateDecision.partnerAccountRefs));
    if (!loaded.ok) return { step, code: "counterparty_not_available", message: `That ${label(input.type)} is not available to you.`, retryable: false };
    const authorized = loaded.authorized;
    const ref = authorized.type === "PARTNER" ? authorized.counterparty.partnerRef : authorized.counterparty.vendorRef;
    const at = nowIso();
    await patch(ctx, (current) => ({ ...current, steps: { ...current.steps, counterparty: { intentAt: at, ref, displayName: authorized.displayName, created: false, adopted: false, resolvedAt: at } } }));
    return null;
  }

  // An earlier attempt that recorded its intent may have created the record before dying: adopt instead of creating again.
  const hadIntent = ctx.ledger.steps.counterparty !== null;
  if (!hadIntent) {
    const at = nowIso();
    await patch(ctx, (current) => ({ ...current, steps: { ...current.steps, counterparty: { intentAt: at, ref: null, displayName: null, created: false, adopted: false, resolvedAt: null } } }));
  }

  let created: { ref: string; displayName: string } | null = hadIntent ? await findAdoptableCounterparty(ctx) : null;
  const adopted = created !== null;
  if (!created) {
    await fault("before_counterparty_create");
    const requestId = onboardingStepRequestId(ctx.ledgerId, "counterparty");
    const common = { displayName: profile.displayName, ...(profile.legalName ? { legalName: profile.legalName } : {}), ...(profile.email ? { email: profile.email } : {}), ...(profile.phone ? { phone: profile.phone } : {}), regionIds: profile.regionIds, createdVia: FINANCE_AGREEMENT_ONBOARDING_PROVENANCE };
    if (input.type === "PARTNER") {
      const result = await createPartner(actor, common, requestId);
      if (!result.ok) return owningFailure(step, input.type, result, { failed: "counterparty_create_failed" });
      created = { ref: result.data.partnerRef, displayName: result.data.displayName };
    } else {
      const result = await createVendor(actor, { ...common, vendorType: profile.vendorType }, requestId);
      if (!result.ok) return owningFailure(step, input.type, result, { failed: "counterparty_create_failed" });
      created = { ref: result.data.vendorRef, displayName: result.data.displayName };
    }
    // (an interruption here leaves the record created but unrecorded: the retry adopts it)
    await fault("after_counterparty_create");
  }

  const at = nowIso();
  const resolved = created;
  await patch(ctx, (current) => ({
    ...current,
    steps: { ...current.steps, counterparty: { intentAt: current.steps.counterparty?.intentAt ?? at, ref: resolved.ref, displayName: resolved.displayName, created: true, adopted, resolvedAt: at } },
  }));
  return null;
}

// The Account named by this key already exists: on THIS Partner (an earlier attempt / a replay) it is simply recorded; on another Partner
// it is a collision (an Account identity can belong to one Partner only) - reported as a strong duplicate signal.
async function resolveExistingAccountClaim(key: string, partnerRef: string): Promise<{ kind: "mine"; ref: string } | { kind: "other" } | { kind: "none" }> {
  const claim = await getPartnerAccountIdentityClaim(key);
  if (!claim) return { kind: "none" };
  const account = await getPartnerAccountDocByRef(claim.partnerAccountRef);
  return account && account.partnerRef === partnerRef ? { kind: "mine", ref: account.partnerAccountRef } : { kind: "other" };
}

const COLLISION: Omit<StepFailure, "step"> = {
  code: "account_identity_collision",
  message: "This account already belongs to another Partner, so it cannot be created again. This is a strong sign that the Partner already exists: use that Partner, or remove the account.",
  retryable: false,
  duplicateSignal: true,
};

async function runAccountsStep(ctx: RunContext): Promise<StepFailure | null> {
  const { actor, input } = ctx;
  const step: OnboardingStepName = "ACCOUNTS_CREATED";
  const partnerRef = ctx.ledger.steps.counterparty?.ref;
  if (input.type !== "PARTNER" || input.duplicateDecision.kind !== "CREATE_NEW" || !partnerRef) return null;
  const accounts = input.accounts ?? [];

  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index]!;
    const key = accountKey(account)!;
    if (ctx.ledger.steps.accounts.some((record) => record.key === key && record.resolvedAt)) continue;

    if (!ctx.ledger.steps.accounts.some((record) => record.key === key)) {
      const at = nowIso();
      await patch(ctx, (current) => ({ ...current, steps: { ...current.steps, accounts: [...current.steps.accounts, { key, platform: account.platform.trim().toLowerCase(), intentAt: at, partnerAccountRef: null, resolvedAt: null }] } }));
    }

    let ref: string | null = null;
    const existing = await resolveExistingAccountClaim(key, partnerRef);
    if (existing.kind === "other") return { step, ...COLLISION };
    if (existing.kind === "mine") ref = existing.ref;

    if (ref === null) {
      await fault(`before_account_create:${index}`);
      const result = await createPartnerAccount(actor, partnerRef, { ...accountCreateInput(account, index === 0), createdVia: FINANCE_AGREEMENT_ONBOARDING_PROVENANCE }, onboardingStepRequestId(ctx.ledgerId, `account${index}`));
      if (result.ok) ref = result.data.partnerAccountRef;
      else if (result.code === "conflict") {
        // Lost a race, or a replay of an Account that already exists: whose claim is it?
        const raced = await resolveExistingAccountClaim(key, partnerRef);
        if (raced.kind === "mine") ref = raced.ref;
        else return { step, ...COLLISION };
      } else return owningFailure(step, input.type, result, { failed: "account_create_failed" });
      await fault(`after_account_create:${index}`);
    }

    const resolvedRef = ref;
    const at = nowIso();
    await patch(ctx, (current) => ({
      ...current,
      steps: { ...current.steps, accounts: current.steps.accounts.map((record) => (record.key === key ? { ...record, partnerAccountRef: resolvedRef, resolvedAt: at } : record)) },
    }));
  }
  return null;
}

async function runAgreementStep(ctx: RunContext): Promise<StepFailure | null> {
  const { actor, input } = ctx;
  const step: OnboardingStepName = "AGREEMENT_DRAFT_CREATED";
  if (ctx.ledger.steps.agreement) return null;
  const counterpartyRef = ctx.ledger.steps.counterparty?.ref;
  if (!counterpartyRef) return { step, code: "agreement_draft_failed", message: "The record for this Agreement is not ready.", retryable: false };

  let counterparty: AgreementCounterpartyInput;
  if (input.type === "VENDOR") counterparty = { type: "VENDOR", vendorRef: counterpartyRef };
  else {
    const refs = input.duplicateDecision.kind === "USE_EXISTING" ? [...new Set(input.duplicateDecision.partnerAccountRefs ?? [])] : ctx.ledger.steps.plannedAccountKeys.flatMap((key) => ctx.ledger.steps.accounts.find((record) => record.key === key)?.partnerAccountRef ?? []);
    counterparty = { type: "PARTNER", partnerRef: counterpartyRef, ...(refs.length > 0 ? { partnerAccountRefs: refs } : {}) };
  }

  await fault("before_agreement_draft");
  const result = await createAgreementDraftWithProvenance(
    actor,
    { clientRequestId: onboardingAgreementClientRequestId(ctx.ledgerId), counterparty, sourceMode: "EXTRACTED" },
    ctx.requestId,
    {
      createdVia: FINANCE_AGREEMENT_ONBOARDING_PROVENANCE,
      onboardingMode: input.duplicateDecision.kind === "CREATE_NEW" ? "NEW_COUNTERPARTY" : "EXISTING_COUNTERPARTY",
      onboardingRef: ctx.ledgerId,
      // the deliberate decision to create a new record despite a possible duplicate is part of the audit trail
      ...(input.duplicateDecision.kind === "CREATE_NEW" && input.duplicateDecision.acknowledgedDuplicates ? { duplicatesAcknowledged: true, ...(input.duplicateDecision.reason ? { reason: input.duplicateDecision.reason } : {}) } : {}),
    },
  );
  if (!result.ok) {
    const retryable = result.code !== "unauthorized" && result.code !== "not_found" && result.code !== "invalid_input" && result.code !== "conflict";
    return { step, code: "agreement_draft_failed", message: retryable ? "The Agreement draft could not be started right now. Try again to resume." : "The Agreement draft could not be started for this record.", retryable };
  }
  // (an interruption here leaves the draft created but unrecorded: the retry's createAgreementDraft returns the same Agreement)
  await fault("after_agreement_draft");
  const agreementRef = result.data.agreement.head.agreementRef;
  const at = nowIso();
  await patch(ctx, (current) => ({ ...current, steps: { ...current.steps, agreement: { agreementRef, at } } }));
  return null;
}

async function failLedger(ctx: RunContext, failure: StepFailure): Promise<OnboardingOutcomeDto> {
  try {
    await patch(ctx, (current) => ({
      ...current,
      status: "FAILED",
      lease: null,
      failure: { step: failure.step, code: failure.code, message: failure.message.slice(0, 500), retryable: failure.retryable, duplicateSignal: failure.duplicateSignal === true, at: nowIso() },
    }));
  } catch (error) {
    if (error instanceof LedgerLeaseLostError) return toOnboardingOutcomeDto(ctx.ledger, { inProgress: true });
    throw error;
  }
  return toOnboardingOutcomeDto(ctx.ledger);
}

async function runSteps(ctx: RunContext): Promise<OnboardingOutcomeDto> {
  const runners: Array<() => Promise<StepFailure | null>> = [() => runCounterpartyStep(ctx), () => runAccountsStep(ctx), () => runAgreementStep(ctx)];
  const stepNames: OnboardingStepName[] = ["COUNTERPARTY_CREATED", "ACCOUNTS_CREATED", "AGREEMENT_DRAFT_CREATED"];
  for (let index = 0; index < runners.length; index += 1) {
    try {
      const failure = await runners[index]!();
      if (failure) return await failLedger(ctx, failure);
    } catch (error) {
      // The lease was lost (another runner took over after it expired): do not touch the ledger again.
      if (error instanceof LedgerLeaseLostError) return toOnboardingOutcomeDto(ctx.ledger, { inProgress: true });
      // Only the error class is logged: never a value from the request.
      console.error("[finance-agreements] onboarding step failed", stepNames[index], error instanceof Error ? error.name : "unknown");
      try {
        return await failLedger(ctx, { step: stepNames[index]!, ...UNEXPECTED });
      } catch {
        return toOnboardingOutcomeDto(ctx.ledger, { inProgress: true });
      }
    }
  }
  try {
    await patch(ctx, (current) => ({ ...current, status: "COMPLETED", lease: null, failure: null }));
  } catch (error) {
    if (error instanceof LedgerLeaseLostError) return toOnboardingOutcomeDto(ctx.ledger, { inProgress: true });
    throw error;
  }
  return toOnboardingOutcomeDto(ctx.ledger);
}

// --- The command ------------------------------------------------------------------------------------------------------------------------
export type OnboardingServiceDeps = { duplicates?: OnboardingDuplicateDeps };

// POST /api/finance/onboarding. Answers 200 with an OnboardingOutcomeDto for every outcome that ran (COMPLETED, FAILED at a step, IN_PROGRESS);
// a refusal BEFORE anything was written is an error result (unauthorized / invalid_input / not_found / conflict, or not_ready with a typed
// blocker code).
export async function createCounterpartyFromOnboarding(actor: ActorContext | null, rawInput: unknown, requestId: string, deps: OnboardingServiceDeps = {}): Promise<FinanceAgreementsServiceResult<OnboardingOutcomeDto>> {
  const access = await requireFinanceAgreementsAccess(actor, "manage_agreements");
  if (!access.ok) return financeAgreementsUnauthorizedResult(access.reason);

  const parsed = onboardingInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeAgreementsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;
  const profile = normalizeProfile(input.type, input.reviewedProfile);
  const fingerprint = onboardingInputFingerprint(input);
  const ledgerId = onboardingLedgerId(actor!.uid, input.clientRequestId);

  let ledger = await getOnboardingLedger(ledgerId);
  let token: string | null = null;

  if (ledger) {
    if (ledger.inputFingerprint !== fingerprint) return financeAgreementsConflictResult("This clientRequestId was already used for a different onboarding request.");
  } else {
    const rejected = await validateNewOnboarding(actor!, input, profile, deps.duplicates);
    if (rejected) return rejected;

    const startedAt = new Date();
    // Only a NEW Partner creates Accounts; with USE_EXISTING the listed accounts served the duplicate check and nothing more.
    const accountKeys = input.duplicateDecision.kind === "CREATE_NEW" ? (input.accounts ?? []).map((account) => accountKey(account)!) : [];
    const leaseToken = randomUUID();
    const created = await createOnboardingLedger({
      kind: "ONBOARDING",
      onboardingRef: ledgerId,
      clientRequestId: input.clientRequestId,
      actorUserRef: actor!.userRef,
      counterpartyType: input.type,
      mode: input.duplicateDecision.kind,
      createdVia: FINANCE_AGREEMENT_ONBOARDING_PROVENANCE,
      inputFingerprint: fingerprint,
      status: "IN_PROGRESS",
      attempts: 1,
      lease: { token: leaseToken, expiresAt: new Date(startedAt.getTime() + ONBOARDING_LEASE_MS).toISOString() },
      duplicateDecision: input.duplicateDecision.kind === "CREATE_NEW" ? { kind: "CREATE_NEW", acknowledgedDuplicates: input.duplicateDecision.acknowledgedDuplicates, reasonRecorded: Boolean(input.duplicateDecision.reason) } : { kind: "USE_EXISTING", acknowledgedDuplicates: false, reasonRecorded: false },
      steps: { validatedAt: startedAt.toISOString(), counterparty: null, plannedAccountKeys: accountKeys, accounts: [], agreement: null },
      failure: null,
      startedAt: startedAt.toISOString(),
      updatedAt: startedAt.toISOString(),
    });
    if (created.kind === "created") {
      ledger = created.doc;
      token = leaseToken;
    } else {
      // A concurrent request created the ledger first: continue as a resume of it.
      ledger = await getOnboardingLedger(ledgerId);
      if (!ledger) return financeAgreementsInternalResult();
      if (ledger.inputFingerprint !== fingerprint) return financeAgreementsConflictResult("This clientRequestId was already used for a different onboarding request.");
    }
  }

  if (ledger.status === "COMPLETED") return { ok: true, data: toOnboardingOutcomeDto(ledger, { replayed: true }) };

  if (token === null) {
    // RESUME. The rights for the steps that still have to run are checked again (a right removed mid-way is honoured), then the lease is taken.
    const counterpartyPending = ledger.mode === "CREATE_NEW" && !ledger.steps.counterparty?.resolvedAt;
    const accountsPending = ledger.mode === "CREATE_NEW" && ledger.steps.plannedAccountKeys.some((key) => !ledger!.steps.accounts.some((account) => account.key === key && account.resolvedAt));
    const rights = await checkCreateRights(actor!, input.type, { counterparty: counterpartyPending, accounts: accountsPending });
    if (rights) return rights;

    const leaseToken = randomUUID();
    const acquired = await acquireOnboardingLease(ledgerId, leaseToken, new Date());
    if (acquired.kind === "missing") return financeAgreementsInternalResult();
    if (acquired.kind === "completed") return { ok: true, data: toOnboardingOutcomeDto(acquired.doc, { replayed: true }) };
    if (acquired.kind === "busy") return { ok: true, data: toOnboardingOutcomeDto(acquired.doc, { inProgress: true }) };
    ledger = acquired.doc;
    token = leaseToken;
  }

  const ctx: RunContext = { actor: actor!, input, profile, ledgerId, token, requestId, ledger };
  return { ok: true, data: await runSteps(ctx) };
}

// --- Status ---------------------------------------------------------------------------------------------------------------------------------
const onboardingStatusInputSchema = z
  .object({ onboardingRef: z.string().regex(/^onb_[0-9a-f]{64}$/).optional(), clientRequestId: z.string().trim().min(8).max(100).optional() })
  .strict()
  .refine((value) => (value.onboardingRef === undefined) !== (value.clientRequestId === undefined), { message: "Give exactly one of onboardingRef or clientRequestId." });

// GET /api/finance/onboarding?clientRequestId= | ?onboardingRef= . Only the actor who started the onboarding can read it; anything else is the
// same neutral not_found. Reads the ledger only - it never resumes or writes.
export async function getOnboardingStatus(actor: ActorContext | null, rawInput: unknown): Promise<FinanceAgreementsServiceResult<OnboardingOutcomeDto>> {
  const access = await requireFinanceAgreementsAccess(actor, "manage_agreements");
  if (!access.ok) return financeAgreementsUnauthorizedResult(access.reason);

  const parsed = onboardingStatusInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeAgreementsInvalidInputResult(formatIssues(parsed.error));

  const ledgerId = parsed.data.onboardingRef ?? onboardingLedgerId(actor!.uid, parsed.data.clientRequestId!);
  const ledger = await getOnboardingLedger(ledgerId);
  if (!ledger || ledger.actorUserRef !== actor!.userRef) return financeAgreementsNotFoundResult();
  return { ok: true, data: toOnboardingOutcomeDto(ledger) };
}
