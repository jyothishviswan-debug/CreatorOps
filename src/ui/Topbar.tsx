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
        <button className="searchtrigger" type="button">
          <Icon name="search" />
          <span>Find a module or pattern</span>
          <kbd className="key">⌘ K</kbd>
        </button>
        <span className="sample">ILLUSTRATIVE DATA</span>
        <button className="iconbutton" aria-label="Preview notifications" type="button">
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
