"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

import { dismissNotification, getUnreadCount, listNotifications, markAllNotificationsRead, markNotificationRead } from "./api-client";
import { relativeTime } from "@/features/administration/format";
import { Icon } from "@/ui/icons";
import type { NotificationDto } from "@/server/notifications/client-dto";

// Topbar notification bell + anchored panel (spec section 14/15/16/26). Real-time behavior:
// refetch-on-focus/navigation + explicit local mutation updates (spec section 16's own "safest
// existing pattern" - this codebase has zero client-side Firestore listeners anywhere; every screen
// already fetches through a trusted API route, so this bell does the same rather than being the
// first thing in the product to open a live Firestore listener). Never a modal dialog - an anchored
// popover/drawer, matching the spec's own "panel/drawer" language (a deliberate, disclosed departure
// from the golden master's illustrative modal markup - see docs/CREATOROPS_CONTINUITY.md).
//
// The panel is rendered through a portal into document.body rather than inline under .topbar: the
// topbar's own `backdrop-filter` (foundation.css) establishes a containing block for any
// position:fixed DESCENDANT, which would otherwise confine the mobile full-height drawer to the
// topbar's own 58px-tall box instead of the viewport. Positioning is computed in JS for the
// desktop/tablet anchored popover; the mobile drawer's full-viewport inset comes from CSS alone (see
// foundation.css's own `@media(max-width:760px) .notifpanel` rule) with no inline override at that
// width, so the stylesheet's mobile rule always wins over any stale computed desktop position.

const UNREAD_BADGE_MAX = 9;
const MOBILE_BREAKPOINT = 760;

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [items, setItems] = useState<NotificationDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Imperative helper for the Retry button - calling setState from an event handler is ordinary
  // React, unlike the effects below.
  async function loadList() {
    setError(null);
    const result = await listNotifications("all");
    if (result.ok) setItems(result.data.notifications);
    else if (result.code !== "unauthorized") setError("Could not load notifications. Try again.");
  }

  // Refetch on mount and whenever the tab regains focus/visibility - the chosen "safest existing
  // pattern" real-time behavior (spec section 16), no listener, no polling loop. The fetch->setState
  // chain is inlined directly in the effect body (mirrors src/ui/GlobalSidebar.tsx's own `/api/me`
  // effect) with a `cancelled` guard so a stale response from an unmounted/re-effected instance never
  // applies.
  useEffect(() => {
    let cancelled = false;
    function refresh() {
      void getUnreadCount().then((result) => {
        if (!cancelled && result.ok) setUnreadCount(result.data.count);
      });
    }
    refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  // `items` starts null and is never reset to null on a later re-open, so a re-open shows the
  // last-known list immediately while a fresh fetch quietly replaces it - `items === null` is the
  // only "first ever load" signal this needs, with no separate loading boolean to set synchronously
  // in the effect body.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listNotifications("all").then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setItems(result.data.notifications);
        setError(null);
      } else if (result.code !== "unauthorized") {
        setError("Could not load notifications. Try again.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Anchors the portaled panel under the trigger button on desktop/tablet; the mobile full-height
  // drawer (<=760px) is CSS-only (see this file's own header comment), so no inline position is set
  // at that width and the stylesheet's own inset always wins.
  useLayoutEffect(() => {
    if (!open) return;
    function updatePosition() {
      if (window.innerWidth <= MOBILE_BREAKPOINT) {
        setPanelStyle({});
        return;
      }
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPanelStyle({ position: "fixed", top: rect.bottom + 8, right: Math.max(16, window.innerWidth - rect.right) });
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [open]);

  // Outside click + Escape close the panel (spec section 26: keyboard/focus). Initial focus moves
  // into the panel on open, and closing returns focus to the trigger - neither MultiSelectDropdown's
  // outside-click precedent nor DialogShell's modal focus trap covers both on their own. The panel is
  // portaled outside containerRef (see header comment), so "outside" means outside BOTH the trigger's
  // container and the portaled panel itself.
  useEffect(() => {
    if (!open) return;
    function onOutsideClick(e: MouseEvent) {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onOutsideClick);
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onOutsideClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function patchItem(notificationRef: string, patch: Partial<NotificationDto>) {
    setItems((current) => (current ? current.map((n) => (n.notificationRef === notificationRef ? { ...n, ...patch } : n)) : current));
  }

  async function handleOpenNotification(notification: NotificationDto) {
    setOpen(false);
    if (notification.unread) {
      patchItem(notification.notificationRef, { readAt: new Date().toISOString(), unread: false });
      setUnreadCount((count) => (count !== null ? Math.max(0, count - 1) : count));
      void markNotificationRead(notification.notificationRef);
    }
    router.push(notification.deepLink);
  }

  async function handleDismiss(notification: NotificationDto) {
    setBusyRef(notification.notificationRef);
    const wasUnread = notification.unread;
    const result = await dismissNotification(notification.notificationRef);
    setBusyRef(null);
    if (!result.ok) return;
    setItems((current) => (current ? current.filter((n) => n.notificationRef !== notification.notificationRef) : current));
    if (wasUnread) setUnreadCount((count) => (count !== null ? Math.max(0, count - 1) : count));
  }

  async function handleMarkAllRead() {
    setBusyRef("__all__");
    const result = await markAllNotificationsRead();
    setBusyRef(null);
    if (!result.ok) return;
    const now = new Date().toISOString();
    setItems((current) => (current ? current.map((n) => (n.unread ? { ...n, unread: false, readAt: now } : n)) : current));
    setUnreadCount(0);
  }

  const hasUnread = items?.some((n) => n.unread) ?? (unreadCount ?? 0) > 0;
  const badgeLabel = unreadCount === null || unreadCount === 0 ? null : unreadCount > UNREAD_BADGE_MAX ? `${UNREAD_BADGE_MAX}+` : String(unreadCount);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        className="iconbutton"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={badgeLabel ? `Notifications, ${unreadCount} unread` : "Notifications"}
        onClick={() => setOpen((value) => !value)}
        style={{ position: "relative" }}
      >
        <Icon name="bell" />
        {badgeLabel && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              minWidth: 16,
              height: 16,
              padding: "0 3px",
              borderRadius: 8,
              background: "var(--red)",
              color: "white",
              fontSize: 9,
              fontWeight: 700,
              display: "grid",
              placeItems: "center",
              lineHeight: 1,
              border: "1.5px solid white",
            }}
          >
            {badgeLabel}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div ref={panelRef} role="dialog" aria-label="Notifications" tabIndex={-1} className="notifpanel" style={panelStyle}>
          <div className="notifpanelhead">
            <h3>Notifications</h3>
            {hasUnread && (
              <button type="button" className="btn ghost" disabled={busyRef === "__all__"} onClick={() => void handleMarkAllRead()}>
                Mark all read
              </button>
            )}
          </div>
          <div className="notifpanelbody">
            {!items && !error && (
              <div style={{ padding: "18px 4px" }}>
                <div className="skeleton" />
                <div className="skeleton" />
                <div className="skeleton" />
              </div>
            )}
            {error && (
              <div className="notifempty">
                <p>{error}</p>
                <button type="button" className="btn" onClick={() => void loadList()}>
                  Retry
                </button>
              </div>
            )}
            {!error && items && items.length === 0 && (
              <div className="notifempty">
                <Icon name="bell" style={{ width: 22, height: 22, color: "#9ba5b1" }} />
                <p>You&apos;re all caught up.</p>
              </div>
            )}
            {!error &&
              items &&
              items.map((notification) => (
                <div key={notification.notificationRef} className={notification.unread ? "notifitem unread" : "notifitem"}>
                  <button type="button" className="notifitembody" onClick={() => void handleOpenNotification(notification)}>
                    <span className="notifdot" aria-hidden="true" />
                    <span className="grow">
                      <strong>{notification.title}</strong>
                      <small>{notification.bodyPreview}</small>
                      <small className="notiftime">
                        {relativeTime(notification.createdAt)}
                        {notification.unread ? " · Unread" : ""}
                      </small>
                    </span>
                  </button>
                  <button type="button" className="notifdismiss" aria-label={`Dismiss "${notification.title}"`} disabled={busyRef === notification.notificationRef} onClick={() => void handleDismiss(notification)}>
                    <Icon name="x" style={{ width: 13, height: 13 }} />
                  </button>
                </div>
              ))}
          </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
