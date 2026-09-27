"use client";

import { useState } from "react";

import { LocalTabs } from "@/ui/LocalTabs";

import { ImportCenterWizard } from "./ImportCenterWizard";
import { ImportHistoryPanel } from "./ImportHistoryPanel";

// Import Center Completion - the page-level tab switch between running a
// new governed import and reviewing History/Provenance of past runs.
export function ImportCenterTabs() {
  const [tab, setTab] = useState<"import" | "history">("import");
  return (
    <div>
      <LocalTabs
        tabs={[
          { key: "import", label: "New import" },
          { key: "history", label: "History" },
        ]}
        active={tab}
        onChange={(key) => setTab(key as "import" | "history")}
      />
      {tab === "import" ? <ImportCenterWizard /> : <ImportHistoryPanel />}
    </div>
  );
}
