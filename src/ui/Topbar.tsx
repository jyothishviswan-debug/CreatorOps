"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Icon } from "./icons";
import { signOutEverywhere } from "@/lib/auth/signOut";

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    await signOutEverywhere();
    router.push("/sign-in");
    router.refresh();
  }

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
        {/* No Notifications subsystem exists yet (recipient-scoped in-app attention is a tracked master-scope gap); inert, not a live bell. */}
        <button className="iconbutton" aria-label="Notifications (not available yet)" title="Notifications are not available yet" type="button" disabled aria-disabled="true" style={{ opacity: 0.6, cursor: "not-allowed" }}>
          <Icon name="bell" />
        </button>
        <button className="iconbutton" aria-label="Sign out" type="button" onClick={handleSignOut} disabled={signingOut}>
          <Icon name="logout" />
        </button>
        <span className="avatar">SA</span>
      </div>
    </header>
  );
}
