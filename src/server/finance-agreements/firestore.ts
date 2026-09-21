import { createHash } from "node:crypto";

import { getAdminFirestore } from "@/server/firebase/admin";

import {
  agreementClaimDocSchema,
  agreementEventSchema,
  agreementHeadDocSchema,
  agreementVersionDocSchema,
  contractArtifactDocSchema,
  extractionRunDocSchema,
  restrictedExtractionDocSchema,
  type AgreementClaimDoc,
  type AgreementCounterpartyInput,
  type AgreementEvent,
  type AgreementHeadDoc,
  type AgreementVersionDoc,
  type ContractArtifactDoc,
  type ExtractionRunDoc,
  type RestrictedExtractionDoc,
} from "./types";

// Step 14A: collection accessors + parse-on-read/parse-on-write helpers for the Finance
// Agreements domain.
//
// There is deliberately NO delete anywhere in this module - not a helper, not a batch,
// not a transaction delete. History is preserved; an Agreement is ended, never removed.
// (A static boundary test enforces this. Test/dev cleanup lives in the emulator-reset
// utility and in test files, never here.)

export const FINANCE_AGREEMENT_COLLECTIONS = {
  financeAgreements: "financeAgreements",
  versions: "versions", // subcollection under financeAgreements/{agreementRef}
  events: "events", // subcollection under financeAgreements/{agreementRef}
  extractionRuns: "extractionRuns", // subcollection under financeAgreements/{agreementRef}
  financeAgreementClaims: "financeAgreementClaims",
  financeContractArtifacts: "financeContractArtifacts",
  financeAgreementRestrictedExtractions: "financeAgreementRestrictedExtractions",
} as const;

export const MAX_AGREEMENT_VERSION_SUMMARIES = 50;
export const DEFAULT_AGREEMENT_EVENT_PAGE = 50;
export const MAX_AGREEMENT_EVENT_PAGE = 100;

export function financeAgreementsCollection() {
  return getAdminFirestore().collection(FINANCE_AGREEMENT_COLLECTIONS.financeAgreements);
}

export function financeAgreementVersionsCollection(agreementRef: string) {
  return financeAgreementsCollection().doc(agreementRef).collection(FINANCE_AGREEMENT_COLLECTIONS.versions);
}

export function financeAgreementEventsCollection(agreementRef: string) {
  return financeAgreementsCollection().doc(agreementRef).collection(FINANCE_AGREEMENT_COLLECTIONS.events);
}

export function financeAgreementExtractionRunsCollection(agreementRef: string) {
  return financeAgreementsCollection().doc(agreementRef).collection(FINANCE_AGREEMENT_COLLECTIONS.extractionRuns);
}

export function financeAgreementClaimsCollection() {
  return getAdminFirestore().collection(FINANCE_AGREEMENT_COLLECTIONS.financeAgreementClaims);
}

export function financeContractArtifactsCollection() {
  return getAdminFirestore().collection(FINANCE_AGREEMENT_COLLECTIONS.financeContractArtifacts);
}

export function financeAgreementRestrictedExtractionsCollection() {
  return getAdminFirestore().collection(FINANCE_AGREEMENT_COLLECTIONS.financeAgreementRestrictedExtractions);
}

// Version doc ids are the plain integer as a string ("1", "2", ...) - the deterministic id
// makes "exactly one version N" a document-existence fact (tx.create fails on a duplicate).
// Ordering never relies on the id (it would sort "10" before "2"); list order is always the
// numeric `version` field.
export function versionDocId(version: number): string {
  return String(version);
}

// Deterministic idempotency-claim id: sha256(actorUid|clientRequestId). Two different actors
// can reuse the same clientRequestId without colliding, and the id never reveals either value.
export function agreementClaimId(actorUid: string, clientRequestId: string): string {
  return createHash("sha256").update(`${actorUid}|${clientRequestId}`).digest("hex");
}

// Canonical fingerprint of the create-draft payload (the counterparty the client named, with
// account refs sorted/deduped), stored on the claim so a retry that CHANGES the payload can be
// reported as a conflict instead of silently returning a different Agreement.
export function createDraftInputFingerprint(counterparty: AgreementCounterpartyInput): string {
  const canonical =
    counterparty.type === "PARTNER"
      ? { type: "PARTNER", partnerRef: counterparty.partnerRef, partnerAccountRefs: [...new Set(counterparty.partnerAccountRefs ?? [])].sort() }
      : { type: "VENDOR", vendorRef: counterparty.vendorRef };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// --- Reads: safeParse, null on missing or malformed ------------------------------------------------------------------
export async function getAgreementHeadDoc(agreementRef: string): Promise<AgreementHeadDoc | null> {
  const snapshot = await financeAgreementsCollection().doc(agreementRef).get();
  if (!snapshot.exists) return null;
  const result = agreementHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getAgreementVersionDoc(agreementRef: string, version: number): Promise<AgreementVersionDoc | null> {
  const snapshot = await financeAgreementVersionsCollection(agreementRef).doc(versionDocId(version)).get();
  if (!snapshot.exists) return null;
  const result = agreementVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Bounded, newest-first list of one Agreement's versions (by the numeric `version` field - a
// single-field index, no composite needed).
export async function listAgreementVersionDocs(agreementRef: string, limit = MAX_AGREEMENT_VERSION_SUMMARIES): Promise<{ versions: AgreementVersionDoc[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_AGREEMENT_VERSION_SUMMARIES));
  const snapshot = await financeAgreementVersionsCollection(agreementRef)
    .orderBy("version", "desc")
    .limit(bound + 1)
    .get();

  const versions: AgreementVersionDoc[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = agreementVersionDocSchema.safeParse(doc.data());
    if (parsed.success) versions.push(parsed.data);
  }
  return { versions, hasMore: snapshot.docs.length > bound };
}

// Bounded, newest-first page of one Agreement's audit events (a single-field orderBy on
// `createdAt`, served by the automatic index).
export async function listAgreementEventDocs(agreementRef: string, limit = DEFAULT_AGREEMENT_EVENT_PAGE): Promise<{ events: AgreementEvent[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_AGREEMENT_EVENT_PAGE));
  const snapshot = await financeAgreementEventsCollection(agreementRef)
    .orderBy("createdAt", "desc")
    .limit(bound + 1)
    .get();

  const events: AgreementEvent[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = agreementEventSchema.safeParse(doc.data());
    if (parsed.success) events.push(parsed.data);
  }
  return { events, hasMore: snapshot.docs.length > bound };
}

export async function getAgreementClaimDoc(claimId: string): Promise<AgreementClaimDoc | null> {
  const snapshot = await financeAgreementClaimsCollection().doc(claimId).get();
  if (!snapshot.exists) return null;
  const result = agreementClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getContractArtifactDoc(artifactRef: string): Promise<ContractArtifactDoc | null> {
  const snapshot = await financeContractArtifactsCollection().doc(artifactRef).get();
  if (!snapshot.exists) return null;
  const result = contractArtifactDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getExtractionRunDoc(agreementRef: string, runRef: string): Promise<ExtractionRunDoc | null> {
  const snapshot = await financeAgreementExtractionRunsCollection(agreementRef).doc(runRef).get();
  if (!snapshot.exists) return null;
  const result = extractionRunDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// SERVER-ONLY: callers must have passed requireContractSensitiveAccess (and, for identity
// values, requireIdentitySensitiveAccess) before reading this.
export async function getRestrictedExtractionDoc(runRef: string): Promise<RestrictedExtractionDoc | null> {
  const snapshot = await financeAgreementRestrictedExtractionsCollection().doc(runRef).get();
  if (!snapshot.exists) return null;
  const result = restrictedExtractionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// --- In-transaction reads (Firestore requires every read before any write) ---------------------------------------------
export async function txGetAgreementHead(tx: FirebaseFirestore.Transaction, agreementRef: string): Promise<AgreementHeadDoc | null> {
  const snapshot = await tx.get(financeAgreementsCollection().doc(agreementRef));
  if (!snapshot.exists) return null;
  const result = agreementHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function txGetAgreementVersion(tx: FirebaseFirestore.Transaction, agreementRef: string, version: number): Promise<AgreementVersionDoc | null> {
  const snapshot = await tx.get(financeAgreementVersionsCollection(agreementRef).doc(versionDocId(version)));
  if (!snapshot.exists) return null;
  const result = agreementVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function txGetAgreementClaim(tx: FirebaseFirestore.Transaction, claimId: string): Promise<AgreementClaimDoc | null> {
  const snapshot = await tx.get(financeAgreementClaimsCollection().doc(claimId));
  if (!snapshot.exists) return null;
  const result = agreementClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// --- In-transaction writes: parsed on WRITE, so an invalid doc can never be persisted ------------------------------------
// `create` variants fail the transaction if the doc already exists (the concurrency
// guarantee for "exactly one head / claim / version N"); `set` variants replace a doc the
// transaction has just read and re-validated.
export function txCreateAgreementHead(tx: FirebaseFirestore.Transaction, head: AgreementHeadDoc): void {
  tx.create(financeAgreementsCollection().doc(head.agreementRef), agreementHeadDocSchema.parse(head));
}

export function txSetAgreementHead(tx: FirebaseFirestore.Transaction, head: AgreementHeadDoc): void {
  tx.set(financeAgreementsCollection().doc(head.agreementRef), agreementHeadDocSchema.parse(head));
}

export function txCreateAgreementVersion(tx: FirebaseFirestore.Transaction, version: AgreementVersionDoc): void {
  tx.create(financeAgreementVersionsCollection(version.agreementRef).doc(versionDocId(version.version)), agreementVersionDocSchema.parse(version));
}

export function txSetAgreementVersion(tx: FirebaseFirestore.Transaction, version: AgreementVersionDoc): void {
  tx.set(financeAgreementVersionsCollection(version.agreementRef).doc(versionDocId(version.version)), agreementVersionDocSchema.parse(version));
}

export function txCreateAgreementClaim(tx: FirebaseFirestore.Transaction, claimId: string, claim: AgreementClaimDoc): void {
  tx.create(financeAgreementClaimsCollection().doc(claimId), agreementClaimDocSchema.parse(claim));
}

export function txCreateContractArtifact(tx: FirebaseFirestore.Transaction, artifact: ContractArtifactDoc): void {
  tx.create(financeContractArtifactsCollection().doc(artifact.artifactRef), contractArtifactDocSchema.parse(artifact));
}

export function txCreateExtractionRun(tx: FirebaseFirestore.Transaction, run: ExtractionRunDoc): void {
  tx.create(financeAgreementExtractionRunsCollection(run.agreementRef).doc(run.runRef), extractionRunDocSchema.parse(run));
}

export function txCreateRestrictedExtraction(tx: FirebaseFirestore.Transaction, doc: RestrictedExtractionDoc): void {
  tx.create(financeAgreementRestrictedExtractionsCollection().doc(doc.runRef), restrictedExtractionDocSchema.parse(doc));
}
