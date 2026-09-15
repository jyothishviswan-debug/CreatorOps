"use client";

import type { ReactNode } from "react";

export type LocalTab = {
  key: string;
  label: string;
};

export function LocalTabs({
  tabs,
  active,
  onChange,
  trailing,
}: {
  tabs: LocalTab[];
  active: string;
  onChange: (key: string) => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="tabsbar">
      <div className="tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={tab.key === active}
            className={tab.key === active ? "tab active" : "tab"}
            onClick={() => onChange(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {trailing}
    </div>
  );
}

export function ScopeLine({ label }: { label: string }) {
  return (
    <div className="scope">
      <span className="dot" />
      {label}
    </div>
  );
}
