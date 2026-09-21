import { createHash } from "node:crypto";

import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";

import { financeAgreementClaimsCollection } from "./firestore";
import { ONBOARDING_STEPS } from "./onboarding-dto";
import { isAlreadyExistsError } from "./service-common";
import { clientRequestIdSchema, counterpartyTypeSchema } from "./types";

// Step 14B.1: the STEP LEDGER of one Agreement-led onboarding (financeAgreementClaims/onb_{sha256(actorUid|clientRequestId)}).
//
// Creating a Partner / Vendor / Partner Accounts / Agreement crosses module boundaries that no single Firestore transaction can span,
// so the onboarding is a RESUMABLE sequence of idempotent steps and this document is its memory:
//
//   VALIDATED -> COUNTERPARTY_CREATED -> ACCOUNTS_CREATED -> AGREEMENT_DRAFT_CREATED
//
// It records only refs, step flags, timestamps and the record's display name (which the outcome shows) - no identity value, no email / phone /
// account handle or link, no contract text. Every write goes
// through a transaction that verifies the writer still holds the LEASE, so two concurrent requests for the same clientRequestId can never
// both run a step. The lease expires on its own if a process dies mid-run.
//
//   inputFingerprint  a retry that changes the request is a conflict, never a silent second onboarding
//   lease             { token, expiresAt }: one runner at a time; released on every normal exit
//   intent            a step writes its INTENT (intentAt, no ref yet) before calling the owning module, so a crash between the
//                     owning create and the ledger write is recoverable: the retry finds the record THIS actor created since the
//                     ledger started and adopts it instead of creating a second one
//   no delete         the ledger is only ever created and updated

export const ONBOARDING_LEDGER_ID_PREFIX = "onb_";
export const ONBOARDING_LEASE_MS = 60_000;

const nonEmpty = z.string().min(1);
const iso = z.string().min(1);
const refString = z.string().min(1).max(200);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const counterpartyStepSchema = z
  .object({
    // Recorded BEFORE the owning create is called.
    intentAt: iso,
    ref: refString.nullable(),
    displayName: z.string().min(1).max(200).nullable(),
    // true when this onboarding CREATED the record (or adopted the one it created); false for USE_EXISTING.
    created: z.boolean(),
    // true when a retry adopted a record created by an earlier, interrupted attempt.
    adopted: z.boolean(),
    resolvedAt: iso.nullable(),
  })
  .strict();

const accountStepSchema = z
  .object({
    // sha256 of the owning normalized Account identity (the owning identity-claim id): never the handle / link itself.
    key: hex64,
    platform: z.string().min(1).max(60),
    intentAt: iso,
    partnerAccountRef: refString.nullable(),
    resolvedAt: iso.nullable(),
  })
  .strict();

export const onboardingLedgerDocSchema = z
  .object({
    kind: z.literal("ONBOARDING"),
    onboardingRef: z.string().regex(/^onb_[0-9a-f]{64}$/),
    clientRequestId: clientRequestIdSchema,
    actorUserRef: nonEmpty,
    counterpartyType: counterpartyTypeSchema,
    mode: z.enum(["CREATE_NEW", "USE_EXISTING"]),
    createdVia: z.literal("FINANCE_AGREEMENT_ONBOARDING"),
    inputFingerprint: hex64,
    status: z.enum(["IN_PROGRESS", "COMPLETED", "FAILED"]),
    attempts: z.number().int().min(1).max(1000),
    lease: z.object({ token: nonEmpty, expiresAt: iso }).strict().nullable(),
    // What the deliberate duplicate decision was (never the reason text): audit context only.
    duplicateDecision: z.object({ kind: z.enum(["CREATE_NEW", "USE_EXISTING"]), acknowledgedDuplicates: z.boolean(), reasonRecorded: z.boolean() }).strict(),
    steps: z
      .object({
        validatedAt: iso.nullable(),
        counterparty: counterpartyStepSchema.nullable(),
        // The Accounts this onboarding must create (their keys, in request order) and the progress on each.
        plannedAccountKeys: z.array(hex64).max(6),
        accounts: z.array(accountStepSchema).max(6),
        agreement: z.object({ agreementRef: refString, at: iso }).strict().nullable(),
      })
      .strict(),
    failure: z
      .object({ step: z.enum(ONBOARDING_STEPS), code: z.string().min(1).max(100), message: z.string().min(1).max(500), retryable: z.boolean(), duplicateSignal: z.boolean(), at: iso })
      .strict()
      .nullable(),
    startedAt: iso,
    updatedAt: iso,
  })
  .strict();
export type OnboardingLedgerDoc = z.infer<typeof onboardingLedgerDocSchema>;

// --- Ids -----------------------------------------------------------------------------------------------------------------------------
function digest(actorUid: string, clientRequestId: string): string {
  return createHash("sha256").update(`${actorUid}|${clientRequestId}`).digest("hex");
}

// onb_ + sha256(actorUid|clientRequestId): two actors can reuse a clientRequestId, and the id reveals neither.
export function onboardingLedgerId(actorUid: string, clientRequestId: string): string {
  return `${ONBOARDING_LEDGER_ID_PREFIX}${digest(actorUid, clientRequestId)}`;
}

// The deterministic clientRequestId of the Agreement draft this onboarding creates (matches clientRequestIdSchema), so a retried
// createAgreementDraft resolves to the same Agreement through its own idempotency claim.
export function onboardingAgreementClientRequestId(ledgerId: string): string {
  return `onb:${ledgerId.slice(ONBOARDING_LEDGER_ID_PREFIX.length, ONBOARDING_LEDGER_ID_PREFIX.length + 40)}`;
}

// A stable request id for the owning modules' audit events of one step (correlates their events with the ledger).
export function onboardingStepRequestId(ledgerId: string, step: string): string {
  return `onb:${ledgerId.slice(ONBOARDING_LEDGER_ID_PREFIX.length, ONBOARDING_LEDGER_ID_PREFIX.length + 24)}:${step}`;
}

// --- Fingerprint ---------------------------------------------------------------------------------------------------------------------
export function onboardingFingerprint(canonical: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// --- Reads / writes ---------------------------------------------------------------------------------------------------------------
export async function getOnboardingLedger(ledgerId: string): Promise<OnboardingLedgerDoc | null> {
  const snapshot = await financeAgreementClaimsCollection().doc(ledgerId).get();
  if (!snapshot.exists) return null;
  const parsed = onboardingLedgerDocSchema.safeParse(snapshot.data());
  return parsed.success ? parsed.data : null;
}

export type CreateLedgerResult = { kind: "created"; doc: OnboardingLedgerDoc } | { kind: "exists" };

// tx-free create: the document's existence is the guarantee of exactly one ledger per (actor, clientRequestId).
export async function createOnboardingLedger(doc: OnboardingLedgerDoc): Promise<CreateLedgerResult> {
  const parsed = onboardingLedgerDocSchema.parse(doc);
  try {
    await financeAgreementClaimsCollection().doc(parsed.onboardingRef).create(parsed);
    return { kind: "created", doc: parsed };
  } catch (error) {
    if (isAlreadyExistsError(error)) return { kind: "exists" };
    throw error;
  }
}

export type AcquireLeaseResult = { kind: "acquired"; doc: OnboardingLedgerDoc } | { kind: "completed"; doc: OnboardingLedgerDoc } | { kind: "busy"; doc: OnboardingLedgerDoc } | { kind: "missing" };

// Takes the lease for a resume: a COMPLETED ledger needs none; a live lease held by someone else is `busy`; otherwise the caller
// becomes the runner (status IN_PROGRESS, the previous failure cleared, attempts + 1).
export async function acquireOnboardingLease(ledgerId: string, token: string, now: Date, leaseMs: number = ONBOARDING_LEASE_MS): Promise<AcquireLeaseResult> {
  const ref = financeAgreementClaimsCollection().doc(ledgerId);
  return getAdminFirestore().runTransaction<AcquireLeaseResult>(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return { kind: "missing" };
    const parsed = onboardingLedgerDocSchema.safeParse(snapshot.data());
    if (!parsed.success) return { kind: "missing" };
    const doc = parsed.data;
    if (doc.status === "COMPLETED") return { kind: "completed", doc };
    if (doc.lease && doc.lease.token !== token && Date.parse(doc.lease.expiresAt) > now.getTime()) return { kind: "busy", doc };
    const next: OnboardingLedgerDoc = onboardingLedgerDocSchema.parse({
      ...doc,
      status: "IN_PROGRESS",
      attempts: Math.min(doc.attempts + 1, 1000),
      lease: { token, expiresAt: new Date(now.getTime() + leaseMs).toISOString() },
      failure: null,
      updatedAt: now.toISOString(),
    });
    tx.set(ref, next);
    return { kind: "acquired", doc: next };
  });
}

export class LedgerLeaseLostError extends Error {
  constructor() {
    super("The onboarding lease is no longer held.");
    this.name = "LedgerLeaseLostError";
  }
}

// One ledger update under the lease: read, verify the writer still holds it, apply a pure patch, write.
export async function updateOnboardingLedger(ledgerId: string, token: string, mutate: (current: OnboardingLedgerDoc) => OnboardingLedgerDoc): Promise<OnboardingLedgerDoc> {
  const ref = financeAgreementClaimsCollection().doc(ledgerId);
  return getAdminFirestore().runTransaction<OnboardingLedgerDoc>(async (tx) => {
    const snapshot = await tx.get(ref);
    const parsed = snapshot.exists ? onboardingLedgerDocSchema.safeParse(snapshot.data()) : null;
    if (!parsed?.success) throw new LedgerLeaseLostError();
    if (parsed.data.lease?.token !== token) throw new LedgerLeaseLostError();
    const next = onboardingLedgerDocSchema.parse({ ...mutate(parsed.data), updatedAt: new Date().toISOString() });
    tx.set(ref, next);
    return next;
  });
}
