"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Icon } from "./icons";
import { NAV_GROUPS } from "./nav-items";

export function GlobalSidebar({ open }: { open: boolean }) {
  const pathname = usePathname();

  return (
    <aside className={open ? "sidebar open" : "sidebar"} id="sidebar">
      <div className="brand">
        <span className="brandmark">c</span>
        <div className="brandname">
          CreatorOps
          <small>PARTNERSHIP WORKSPACE</small>
        </div>
      </div>
      <nav aria-label="Global navigation">
        {NAV_GROUPS.map((group) => (
          <div key={group.label ?? "root"}>
            {group.label && <div className="navgroup">{group.label}</div>}
            {group.items.map((item) => {
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
        ))}
      </nav>
      <div className="sidebarfoot">
        <span className="avatar">SA</span>
        <div>
          Super Admin
          <small style={{ display: "block" }}>Illustrative workspace</small>
        </div>
      </div>
    </aside>
  );
}
