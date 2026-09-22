import type { z } from "zod";

import { FINANCE_AGREEMENT_LIFECYCLE_TRANSITIONS, canTransitionLifecycle } from "@/server/authz/lifecycle";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import { draftFromConfirmedVersion } from "./agreement-draft";
import { describeDocumentNotStored } from "./agreement-document-service";
import { appendAgreementEvent } from "./agreement-events";
import { txResolveDisplayVersions, withHeadDisplay } from "./agreement-head-display";
import type { AgreementDetailDto } from "./client-dto";
import { txCreateAgreementVersion, txGetAgreementHead, txGetAgreementVersion, txSetAgreementHead, txSetAgreementVersion } from "./firestore";
import { authorizeAgreementCommand, buildAgreementDetailDto, newDraftVersionDoc, scopeFieldsOf } from "./service-common";
import {
  activateAgreementVersionInputSchema,
  agreementPartyPrimaryAmbiguity,
  createAgreementRevisionInputSchema,
  endAgreementInputSchema,
  financeAgreementsConflictResult,
  financeAgreementsNotFoundResult,
  financeAgreementsNotReadyResult,
  financeAgreementsStaleResult,
  MAX_AGREEMENT_VERSIONS,
  resumeAgreementInputSchema,
  suspendAgreementInputSchema,
  type AgreementHeadDoc,
  type AgreementVersionDoc,
  type FinanceAgreementsErrorResult,
  type FinanceAgreementsServiceResult,
} from "./types";

// Step 14A: the Agreement LIFECYCLE - activate, create a revision, suspend, resume, end. All five
// need the `activate_agreements` action (Head / Super Admin by explicit grant; a Manager prepares and
// confirms but never makes an Agreement operational). Each is ONE Firestore transaction that reads the
// head (and the version documents it needs) first and writes afterwards, verifies the caller's
// optimistic expectedDocVersion - which for these commands is the HEAD's docVersion - and appends its
// audit event(s) in the same transaction.
//
// Invariants:
//   - at most ONE ACTIVE/SUSPENDED version per logical Agreement, ever: activation supersedes the
//     prior governing version in the SAME transaction, and two racing activations cannot both commit
//     (both read the head; the loser observes the bumped docVersion / open-version pointer);
//   - a confirmed version's terms, contactSnapshot, identityStatusSnapshot, fieldProvenance, source and
//     effective dates are NEVER written here - only lifecycle fields change;
//   - history is preserved: nothing is deleted, ended and superseded versions stay readable.

type Failure = { kind: "not_found" } | { kind: "stale" } | { kind: "conflict"; message: string } | { kind: "not_ready"; message: string };

function failureResult(failure: Failure): FinanceAgreementsErrorResult {
  if (failure.kind === "not_found") return financeAgreementsNotFoundResult();
  if (failure.kind === "stale") return financeAgreementsStaleResult();
  if (failure.kind === "not_ready") return financeAgreementsNotReadyResult(failure.message, [{ code: AGREEMENT_DOCUMENT_NOT_STORED, message: failure.message }]);
  return financeAgreementsConflictResult(failure.message);
}

const conflict = (message: string): Failure => ({ kind: "conflict", message });

// Step 14B.1 activation readiness: the reason code the client can key on.
export const AGREEMENT_DOCUMENT_NOT_STORED = "agreement_document_not_stored";
const transitions = FINANCE_AGREEMENT_LIFECYCLE_TRANSITIONS;

type OkResult = { kind: "ok"; head: AgreementHeadDoc; version: AgreementVersionDoc };

// --- Activate ---------------------------------------------------------------------------------------------------------------------
// Makes a CONFIRMED draft version operational. Requires the version to be the head's open version, to
// carry its confirmation and effective dates, and the caller's expectedDocVersion to match the head. A version with its OWN source
// contract artifact must also have its original signed document STORED in Drive first (not_ready / agreement_document_not_stored; a
// manual-only version or a revision without a new signed file is never blocked). In ONE transaction: the version becomes ACTIVE, the previously ACTIVE/SUSPENDED version (if any) becomes
// SUPERSEDED with supersededByVersion, and the head points at the new governing version.
export async function activateAgreementVersion(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceAgreementsServiceResult<AgreementDetailDto>> {
  const command = await authorizeAgreementCommand(actor, "activate_agreements", activateAgreementVersionInputSchema, rawInput);
  if (!command.ok) return command.error;
  const { input, authorized } = command;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    // ALL reads first.
    const head = await txGetAgreementHead(tx, input.agreementRef);
    const target = await txGetAgreementVersion(tx, input.agreementRef, input.version);
    if (!head || !target) return { kind: "not_found" };
    const priorNumber = head.activeVersion;
    const prior = priorNumber !== null && priorNumber !== target.version ? await txGetAgreementVersion(tx, input.agreementRef, priorNumber) : null;

    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (target.confirmation === null || target.terms === null || target.effective === null || !target.effective.effectiveFrom) return conflict("Only a confirmed version with an effective date can be activated. Confirm it first.");
    if (head.openVersion !== target.version || target.status !== "DRAFT" || !canTransitionLifecycle(target.status, "ACTIVE", transitions)) return conflict(`Version ${target.version} is not the open confirmed version and cannot be activated.`);
    // FINAL_EXECUTION #10: more than one party could be the primary Finance counterparty/payee - never guessed, activation is
    // blocked until a human resolves the ambiguity (marks exactly one PAYEE, or removes/re-roles the extra PRIMARY_COUNTERPARTY).
    if (agreementPartyPrimaryAmbiguity(target.parties).ambiguous) return conflict("More than one Agreement party could be the primary counterparty or payee. Choose exactly one before activating.");
    // Step 14B.1: a version that has its OWN signed Agreement file needs that original stored in Drive first. A manual-only
    // version, and a revision without a new signed file, have no document of their own and are not blocked.
    if (target.source.contractArtifactRef !== null && target.document?.status !== "STORED") return { kind: "not_ready", message: describeDocumentNotStored(target.document) };
    if (priorNumber !== null && (!prior || !canTransitionLifecycle(prior.status, "SUPERSEDED", transitions))) return conflict("The governing version of this agreement is not in a state that can be superseded.");

    const now = new Date().toISOString();
    const activated: AgreementVersionDoc = {
      ...target,
      status: "ACTIVE",
      activation: { activatedByUserRef: actor!.userRef, activatedAt: now, supersededVersion: prior?.version ?? null },
      docVersion: target.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    const superseded: AgreementVersionDoc | null = prior
      ? { ...prior, status: "SUPERSEDED", supersededByVersion: target.version, supersededAt: now, docVersion: prior.docVersion + 1, updatedAt: now, updatedByUserRef: actor!.userRef }
      : null;
    const steppedHead: AgreementHeadDoc = {
      ...head,
      ...scopeFieldsOf(authorized.liveScope),
      status: "ACTIVE",
      activeVersion: target.version,
      openVersion: null,
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    // List projection (same transaction; describes the POST-activation state). Reads precede the first write.
    const nextHead = withHeadDisplay(steppedHead, { counterpartyName: authorized.displayName, ...(await txResolveDisplayVersions(tx, steppedHead, [activated])), projectedAt: now });

    txSetAgreementVersion(tx, activated);
    if (superseded) txSetAgreementVersion(tx, superseded);
    txSetAgreementHead(tx, nextHead);
    appendAgreementEvent(tx, {
      agreementRef: input.agreementRef,
      kind: "activated",
      version: target.version,
      actorUserRef: actor!.userRef,
      metadata: {
        fromStatus: "DRAFT",
        toStatus: "ACTIVE",
        headStatus: "ACTIVE",
        agreementType: target.terms.agreementType,
        effectiveFrom: target.effective.effectiveFrom,
        ...(target.effective.effectiveTo ? { effectiveTo: target.effective.effectiveTo } : {}),
        ...(prior ? { supersededVersion: prior.version } : {}),
      },
      requestId,
      createdAt: now,
    });
    if (superseded) {
      appendAgreementEvent(tx, {
        agreementRef: input.agreementRef,
        kind: "superseded",
        version: superseded.version,
        actorUserRef: actor!.userRef,
        metadata: { fromStatus: prior!.status, toStatus: "SUPERSEDED", supersededByVersion: target.version },
        requestId,
        createdAt: now,
      });
    }
    return { kind: "ok", head: nextHead, version: activated };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildAgreementDetailDto(actor!, result.head, authorized.displayName, result.version) };
}

// --- Revise ------------------------------------------------------------------------------------------------------------------------
// Opens the NEXT version (latest + 1, DRAFT) of an Agreement that has no open version, prefilled from
// the previous confirmed version's FROZEN terms (origin MANUAL, provenance "previous version n"; see
// draftFromConfirmedVersion) with the SAME counterparty snapshot - the counterparty's current master
// data (a Partner's later Vendor link change, an edited name) is never re-read. The governing version
// stays ACTIVE (or SUSPENDED) until the replacement is activated. tx.create on version n guarantees at
// most one version n.
export async function createAgreementRevision(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceAgreementsServiceResult<AgreementDetailDto>> {
  const command = await authorizeAgreementCommand(actor, "activate_agreements", createAgreementRevisionInputSchema, rawInput);
  if (!command.ok) return command.error;
  const { input, authorized } = command;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetAgreementHead(tx, input.agreementRef);
    if (!head) return { kind: "not_found" };
    const baseNumber = head.activeVersion ?? head.lastEndedVersion ?? head.latestVersion;
    const base = await txGetAgreementVersion(tx, input.agreementRef, baseNumber);

    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (head.openVersion !== null) return conflict(`Version ${head.openVersion} is still open. Finish or activate it before creating a revision.`);
    if (head.latestVersion >= MAX_AGREEMENT_VERSIONS) return conflict("This agreement has reached its maximum number of versions.");
    if (!base || base.terms === null || base.confirmation === null) return conflict("A revision can only be created from a confirmed version.");

    const now = new Date().toISOString();
    const nextNumber = head.latestVersion + 1;
    const draftVersion = newDraftVersionDoc({ agreementRef: input.agreementRef, version: nextNumber, counterparty: base.counterparty, sourceMode: "MANUAL", draft: draftFromConfirmedVersion(base), now, actorUserRef: actor!.userRef });
    const steppedHead: AgreementHeadDoc = {
      ...head,
      ...scopeFieldsOf(authorized.liveScope),
      latestVersion: nextNumber,
      openVersion: nextNumber,
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    // A fresh revision has no extraction of its own yet.
    const nextHead = withHeadDisplay(steppedHead, { counterpartyName: authorized.displayName, ...(await txResolveDisplayVersions(tx, steppedHead, [draftVersion, ...(base ? [base] : [])])), extractionStatus: null, projectedAt: now });

    txCreateAgreementVersion(tx, draftVersion);
    txSetAgreementHead(tx, nextHead);
    appendAgreementEvent(tx, {
      agreementRef: input.agreementRef,
      kind: "revision_created",
      version: nextNumber,
      actorUserRef: actor!.userRef,
      metadata: { previousVersion: base.version, newVersion: nextNumber, fieldCount: Object.keys(draftVersion.draft).length },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead, version: draftVersion };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildAgreementDetailDto(actor!, result.head, authorized.displayName, result.version) };
}

// --- Suspend / resume / end (act on the GOVERNING version) ------------------------------------------------------------------
type GoverningSpec<T> = {
  to: "SUSPENDED" | "ACTIVE" | "ENDED";
  eventKind: "suspended" | "resumed" | "ended";
  verb: string;
  reason: (input: T) => string | null;
  applyVersion: (version: AgreementVersionDoc, input: T, now: string, actorUserRef: string) => AgreementVersionDoc;
  applyHead: (head: AgreementHeadDoc, version: AgreementVersionDoc) => Pick<AgreementHeadDoc, "status" | "activeVersion" | "lastEndedVersion">;
};

async function transitionGoverningVersion<T extends { agreementRef: string; expectedDocVersion: number }>(
  actor: ActorContext | null,
  schema: z.ZodType<T, unknown>,
  rawInput: unknown,
  requestId: string,
  spec: GoverningSpec<T>,
): Promise<FinanceAgreementsServiceResult<AgreementDetailDto>> {
  const command = await authorizeAgreementCommand(actor, "activate_agreements", schema, rawInput);
  if (!command.ok) return command.error;
  const { input, authorized } = command;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetAgreementHead(tx, input.agreementRef);
    if (!head) return { kind: "not_found" };
    const governing = head.activeVersion !== null ? await txGetAgreementVersion(tx, input.agreementRef, head.activeVersion) : null;

    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!governing) return conflict(`This agreement has no active or suspended version to ${spec.verb}.`);
    if (!canTransitionLifecycle(governing.status, spec.to, transitions)) return conflict(`Cannot ${spec.verb}: the governing version ${governing.version} is ${governing.status}.`);

    const now = new Date().toISOString();
    const nextVersion = spec.applyVersion(governing, input, now, actor!.userRef);
    const steppedHead: AgreementHeadDoc = {
      ...head,
      ...scopeFieldsOf(authorized.liveScope),
      ...spec.applyHead(head, nextVersion),
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    // List projection (same transaction; describes the POST-transition state). Reads precede the first write.
    const nextHead = withHeadDisplay(steppedHead, { counterpartyName: authorized.displayName, ...(await txResolveDisplayVersions(tx, steppedHead, [nextVersion])), projectedAt: now });
    txSetAgreementVersion(tx, { ...nextVersion, docVersion: governing.docVersion + 1, updatedAt: now, updatedByUserRef: actor!.userRef });
    txSetAgreementHead(tx, nextHead);
    const reason = spec.reason(input);
    appendAgreementEvent(tx, {
      agreementRef: input.agreementRef,
      kind: spec.eventKind,
      version: governing.version,
      actorUserRef: actor!.userRef,
      metadata: { fromStatus: governing.status, toStatus: spec.to, headStatus: nextHead.status, ...(reason ? { reason } : {}) },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead, version: { ...nextVersion, docVersion: governing.docVersion + 1, updatedAt: now, updatedByUserRef: actor!.userRef } };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildAgreementDetailDto(actor!, result.head, authorized.displayName, result.version) };
}

// ACTIVE -> SUSPENDED. A reason is required. The version stays the governing one; history (who/when/why)
// is on the version and in the audit event.
export function suspendAgreement(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceAgreementsServiceResult<AgreementDetailDto>> {
  return transitionGoverningVersion(actor, suspendAgreementInputSchema, rawInput, requestId, {
    to: "SUSPENDED",
    eventKind: "suspended",
    verb: "suspend",
    reason: (input) => input.reason,
    applyVersion: (version, input, now, actorUserRef) => ({ ...version, status: "SUSPENDED", suspendedAt: now, suspendedByUserRef: actorUserRef, suspendReason: input.reason }),
    applyHead: (head) => ({ status: "SUSPENDED", activeVersion: head.activeVersion, lastEndedVersion: head.lastEndedVersion }),
  });
}

// SUSPENDED -> ACTIVE. The suspension fields are cleared on the version; the suspension itself stays in
// the append-only event history.
export function resumeAgreement(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceAgreementsServiceResult<AgreementDetailDto>> {
  return transitionGoverningVersion(actor, resumeAgreementInputSchema, rawInput, requestId, {
    to: "ACTIVE",
    eventKind: "resumed",
    verb: "resume",
    reason: () => null,
    applyVersion: (version) => ({ ...version, status: "ACTIVE", suspendedAt: null, suspendedByUserRef: null, suspendReason: null }),
    applyHead: (head) => ({ status: "ACTIVE", activeVersion: head.activeVersion, lastEndedVersion: head.lastEndedVersion }),
  });
}

// ACTIVE | SUSPENDED -> ENDED (terminal for that version). A reason is required. The head records the
// ended version and no longer names a governing version; the version and its history stay readable.
export function endAgreement(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceAgreementsServiceResult<AgreementDetailDto>> {
  return transitionGoverningVersion(actor, endAgreementInputSchema, rawInput, requestId, {
    to: "ENDED",
    eventKind: "ended",
    verb: "end",
    reason: (input) => input.reason,
    applyVersion: (version, input, now, actorUserRef) => ({ ...version, status: "ENDED", endedAt: now, endedByUserRef: actorUserRef, endReason: input.reason }),
    applyHead: (_head, version) => ({ status: "ENDED", activeVersion: null, lastEndedVersion: version.version }),
  });
}
