"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Icon } from "./icons";
import { NAV_GROUPS } from "./nav-items";
import { initialsOf } from "@/features/shared/types";
import type { FeatureId } from "@/server/authz/features";
import { ROLE_LABELS, isRole } from "@/server/authz/roles";

type MeResponse =
  | { authenticated: false }
  | { authenticated: true; role: string; displayName: string; activeFeatures: FeatureId[] };

export function GlobalSidebar({ open }: { open: boolean }) {
  const pathname = usePathname();
  const [me, setMe] = useState<MeResponse | null>(null);

  // Presentational only - filters which nav items are worth showing. The
  // server independently re-checks feature access on every route via
  // proxy.ts regardless of what this fetch returns; losing or delaying
  // it can at worst show an item that then 404s-to-access-denied on
  // click, never grant anything.
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

  const activeFeatures = me?.authenticated ? new Set(me.activeFeatures) : null;
  const roleLabel = me?.authenticated && isRole(me.role) ? ROLE_LABELS[me.role] : "Illustrative workspace";
  const displayName = me?.authenticated ? me.displayName : "Super Admin";

  return (
    <aside className={open ? "sidebar open" : "sidebar"} id="sidebar">
      <div className="brand">
        <span className="brandmark">
          <Image src="/logo.png" alt="" width={20} height={20} style={{ filter: "brightness(0) invert(1)" }} />
        </span>
        <div className="brandname">
          CreatorOps
          <small>PARTNERSHIP WORKSPACE</small>
        </div>
      </div>
      <nav aria-label="Global navigation">
        {NAV_GROUPS.map((group) => {
          const items = activeFeatures ? group.items.filter((item) => activeFeatures.has(item.feature)) : group.items;
          if (items.length === 0) return null;
          return (
            <div key={group.label ?? "root"}>
              {group.label && <div className="navgroup">{group.label}</div>}
              {items.map((item) => {
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={active ? "navitem active" : "navitem"}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          );
        })}
        {/* Dev-only preview link, not a real feature - never feature-gated, never routed through this app's own
            build. Opens the visual-rewrite worktree, a separate `next dev` instance on its own port (see
            VISUAL_REWRITE_REPORT.md), in a new tab so it never navigates away from the live session. */}
        <div>
          <div className="navgroup">PREVIEW</div>
          <a href="http://localhost:3001" target="_blank" rel="noopener noreferrer" className="navitem">
            <Icon name="eye" />
            <span>v2</span>
          </a>
        </div>
      </nav>
      <div className="sidebarfoot">
        <span className="avatar">{initialsOf(roleLabel)}</span>
        <div>
          {roleLabel}
          <small style={{ display: "block" }}>{displayName}</small>
        </div>
      </div>
    </aside>
  );
}
