"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/ui/Button";
import { Icon } from "@/ui/icons";
import { EmptyState, Skeleton } from "@/ui/States";
import type { ReportDefinitionDto, ReportResultDto, ReportsPermissionsDto } from "@/server/reports";

import { finalizeReportRun, runReportFull, runReportViewerSafe, type ReportsApiResult } from "../api-client";
import { VIEWER_SAFE_BLOCKED_REPORT_IDS } from "../copy";
import { ReportFiltersForm } from "../filters/ReportFiltersForm";
import { ReportResultView } from "../result/ReportResultView";

export type ReportRunnerProps = {
  definition: ReportDefinitionDto;
  permissions: ReportsPermissionsDto;
};

type RunState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "loaded"; result: ReportResultDto; viewerSafe: boolean };

// Step 19B: configure a single report's own declared filters, run it (full run when the actor holds
// run_reports; the sanctioned viewer-safe path otherwise), and view the governed result. Also offers
// Finalize (same run_reports permission the real /api/reports/finalize route requires - see
// report-service.ts's runReport, which finalize calls with no viewerSafe flag). Every number here
// comes straight from the ReportResult the server returned; this component computes nothing.
export function ReportRunner({ definition, permissions }: ReportRunnerProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [run, setRun] = useState<RunState>({ status: "idle" });
  const [finalizeState, setFinalizeState] = useState<{ status: "idle" | "loading" | "error" | "done"; message?: string; snapshotRef?: string }>({ status: "idle" });

  const blockedForViewerSafe = VIEWER_SAFE_BLOCKED_REPORT_IDS.has(definition.reportId);
  const viewerOnlyAndBlocked = !permissions.canRunReports && permissions.canViewerSafeRun && blockedForViewerSafe;

  function setFilterValue(id: string, value: string) {
    setValues((prev) => ({ ...prev, [id]: value }));
  }

  async function handleRun() {
    setRun({ status: "loading" });
    setFinalizeState({ status: "idle" });
    const filters = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim().length > 0));
    const useFull = permissions.canRunReports;
    const result: ReportsApiResult<ReportResultDto> = useFull ? await runReportFull(definition.reportId, filters) : await runReportViewerSafe(definition.reportId, filters);
    if (!result.ok) {
      setRun({ status: "error", message: result.message });
      return;
    }
    setRun({ status: "loaded", result: result.data, viewerSafe: !useFull });
  }

  async function handleFinalize() {
    setFinalizeState({ status: "loading" });
    const filters = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim().length > 0));
    const result = await finalizeReportRun(definition.reportId, filters);
    if (!result.ok) {
      setFinalizeState({ status: "error", message: result.message });
      return;
    }
    setFinalizeState({ status: "done", snapshotRef: result.data.snapshotRef });
  }

  if (viewerOnlyAndBlocked) {
    return (
      <section className="panel" data-testid="report-viewer-blocked">
        <EmptyState
          title="Not available on your access level"
          description={`${definition.title} is not offered through the viewer-safe view - it can carry Finance or Administration-sensitive detail. Ask for the Analyst role or above if you need this report.`}
          icon="lock"
        />
      </section>
    );
  }

  return (
    <>
      <section className="panel" style={{ marginBottom: 18 }}>
        <div className="panelhead">
          <div>
            <h2>Configure</h2>
            <p>{definition.recordScopeNote}</p>
          </div>
        </div>
        <div className="panelbody">
          <ReportFiltersForm filters={definition.supportedFilters} values={values} onChange={setFilterValue} disabled={run.status === "loading"} />
        </div>
        <div className="panelfoot">
          <span>{permissions.canRunReports ? "Full run" : "Viewer-safe run"}</span>
          <div className="actions">
            {permissions.canRunReports && (
              <Button variant="ghost" onClick={handleFinalize} disabled={finalizeState.status === "loading" || run.status === "loading"}>
                <Icon name="file" />
                Finalize as snapshot
              </Button>
            )}
            <Button variant="primary" onClick={handleRun} disabled={run.status === "loading"} data-testid="report-run-button">
              <Icon name="chart" />
              {run.status === "loading" ? "Running…" : "Run report"}
            </Button>
          </div>
        </div>
        {finalizeState.status === "error" && (
          <div className="banner" role="alert" style={{ margin: "0 20px 16px" }}>
            <Icon name="alert" />
            <span>{finalizeState.message}</span>
          </div>
        )}
        {finalizeState.status === "done" && finalizeState.snapshotRef && (
          <div className="banner" role="status" style={{ margin: "0 20px 16px" }} data-testid="finalize-success">
            <Icon name="check" />
            <span>
              Finalized. <Link href={`/reports/snapshots/${finalizeState.snapshotRef}`}>View this snapshot</Link>
            </span>
          </div>
        )}
      </section>

      {run.status === "loading" && (
        <section className="panel" aria-busy="true">
          <div className="panelbody">
            <Skeleton lines={6} />
          </div>
        </section>
      )}

      {run.status === "error" && (
        <section className="panel">
          <EmptyState title="Could not run this report" description={run.message} icon="alert" />
        </section>
      )}

      {run.status === "loaded" && <ReportResultView definition={definition} result={run.result} viewerSafe={run.viewerSafe} />}
    </>
  );
}
