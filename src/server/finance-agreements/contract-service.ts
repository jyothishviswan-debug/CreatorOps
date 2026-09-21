import { createHash } from "node:crypto";

import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import { ContractArtifactStoreError, getContractArtifactStore } from "./contract-artifacts/store";
import { CONTRACT_PDF_MIME_TYPE, MAX_CONTRACT_PDF_BYTES, sha256Hex, validateContractPdf, type ContractPdfRejection } from "./contract-artifacts/validation";
import { toContractArtifactDto, type ContractArtifactDto } from "./client-dto";
import { financeAgreementClaimsCollection, financeContractArtifactsCollection, getContractArtifactDoc, txCreateContractArtifact } from "./firestore";
import { loadAuthorizedCounterparty, requireFinanceAgreementsAccess } from "./finance-agreements-gate";
import { generateContractArtifactRef } from "./ids";
import { formatIssues, isAlreadyExistsError } from "./service-common";
import {
  artifactRefSchema,
  contractArtifactDocSchema,
  counterpartyTypeSchema,
  financeAgreementsInternalResult,
  financeAgreementsInvalidInputResult,
  financeAgreementsNotFoundResult,
  financeAgreementsUnauthorizedResult,
  type AgreementCounterpartyInput,
  type ContractArtifactDoc,
  type CounterpartyType,
  type FinanceAgreementsServiceResult,
} from "./types";

// Step 14A: contract artifact UPLOAD + read.
//
// The PDF bytes live behind the ContractArtifactStore (server-only locator); Firestore holds
// only restricted artifact METADATA. A DTO exposes artifactRef, a sanitized fileName, size, a
// short checksum prefix, status and the counterparty ref - never a path, bucket, locator or
// signed URL. Uploading NEVER creates or changes an Agreement, and reads nothing of the
// contract: the file is validated (size / magic), hashed and stored, nothing more.

const MAX_FILE_NAME_CHARS = 200;
const FALLBACK_FILE_NAME = "contract.pdf";

// Keeps letters, digits and a few harmless punctuation marks; everything else (path separators,
// control characters, quotes, angle brackets ...) becomes "_". Only the last path segment is kept,
// so a name can never carry a directory or a traversal.
export function sanitizeContractFileName(raw: string): string {
  const lastSegment = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = lastSegment
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ._()&,'+-]/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
  if (cleaned.length === 0) return FALLBACK_FILE_NAME;
  if (cleaned.length <= MAX_FILE_NAME_CHARS) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
  return `${cleaned.slice(0, MAX_FILE_NAME_CHARS - extension.length)}${extension}`;
}

// Step 14B.1: exported so the ephemeral onboarding preview words a rejected file exactly as the upload does.
export const REJECTION_MESSAGES: Record<ContractPdfRejection, string> = {
  empty: "The contract file is empty.",
  too_large: `The contract file is larger than the ${MAX_CONTRACT_PDF_BYTES / (1024 * 1024)} MB limit.`,
  not_a_pdf: "The contract file is not a PDF.",
  invalid_header: "The contract file is not a valid PDF.",
};

// --- Idempotency claim ------------------------------------------------------------------------------------------------------
// The same bytes uploaded for the same counterparty re-use ONE artifact. The claim lives in the
// EXISTING financeAgreementClaims collection under a distinct `ctr_` id prefix (an Agreement
// idempotency claim id is a bare 64-hex digest, so the two id spaces can never collide, and the
// collection is already wiped by the emulator reset). id = ctr_ + sha256(type|counterpartyRef|sha256).
export const CONTRACT_CLAIM_ID_PREFIX = "ctr_";

export function contractArtifactClaimId(type: CounterpartyType, counterpartyRef: string, sha256: string): string {
  return `${CONTRACT_CLAIM_ID_PREFIX}${createHash("sha256").update(`${type}|${counterpartyRef}|${sha256}`).digest("hex")}`;
}

const contractArtifactClaimSchema = z.object({ artifactRef: z.string().min(1).max(200), createdAt: z.string().min(1) }).strict();

// --- Upload -----------------------------------------------------------------------------------------------------------------------
export const uploadContractInputSchema = z
  .object({
    fileName: z.string().min(1).max(2000),
    bytes: z.instanceof(Uint8Array),
    counterparty: z.object({ type: counterpartyTypeSchema, ref: z.string().min(1).max(200) }).strict(),
  })
  .strict();
export type UploadContractInput = z.input<typeof uploadContractInputSchema>;

export type UploadContractArtifactOutcome = { artifact: ContractArtifactDto; created: boolean };

// A contract counterparty is named by (type, opaque ref); the loader takes the gate's input shape.
export function contractCounterpartyToGateInput(counterparty: { type: CounterpartyType; ref: string }): AgreementCounterpartyInput {
  return counterparty.type === "PARTNER" ? { type: "PARTNER", partnerRef: counterparty.ref } : { type: "VENDOR", vendorRef: counterparty.ref };
}

type ClaimResolution = { kind: "existing"; artifact: ContractArtifactDoc } | { kind: "none" };

async function resolveExistingArtifact(claimId: string): Promise<ClaimResolution> {
  const claimSnap = await financeAgreementClaimsCollection().doc(claimId).get();
  const claim = claimSnap.exists ? contractArtifactClaimSchema.safeParse(claimSnap.data()) : null;
  if (!claim?.success) return { kind: "none" };
  const artifact = await getContractArtifactDoc(claim.data.artifactRef);
  return artifact ? { kind: "existing", artifact } : { kind: "none" };
}

// Chain: Authentication -> Admission -> FeatureAccess(finance) -> ActionPermission(manage_agreements)
// -> input shape -> live RecordScope of the named Partner / Vendor (a missing, out-of-scope or forged
// counterparty is the neutral not_found) -> content validation (empty / > 10 MB / not a PDF ->
// invalid_input with a safe reason and NO bytes echoed) -> store bytes -> metadata (transactional
// claim + artifact). Idempotent by content: the same bytes for the same counterparty return the
// existing artifact (created:false).
//
// Bytes are written BEFORE the metadata so a metadata doc never points at missing bytes. The
// storage interface has no delete, so a lost race (or a metadata failure) can leave an unreferenced,
// unreachable object; that is the accepted cost of never having a dangling artifact.
export async function uploadContractArtifact(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceAgreementsServiceResult<UploadContractArtifactOutcome>> {
  // requestId is accepted for parity with the mutation services; an upload has no Agreement head yet, so it appends no event.
  void requestId;
  const access = await requireFinanceAgreementsAccess(actor, "manage_agreements");
  if (!access.ok) return financeAgreementsUnauthorizedResult(access.reason);

  const parsed = uploadContractInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeAgreementsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const counterparty = await loadAuthorizedCounterparty(actor!, contractCounterpartyToGateInput(input.counterparty));
  if (!counterparty.ok) return counterparty.error;

  const validation = validateContractPdf(input.bytes);
  if (!validation.ok) return financeAgreementsInvalidInputResult(REJECTION_MESSAGES[validation.reason]);

  const sha256 = sha256Hex(input.bytes);
  const counterpartyRef = counterparty.authorized.type === "PARTNER" ? counterparty.authorized.counterparty.partnerRef : counterparty.authorized.counterparty.vendorRef;
  const claimId = contractArtifactClaimId(input.counterparty.type, counterpartyRef, sha256);

  try {
    const existing = await resolveExistingArtifact(claimId);
    if (existing.kind === "existing") return { ok: true, data: { artifact: toContractArtifactDto(existing.artifact), created: false } };

    const artifactRef = generateContractArtifactRef();
    const storageLocator = await getContractArtifactStore().put({ artifactRef, bytes: input.bytes, mimeType: CONTRACT_PDF_MIME_TYPE });
    const now = new Date().toISOString();
    const artifact = contractArtifactDocSchema.parse({
      artifactRef,
      fileName: sanitizeContractFileName(input.fileName),
      mimeType: CONTRACT_PDF_MIME_TYPE,
      sizeBytes: validation.sizeBytes,
      sha256,
      uploadedByUserRef: actor!.userRef,
      uploadedAt: now,
      counterparty: { type: input.counterparty.type, ref: counterpartyRef },
      status: "UPLOADED",
      storageLocator,
    });

    const outcome = await getAdminFirestore().runTransaction<UploadContractArtifactOutcome>(async (tx) => {
      const claimRef = financeAgreementClaimsCollection().doc(claimId);
      const claimSnap = await tx.get(claimRef);
      const claim = claimSnap.exists ? contractArtifactClaimSchema.safeParse(claimSnap.data()) : null;
      if (claim?.success) {
        // A concurrent upload of the same bytes won the race: return ITS artifact.
        const winnerSnap = await tx.get(financeContractArtifactsCollection().doc(claim.data.artifactRef));
        const winner = winnerSnap.exists ? contractArtifactDocSchema.safeParse(winnerSnap.data()) : null;
        if (winner?.success) return { artifact: toContractArtifactDto(winner.data), created: false };
      }
      tx.set(claimRef, contractArtifactClaimSchema.parse({ artifactRef, createdAt: now }));
      txCreateContractArtifact(tx, artifact);
      return { artifact: toContractArtifactDto(artifact), created: true };
    });
    return { ok: true, data: outcome };
  } catch (error) {
    if (isAlreadyExistsError(error)) return { ok: false, code: "conflict", message: "This contract was just uploaded by another request. Try again." };
    // Only the error class and store code are logged: never bytes, names, paths or locators.
    console.error("[finance-agreements] contract upload failed", error instanceof ContractArtifactStoreError ? `store:${error.code}` : error instanceof Error ? error.name : "unknown");
    return financeAgreementsInternalResult("The contract could not be stored. Try again.");
  }
}

// --- Read ---------------------------------------------------------------------------------------------------------------------------
// Read gate = finance feature + LIVE scope of the artifact's counterparty. A malformed, missing,
// out-of-scope or forged artifactRef is the same neutral not_found.
export async function getContractArtifactSummary(actor: ActorContext | null, artifactRef: unknown): Promise<FinanceAgreementsServiceResult<ContractArtifactDto>> {
  const access = await requireFinanceAgreementsAccess(actor);
  if (!access.ok) return financeAgreementsUnauthorizedResult(access.reason);

  const ref = artifactRefSchema.safeParse(artifactRef);
  if (!ref.success) return financeAgreementsNotFoundResult();
  const artifact = await getContractArtifactDoc(ref.data);
  if (!artifact) return financeAgreementsNotFoundResult();

  const counterparty = await loadAuthorizedCounterparty(actor!, contractCounterpartyToGateInput(artifact.counterparty));
  if (!counterparty.ok) return counterparty.error;
  return { ok: true, data: toContractArtifactDto(artifact) };
}
