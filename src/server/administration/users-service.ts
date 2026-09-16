import { z } from "zod";

import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { requireAdministrationAccess } from "@/server/authz/administration-gate";
import { hasAnotherActiveAdminManager, readerFor, resolveCandidateCapability } from "@/server/authz/admin-manager-guard";
import { writeAuditEvent } from "@/server/authz/audit";
import { COLLECTIONS, DEFAULT_LIST_PAGE_SIZE, getUserDoc, getUserDocByRef, listUserDocs, type UserListCursor } from "@/server/authz/firestore";
import { roleSchema, userDocSchema, type ActorContext, type UserDoc } from "@/server/authz/types";
import { generateUserRef } from "@/server/authz/user-ref";
import { invalidInputResult, toAdminUserDto, unauthorizedResult, type AdminUserDto, type ServiceResult } from "./types";

// ---- List ----

const listUsersInputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.object({ email: z.string().min(1), userRef: z.string().min(1) }).optional(),
  role: roleSchema.optional(),
  active: z.boolean().optional(),
  // A bounded email-prefix search, not a substring filter over a
  // preloaded page - see listUserDocs. Lowercased so a search box that
  // doesn't itself normalize case still matches seeded/created
  // lowercase emails.
  emailPrefix: z.string().min(1).optional(),
});

export type ListUsersInput = z.input<typeof listUsersInputSchema>;

export async function listUsers(
  actor: ActorContext | null,
  rawInput: unknown,
): Promise<ServiceResult<{ users: AdminUserDto[]; nextCursor: UserListCursor | null }>> {
  if (!actor) return unauthorizedResult("not_authenticated");
  const gate = await requireAdministrationAccess(actor, "manage_users");
  if (!gate.ok) return unauthorizedResult(gate.reason);

  const parsed = listUsersInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const page = await listUserDocs({
    limit: parsed.data.limit ?? DEFAULT_LIST_PAGE_SIZE,
    cursor: parsed.data.cursor,
    role: parsed.data.role,
    active: parsed.data.active,
    emailPrefix: parsed.data.emailPrefix?.toLowerCase(),
  });
  return { ok: true, data: { users: page.users.map(toAdminUserDto), nextCursor: page.nextCursor } };
}

// ---- Get one ----

export async function getUser(actor: ActorContext | null, userRef: unknown): Promise<ServiceResult<AdminUserDto>> {
  if (!actor) return unauthorizedResult("not_authenticated");
  const gate = await requireAdministrationAccess(actor, "manage_users");
  if (!gate.ok) return unauthorizedResult(gate.reason);

  if (typeof userRef !== "string" || userRef.length === 0) return invalidInputResult("Missing userRef.");

  const doc = await getUserDocByRef(userRef);
  if (!doc) return { ok: false, code: "not_found", message: "User not found." };

  return { ok: true, data: toAdminUserDto(doc) };
}

// ---- Create / provision (idempotent by email) ----

const createUserInputSchema = z.object({
  email: z.string().min(3).email(),
  password: z.string().min(8),
  displayName: z.string().min(1),
  role: roleSchema,
});

export type CreateUserInput = z.input<typeof createUserInputSchema>;

function isFirebaseAuthError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}

export async function createUser(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<ServiceResult<AdminUserDto>> {
  if (!actor) return unauthorizedResult("not_authenticated");
  const gate = await requireAdministrationAccess(actor, "manage_users");
  if (!gate.ok) return unauthorizedResult(gate.reason);

  const parsed = createUserInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const auth = getAdminAuth();
  const db = getAdminFirestore();

  // Idempotent by email: if the Auth user already exists (this request is
  // a retry, or the email was already provisioned), reuse it instead of
  // erroring or creating a duplicate.
  let authUser;
  try {
    authUser = await auth.getUserByEmail(input.email);
  } catch (error) {
    if (!isFirebaseAuthError(error, "auth/user-not-found")) {
      return { ok: false, code: "internal", message: "Failed to look up the Auth emulator user." };
    }
    try {
      authUser = await auth.createUser({ email: input.email, password: input.password, displayName: input.displayName, emailVerified: true });
    } catch (createError) {
      // Two concurrent create requests for the same new email: the loser
      // of the race just fetches what the winner created.
      if (!isFirebaseAuthError(createError, "auth/email-already-exists")) {
        return { ok: false, code: "internal", message: "Failed to create the Auth emulator user." };
      }
      authUser = await auth.getUserByEmail(input.email);
    }
  }

  const existingDoc = await getUserDoc(authUser.uid);
  if (existingDoc) {
    // Already provisioned - idempotent no-op. Nothing changed, so no new
    // audit event is written (the original creation already has one).
    return { ok: true, data: toAdminUserDto(existingDoc) };
  }

  const userDoc: UserDoc = {
    uid: authUser.uid,
    email: input.email,
    role: input.role,
    active: true,
    displayName: input.displayName,
    userRef: generateUserRef(),
    version: 1,
  };
  await db.collection(COLLECTIONS.users).doc(authUser.uid).set(userDoc);

  await writeAuditEvent({
    operation: "user.create",
    actor,
    actorUserRef: actor.userRef,
    target: { uid: userDoc.uid, userRef: userDoc.userRef, email: userDoc.email },
    targetRole: userDoc.role,
    before: null,
    after: { email: userDoc.email, displayName: userDoc.displayName, role: userDoc.role, active: userDoc.active },
    requestId,
  });

  return { ok: true, data: toAdminUserDto(userDoc) };
}

// ---- Update profile (displayName / role / active) ----

const updateUserInputSchema = z
  .object({
    displayName: z.string().min(1).optional(),
    role: roleSchema.optional(),
    active: z.boolean().optional(),
    expectedVersion: z.number().int().min(1),
  })
  .refine((patch) => patch.displayName !== undefined || patch.role !== undefined || patch.active !== undefined, {
    message: "At least one of displayName, role, active must be provided.",
  });

export type UpdateUserInput = z.input<typeof updateUserInputSchema>;

export async function updateUser(actor: ActorContext | null, userRef: unknown, rawInput: unknown, requestId: string): Promise<ServiceResult<AdminUserDto>> {
  if (!actor) return unauthorizedResult("not_authenticated");
  const gate = await requireAdministrationAccess(actor, "manage_users");
  if (!gate.ok) return unauthorizedResult(gate.reason);

  if (typeof userRef !== "string" || userRef.length === 0) return invalidInputResult("Missing userRef.");

  const parsed = updateUserInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const { expectedVersion, ...patch } = parsed.data;

  const targetDoc = await getUserDocByRef(userRef);
  if (!targetDoc) return { ok: false, code: "not_found", message: "User not found." };

  const db = getAdminFirestore();
  const docRef = db.collection(COLLECTIONS.users).doc(targetDoc.uid);

  type TxResult = { kind: "ok"; doc: UserDoc } | { kind: "stale" } | { kind: "last_admin_manager" } | { kind: "not_found" };

  const result = await db.runTransaction<TxResult>(async (tx) => {
    // Reads before writes, always - this is a hard Firestore transaction
    // requirement, not just a style preference.
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };

    const parsedCurrent = userDocSchema.safeParse(snap.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const current = parsedCurrent.data;

    if (current.version !== expectedVersion) return { kind: "stale" };

    const nextRole = patch.role ?? current.role;
    const nextActive = patch.active ?? current.active;
    const reader = readerFor(tx);

    // Effective-access-based, not role-label-based: resolve whether this
    // user currently has full Administration-manager capability (role
    // baseline + their own overrides + GLOBAL scope, exactly like a live
    // request would), and whether they'd still have it after this patch
    // (a role change re-evaluates against the NEW role's baseline; their
    // overrides/scope are unaffected by a profile update, so those are
    // read once and reused for both the "before" and "after" check).
    const hadCapability = await resolveCandidateCapability(reader, { uid: current.uid, role: current.role, active: current.active });
    const wouldStillHaveCapability = patch.role === undefined && patch.active === undefined ? hadCapability : await resolveCandidateCapability(reader, { uid: current.uid, role: nextRole, active: nextActive });

    if (hadCapability && !wouldStillHaveCapability) {
      // Still reads, still before any write in this transaction - a
      // bounded scan for any OTHER active user who currently resolves to
      // full Administration-manager capability.
      const another = await hasAnotherActiveAdminManager(current.uid, tx);
      if (!another) return { kind: "last_admin_manager" };
    }

    const updated: UserDoc = {
      ...current,
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      version: current.version + 1,
    };
    tx.set(docRef, updated);
    return { kind: "ok", doc: updated };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "User not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "The user was modified by someone else. Reload and try again." };
  if (result.kind === "last_admin_manager") {
    return { ok: false, code: "conflict", message: "Refusing to change this user: they are the last active user who can fully administer users and access." };
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (patch.displayName !== undefined) {
    before.displayName = targetDoc.displayName;
    after.displayName = patch.displayName;
  }
  if (patch.role !== undefined) {
    before.role = targetDoc.role;
    after.role = patch.role;
  }
  if (patch.active !== undefined) {
    before.active = targetDoc.active;
    after.active = patch.active;
  }

  const operation = patch.role !== undefined ? "user.role_change" : patch.active === false ? "user.deactivate" : patch.active === true ? "user.activate" : "user.update";

  await writeAuditEvent({
    operation,
    actor,
    actorUserRef: actor.userRef,
    target: { uid: targetDoc.uid, userRef: targetDoc.userRef, email: targetDoc.email },
    targetRole: result.doc.role,
    before,
    after,
    requestId,
  });

  return { ok: true, data: toAdminUserDto(result.doc) };
}
