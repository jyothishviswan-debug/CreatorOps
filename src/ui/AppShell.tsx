"use client";

import { useState, type ReactNode } from "react";

import { GlobalSidebar } from "./GlobalSidebar";
import { Topbar } from "./Topbar";

export function AppShell({
  crumb,
  children,
}: {
  crumb: string;
  children: ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <GlobalSidebar open={navOpen} />
      <button
        className="backdrop"
        aria-label="Close navigation"
        onClick={() => setNavOpen(false)}
      />
      <div className="app">
        <Topbar crumb={crumb} onMenuClick={() => setNavOpen((value) => !value)} />
        <main className="main" id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </>
  );
}
