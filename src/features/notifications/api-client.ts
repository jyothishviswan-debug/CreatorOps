// Thin client-side fetch wrappers around the trusted `/api/notifications*` routes - the ONLY way the
// topbar bell touches notification data. Every call hits a real route that independently
// re-authorizes the caller server-side (see src/server/notifications/notifications-gate.ts). Mirrors
// src/features/vendors/api-client.ts's own ApiResult shape.
import type { NotificationDto } from "@/server/notifications/client-dto";

export type NotificationsApiErrorCode = "unauthorized" | "not_found" | "invalid_input" | "conflict" | "internal" | "network_error";
export type NotificationsApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: NotificationsApiErrorCode; error: string };

async function call<T>(input: string, init?: RequestInit): Promise<NotificationsApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(input, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
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
    // No JSON body - keep the generic message.
  }

  const code: NotificationsApiErrorCode = res.status === 401 || res.status === 403 ? "unauthorized" : res.status === 404 ? "not_found" : res.status === 409 ? "conflict" : res.status === 400 ? "invalid_input" : "internal";
  return { ok: false, status: res.status, code, error };
}

export type ListNotificationsResponse = { notifications: NotificationDto[]; nextCursor: string | null };

export function listNotifications(status: "unread" | "all" | "dismissed" = "all", cursor?: string | null) {
  const params = new URLSearchParams({ status });
  if (cursor) params.set("cursor", cursor);
  return call<ListNotificationsResponse>(`/api/notifications?${params.toString()}`);
}

export function getUnreadCount() {
  return call<{ count: number }>("/api/notifications/unread-count");
}

export function markNotificationRead(notificationRef: string) {
  return call<NotificationDto>(`/api/notifications/${encodeURIComponent(notificationRef)}/read`, { method: "POST" });
}

export function dismissNotification(notificationRef: string) {
  return call<NotificationDto>(`/api/notifications/${encodeURIComponent(notificationRef)}/dismiss`, { method: "POST" });
}

export function markAllNotificationsRead() {
  return call<{ updated: number; hasMore: boolean }>("/api/notifications/mark-all-read", { method: "POST" });
}
