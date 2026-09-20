"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { isModuleTabActive, type ModuleTab } from "./module-tabs-active";

export type { ModuleTab } from "./module-tabs-active";

// Route-based sibling-page tabs (docs/reference/CreatorOps_UI_Golden_Master.html
// switches these via in-page state since it's a single-page prototype; this app
// uses real routes per module screen, so tabs are real links instead).
//
// Step 12F (additive, default behavior unchanged for every other module):
//   - a tab may declare `activePrefixes` (see module-tabs-active.ts);
//   - `scrollActiveIntoView` (opt-in, Analytics only) brings the current tab
//     into view INSIDE the tab row on mount, by setting the row's own
//     scrollLeft - never scrollIntoView, so the document can never jump.
export function ModuleTabs({ tabs, scope = "Global scope preview", scrollActiveIntoView = false }: { tabs: ModuleTab[]; scope?: string; scrollActiveIntoView?: boolean }) {
  const pathname = usePathname();
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollActiveIntoView) return;
    const row = rowRef.current;
    const active = row?.querySelector<HTMLElement>(".tab.active");
    if (!row || !active) return;
    const rowRect = row.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    if (tabRect.left < rowRect.left) row.scrollLeft += tabRect.left - rowRect.left;
    else if (tabRect.right > rowRect.right) row.scrollLeft += tabRect.right - rowRect.right;
  }, [scrollActiveIntoView, pathname]);

  return (
    <div className="tabsbar">
      <div className="tabs" ref={rowRef}>
        {tabs.map((tab) => {
          const active = isModuleTabActive(pathname, tab);
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
