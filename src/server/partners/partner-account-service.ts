import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import type { ActorContext } from "@/server/authz/types";
import { toPartnerAccountDto, type PartnerAccountDto } from "./client-dto";
import {
  getPartnerAccountDocByRef,
  getPartnerDocByRef,
  listPartnerAccountDocs,
  partnerAccountIdentityClaimsCollection,
  partnerAccountsCollection,
  partnersCollection,
  runPartnerAccountMutation,
} from "./firestore";
import { claimIdFor, computeNormalizedIdentity } from "./identity";
import { generatePartnerAccountRef } from "./ids";
import { writePartnerEvent } from "./partner-events";
import { requirePartnerInScope, requirePartnersAccess, requirePartnersFeatureAccess } from "./partners-gate";
import {
  partnerAccountDocSchema,
  partnerAccountIdentityClaimDocSchema,
  partnerDocSchema,
  partnersInvalidInputResult,
  partnersUnauthorizedResult,
  type PartnerAccountDoc,
  type PartnerDoc,
  type PartnersServiceResult,
} from "./types";

async function loadOwningPartner(partnerAccount: PartnerAccountDoc): Promise<PartnerDoc | null> {
  return getPartnerDocByRef(partnerAccount.partnerRef);
}

async function loadAuthorizedAccount(
  actor: ActorContext | null,
  partnerAccountRef: unknown,
  action: Parameters<typeof requirePartnersAccess>[1],
): Promise<{ ok: true; account: PartnerAccountDoc; partner: PartnerDoc } | { ok: false; error: PartnersServiceResult<never> }> {
  const gate = await requirePartnersAccess(actor, action);
  if (!gate.ok) return { ok: false, error: partnersUnauthorizedResult(gate.reason) };

  if (typeof partnerAccountRef !== "string" || partnerAccountRef.length === 0) return { ok: false, error: partnersInvalidInputResult("Missing partnerAccountRef.") };
  const account = await getPartnerAccountDocByRef(partnerAccountRef);
  if (!account) return { ok: false, error: { ok: false, code: "not_found", message: "Partner Account not found." } };

  const partner = await loadOwningPartner(account);
  if (!partner) return { ok: false, error: { ok: false, code: "not_found", message: "Owning Partner not found." } };

  const scopeCheck = await requirePartnerInScope(actor!, partner);
  if (!scopeCheck.ok) return { ok: false, error: partnersUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, account, partner };
}

// ---- Create ----

const createPartnerAccountInputSchema = z.object({
  platform: z.string().min(1).max(60),
  handle: z.string().min(1).max(120).optional(),
  displayName: z.string().min(1).max(200).optional(),
  profileUrl: z.string().min(1).max(500).optional(),
  platformAccountId: z.string().min(1).max(200).optional(),
  primary: z.boolean().optional(),
  followerCount: z.number().int().min(0).optional(),
}).strict();
export type CreatePartnerAccountInput = z.input<typeof createPartnerAccountInputSchema>;

type CreateAccountTxResult = { kind: "ok"; doc: PartnerAccountDoc } | { kind: "collision" } | { kind: "partner_not_found" };

// The transactional core of "concurrency-safe normalized uniqueness"
// (Step 7A section 3): the identity-claim document's existence IS the
// lock. All reads happen before any write (a hard Firestore transaction
// requirement) - the claim doc, any existing primary account for this
// Partner (only read when this account is being created as primary),
// and the Partner doc itself (only when it currently has
// pendingPartnerAccountSetup, so creating a real account can resolve
// that flag atomically in the same transaction).
export async function createPartnerAccount(actor: ActorContext | null, partnerRef: unknown, rawInput: unknown, requestId: string): Promise<PartnersServiceResult<PartnerAccountDto>> {
  const gate = await requirePartnersAccess(actor, "manage_partner_accounts");
  if (!gate.ok) return partnersUnauthorizedResult(gate.reason);

  if (typeof partnerRef !== "string" || partnerRef.length === 0) return partnersInvalidInputResult("Missing partnerRef.");
  const partner = await getPartnerDocByRef(partnerRef);
  if (!partner) return { ok: false, code: "not_found", message: "Partner not found." };

  const scopeCheck = await requirePartnerInScope(actor!, partner);
  if (!scopeCheck.ok) return partnersUnauthorizedResult(scopeCheck.reason);

  const parsed = createPartnerAccountInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const normalizedIdentity = computeNormalizedIdentity({ platform: input.platform, platformAccountId: input.platformAccountId, profileUrl: input.profileUrl, handle: input.handle });
  if (!normalizedIdentity) return partnersInvalidInputResult("At least one of platformAccountId, profileUrl, or handle is required to establish account identity.");
  const claimId = claimIdFor(normalizedIdentity);

  const db = getAdminFirestore();
  const claimRef = partnerAccountIdentityClaimsCollection().doc(claimId);
  const partnerDocRef = partnersCollection().doc(partner.uid);
  const newUid = partnerAccountsCollection().doc().id;
  const newRef = generatePartnerAccountRef();
  const now = new Date().toISOString();

  const result = await db.runTransaction<CreateAccountTxResult>(async (tx) => {
    const claimSnap = await tx.get(claimRef);
    if (claimSnap.exists) return { kind: "collision" };

    let existingPrimarySnap: FirebaseFirestore.QuerySnapshot | null = null;
    if (input.primary) {
      existingPrimarySnap = await tx.get(partnerAccountsCollection().where("partnerRef", "==", partner.partnerRef).where("primary", "==", true).limit(5));
    }

    const partnerSnap = await tx.get(partnerDocRef);
    if (!partnerSnap.exists) return { kind: "partner_not_found" };
    const freshPartner = partnerDocSchema.safeParse(partnerSnap.data());
    if (!freshPartner.success) return { kind: "partner_not_found" };

    const accountDoc: PartnerAccountDoc = partnerAccountDocSchema.parse({
      uid: newUid,
      partnerAccountRef: newRef,
      version: 1,
      partnerRef: partner.partnerRef,
      platform: input.platform,
      handle: input.handle ?? null,
      displayName: input.displayName ?? null,
      profileUrl: input.profileUrl ?? null,
      platformAccountId: input.platformAccountId ?? null,
      normalizedIdentity,
      primary: Boolean(input.primary),
      status: "ACTIVE",
      followerSnapshot: input.followerCount !== undefined ? { count: input.followerCount, asOf: now } : null,
      originAssetDecision: null,
      originLeadRef: null,
      createdAt: now,
      createdByUserRef: actor!.userRef,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    tx.set(partnerAccountsCollection().doc(newUid), accountDoc);
    tx.set(claimRef, partnerAccountIdentityClaimDocSchema.parse({ normalizedIdentity, partnerAccountUid: newUid, partnerAccountRef: newRef, claimedAt: now }));

    if (existingPrimarySnap) {
      for (const doc of existingPrimarySnap.docs) {
        const existing = partnerAccountDocSchema.safeParse(doc.data());
        if (existing.success) tx.update(doc.ref, { primary: false, version: existing.data.version + 1, updatedAt: now, updatedByUserRef: actor!.userRef });
      }
    }

    if (freshPartner.data.pendingPartnerAccountSetup) {
      tx.update(partnerDocRef, { pendingPartnerAccountSetup: false, version: freshPartner.data.version + 1, updatedAt: now, updatedByUserRef: actor!.userRef });
    }

    return { kind: "ok", doc: accountDoc };
  });

  if (result.kind === "collision") return { ok: false, code: "conflict", message: "This account identity is already claimed by another Partner Account." };
  if (result.kind === "partner_not_found") return { ok: false, code: "not_found", message: "Partner not found." };

  await writePartnerEvent({ partnerUid: partner.uid, kind: "account_created", actorUserRef: actor!.userRef, metadata: { platform: input.platform, primary: Boolean(input.primary) }, requestId });
  return { ok: true, data: toPartnerAccountDto(result.doc) };
}

// ---- Read ----

export async function getPartnerAccount(actor: ActorContext | null, partnerAccountRef: unknown): Promise<PartnersServiceResult<PartnerAccountDto>> {
  const gate = await requirePartnersFeatureAccess(actor);
  if (!gate.ok) return partnersUnauthorizedResult(gate.reason);

  if (typeof partnerAccountRef !== "string" || partnerAccountRef.length === 0) return partnersInvalidInputResult("Missing partnerAccountRef.");
  const account = await getPartnerAccountDocByRef(partnerAccountRef);
  if (!account) return { ok: false, code: "not_found", message: "Partner Account not found." };

  const partner = await loadOwningPartner(account);
  if (!partner) return { ok: false, code: "not_found", message: "Owning Partner not found." };

  const scopeCheck = await requirePartnerInScope(actor!, partner);
  if (!scopeCheck.ok) return partnersUnauthorizedResult(scopeCheck.reason);

  return { ok: true, data: toPartnerAccountDto(account) };
}

export async function listPartnerAccounts(actor: ActorContext | null, partnerRef: unknown): Promise<PartnersServiceResult<PartnerAccountDto[]>> {
  const gate = await requirePartnersFeatureAccess(actor);
  if (!gate.ok) return partnersUnauthorizedResult(gate.reason);

  if (typeof partnerRef !== "string" || partnerRef.length === 0) return partnersInvalidInputResult("Missing partnerRef.");
  const partner = await getPartnerDocByRef(partnerRef);
  if (!partner) return { ok: false, code: "not_found", message: "Partner not found." };

  const scopeCheck = await requirePartnerInScope(actor!, partner);
  if (!scopeCheck.ok) return partnersUnauthorizedResult(scopeCheck.reason);

  const accounts = await listPartnerAccountDocs(partner.partnerRef);
  return { ok: true, data: accounts.map(toPartnerAccountDto) };
}

// ---- Edit (identity-bearing fields may evolve normalizedIdentity - see below) ----

const editPartnerAccountInputSchema = z
  .object({
    handle: z.string().min(1).max(120).nullable().optional(),
    displayName: z.string().min(1).max(200).nullable().optional(),
    profileUrl: z.string().min(1).max(500).nullable().optional(),
    platformAccountId: z.string().min(1).max(200).nullable().optional(),
    followerCount: z.number().int().min(0).nullable().optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type EditPartnerAccountInput = z.input<typeof editPartnerAccountInputSchema>;

type EditAccountTxResult = { kind: "ok"; doc: PartnerAccountDoc; oldNormalizedIdentity: string } | { kind: "not_found" } | { kind: "stale" } | { kind: "collision" };

// Step 7A.1: normalizedIdentity is allowed to evolve - it represents the
// CURRENT strongest identity evidence, not a value frozen at creation
// (see identity.ts's own comment for the full rationale). Plain
// display-name/follower-count edits never touch it at all. When an
// identity-bearing field (handle/profileUrl/platformAccountId) actually
// changes the computed identity, this transactionally: verifies the new
// claim is free (or already owned by this same account), claims it,
// updates the account, and releases the old claim - so the obsolete
// value never remains a permanent uniqueness lock, and the new value
// collides against duplicate creation immediately. All reads happen
// before any write (a hard Firestore transaction requirement).
//
// One case is deliberately NOT evolved through this ordinary path:
// replacing an already-set stable platform id with a DIFFERENT one (or
// clearing it once set). That is a materially different kind of
// identity-sensitive change than a rename/upgrade - a real stable id
// changing usually means "this is now a different underlying account",
// not "the same account got a better handle" - and there is no governed
// correction workflow for that yet, so it is rejected outright rather
// than silently allowed through the same evolution path a rename uses.
export async function editPartnerAccount(actor: ActorContext | null, partnerAccountRef: unknown, rawInput: unknown, requestId: string): Promise<PartnersServiceResult<PartnerAccountDto>> {
  const loaded = await loadAuthorizedAccount(actor, partnerAccountRef, "manage_partner_accounts");
  if (!loaded.ok) return loaded.error;

  const parsed = editPartnerAccountInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const current = loaded.account;
  const effectivePlatformAccountId = input.platformAccountId !== undefined ? input.platformAccountId : current.platformAccountId;
  const effectiveProfileUrl = input.profileUrl !== undefined ? input.profileUrl : current.profileUrl;
  const effectiveHandle = input.handle !== undefined ? input.handle : current.handle;

  // Replacing (or clearing) an already-set stable platform id is
  // rejected in this ordinary edit path - see the function doc comment.
  if (current.platformAccountId && input.platformAccountId !== undefined && input.platformAccountId !== current.platformAccountId) {
    return partnersInvalidInputResult(
      "This account already has a stable platform account id - changing it to a different value (or clearing it) is an identity-sensitive change not supported through an ordinary edit.",
    );
  }

  const candidateIdentity = computeNormalizedIdentity({ platform: current.platform, platformAccountId: effectivePlatformAccountId, profileUrl: effectiveProfileUrl, handle: effectiveHandle });
  if (!candidateIdentity) return partnersInvalidInputResult("At least one of platformAccountId, profileUrl, or handle is required to establish account identity.");

  const now = new Date().toISOString();

  // Fast path: no identity-bearing field actually changed the computed
  // identity (a pure display-name/follower-count edit, or a
  // handle/profileUrl edit that a stable id already overrides in
  // priority) - ordinary versioned edit, no claim collection involved.
  if (candidateIdentity === current.normalizedIdentity) {
    const result = await runPartnerAccountMutation(current.uid, input.expectedVersion, (fresh) => ({
      ...fresh,
      handle: effectiveHandle,
      displayName: input.displayName !== undefined ? input.displayName : fresh.displayName,
      profileUrl: effectiveProfileUrl,
      platformAccountId: effectivePlatformAccountId,
      followerSnapshot: input.followerCount !== undefined ? (input.followerCount === null ? null : { count: input.followerCount, asOf: now }) : fresh.followerSnapshot,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    }));

    if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Partner Account not found." };
    if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Partner Account was changed elsewhere. Reload and try again." };

    await writePartnerEvent({ partnerUid: loaded.partner.uid, kind: "account_edited", actorUserRef: actor!.userRef, metadata: { partnerAccountRef: current.partnerAccountRef }, requestId });
    return { ok: true, data: toPartnerAccountDto(result.doc) };
  }

  // Identity evolution path: the computed identity actually changed -
  // claim the new one and release the old one, transactionally.
  const db = getAdminFirestore();
  const accountRef = partnerAccountsCollection().doc(current.uid);
  const newClaimId = claimIdFor(candidateIdentity);
  const newClaimRef = partnerAccountIdentityClaimsCollection().doc(newClaimId);
  const oldClaimId = claimIdFor(current.normalizedIdentity);
  const oldClaimRef = partnerAccountIdentityClaimsCollection().doc(oldClaimId);

  const result = await db.runTransaction<EditAccountTxResult>(async (tx) => {
    // All reads before any write.
    const accountSnap = await tx.get(accountRef);
    if (!accountSnap.exists) return { kind: "not_found" };
    const freshAccount = partnerAccountDocSchema.safeParse(accountSnap.data());
    if (!freshAccount.success) return { kind: "not_found" };
    if (freshAccount.data.version !== input.expectedVersion) return { kind: "stale" };

    const newClaimSnap = await tx.get(newClaimRef);
    if (newClaimSnap.exists) {
      const existingClaim = partnerAccountIdentityClaimDocSchema.safeParse(newClaimSnap.data());
      // Free to proceed only if the new identity is already owned by
      // THIS same account (a defensive idempotency allowance - in
      // practice unreachable via a fresh request, since a prior success
      // would already show candidateIdentity === current.normalizedIdentity
      // on the next attempt); owned by any other account is a real
      // collision.
      if (!existingClaim.success || existingClaim.data.partnerAccountUid !== freshAccount.data.uid) return { kind: "collision" };
    }

    const oldClaimSnap = await tx.get(oldClaimRef);
    const oldClaimBelongsToThisAccount = oldClaimSnap.exists && (() => {
      const parsedOld = partnerAccountIdentityClaimDocSchema.safeParse(oldClaimSnap.data());
      return parsedOld.success && parsedOld.data.partnerAccountUid === freshAccount.data.uid;
    })();

    // Writes.
    const updated: PartnerAccountDoc = {
      ...freshAccount.data,
      handle: effectiveHandle,
      displayName: input.displayName !== undefined ? input.displayName : freshAccount.data.displayName,
      profileUrl: effectiveProfileUrl,
      platformAccountId: effectivePlatformAccountId,
      normalizedIdentity: candidateIdentity,
      followerSnapshot: input.followerCount !== undefined ? (input.followerCount === null ? null : { count: input.followerCount, asOf: now }) : freshAccount.data.followerSnapshot,
      version: freshAccount.data.version + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    tx.set(accountRef, updated);
    tx.set(newClaimRef, partnerAccountIdentityClaimDocSchema.parse({ normalizedIdentity: candidateIdentity, partnerAccountUid: freshAccount.data.uid, partnerAccountRef: freshAccount.data.partnerAccountRef, claimedAt: now }));
    if (oldClaimBelongsToThisAccount) tx.delete(oldClaimRef);

    return { kind: "ok", doc: updated, oldNormalizedIdentity: freshAccount.data.normalizedIdentity };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Partner Account not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Partner Account was changed elsewhere. Reload and try again." };
  if (result.kind === "collision") return { ok: false, code: "conflict", message: "This account identity is already claimed by another Partner Account." };

  // Safe labels only (normalized platform:type:value strings) - never a
  // secret, same discipline as every other partner event.
  await writePartnerEvent({
    partnerUid: loaded.partner.uid,
    kind: "account_identity_changed",
    actorUserRef: actor!.userRef,
    metadata: { partnerAccountRef: current.partnerAccountRef, oldNormalizedIdentity: result.oldNormalizedIdentity, newNormalizedIdentity: candidateIdentity },
    requestId,
  });
  return { ok: true, data: toPartnerAccountDto(result.doc) };
}

// ---- Status (ACTIVE <-> INACTIVE) ----

const setAccountStatusInputSchema = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]), expectedVersion: z.number().int().min(1) });
export type SetPartnerAccountStatusInput = z.input<typeof setAccountStatusInputSchema>;

// Inactivating the current primary account clears its own primary flag
// as part of the same mutation - "primary but inactive" is never a valid
// combination. This never auto-promotes a replacement (see the module
// doc comment on the primary invariant) - it deliberately leaves the
// Partner with no primary account until someone explicitly calls
// setPrimaryPartnerAccount.
export async function setPartnerAccountStatus(actor: ActorContext | null, partnerAccountRef: unknown, rawInput: unknown, requestId: string): Promise<PartnersServiceResult<PartnerAccountDto>> {
  const loaded = await loadAuthorizedAccount(actor, partnerAccountRef, "manage_partner_accounts");
  if (!loaded.ok) return loaded.error;

  const parsed = setAccountStatusInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const result = await runPartnerAccountMutation(loaded.account.uid, input.expectedVersion, (current) => ({
    ...current,
    status: input.status,
    primary: input.status === "INACTIVE" ? false : current.primary,
    updatedAt: new Date().toISOString(),
    updatedByUserRef: actor!.userRef,
  }));

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Partner Account not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Partner Account was changed elsewhere. Reload and try again." };

  await writePartnerEvent({ partnerUid: loaded.partner.uid, kind: "account_status_changed", actorUserRef: actor!.userRef, metadata: { to: input.status, partnerAccountRef: loaded.account.partnerAccountRef }, requestId });
  return { ok: true, data: toPartnerAccountDto(result.doc) };
}

// ---- Primary ----

const setPrimaryInputSchema = z.object({ expectedVersion: z.number().int().min(1) });
export type SetPrimaryPartnerAccountInput = z.input<typeof setPrimaryInputSchema>;

type SetPrimaryTxResult = { kind: "ok"; doc: PartnerAccountDoc } | { kind: "not_found" } | { kind: "stale" } | { kind: "inactive" };

// Transactional: demotes any other current primary account for this
// Partner and promotes the target in one atomic step, so "at most one
// active primary account per Partner" can never be observed violated
// even under concurrent requests.
export async function setPrimaryPartnerAccount(actor: ActorContext | null, partnerAccountRef: unknown, rawInput: unknown, requestId: string): Promise<PartnersServiceResult<PartnerAccountDto>> {
  const loaded = await loadAuthorizedAccount(actor, partnerAccountRef, "manage_partner_accounts");
  if (!loaded.ok) return loaded.error;

  const parsed = setPrimaryInputSchema.safeParse(rawInput);
  if (!parsed.success) return partnersInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const db = getAdminFirestore();
  const targetRef = partnerAccountsCollection().doc(loaded.account.uid);
  const now = new Date().toISOString();

  const result = await db.runTransaction<SetPrimaryTxResult>(async (tx) => {
    const targetSnap = await tx.get(targetRef);
    if (!targetSnap.exists) return { kind: "not_found" };
    const target = partnerAccountDocSchema.safeParse(targetSnap.data());
    if (!target.success) return { kind: "not_found" };
    if (target.data.version !== input.expectedVersion) return { kind: "stale" };
    if (target.data.status !== "ACTIVE") return { kind: "inactive" };

    const othersSnap = await tx.get(partnerAccountsCollection().where("partnerRef", "==", target.data.partnerRef).where("primary", "==", true).limit(5));

    for (const doc of othersSnap.docs) {
      if (doc.id === target.data.uid) continue;
      const other = partnerAccountDocSchema.safeParse(doc.data());
      if (other.success) tx.update(doc.ref, { primary: false, version: other.data.version + 1, updatedAt: now, updatedByUserRef: actor!.userRef });
    }

    const updated: PartnerAccountDoc = { ...target.data, primary: true, version: target.data.version + 1, updatedAt: now, updatedByUserRef: actor!.userRef };
    tx.set(targetRef, updated);
    return { kind: "ok", doc: updated };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Partner Account not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Partner Account was changed elsewhere. Reload and try again." };
  if (result.kind === "inactive") return partnersInvalidInputResult("Only an ACTIVE Partner Account can be set as primary.");

  await writePartnerEvent({ partnerUid: loaded.partner.uid, kind: "primary_account_changed", actorUserRef: actor!.userRef, metadata: { partnerAccountRef: loaded.account.partnerAccountRef }, requestId });
  return { ok: true, data: toPartnerAccountDto(result.doc) };
}
