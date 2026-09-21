import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import { applyFieldDecision, attachProposalsToDraft, buildMasterDataDraft, reconciliationEntriesForVersion, type ReconciliationFieldEntry } from "./agreement-draft";
import { appendAgreementEvent } from "./agreement-events";
import { buildHeadDisplay, txResolveDisplayVersions, withHeadDisplay } from "./agreement-head-display";
import { toAgreementEventDto, toAgreementHeadDto, toAgreementVersionSummaryDto, type AgreementDetailDto, type AgreementEventDto, type AgreementHeadDto, type AgreementVersionSummaryDto } from "./client-dto";
import { assembleConfirmedAgreement, fieldAppliesTo } from "./fields";
import {
  agreementClaimId,
  createDraftInputFingerprint,
  DEFAULT_AGREEMENT_EVENT_PAGE,
  financeAgreementExtractionRunsCollection,
  financeAgreementsCollection,
  financeContractArtifactsCollection,
  getAgreementClaimDoc,
  getAgreementVersionDoc,
  listAgreementEventDocs,
  listAgreementVersionDocs,
  MAX_AGREEMENT_EVENT_PAGE,
  txCreateAgreementClaim,
  txCreateAgreementHead,
  txCreateAgreementVersion,
  txGetAgreementClaim,
  txGetAgreementHead,
  txGetAgreementVersion,
  txSetAgreementHead,
  txSetAgreementVersion,
} from "./firestore";
import { loadAuthorizedAgreement, loadAuthorizedCounterparty, requireContractSensitiveAccess, requireFinanceAgreementsAccess } from "./finance-agreements-gate";
import { generateAgreementRef } from "./ids";
import { computeIdentityStatus } from "./identity-status";
import { authorizeAgreementCommand, buildAgreementDetailDto, defaultVersionNumber, formatIssues, isAlreadyExistsError, newDraftVersionDoc, scopeFieldsOf } from "./service-common";
import {
  agreementHeadDocSchema,
  attachExtractionInputSchema,
  confirmAgreementVersionInputSchema,
  contractArtifactDocSchema,
  counterpartyTypeSchema,
  createAgreementDraftInputSchema,
  decideFieldInputSchema,
  extractionRunDocSchema,
  financeAgreementsConflictResult,
  financeAgreementsInvalidInputResult,
  financeAgreementsNotFoundResult,
  financeAgreementsNotReadyResult,
  financeAgreementsStaleResult,
  financeAgreementsUnauthorizedResult,
  type AgreementHeadDoc,
  type AgreementVersionDoc,
  type CounterpartyType,
  type FinanceAgreementsErrorResult,
  type FinanceAgreementsReadinessIssue,
  type FinanceAgreementsServiceResult,
} from "./types";

// Step 14A: the trusted Finance Agreements service - create, reads, and (below) the draft
// preparation commands decide / attach extraction / confirm. The lifecycle transitions
// (activate, revise, suspend, resume, end) live in agreement-lifecycle-service.ts.
//
// Every command runs the gate chain (Authentication -> Admission -> FeatureAccess(finance)
// -> ActionPermission -> live RecordScope -> lifecycle preconditions inside the transaction),
// writes ONLY financeAgreements* documents, appends its audit event in the SAME transaction, and
// never writes a Partner, Vendor, KYC, Payable, Invoice or Payment record.

const versionNumberSchema = z.number().int().min(1);

// --- Create -------------------------------------------------------------------------------------------------------------------
export type CreateAgreementDraftOutcome = { outcome: "created" | "existing"; agreement: AgreementDetailDto };

type CreateTxResult = { kind: "created"; head: AgreementHeadDoc; version: AgreementVersionDoc } | { kind: "existing"; agreementRef: string; fingerprint: string };

// Creates the Agreement head + version 1 (DRAFT) for one Partner or Vendor. IDEMPOTENT by
// construction: a claim document keyed by sha256(actorUid | clientRequestId) is created with
// tx.create in the SAME transaction as the head and version 1, so a retried or concurrent create
// with the same clientRequestId can only ever resolve to the ONE head (the loser - whose create
// aborts or whose read sees the claim - returns the existing Agreement). The same id with a
// DIFFERENT counterparty payload is a conflict, never a silent hand-back of another Agreement.
//
// The draft working copy is pre-filled from the canonical Partner/Vendor master data (origin
// MASTER_DATA, decision PENDING, provenance "CreatorOps master data"): name, phone, email, a state
// when the record has exactly one region, and platform/page context from the derived counterparty
// - NEVER an identity value.
export async function createAgreementDraft(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceAgreementsServiceResult<CreateAgreementDraftOutcome>> {
  return createAgreementDraftWithProvenance(actor, rawInput, requestId, null);
}

// Step 14B.1: the SAME command, additionally recording on the `created` event that the Agreement was started from Finance Agreement
// onboarding (provenance only: the allowlisted keys `createdVia`, `onboardingMode`, `onboardingRef`). Used by the onboarding orchestration;
// it changes no rule of draft creation, and an idempotent replay keeps the original event.
export type AgreementDraftProvenance = {
  createdVia: "FINANCE_AGREEMENT_ONBOARDING";
  onboardingMode: "NEW_COUNTERPARTY" | "EXISTING_COUNTERPARTY";
  onboardingRef: string;
  // The deliberate "create new despite a possible duplicate" decision (the reviewer's own words are screened by the event allowlist).
  duplicatesAcknowledged?: boolean;
  reason?: string;
};

export async function createAgreementDraftWithProvenance(actor: ActorContext | null, rawInput: unknown, requestId: string, provenance: AgreementDraftProvenance | null): Promise<FinanceAgreementsServiceResult<CreateAgreementDraftOutcome>> {
  const access = await requireFinanceAgreementsAccess(actor, "manage_agreements");
  if (!access.ok) return financeAgreementsUnauthorizedResult(access.reason);

  const parsed = createAgreementDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeAgreementsInvalidInputResult(formatIssues(parsed.error));

  const loaded = await loadAuthorizedCounterparty(actor!, parsed.data.counterparty);
  if (!loaded.ok) return loaded.error;
  const authorized = loaded.authorized;

  const claimId = agreementClaimId(actor!.uid, parsed.data.clientRequestId);
  const fingerprint = createDraftInputFingerprint(parsed.data.counterparty);

  const resolveExisting = async (agreementRef: string, claimFingerprint: string): Promise<FinanceAgreementsServiceResult<CreateAgreementDraftOutcome>> => {
    if (claimFingerprint !== fingerprint) return financeAgreementsConflictResult("This clientRequestId was already used for a different agreement request.");
    const existing = await loadAuthorizedAgreement(actor, agreementRef);
    if (!existing.ok) return existing.error;
    const { head, displayName } = existing.authorized;
    const version = await getAgreementVersionDoc(head.agreementRef, defaultVersionNumber(head));
    return { ok: true, data: { outcome: "existing", agreement: await buildAgreementDetailDto(actor!, head, displayName, version) } };
  };

  // Fast path: a retry finds its claim without any write.
  const priorClaim = await getAgreementClaimDoc(claimId);
  if (priorClaim) return resolveExisting(priorClaim.agreementRef, priorClaim.inputFingerprint);

  const agreementRef = generateAgreementRef();
  const draft = buildMasterDataDraft(authorized);

  let txResult: CreateTxResult;
  try {
    txResult = await getAdminFirestore().runTransaction<CreateTxResult>(async (tx) => {
      const claim = await txGetAgreementClaim(tx, claimId);
      if (claim) return { kind: "existing", agreementRef: claim.agreementRef, fingerprint: claim.inputFingerprint };

      const now = new Date().toISOString();
      const version = newDraftVersionDoc({ agreementRef, version: 1, counterparty: authorized.counterparty, sourceMode: parsed.data.sourceMode ?? "MANUAL", draft, now, actorUserRef: actor!.userRef });
      const head: AgreementHeadDoc = agreementHeadDocSchema.parse({
        agreementRef,
        docVersion: 1,
        counterparty: authorized.counterparty,
        ...scopeFieldsOf(authorized.scope),
        status: "DRAFT",
        latestVersion: 1,
        openVersion: 1,
        activeVersion: null,
        lastEndedVersion: null,
        // Step 14B list projection, written in the same transaction as the head.
        display: buildHeadDisplay({ head: { status: "DRAFT", openVersion: 1, activeVersion: null, lastEndedVersion: null }, counterpartyName: authorized.displayName, open: version, governing: null, extractionStatus: null, projectedAt: now }),
        createdAt: now,
        createdByUserRef: actor!.userRef,
        updatedAt: now,
        updatedByUserRef: actor!.userRef,
      });

      txCreateAgreementClaim(tx, claimId, { agreementRef, inputFingerprint: fingerprint, createdAt: now });
      txCreateAgreementHead(tx, head);
      txCreateAgreementVersion(tx, version);
      appendAgreementEvent(tx, {
        agreementRef,
        kind: "created",
        version: 1,
        actorUserRef: actor!.userRef,
        metadata: { counterpartyType: authorized.type, sourceMode: version.sourceMode, fieldCount: Object.keys(draft).length, platformCount: authorized.counterparty.type === "PARTNER" ? authorized.counterparty.platformScope.length : 0, accountCount: authorized.counterparty.type === "PARTNER" ? authorized.counterparty.partnerAccountRefs.length : 0, ...(provenance ?? {}) },
        requestId,
        createdAt: now,
      });
      return { kind: "created", head, version };
    });
  } catch (error) {
    // A parallel create with the same clientRequestId won the claim's tx.create: hand back its Agreement.
    if (!isAlreadyExistsError(error)) throw error;
    const claim = await getAgreementClaimDoc(claimId);
    if (!claim) throw error;
    return resolveExisting(claim.agreementRef, claim.inputFingerprint);
  }

  if (txResult.kind === "existing") return resolveExisting(txResult.agreementRef, txResult.fingerprint);
  return { ok: true, data: { outcome: "created", agreement: await buildAgreementDetailDto(actor!, txResult.head, authorized.displayName, txResult.version) } };
}

// --- Reads ----------------------------------------------------------------------------------------------------------------------
// Head + bounded version summaries + one version's full detail (default: the open version, else the
// governing one, else the newest). Read gate = finance feature + LIVE Record Scope; knowing an
// agreementRef never grants access. Identity is STATUS only.
export async function getAgreementDetail(actor: ActorContext | null, agreementRef: unknown, input: { version?: unknown } = {}): Promise<FinanceAgreementsServiceResult<AgreementDetailDto>> {
  const loaded = await loadAuthorizedAgreement(actor, typeof agreementRef === "string" ? agreementRef : "");
  if (!loaded.ok) return loaded.error;
  const { head, displayName } = loaded.authorized;

  let versionNumber = defaultVersionNumber(head);
  if (input.version !== undefined) {
    const parsedVersion = versionNumberSchema.safeParse(input.version);
    if (!parsedVersion.success) return financeAgreementsInvalidInputResult("version must be a positive integer.");
    versionNumber = parsedVersion.data;
  }
  const version = await getAgreementVersionDoc(head.agreementRef, versionNumber);
  if (!version) return financeAgreementsNotFoundResult();
  return { ok: true, data: await buildAgreementDetailDto(actor!, head, displayName, version) };
}

export async function listAgreementVersions(actor: ActorContext | null, agreementRef: unknown): Promise<FinanceAgreementsServiceResult<{ agreementRef: string; versions: AgreementVersionSummaryDto[]; hasMore: boolean }>> {
  const loaded = await loadAuthorizedAgreement(actor, typeof agreementRef === "string" ? agreementRef : "");
  if (!loaded.ok) return loaded.error;
  const listed = await listAgreementVersionDocs(loaded.authorized.head.agreementRef);
  const contractDetailVisible = (await requireContractSensitiveAccess(actor!)).ok;
  return { ok: true, data: { agreementRef: loaded.authorized.head.agreementRef, versions: listed.versions.map((doc) => toAgreementVersionSummaryDto(doc, { contractDetailVisible })), hasMore: listed.hasMore } };
}

const eventLimitSchema = z.number().int().min(1).max(MAX_AGREEMENT_EVENT_PAGE);

// Newest first, one bounded page (no cursor). Event metadata is allowlist-redacted on the way out.
export async function listAgreementEvents(actor: ActorContext | null, agreementRef: unknown, input: { limit?: unknown } = {}): Promise<FinanceAgreementsServiceResult<{ agreementRef: string; events: AgreementEventDto[]; hasMore: boolean }>> {
  const loaded = await loadAuthorizedAgreement(actor, typeof agreementRef === "string" ? agreementRef : "");
  if (!loaded.ok) return loaded.error;
  let limit = DEFAULT_AGREEMENT_EVENT_PAGE;
  if (input.limit !== undefined) {
    const parsedLimit = eventLimitSchema.safeParse(input.limit);
    if (!parsedLimit.success) return financeAgreementsInvalidInputResult(`limit must be an integer between 1 and ${MAX_AGREEMENT_EVENT_PAGE}.`);
    limit = parsedLimit.data;
  }
  const listed = await listAgreementEventDocs(loaded.authorized.head.agreementRef, limit);
  return { ok: true, data: { agreementRef: loaded.authorized.head.agreementRef, events: listed.events.map(toAgreementEventDto), hasMore: listed.hasMore } };
}

export const MAX_COUNTERPARTY_AGREEMENTS = 50;
const counterpartyListInputSchema = z.object({ counterpartyType: counterpartyTypeSchema, ref: z.string().min(1).max(200) }).strict();

// Every Agreement head of ONE Partner or Vendor. An equality-only query on the counterparty ref
// (single-field, no composite index), bounded, sorted in memory, and every head is re-checked
// against the LIVE counterparty (the ref names the counterparty, but the head's stored uid must
// still be that counterparty's own uid). The counterparty's Record Scope is verified live first:
// an out-of-scope, missing or forged counterparty is the neutral not_found.
export async function listAgreementsForCounterparty(actor: ActorContext | null, rawInput: unknown): Promise<FinanceAgreementsServiceResult<{ agreements: AgreementHeadDto[]; hasMore: boolean }>> {
  const access = await requireFinanceAgreementsAccess(actor);
  if (!access.ok) return financeAgreementsUnauthorizedResult(access.reason);
  const parsed = counterpartyListInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeAgreementsInvalidInputResult(formatIssues(parsed.error));

  const type: CounterpartyType = parsed.data.counterpartyType;
  const loaded = await loadAuthorizedCounterparty(actor!, type === "PARTNER" ? { type: "PARTNER", partnerRef: parsed.data.ref } : { type: "VENDOR", vendorRef: parsed.data.ref });
  if (!loaded.ok) return loaded.error;
  const liveUid = loaded.authorized.type === "PARTNER" ? loaded.authorized.scope.partnerUid : loaded.authorized.scope.vendorUid;

  const listed = await loadCounterpartyHeadDocs(type, parsed.data.ref, liveUid);
  return { ok: true, data: { agreements: listed.heads.map((head) => toAgreementHeadDto(head, loaded.authorized.displayName)), hasMore: listed.hasMore } };
}

// The Agreement heads of ONE already-authorized counterparty (shared by the counterparty list and the Step 14B.1 document
// projection, so both use the one audited query): bounded, newest first, and each head re-checked against the counterparty's LIVE
// uid. The CALLER must have verified the counterparty's Record Scope.
export async function loadCounterpartyHeadDocs(type: CounterpartyType, ref: string, liveUid: string | null): Promise<{ heads: AgreementHeadDoc[]; hasMore: boolean }> {
  const field = type === "PARTNER" ? "counterparty.partnerRef" : "counterparty.vendorRef";
  const snapshot = await financeAgreementsCollection()
    .where(field, "==", ref)
    .limit(MAX_COUNTERPARTY_AGREEMENTS + 1)
    .get();

  const heads: AgreementHeadDoc[] = [];
  for (const doc of snapshot.docs.slice(0, MAX_COUNTERPARTY_AGREEMENTS)) {
    const head = agreementHeadDocSchema.safeParse(doc.data());
    if (!head.success || head.data.counterparty.type !== type) continue;
    const headUid = type === "PARTNER" ? head.data.partnerUid : head.data.vendorUid;
    if (headUid !== liveUid) continue;
    heads.push(head.data);
  }
  heads.sort((a, b) => (a.updatedAt === b.updatedAt ? a.agreementRef.localeCompare(b.agreementRef) : b.updatedAt.localeCompare(a.updatedAt)));
  return { heads, hasMore: snapshot.docs.length > MAX_COUNTERPARTY_AGREEMENTS };
}

export type ReconciliationDraftFields = {
  agreementRef: string;
  version: number;
  counterpartyType: CounterpartyType;
  confirmed: boolean;
  versionStatus: AgreementVersionDoc["status"];
  // The Agreement-side values (working draft or frozen terms). Restricted fields carry no value.
  fields: ReconciliationFieldEntry[];
};

// SEAM for the reconciliation agent: the Agreement side of a comparison. Read gate + live scope only;
// restricted values are never present (an Agreement holds none) and no raw contract text is here.
export async function getDraftFieldsForReconciliation(actor: ActorContext | null, agreementRef: unknown, version?: unknown): Promise<FinanceAgreementsServiceResult<ReconciliationDraftFields>> {
  const loaded = await loadAuthorizedAgreement(actor, typeof agreementRef === "string" ? agreementRef : "");
  if (!loaded.ok) return loaded.error;
  const { head } = loaded.authorized;

  let versionNumber = defaultVersionNumber(head);
  if (version !== undefined) {
    const parsedVersion = versionNumberSchema.safeParse(version);
    if (!parsedVersion.success) return financeAgreementsInvalidInputResult("version must be a positive integer.");
    versionNumber = parsedVersion.data;
  }
  const doc = await getAgreementVersionDoc(head.agreementRef, versionNumber);
  if (!doc) return financeAgreementsNotFoundResult();
  return { ok: true, data: { agreementRef: head.agreementRef, version: doc.version, counterpartyType: doc.counterparty.type, confirmed: doc.confirmation !== null, versionStatus: doc.status, fields: reconciliationEntriesForVersion(doc) } };
}

// --- Draft preparation commands (manage_agreements) ------------------------------------------------------------------------------
// Shared transaction precondition for every command that edits or freezes the working draft: the
// version must exist, match the caller's expectedDocVersion (the VERSION doc's own docVersion), be the
// head's ONE open version, and be unconfirmed. Once `confirmation` is set the version's terms,
// contact snapshot, provenance, source and effective dates are immutable forever.
type EditFailure = { kind: "not_found" } | { kind: "stale" } | { kind: "locked"; version: number };

function checkEditable(head: AgreementHeadDoc | null, version: AgreementVersionDoc | null, expectedDocVersion: number): EditFailure | null {
  if (!head || !version) return { kind: "not_found" };
  if (version.docVersion !== expectedDocVersion) return { kind: "stale" };
  if (head.openVersion !== version.version || version.status !== "DRAFT" || version.confirmation !== null) return { kind: "locked", version: version.version };
  return null;
}

function editFailureResult(failure: EditFailure): FinanceAgreementsErrorResult {
  if (failure.kind === "not_found") return financeAgreementsNotFoundResult();
  if (failure.kind === "stale") return financeAgreementsStaleResult();
  return financeAgreementsConflictResult(`Version ${failure.version} is confirmed or is not the open version and can no longer be changed.`);
}

type DecideTxResult = { kind: "ok"; head: AgreementHeadDoc; version: AgreementVersionDoc } | { kind: "invalid"; message: string } | EditFailure;

// Records one human decision on one field of the OPEN, unconfirmed version (ACCEPTED, CORRECTED,
// UNAVAILABLE or NOT_APPLICABLE). The value was validated by checkFieldDecisionValue in the input
// schema; identity VALUE fields take an acknowledgement only. Optimistic: expectedDocVersion is the
// VERSION doc's docVersion, verified inside the transaction. The audit event carries the field NAME
// and the decision only - never a value.
export async function decideField(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceAgreementsServiceResult<AgreementDetailDto>> {
  const command = await authorizeAgreementCommand(actor, "manage_agreements", decideFieldInputSchema, rawInput);
  if (!command.ok) return command.error;
  const { input, authorized } = command;

  const result = await getAdminFirestore().runTransaction<DecideTxResult>(async (tx) => {
    const head = await txGetAgreementHead(tx, input.agreementRef);
    const version = await txGetAgreementVersion(tx, input.agreementRef, input.version);
    const failure = checkEditable(head, version, input.expectedDocVersion);
    if (failure) return failure;
    if (!head || !version) return { kind: "not_found" };

    if (!fieldAppliesTo(input.fieldKey, version.counterparty.type)) return { kind: "invalid", message: `${input.fieldKey} does not apply to a ${version.counterparty.type.toLowerCase()} agreement.` };
    const now = new Date().toISOString();
    const applied = applyFieldDecision({ existing: version.draft[input.fieldKey], fieldKey: input.fieldKey, decision: input.decision, value: input.value, actorUserRef: actor!.userRef, now });
    if (!applied.ok) return { kind: "invalid", message: applied.message };

    const next: AgreementVersionDoc = { ...version, draft: { ...version.draft, [input.fieldKey]: applied.entry }, docVersion: version.docVersion + 1, updatedAt: now, updatedByUserRef: actor!.userRef };
    // List projection: refreshed in this same transaction; head.docVersion is deliberately NOT bumped.
    const displayed = await txResolveDisplayVersions(tx, head, [next]);
    const nextHead = withHeadDisplay(head, { counterpartyName: authorized.displayName, ...displayed, projectedAt: now, touchedBy: { actorUserRef: actor!.userRef } });
    txSetAgreementVersion(tx, next);
    txSetAgreementHead(tx, nextHead);
    appendAgreementEvent(tx, { agreementRef: input.agreementRef, kind: "field_decided", version: version.version, actorUserRef: actor!.userRef, metadata: { fieldKey: input.fieldKey, decision: input.decision, ...(input.note ? { note: input.note } : {}) }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead, version: next };
  });

  if (result.kind === "invalid") return financeAgreementsInvalidInputResult(result.message);
  if (result.kind !== "ok") return editFailureResult(result);
  return { ok: true, data: await buildAgreementDetailDto(actor!, result.head, authorized.displayName, result.version) };
}

export type AttachExtractionOutcome = { agreement: AgreementDetailDto; attachedCount: number; keptDecisionCount: number; skippedCount: number };

type AttachTxResult = { kind: "ok"; head: AgreementHeadDoc; version: AgreementVersionDoc; attachedCount: number; keptDecisionCount: number; skippedCount: number } | EditFailure;

// SEAM for the extraction agent. The run document (financeAgreements/{ref}/extractionRuns/{runRef})
// must already exist - this service never parses a contract itself. It copies the run's NON-restricted
// proposals into the OPEN, unconfirmed version's draft as origin EXTRACTED / decision PENDING, with
// confidence/page as provenance. Nothing extracted is operational: this never confirms, activates,
// resolves a discrepancy, or touches a Partner, Vendor or KYC record, never overwrites a field a human
// already decided, and never copies a restricted value (identity proposals become value-less
// acknowledgement entries). The draft-level source (artifact, run, parser version) is recorded.
// A run or artifact that is missing, belongs to another Agreement, or names a different counterparty
// is the neutral not_found.
export async function attachExtractionProposals(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceAgreementsServiceResult<AttachExtractionOutcome>> {
  const command = await authorizeAgreementCommand(actor, "manage_agreements", attachExtractionInputSchema, rawInput);
  if (!command.ok) return command.error;
  const { input, authorized } = command;

  const result = await getAdminFirestore().runTransaction<AttachTxResult>(async (tx) => {
    const head = await txGetAgreementHead(tx, input.agreementRef);
    const version = await txGetAgreementVersion(tx, input.agreementRef, input.version);
    const runSnap = await tx.get(financeAgreementExtractionRunsCollection(input.agreementRef).doc(input.extractionRunRef));
    const run = runSnap.exists ? extractionRunDocSchema.safeParse(runSnap.data()) : null;
    const artifactSnap = run?.success ? await tx.get(financeContractArtifactsCollection().doc(run.data.artifactRef)) : null;
    const artifact = artifactSnap?.exists ? contractArtifactDocSchema.safeParse(artifactSnap.data()) : null;

    const failure = checkEditable(head, version, input.expectedDocVersion);
    if (failure) return failure;
    if (!head || !version || !run?.success || !artifact?.success) return { kind: "not_found" };
    const counterpartyRef = head.counterparty.type === "PARTNER" ? head.counterparty.partnerRef : head.counterparty.vendorRef;
    if (run.data.agreementRef !== head.agreementRef || artifact.data.counterparty.type !== head.counterparty.type || artifact.data.counterparty.ref !== counterpartyRef) return { kind: "not_found" };

    const attached = attachProposalsToDraft(version.draft, run.data, version.counterparty.type);
    const now = new Date().toISOString();
    const hasManual = Object.values(attached.draft).some((entry) => entry?.origin === "MANUAL");
    const next: AgreementVersionDoc = {
      ...version,
      draft: attached.draft,
      source: { contractArtifactRef: run.data.artifactRef, extractionRunRef: run.data.runRef, parserVersion: run.data.parserVersion },
      // Advisory intention only; the effective sourceMode is recomputed from field origins at confirm.
      sourceMode: attached.attachedCount > 0 ? (hasManual ? "MIXED" : "EXTRACTED") : version.sourceMode,
      docVersion: version.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    const displayed = await txResolveDisplayVersions(tx, head, [next]);
    const nextHead = withHeadDisplay(head, { counterpartyName: authorized.displayName, ...displayed, extractionStatus: run.data.status, projectedAt: now, touchedBy: { actorUserRef: actor!.userRef } });
    txSetAgreementVersion(tx, next);
    txSetAgreementHead(tx, nextHead);
    appendAgreementEvent(tx, {
      agreementRef: input.agreementRef,
      kind: "extraction_attached",
      version: version.version,
      actorUserRef: actor!.userRef,
      metadata: { runRef: run.data.runRef, artifactRef: run.data.artifactRef, parserVersion: run.data.parserVersion, proposalCount: run.data.proposals.length, attachedCount: attached.attachedCount },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead, version: next, attachedCount: attached.attachedCount, keptDecisionCount: attached.keptDecisionCount, skippedCount: attached.skippedCount };
  });

  if (result.kind !== "ok") return editFailureResult(result);
  return {
    ok: true,
    data: { agreement: await buildAgreementDetailDto(actor!, result.head, authorized.displayName, result.version), attachedCount: result.attachedCount, keptDecisionCount: result.keptDecisionCount, skippedCount: result.skippedCount },
  };
}

type ConfirmTxResult = { kind: "ok"; head: AgreementHeadDoc; version: AgreementVersionDoc } | { kind: "not_ready"; blockers: FinanceAgreementsReadinessIssue[] } | EditFailure;

// Freezes the OPEN version. assembleConfirmedAgreement runs INSIDE the transaction on the freshly
// read draft: every entry (extracted, master-data prefilled or manual) must be decided, every
// payment-affecting / dating field must be decided deliberately, and the assembled terms must parse
// against the strict ConfirmedAgreementTerms schema - otherwise not_ready with per-field blockers and
// NO write. On success the version keeps status DRAFT (activatable, not yet operational) and gains
// terms / contactSnapshot / fieldProvenance / effective / confirmation together; the working draft is
// cleared; sourceMode is computed from field origins. identityStatusSnapshot is STATUS ONLY, derived
// from the canonical restricted store (identity-status.ts) - never a value.
export async function confirmAgreementVersion(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceAgreementsServiceResult<AgreementDetailDto>> {
  const command = await authorizeAgreementCommand(actor, "manage_agreements", confirmAgreementVersionInputSchema, rawInput);
  if (!command.ok) return command.error;
  const { input, authorized } = command;

  const subjectUid = authorized.head.counterparty.type === "PARTNER" ? authorized.head.partnerUid : authorized.head.vendorUid;
  const identity = await computeIdentityStatus(authorized.head.counterparty.type, subjectUid ?? "");

  const result = await getAdminFirestore().runTransaction<ConfirmTxResult>(async (tx) => {
    const head = await txGetAgreementHead(tx, input.agreementRef);
    const version = await txGetAgreementVersion(tx, input.agreementRef, input.version);
    const failure = checkEditable(head, version, input.expectedDocVersion);
    if (failure) return failure;
    if (!head || !version) return { kind: "not_found" };

    const now = new Date().toISOString();
    const assembled = assembleConfirmedAgreement({ draft: version.draft, counterpartyType: version.counterparty.type, actorUserRef: actor!.userRef, confirmedAt: now });
    if (!assembled.ok) return { kind: "not_ready", blockers: assembled.blockers };

    const next: AgreementVersionDoc = {
      ...version,
      sourceMode: assembled.sourceMode,
      draft: {},
      terms: assembled.terms,
      contactSnapshot: assembled.contactSnapshot,
      identityStatusSnapshot: identity,
      fieldProvenance: assembled.fieldProvenance,
      effective: assembled.effective,
      confirmation: { confirmedByUserRef: actor!.userRef, confirmedAt: now },
      docVersion: version.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    const displayed = await txResolveDisplayVersions(tx, head, [next]);
    const nextHead = withHeadDisplay(head, { counterpartyName: authorized.displayName, ...displayed, projectedAt: now, touchedBy: { actorUserRef: actor!.userRef } });
    txSetAgreementVersion(tx, next);
    txSetAgreementHead(tx, nextHead);
    appendAgreementEvent(tx, {
      agreementRef: input.agreementRef,
      kind: "confirmed",
      version: version.version,
      actorUserRef: actor!.userRef,
      metadata: {
        sourceMode: assembled.sourceMode,
        agreementType: assembled.terms.agreementType,
        effectiveFrom: assembled.effective.effectiveFrom,
        ...(assembled.effective.effectiveTo ? { effectiveTo: assembled.effective.effectiveTo } : {}),
        fieldCount: Object.keys(assembled.fieldProvenance).length,
      },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead, version: next };
  });

  if (result.kind === "not_ready") return financeAgreementsNotReadyResult("This agreement version is not ready to confirm.", result.blockers);
  if (result.kind !== "ok") return editFailureResult(result);
  return { ok: true, data: await buildAgreementDetailDto(actor!, result.head, authorized.displayName, result.version) };
}
