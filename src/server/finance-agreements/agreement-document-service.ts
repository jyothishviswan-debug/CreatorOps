import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import { loadCounterpartyHeadDocs } from "./agreement-service";
import { appendAgreementEvent } from "./agreement-events";
import { toAgreementDocumentDto, type AgreementDetailDto, type AgreementDocumentDto, type CounterpartyAgreementDocumentDto, type CounterpartyAgreementDocumentsDto } from "./client-dto";
import { ContractArtifactStoreError, getContractArtifactStore } from "./contract-artifacts/store";
import { sha256Hex } from "./contract-artifacts/validation";
import {
  agreementDocumentIdempotencyKey,
  AGREEMENT_DOCUMENT_FAILURE_MESSAGES,
  AGREEMENT_DOCUMENT_MIME_TYPE,
  getAgreementDocumentStorage,
  type AgreementDocumentFailureCode,
  type AgreementDocumentStoreResult,
} from "./document-storage";
import { getAgreementVersionDoc, getContractArtifactDoc, listAgreementVersionDocs, txGetAgreementVersion, txSetAgreementVersion } from "./firestore";
import { loadAuthorizedAgreement, loadAuthorizedCounterparty, requireContractSensitiveAccess, requireFinanceAgreementsAccess } from "./finance-agreements-gate";
import { authorizeAgreementCommand, buildAgreementDetailDto, defaultVersionNumber, formatIssues } from "./service-common";
import {
  agreementRefSchema,
  counterpartyTypeSchema,
  financeAgreementsConflictResult,
  financeAgreementsInternalResult,
  financeAgreementsInvalidInputResult,
  financeAgreementsNotFoundResult,
  financeAgreementsStaleResult,
  financeAgreementsUnauthorizedResult,
  storeAgreementDocumentInputSchema,
  type AgreementDocument,
  type ContractArtifactDoc,
  type AgreementHeadDoc,
  type AgreementVersionDoc,
  type CounterpartyType,
  type FinanceAgreementsServiceResult,
} from "./types";

// Step 14B.1: the ORIGINAL signed Agreement document.
//
// DURABLE POINT: AFTER CONFIRMATION. During extraction and review the exact uploaded PDF lives only in the
// restricted ContractArtifactStore. Once a version is CONFIRMED, storeAgreementDocument copies THAT file - the
// exact bytes read back from the artifact store and verified against the recorded sha256, never a generated
// replacement - to the configured Drive folder through the AgreementDocumentStorage seam, then records the Drive
// reference on the version (`document`). One physical file per Agreement VERSION; the Finance detail and the
// Partner / Vendor contextual list are two controlled references to it.
//
// Guarantees:
//   - IDEMPOTENT: STORED => the stored reference is returned and the adapter is not called again. A FAILED /
//     not-yet-attempted version can be retried; the adapter itself is idempotent by sha256(agreementRef|version|
//     artifactSha256), so a crash between "Drive stored it" and "the reference was recorded" resolves to the SAME file.
//   - NON-DESTRUCTIVE: a failure never touches the source artifact and never claims the document is stored; it records
//     a FAILED attempt (safe code only) and returns a retriable outcome. STORED never regresses.
//   - NEVER fabricates a link: without a configured adapter the outcome is NOT_CONFIGURED and no link exists.
//   - The Drive link is shown only to actors holding finance_contracts (see client-dto.ts); events carry the file NAME
//     and a status / failure code - never the link or the Drive file id.
//   - `document` is the ONE controlled post-confirm write to a confirmed version: terms / contact / identity status /
//     provenance / source / dates are untouched. It is written in its own transaction (version docVersion + 1); the
//     head is not touched (an in-flight activate / revise keeps its expectedDocVersion).

export type StoreAgreementDocumentOutcome = {
  outcome: "stored" | "already_stored" | "failed";
  // A failed outcome can be retried (it always can, once the cause is fixed).
  retriable: boolean;
  document: AgreementDocumentDto;
  agreement: AgreementDetailDto;
};

export type AgreementDocumentStatusResultDto = {
  agreementRef: string;
  version: number;
  document: AgreementDocumentDto;
  // Whether a Drive storage backend is configured in this deployment (no detail about it).
  storageConfigured: boolean;
};

type AttemptFailure = { ok: false; code: AgreementDocumentFailureCode };
type Attempt = AttemptFailure | Extract<AgreementDocumentStoreResult, { ok: true }>;

type PersistResult =
  | { kind: "written" | "already_stored"; version: AgreementVersionDoc }
  | { kind: "not_found" }
  | { kind: "not_eligible" };

function counterpartyRefOf(head: AgreementHeadDoc): string {
  return head.counterparty.type === "PARTNER" ? head.counterparty.partnerRef : head.counterparty.vendorRef;
}

// Reads the exact original bytes back from the artifact store, verifies them against the recorded digest and size, and hands
// them - untouched - to the storage adapter.
async function attemptStore(head: AgreementHeadDoc, version: AgreementVersionDoc, artifact: ContractArtifactDoc): Promise<Attempt> {
  const resolution = getAgreementDocumentStorage();
  if (resolution.state === "NOT_CONFIGURED") return { ok: false, code: "not_configured" };

  let bytes: Uint8Array;
  try {
    bytes = await getContractArtifactStore().get(artifact.storageLocator);
  } catch (error) {
    console.error("[finance-agreements] agreement document: artifact read failed", error instanceof ContractArtifactStoreError ? `store:${error.code}` : error instanceof Error ? error.name : "unknown");
    return { ok: false, code: "artifact_unavailable" };
  }
  if (bytes.byteLength !== artifact.sizeBytes || sha256Hex(bytes) !== artifact.sha256) return { ok: false, code: "artifact_mismatch" };

  try {
    return await resolution.storage.store({
      idempotencyKey: agreementDocumentIdempotencyKey(head.agreementRef, version.version, artifact.sha256),
      bytes,
      mimeType: AGREEMENT_DOCUMENT_MIME_TYPE,
      fileName: artifact.fileName,
      target: head.counterparty.type,
      metadata: { agreementRef: head.agreementRef, version: version.version, counterpartyType: head.counterparty.type, counterpartyRef: counterpartyRefOf(head), artifactSha256: artifact.sha256 },
    });
  } catch (error) {
    console.error("[finance-agreements] agreement document: storage adapter threw", error instanceof Error ? error.name : "unknown");
    return { ok: false, code: "unknown" };
  }
}

// Records the attempt on the version + its audit event, atomically. STORED is terminal: if a concurrent attempt already stored
// the document the existing record wins and nothing is overwritten (a FAILED write can never regress a STORED document).
async function persistAttempt(actor: ActorContext, head: AgreementHeadDoc, versionNumber: number, artifact: ContractArtifactDoc, attempt: Attempt, requestId: string): Promise<PersistResult> {
  const { artifactRef, sha256: artifactSha256, fileName } = artifact;
  return getAdminFirestore().runTransaction<PersistResult>(async (tx) => {
    const current = await txGetAgreementVersion(tx, head.agreementRef, versionNumber);
    if (!current) return { kind: "not_found" };
    if (current.document?.status === "STORED") return { kind: "already_stored", version: current };
    if (current.confirmation === null || current.source.contractArtifactRef !== artifactRef) return { kind: "not_eligible" };

    const now = new Date().toISOString();
    const attemptCount = (current.document?.attemptCount ?? 0) + 1;
    const document: AgreementDocument = attempt.ok
      ? { status: "STORED", driveFileId: attempt.data.fileId, driveLink: attempt.data.webViewLink, fileName, storedAt: now, storedByUserRef: actor.userRef, artifactRef, artifactSha256, attemptCount, lastFailureCode: null, lastAttemptAt: now }
      : { status: "FAILED", driveFileId: null, driveLink: null, fileName, storedAt: null, storedByUserRef: null, artifactRef, artifactSha256, attemptCount, lastFailureCode: attempt.code, lastAttemptAt: now };
    const next: AgreementVersionDoc = { ...current, document, docVersion: current.docVersion + 1, updatedAt: now, updatedByUserRef: actor.userRef };

    txSetAgreementVersion(tx, next);
    appendAgreementEvent(tx, {
      agreementRef: head.agreementRef,
      kind: attempt.ok ? "document_stored" : "document_store_failed",
      version: versionNumber,
      actorUserRef: actor.userRef,
      metadata: { version: versionNumber, documentStatus: document.status, fileName, artifactRef, attemptCount, ...(attempt.ok ? {} : { failureCode: attempt.code }) },
      requestId,
      createdAt: now,
    });
    return { kind: "written", version: next };
  });
}

// --- Store / retry ---------------------------------------------------------------------------------------------------------------
// POST /api/finance/agreements/[agreementRef]/document. Needs manage_agreements (the actor who confirms stores; holding
// finance_contracts is NOT required to store - only to be shown the link) and the live Record Scope of the counterparty. The
// version must be CONFIRMED and have its own source contract artifact. Returns ok:true with outcome "stored" |
// "already_stored" | "failed"; a Drive failure is a `failed` outcome (retriable), not an error response.
export async function storeAgreementDocument(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceAgreementsServiceResult<StoreAgreementDocumentOutcome>> {
  const command = await authorizeAgreementCommand(actor, "manage_agreements", storeAgreementDocumentInputSchema, rawInput);
  if (!command.ok) return command.error;
  const { input, authorized } = command;
  const { head } = authorized;

  const version = await getAgreementVersionDoc(head.agreementRef, input.version);
  if (!version) return financeAgreementsNotFoundResult();

  const respond = async (outcome: StoreAgreementDocumentOutcome["outcome"], doc: AgreementVersionDoc): Promise<FinanceAgreementsServiceResult<StoreAgreementDocumentOutcome>> => {
    const agreement = await buildAgreementDetailDto(actor!, head, authorized.displayName, doc);
    return { ok: true, data: { outcome, retriable: outcome === "failed", document: agreement.selectedVersion!.document, agreement } };
  };

  // Idempotent: a stored document is returned as it is (no adapter call, no write).
  if (version.document?.status === "STORED") return respond("already_stored", version);

  if (version.confirmation === null) return financeAgreementsConflictResult("Confirm this version before storing its Agreement document.");
  const artifactRef = version.source.contractArtifactRef;
  if (artifactRef === null) return financeAgreementsConflictResult("This version has no signed Agreement file of its own, so there is no document to store.");
  if (input.expectedDocVersion !== undefined && input.expectedDocVersion !== version.docVersion) return financeAgreementsStaleResult("This version changed elsewhere. Reload and try again.");

  try {
    // The artifact's own metadata must exist and belong to this Agreement's counterparty (attach already guaranteed both).
    const artifact = await getContractArtifactDoc(artifactRef);
    if (!artifact || artifact.counterparty.type !== head.counterparty.type || artifact.counterparty.ref !== counterpartyRefOf(head)) return financeAgreementsConflictResult("The signed Agreement file for this version is unavailable.");
    const attempt = await attemptStore(head, version, artifact);
    const persisted = await persistAttempt(actor!, head, version.version, artifact, attempt, requestId);
    if (persisted.kind === "not_found") return financeAgreementsNotFoundResult();
    if (persisted.kind === "not_eligible") return financeAgreementsConflictResult("This version can no longer store an Agreement document.");
    if (persisted.kind === "already_stored") return respond("already_stored", persisted.version);
    return respond(attempt.ok ? "stored" : "failed", persisted.version);
  } catch (error) {
    console.error("[finance-agreements] agreement document: store failed", error instanceof Error ? error.name : "unknown");
    return financeAgreementsInternalResult("The Agreement document could not be recorded. Try again.");
  }
}

// --- Status (one version) --------------------------------------------------------------------------------------------------------
const documentStatusInputSchema = z.object({ agreementRef: agreementRefSchema, version: z.number().int().min(1).optional() }).strict();

// GET /api/finance/agreements/[agreementRef]/document?version= . Read gate = finance feature + live scope. The link is included
// only for an actor holding finance_contracts.
export async function getAgreementDocumentStatus(actor: ActorContext | null, rawInput: unknown): Promise<FinanceAgreementsServiceResult<AgreementDocumentStatusResultDto>> {
  const parsed = documentStatusInputSchema.safeParse(rawInput);
  const loaded = await loadAuthorizedAgreement(actor, parsed.success ? parsed.data.agreementRef : typeof (rawInput as { agreementRef?: unknown } | null)?.agreementRef === "string" ? (rawInput as { agreementRef: string }).agreementRef : "");
  if (!loaded.ok) return loaded.error;
  if (!parsed.success) return financeAgreementsInvalidInputResult(formatIssues(parsed.error));
  const { head } = loaded.authorized;

  const versionNumber = parsed.data.version ?? defaultVersionNumber(head);
  const version = await getAgreementVersionDoc(head.agreementRef, versionNumber);
  if (!version) return financeAgreementsNotFoundResult();
  const contractDetailVisible = (await requireContractSensitiveAccess(actor!)).ok;
  return { ok: true, data: { agreementRef: head.agreementRef, version: version.version, document: toAgreementDocumentDto(version, { contractDetailVisible }), storageConfigured: getAgreementDocumentStorage().state === "CONFIGURED" } };
}

// --- Contextual projection (Partner / Vendor pages) --------------------------------------------------------------------------------
const PROJECTION_VERSIONS_PER_AGREEMENT = 20;
export const MAX_COUNTERPARTY_DOCUMENT_ROWS = 100;
const projectionInputSchema = z.object({ counterpartyType: counterpartyTypeSchema, ref: z.string().min(1).max(200) }).strict();

// The signed Agreement documents of ONE Partner or Vendor - the same stored Drive reference the Finance detail shows (one
// physical file, several controlled references), never a second copy. Gate = finance feature (a profile permission alone never
// reaches here) + the counterparty's LIVE Record Scope (an out-of-scope, missing or forged counterparty is the neutral
// not_found). A row's `link` is present ONLY for an actor holding finance_contracts.
export async function listCounterpartyAgreementDocuments(actor: ActorContext | null, rawInput: unknown): Promise<FinanceAgreementsServiceResult<CounterpartyAgreementDocumentsDto>> {
  const access = await requireFinanceAgreementsAccess(actor);
  if (!access.ok) return financeAgreementsUnauthorizedResult(access.reason);
  const parsed = projectionInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeAgreementsInvalidInputResult(formatIssues(parsed.error));

  const type: CounterpartyType = parsed.data.counterpartyType;
  const loaded = await loadAuthorizedCounterparty(actor!, type === "PARTNER" ? { type: "PARTNER", partnerRef: parsed.data.ref } : { type: "VENDOR", vendorRef: parsed.data.ref });
  if (!loaded.ok) return loaded.error;
  const liveUid = loaded.authorized.type === "PARTNER" ? loaded.authorized.scope.partnerUid : loaded.authorized.scope.vendorUid;
  const contractDetailVisible = (await requireContractSensitiveAccess(actor!)).ok;

  const { heads, hasMore: moreAgreements } = await loadCounterpartyHeadDocs(type, parsed.data.ref, liveUid);

  const perHead = await Promise.all(heads.map(async (head) => ({ head, listed: await listAgreementVersionDocs(head.agreementRef, PROJECTION_VERSIONS_PER_AGREEMENT) })));
  const rows: CounterpartyAgreementDocumentDto[] = [];
  let hasMore = moreAgreements;
  for (const { head, listed } of perHead) {
    if (listed.hasMore) hasMore = true;
    for (const version of listed.versions) {
      // Untouched empty drafts are not documents; a confirmed version, or one with its own file / a store record, is.
      if (version.confirmation === null && version.source.contractArtifactRef === null && version.document === null) continue;
      rows.push({
        agreementRef: head.agreementRef,
        version: version.version,
        lifecycle: version.status,
        confirmed: version.confirmation !== null,
        headStatus: head.status,
        effectiveFrom: version.effective?.effectiveFrom ?? null,
        effectiveTo: version.effective?.effectiveTo ?? null,
        document: toAgreementDocumentDto(version, { contractDetailVisible }),
      });
    }
  }
  if (rows.length > MAX_COUNTERPARTY_DOCUMENT_ROWS) hasMore = true;
  return { ok: true, data: { counterpartyType: type, ref: parsed.data.ref, documents: rows.slice(0, MAX_COUNTERPARTY_DOCUMENT_ROWS), hasMore, linksVisible: contractDetailVisible } };
}

// Exposed for the activation gate's message (plain words; says so when Drive storage is not configured).
export function describeDocumentNotStored(document: AgreementDocument | null): string {
  if (document?.status === "FAILED") {
    const code = document.lastFailureCode ?? "unknown";
    if (code === "not_configured" || code === "live_drive_disabled_in_tests") return "The signed Agreement document is not stored: Drive storage is not configured. Configure Drive storage, then store the document before activating.";
    return `The signed Agreement document could not be stored yet (${AGREEMENT_DOCUMENT_FAILURE_MESSAGES[code]}). Retry storing it before activating.`;
  }
  if (getAgreementDocumentStorage().state === "NOT_CONFIGURED") return "The signed Agreement document is not stored, and Drive storage is not configured. Configure Drive storage, then store the document before activating.";
  return "Store the signed Agreement document before activating this version.";
}
