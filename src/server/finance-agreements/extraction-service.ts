import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import { txResolveDisplayVersions, withHeadDisplay } from "./agreement-head-display";
import { ContractArtifactStoreError, getContractArtifactStore } from "./contract-artifacts/store";
import { toExtractionResultDto, type ExtractionResultDto } from "./client-dto";
import { redactIdentityFromText } from "./extraction-redaction";
import { buildExtractionDocs, runExtractionPipeline } from "./extraction-run-builder";
import { PARSER_VERSION } from "./extraction/pdf-text";
import { AGREEMENT_FIELD_BY_KEY } from "./fields";
import {
  financeAgreementExtractionRunsCollection,
  financeContractArtifactsCollection,
  getContractArtifactDoc,
  getRestrictedExtractionDoc,
  txCreateExtractionRun,
  txCreateRestrictedExtraction,
  txGetAgreementHead,
  txGetAgreementVersion,
  txSetAgreementHead,
} from "./firestore";
import { loadAuthorizedAgreement, requireContractSensitiveAccess, requireFinanceAgreementsAccess, requireIdentitySensitiveAccess } from "./finance-agreements-gate";
import { generateExtractionRunRef } from "./ids";
import { authorizeAgreementCommand, formatIssues } from "./service-common";
import {
  agreementRefSchema,
  contractArtifactDocSchema,
  extractionRunDocSchema,
  extractionRunRefSchema,
  artifactRefSchema,
  financeAgreementsConflictResult,
  financeAgreementsInternalResult,
  financeAgreementsInvalidInputResult,
  financeAgreementsNotFoundResult,
  financeAgreementsUnauthorizedResult,
  type AgreementHeadDoc,
  type ContractArtifactDoc,
  type CounterpartyType,
  type ExtractionRunDoc,
  type FinanceAgreementsServiceResult,
  type RestrictedExtractionDoc,
} from "./types";

// Step 14A: contract EXTRACTION service.
//
// Running extraction is a PREPARATION step (manage_agreements + live scope). It parses one
// uploaded PDF (local, deterministic, no OCR, no cloud) and records the result as data:
//   - financeAgreements/{ref}/extractionRuns/{runRef}   ordinary proposals (no raw snippet, identity
//                                                       fields value-less), status, reason codes;
//   - financeAgreementRestrictedExtractions/{runRef}    raw snippets/locators + raw identity values;
//   - the artifact's status.
// It NEVER attaches a proposal to the draft (that is the separate, explicit attachExtractionProposals
// call), never confirms or activates, never writes a version (the head gets only its display projection,
// docVersion untouched), and never touches a
// Partner, Vendor or KYC record. Nothing extracted is operational, whatever the status.

// --- Input shapes ---------------------------------------------------------------------------------------------------------------
export const extractContractInputSchema = z.object({ agreementRef: agreementRefSchema, version: z.number().int().min(1).max(200), artifactRef: artifactRefSchema }).strict();
export type ExtractContractInput = z.infer<typeof extractContractInputSchema>;

export const getExtractionResultInputSchema = z.object({ agreementRef: agreementRefSchema, extractionRunRef: extractionRunRefSchema.optional() }).strict();
export type GetExtractionResultInput = z.infer<typeof getExtractionResultInputSchema>;

// --- Visibility + DTO ------------------------------------------------------------------------------------------------------------
type Visibility = { contractDetail: boolean; identityValues: boolean };

// Raw snippets/locators need finance_contracts; an identity VALUE needs finance_contracts AND the
// counterparty's own identity category (payment_details for a Partner, vendor_payment_details for a
// Vendor). Independent checks - either one alone shows nothing of the other.
async function resolveVisibility(actor: ActorContext, counterpartyType: CounterpartyType): Promise<Visibility> {
  const contract = await requireContractSensitiveAccess(actor);
  if (!contract.ok) return { contractDetail: false, identityValues: false };
  const identity = await requireIdentitySensitiveAccess(actor, counterpartyType);
  return { contractDetail: true, identityValues: identity.ok };
}

function buildResultDto(agreementRef: string, run: ExtractionRunDoc, restricted: RestrictedExtractionDoc | null, visibility: Visibility): ExtractionResultDto {
  const identityValues = new Map<string, string>();
  const allIdentityValues: string[] = [];
  const snippets: Array<{ fieldKey: ExtractionRunDoc["proposals"][number]["fieldKey"]; page: number | null; locator: string | null; rawSnippet: string | null }> = [];

  if (visibility.contractDetail && restricted) {
    for (const [fieldKey, entry] of Object.entries(restricted.fields)) {
      if (entry?.rawValue) allIdentityValues.push(entry.rawValue);
      if (entry?.rawValue && visibility.identityValues) identityValues.set(fieldKey, entry.rawValue);
    }
    for (const proposal of run.proposals) {
      const entry = restricted.fields[proposal.fieldKey];
      const isIdentity = AGREEMENT_FIELD_BY_KEY[proposal.fieldKey].identityValue;
      let rawSnippet: string | null = entry?.rawSnippet ?? null;
      if (rawSnippet !== null && !visibility.identityValues) {
        // The snippet of an identity field quotes its value: withheld outright. Every other
        // snippet is masked for identity values that sit next to (or inside) it.
        rawSnippet = isIdentity ? null : redactIdentityFromText(rawSnippet, allIdentityValues);
      }
      snippets.push({ fieldKey: proposal.fieldKey, page: proposal.source.page, locator: entry?.locator ?? null, rawSnippet });
    }
  }
  return toExtractionResultDto({ agreementRef, run, contractDetailVisible: visibility.contractDetail, identityValuesVisible: visibility.identityValues, identityValues, snippets });
}

// --- Run extraction -------------------------------------------------------------------------------------------------------------
type ExtractTxResult = { kind: "ok" } | { kind: "not_found" } | { kind: "locked"; version: number };

function counterpartyRefOf(head: AgreementHeadDoc): string {
  return head.counterparty.type === "PARTNER" ? head.counterparty.partnerRef : head.counterparty.vendorRef;
}

function artifactBelongsToHead(artifact: ContractArtifactDoc, head: AgreementHeadDoc): boolean {
  return artifact.counterparty.type === head.counterparty.type && artifact.counterparty.ref === counterpartyRefOf(head);
}

// Chain: Authentication -> Admission -> FeatureAccess(finance) -> ActionPermission(manage_agreements)
// -> input shape -> live RecordScope of the head's Partner / Vendor. The artifact must exist and belong
// to the SAME counterparty as the agreement (a missing, foreign or forged artifactRef is the neutral
// not_found). The named version must be the head's open, unconfirmed version (re-checked inside the
// transaction that writes the run).
//
// A PDF that is scanned, encrypted, oversized, malformed or unreadable never throws and never yields
// partial output: the run is recorded as MANUAL_REVIEW_REQUIRED with a machine reason code
// (no_extractable_text / unreadable_pdf / encrypted / too_many_pages / timeout) and no proposals.
// Returns the result shaped for THIS actor's visibility (a manager sees ordinary proposals only).
export async function extractContract(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceAgreementsServiceResult<ExtractionResultDto>> {
  // requestId is accepted for parity with the mutation services; a run is recorded by its own document (createdBy/createdAt), not by an Agreement event.
  void requestId;
  const command = await authorizeAgreementCommand(actor, "manage_agreements", extractContractInputSchema, rawInput);
  if (!command.ok) return command.error;
  const { input, authorized } = command;
  const head = authorized.head;

  const artifact = await getContractArtifactDoc(input.artifactRef);
  if (!artifact || !artifactBelongsToHead(artifact, head)) return financeAgreementsNotFoundResult();

  // Cheap pre-check so a locked version does not cost a parse; the transaction below is authoritative.
  if (head.openVersion !== input.version) return financeAgreementsConflictResult(`Version ${input.version} is not the open version and can no longer be changed.`);

  let bytes: Uint8Array;
  try {
    bytes = await getContractArtifactStore().get(artifact.storageLocator);
  } catch (error) {
    console.error("[finance-agreements] contract read failed", error instanceof ContractArtifactStoreError ? `store:${error.code}` : error instanceof Error ? error.name : "unknown");
    return financeAgreementsInternalResult("The contract file could not be read. Try again.");
  }

  const runRef = generateExtractionRunRef();
  const now = new Date().toISOString();
  let docs: ReturnType<typeof buildExtractionDocs>;
  try {
    const outcome = await runExtractionPipeline(bytes, artifact.sha256);
    docs = buildExtractionDocs({ agreementRef: head.agreementRef, artifactRef: artifact.artifactRef, runRef, actorUserRef: actor!.userRef, now, parserVersion: PARSER_VERSION, outcome });
  } catch {
    // The pipeline reports every PDF failure as an outcome; reaching here is an internal defect.
    return financeAgreementsInternalResult();
  }

  const result = await getAdminFirestore().runTransaction<ExtractTxResult>(async (tx) => {
    const freshHead = await txGetAgreementHead(tx, head.agreementRef);
    const version = await txGetAgreementVersion(tx, head.agreementRef, input.version);
    const artifactSnap = await tx.get(financeContractArtifactsCollection().doc(artifact.artifactRef));
    const freshArtifact = artifactSnap.exists ? contractArtifactDocSchema.safeParse(artifactSnap.data()) : null;

    if (!freshHead || !version || !freshArtifact?.success || !artifactBelongsToHead(freshArtifact.data, freshHead)) return { kind: "not_found" };
    if (freshHead.openVersion !== version.version || version.status !== "DRAFT" || version.confirmation !== null) return { kind: "locked", version: version.version };

    // List projection: the head's display.extractionStatus follows the newest run. Reads precede the first write.
    const displayed = await txResolveDisplayVersions(tx, freshHead, [version]);
    txCreateExtractionRun(tx, docs.run);
    txCreateRestrictedExtraction(tx, docs.restricted);
    // The head's ONLY change is that projection (docVersion, lifecycle pointers and scope stay as they were);
    // every version stays untouched. Apart from that, only the artifact's own status changes.
    txSetAgreementHead(tx, withHeadDisplay(freshHead, { counterpartyName: authorized.displayName, ...displayed, extractionStatus: docs.run.status, projectedAt: now, touchedBy: { actorUserRef: actor!.userRef } }));
    tx.set(
      financeContractArtifactsCollection().doc(artifact.artifactRef),
      contractArtifactDocSchema.parse({ ...freshArtifact.data, status: docs.run.status === "MANUAL_REVIEW_REQUIRED" ? "MANUAL_REVIEW_REQUIRED" : "EXTRACTED" }),
    );
    return { kind: "ok" };
  });

  if (result.kind === "not_found") return financeAgreementsNotFoundResult();
  if (result.kind === "locked") return financeAgreementsConflictResult(`Version ${result.version} is confirmed or is not the open version and can no longer be changed.`);

  const visibility = await resolveVisibility(actor!, authorized.counterpartyType);
  return { ok: true, data: buildResultDto(head.agreementRef, docs.run, docs.restricted, visibility) };
}

// --- Read a run -----------------------------------------------------------------------------------------------------------------
// Read gate = finance feature + LIVE scope of the head's Partner / Vendor (no action grant needed).
// Ordinary proposals for every authorized actor; the restricted block only with finance_contracts;
// identity values only with finance_contracts AND the counterparty's identity category, otherwise the
// identity fields are listed as RESTRICTED with no value. `extractionRunRef` omitted = the latest run.
// A missing run (or an Agreement with none) is the neutral not_found.
export async function getExtractionResult(actor: ActorContext | null, rawInput: unknown): Promise<FinanceAgreementsServiceResult<ExtractionResultDto>> {
  const access = await requireFinanceAgreementsAccess(actor);
  if (!access.ok) return financeAgreementsUnauthorizedResult(access.reason);

  const parsed = getExtractionResultInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeAgreementsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedAgreement(actor, input.agreementRef);
  if (!loaded.ok) return loaded.error;
  const { head, counterpartyType } = loaded.authorized;

  let run: ExtractionRunDoc | null = null;
  const runs = financeAgreementExtractionRunsCollection(head.agreementRef);
  if (input.extractionRunRef) {
    const snap = await runs.doc(input.extractionRunRef).get();
    const parsedRun = snap.exists ? extractionRunDocSchema.safeParse(snap.data()) : null;
    run = parsedRun?.success ? parsedRun.data : null;
  } else {
    // Latest by createdAt (a single-field orderBy, served by the automatic index).
    const snapshot = await runs.orderBy("createdAt", "desc").limit(1).get();
    const parsedRun = snapshot.docs[0] ? extractionRunDocSchema.safeParse(snapshot.docs[0].data()) : null;
    run = parsedRun?.success ? parsedRun.data : null;
  }
  if (!run || run.agreementRef !== head.agreementRef) return financeAgreementsNotFoundResult();

  const visibility = await resolveVisibility(actor!, counterpartyType);
  const restricted = visibility.contractDetail ? await getRestrictedExtractionDoc(run.runRef) : null;
  return { ok: true, data: buildResultDto(head.agreementRef, run, restricted && restricted.agreementRef === head.agreementRef ? restricted : null, visibility) };
}
