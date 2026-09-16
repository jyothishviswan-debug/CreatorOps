// Thin client-side fetch wrappers around the Step 5A trusted Administration
// API routes. This is the ONLY way any Administration screen mutates data -
// every call here hits a real `/api/administration/*` route, which
// independently re-verifies the actor server-side; nothing here trusts or
// interprets access on its own. Types are imported with `import type` only,
// so nothing server-only (firebase-admin, etc.) ever reaches the client
// bundle - just the shape of the request/response.
import type { AdminUserDto, ServiceErrorCode } from "@/server/administration/types";
import type { UserListCursor } from "@/server/authz/firestore";
import type { CreateUserInput, ListUsersInput, UpdateUserInput } from "@/server/administration/users-service";
import type { ScopeGrantRequestInput } from "@/server/administration/scope-grants-service";
import type { SensitiveGrantRequestInput } from "@/server/administration/sensitive-grants-service";
import type { EffectiveAccessDto } from "@/server/administration/effective-access-service";
import type { BulkOverrideInput, SetOverrideInput } from "@/server/administration/access-overrides-service";
import type { AuditEventDto, ListAuditInput } from "@/server/administration/audit-service";
import type { AuditEventListCursor } from "@/server/authz/audit";
import type { Role } from "@/server/authz/roles";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: ServiceErrorCode | "network_error"; error: string };

async function call<T>(input: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(input, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    return { ok: false, status: 0, code: "network_error", error: "Could not reach the server. Check your connection and try again." };
  }

  if (res.ok) {
    const data = (await res.json()) as T;
    return { ok: true, data };
  }

  let error = "Something went wrong.";
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === "string") error = body.error;
  } catch {
    // Response had no JSON body - keep the generic message.
  }

  const code: ServiceErrorCode =
    res.status === 401 || res.status === 403
      ? "unauthorized"
      : res.status === 404
        ? "not_found"
        : res.status === 400
          ? "invalid_input"
          : res.status === 409
            ? "conflict"
            : "internal";

  return { ok: false, status: res.status, code, error };
}

function query(params: Record<string, string | undefined>): string {
  const usable = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined);
  if (usable.length === 0) return "";
  return `?${new URLSearchParams(usable).toString()}`;
}

export type ListUsersResult = { users: AdminUserDto[]; nextCursor: UserListCursor | null };

export function listUsers(input: ListUsersInput = {}): Promise<ApiResult<ListUsersResult>> {
  const qs = query({
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    cursorEmail: input.cursor?.email,
    cursorUserRef: input.cursor?.userRef,
    role: input.role,
    active: input.active !== undefined ? String(input.active) : undefined,
    emailPrefix: input.emailPrefix,
  });
  return call(`/api/administration/users${qs}`);
}

export function createUser(input: CreateUserInput): Promise<ApiResult<AdminUserDto>> {
  return call("/api/administration/users", { method: "POST", body: JSON.stringify(input) });
}

export function getUser(userRef: string): Promise<ApiResult<AdminUserDto>> {
  return call(`/api/administration/users/${encodeURIComponent(userRef)}`);
}

export function updateUser(userRef: string, patch: UpdateUserInput): Promise<ApiResult<AdminUserDto>> {
  return call(`/api/administration/users/${encodeURIComponent(userRef)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function getEffectiveAccess(userRef: string): Promise<ApiResult<EffectiveAccessDto>> {
  return call(`/api/administration/users/${encodeURIComponent(userRef)}/effective-access`);
}

export function setAccessOverride(userRef: string, input: SetOverrideInput): Promise<ApiResult<{ version: number }>> {
  return call(`/api/administration/users/${encodeURIComponent(userRef)}/access-overrides`, { method: "PATCH", body: JSON.stringify(input) });
}

export function bulkSetAccessOverrides(userRef: string, input: BulkOverrideInput): Promise<ApiResult<{ version: number }>> {
  return call(`/api/administration/users/${encodeURIComponent(userRef)}/access-overrides/bulk`, { method: "POST", body: JSON.stringify(input) });
}

export function addScopeGrant(userRef: string, grant: ScopeGrantRequestInput): Promise<ApiResult<{ created: boolean }>> {
  return call(`/api/administration/users/${encodeURIComponent(userRef)}/scope-grants`, { method: "POST", body: JSON.stringify(grant) });
}

export function removeScopeGrant(userRef: string, grant: ScopeGrantRequestInput): Promise<ApiResult<{ removed: boolean }>> {
  return call(`/api/administration/users/${encodeURIComponent(userRef)}/scope-grants`, { method: "DELETE", body: JSON.stringify(grant) });
}

export function getSensitiveGrants(role: Role): Promise<ApiResult<{ role: Role; categories: string[] }>> {
  return call(`/api/administration/roles/${encodeURIComponent(role)}/sensitive-grants`);
}

export function addSensitiveGrant(role: Role, input: SensitiveGrantRequestInput): Promise<ApiResult<{ categories: string[] }>> {
  return call(`/api/administration/roles/${encodeURIComponent(role)}/sensitive-grants`, { method: "POST", body: JSON.stringify(input) });
}

export function removeSensitiveGrant(role: Role, input: SensitiveGrantRequestInput): Promise<ApiResult<{ categories: string[] }>> {
  return call(`/api/administration/roles/${encodeURIComponent(role)}/sensitive-grants`, { method: "DELETE", body: JSON.stringify(input) });
}

export type ListAuditResult = { events: AuditEventDto[]; nextCursor: AuditEventListCursor | null };

export function listAuditEvents(input: ListAuditInput = {}): Promise<ApiResult<ListAuditResult>> {
  const qs = query({
    limit: input.limit !== undefined ? String(input.limit) : undefined,
    cursorCreatedAt: input.cursor?.createdAt,
    cursorRequestId: input.cursor?.requestId,
  });
  return call(`/api/administration/audit${qs}`);
}
