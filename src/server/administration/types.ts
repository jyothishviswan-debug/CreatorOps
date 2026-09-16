import type { AdministrationDenialReason } from "@/server/authz/administration-gate";
import type { Role } from "@/server/authz/roles";
import type { UserDoc } from "@/server/authz/types";

// Every Administration service function returns this instead of throwing
// for *expected* failure modes (denied, not found, bad input, stale
// write, the last-Super-Admin guard) - callers (API routes) map the code
// straight to an HTTP status. A thrown exception is reserved for genuine
// bugs/infrastructure failures, never for "the request was invalid".
export type ServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "conflict" | "internal";

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; code: ServiceErrorCode; message: string; reason?: AdministrationDenialReason };

export function unauthorizedResult<T>(reason: AdministrationDenialReason): ServiceResult<T> {
  return { ok: false, code: "unauthorized", message: `Administration access denied (${reason}).`, reason };
}

export function invalidInputResult<T>(message: string): ServiceResult<T> {
  return { ok: false, code: "invalid_input", message };
}

// The only shape of a user ever handed to the browser: no Firebase uid,
// no internal Firestore document id - `userRef` is the sole reference a
// client can hold. `version` is not a secret, just an optimistic-
// concurrency token the client must echo back on the next update.
export type AdminUserDto = {
  userRef: string;
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
  version: number;
};

export function toAdminUserDto(doc: UserDoc): AdminUserDto {
  return {
    userRef: doc.userRef,
    email: doc.email,
    displayName: doc.displayName,
    role: doc.role,
    active: doc.active,
    version: doc.version,
  };
}
