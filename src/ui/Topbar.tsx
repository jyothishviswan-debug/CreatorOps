"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Icon } from "./icons";
import { signOutEverywhere } from "@/lib/auth/signOut";
import { NotificationBell } from "@/features/notifications/NotificationBell";
import type { MeResponse } from "./current-actor";
import { initialsOf } from "@/features/shared/types";
import { ROLE_LABELS, isRole } from "@/server/authz/roles";

export function Topbar({ onMenuClick, me }: { onMenuClick: () => void; me: MeResponse | null }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    await signOutEverywhere();
    router.push("/sign-in");
    router.refresh();
  }

  // Production hardening (base spec section 25): previously a hardcoded `<span
  // className="avatar">SA</span>` never wired to the real signed-in user (carried debt, see
  // docs/PRODUCTION_HARDENING.md). Now sourced from the same /api/me DTO GlobalSidebar's own
  // identical avatar already uses (role-label initials, e.g. "Super Admin" -> "SA") - kept
  // consistent with that existing convention rather than switching to personal-name initials, so
  // the two avatars in the shell never disagree. `me` is presentational only (see /api/me's own
  // comment) and is never the authorization boundary; before it resolves (or on any fetch failure)
  // this renders the same neutral generic-account fallback the sidebar already uses, never a UID or
  // email.
  const roleLabel = me?.authenticated && isRole(me.role) ? ROLE_LABELS[me.role] : "Illustrative workspace";
  const avatarInitials = initialsOf(roleLabel);

  return (
    <header className="topbar">
      <button
        className="iconbutton menu"
        aria-label="Open navigation"
        aria-expanded="false"
        onClick={onMenuClick}
      >
        ☰
      </button>
      <div className="topactions" style={{ marginLeft: "auto" }}>
        {/* Whole-product integration: no global-search subsystem exists (no bounded cross-module search service, and unrestricted
            Firestore search is out of bounds), so this affordance is honestly inert rather than a dead-looking live control. */}
        <button className="searchtrigger" type="button" disabled aria-disabled="true" title="Global search is not available yet" style={{ opacity: 0.6, cursor: "not-allowed" }}>
          <Icon name="search" />
          <span>Find a module or pattern</span>
          <kbd className="key">⌘ K</kbd>
        </button>
        <span className="sample">ILLUSTRATIVE DATA</span>
        {/* Recipient-Scoped Notifications Completion: a real, server-backed, recipient-scoped bell
            (src/server/notifications) - never client-filtered, never a second design system. */}
        <NotificationBell />
        <button className="iconbutton" aria-label="Sign out" type="button" onClick={handleSignOut} disabled={signingOut}>
          <Icon name="logout" />
        </button>
        <span className="avatar" aria-label={`Signed in as ${roleLabel}`}>{avatarInitials}</span>
      </div>
    </header>
  );
}
