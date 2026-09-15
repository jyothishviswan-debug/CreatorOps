"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type ModuleTab = { label: string; href: string };

// Route-based sibling-page tabs (docs/reference/CreatorOps_UI_Golden_Master.html
// switches these via in-page state since it's a single-page prototype; this app
// uses real routes per module screen, so tabs are real links instead).
export function ModuleTabs({ tabs, scope = "Global scope preview" }: { tabs: ModuleTab[]; scope?: string }) {
  const pathname = usePathname();
  return (
    <div className="tabsbar">
      <div className="tabs">
        {tabs.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link key={tab.href} href={tab.href} className={active ? "tab active" : "tab"} aria-current={active ? "page" : undefined}>
              {tab.label}
            </Link>
          );
        })}
      </div>
      <span className="scope">
        <i className="dot" />
        {scope} <span style={{ margin: "0 6px" }}>&middot;</span> September 2026
      </span>
    </div>
  );
}
