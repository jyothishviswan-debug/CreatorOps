"use client";

import Link from "next/link";

import { Pill } from "@/ui/Badge";
import { Icon } from "@/ui/icons";
import type { ReportDefinitionDto } from "@/server/reports";

import { REPORT_FAMILY_GROUPS } from "../copy";

export type ReportsCatalogProps = {
  definitions: ReportDefinitionDto[];
  canRunReports: boolean;
};

// Step 19B: the governed report catalog, organized by the same family groups catalog.ts's own
// comments already establish (section 12 "high-value" six / additional fully-executed three /
// Step 19A.1 management-scale four) - a real existing grouping, not an invented one. Every entry
// here has executionSupport "full" (13/13 as of Step 19A.1) - no "coming soon" language anywhere.
export function ReportsCatalog({ definitions, canRunReports }: ReportsCatalogProps) {
  const byId = new Map(definitions.map((d) => [d.reportId, d]));

  return (
    <>
      {REPORT_FAMILY_GROUPS.map((group) => {
        const entries = group.reportIds.map((id) => byId.get(id)).filter((d): d is ReportDefinitionDto => d !== undefined);
        if (entries.length === 0) return null;
        return (
          <section key={group.key} style={{ marginBottom: 28 }} data-testid="report-family-group" data-family={group.key}>
            <div className="sectionlabel">
              <span>{entries.length}</span>
              <div>
                <h2>{group.label}</h2>
                <p>{group.description}</p>
              </div>
            </div>
            <div className="recordgrid" data-testid="report-catalog-grid">
              {entries.map((def) => (
                <article className="record" key={def.reportId} data-testid="report-catalog-card" data-report-id={def.reportId}>
                  <b>{def.title}</b>
                  <p className="foundationnote" style={{ margin: "8px 0 12px" }}>
                    {def.purpose}
                  </p>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                    {def.sourceModules.map((m) => (
                      <Pill tone="gray" key={m}>
                        {m}
                      </Pill>
                    ))}
                  </div>
                  <div className="recordmeta">
                    <span>Bounded to {def.maxRows} rows</span>
                    <span>{def.supportedFilters.length} filter{def.supportedFilters.length === 1 ? "" : "s"}</span>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <Link className="btn" style={{ width: "100%" }} href={`/reports/${def.reportId}`} data-testid="open-report">
                      <Icon name={canRunReports ? "chart" : "eye"} />
                      {canRunReports ? "Configure & run" : "View (safe run)"}
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
