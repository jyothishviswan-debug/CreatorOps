"use client";

import { useEffect, useState, type ReactNode } from "react";

import { GlobalSidebar } from "./GlobalSidebar";
import { Topbar } from "./Topbar";
import type { MeResponse } from "./current-actor";

export function AppShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const [me, setMe] = useState<MeResponse | null>(null);

  // Production hardening (base spec section 25): the single fetch of the signed-in actor's own
  // safe presentation DTO, shared by both GlobalSidebar (nav filtering + its own identity line) and
  // Topbar (the avatar - previously a hardcoded "SA" span never wired to the real signed-in user,
  // per the carried debt at Topbar.tsx:46). Lifting the fetch here instead of each child doing its
  // own /api/me call avoids a duplicate-request pattern (spec section 16's fan-out review) - one
  // request per page load, not two. Never trusted for enforcement; proxy.ts independently re-checks
  // every protected route server-side regardless of what this returns (see /api/me's own comment).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/me")
      .then((res) => res.json() as Promise<MeResponse>)
      .then((data) => {
        if (!cancelled) setMe(data);
      })
      .catch(() => {
        if (!cancelled) setMe({ authenticated: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <GlobalSidebar open={navOpen} me={me} />
      <button
        className="backdrop"
        aria-label="Close navigation"
        onClick={() => setNavOpen(false)}
      />
      <div className="app">
        <Topbar onMenuClick={() => setNavOpen((value) => !value)} me={me} />
        <main className="main" id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </>
  );
}
