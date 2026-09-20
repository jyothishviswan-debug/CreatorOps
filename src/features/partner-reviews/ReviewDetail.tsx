"use client";

import { useState } from "react";
import Link from "next/link";

import { DialogShell } from "@/ui/Dialog";
import { Pill } from "@/ui/Badge";
import type { PartnerReviewDetailDto } from "@/server/partner-reviews/client-dto";
import type { ReviewActionPermissions } from "@/server/partner-reviews/ui-dto";
import { DETAIL_TABS, DETAIL_TAB_LABELS, monthLabel, partnerHistoryHref, workspaceHref, type DetailTab } from "@/server/partner-reviews/ui-params";

import { createReviewRevision, finalizeReview, loadReviewDetail, refreshReviewEvidence, submitReview, type ReviewsApiResult } from "./api-client";
import { absoluteTime, dateOnly, DISABLED_BUTTON_STYLE, FRESHNESS_LABELS, freshnessTone, LIFECYCLE_LABELS, lifecycleTone } from "./format";
import { classifyActionFailure, computeReviewActionState, type ActionFailure } from "./review-action-state";
import { ComplianceSection, FRESHNESS_EXPLANATIONS, OverviewSection, PerformanceSection, ProductionSection, VersionHistorySection } from "./ReviewDetailTabs";

type ActionKey = "refresh" | "submit" | "finalize" | "revision";
type Notice = { kind: "success" | "info"; text: string } | null;

// Step 13B: the Review Detail. The accepted Detail visual language (header + `.detailcontext` strip + a
// local `.workflow role=tablist` strip + `.grid` panels - exactly Campaign / Assignment Detail), never a
// second sidebar. The server renders the first view (accepted getPartnerReview: live Partner scope,
// actor-scoped redaction, ONE bounded freshness computation for this review); every lifecycle button calls
// the accepted route with the version's own docVersion. Buttons are RENDERED from the server-computed
// permission booleans (absent, never flashing) but each call is re-authorized by the server.
export function ReviewDetail({
  initialDetail,
  permissions,
  initialTab,
  notices,
}: {
  initialDetail: PartnerReviewDetailDto;
  permissions: ReviewActionPermissions;
  initialTab: DetailTab;
  notices: string[];
}) {
  const [detail, setDetail] = useState(initialDetail);
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [busy, setBusy] = useState<ActionKey | "view" | null>(null);
  const [dialog, setDialog] = useState<"finalize" | "revision" | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const { head } = detail;
  const version = detail.selectedVersion;
  const freshnessState = detail.freshness?.state ?? null;
  const partnerName = head.partnerDisplayName ?? "Partner";
  const month = monthLabel(head.periodKey);

  const action = version
    ? computeReviewActionState({ permissions, version: { version: version.version, status: version.status, docVersion: version.docVersion }, head, freshnessState })
    : { canRefresh: false, canSubmit: false, canFinalize: false, canCreateRevision: false, onOpenVersion: false, any: false };

  function selectTab(next: DetailTab) {
    setTab(next);
    // The tab is URL state (`?tab=`) - kept in the address bar without a server round-trip (the server would
    // otherwise recompute this review's freshness again).
    const url = new URL(window.location.href);
    if (next === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
  }

  function applyResult(result: ReviewsApiResult<PartnerReviewDetailDto>, success: string): boolean {
    if (result.ok) {
      setDetail(result.data);
      setFailure(null);
      setNotice({ kind: "success", text: success });
      return true;
    }
    setFailure(classifyActionFailure(result));
    setNotice(null);
    return false;
  }

  async function run(key: ActionKey, call: () => Promise<ReviewsApiResult<PartnerReviewDetailDto>>, success: string) {
    if (busy) return false;
    setBusy(key);
    setFailure(null);
    setNotice(null);
    const result = await call();
    setBusy(null);
    return applyResult(result, success);
  }

  const doRefresh = () => version && run("refresh", () => refreshReviewEvidence(head.reviewRef, { version: version.version, expectedDocVersion: version.docVersion }), "Evidence refreshed. Review the updated evidence before finalizing.");
  const doSubmit = () => version && run("submit", () => submitReview(head.reviewRef, { version: version.version, expectedDocVersion: version.docVersion }), "Submitted for review.");

  async function confirmFinalize() {
    if (!version || busy) return;
    setBusy("finalize");
    setDialogError(null);
    const result = await finalizeReview(head.reviewRef, { version: version.version, expectedDocVersion: version.docVersion });
    setBusy(null);
    if (result.ok) {
      setDialog(null);
      applyResult(result, "Review finalized.");
      return;
    }
    const classified = classifyActionFailure(result);
    // A stale or changed-elsewhere outcome is shown on the page (with its own recovery action), not buried in the dialog.
    if (classified.kind === "refresh_required" || classified.kind === "changed_elsewhere" || classified.kind === "denied") {
      setDialog(null);
      setFailure(classified);
      setNotice(null);
    } else setDialogError(classified.message);
  }

  async function confirmRevision() {
    if (busy) return;
    setBusy("revision");
    setDialogError(null);
    const result = await createReviewRevision(head.reviewRef, { expectedDocVersion: head.docVersion });
    setBusy(null);
    if (result.ok) {
      setDialog(null);
      applyResult(result, "Revision created as a new Draft. The finalized version stays current until the replacement is finalized.");
      return;
    }
    const classified = classifyActionFailure(result);
    if (classified.kind === "revision_not_needed" || classified.kind === "changed_elsewhere" || classified.kind === "denied") {
      setDialog(null);
      setFailure(classified);
      setNotice(null);
    } else setDialogError(classified.message);
  }

  async function reload() {
    if (busy) return;
    setBusy("view");
    const result = await loadReviewDetail(head.reviewRef);
    setBusy(null);
    if (result.ok) {
      setDetail(result.data);
      setFailure(null);
      setNotice({ kind: "info", text: "Reloaded the latest version of this review." });
    } else setFailure(classifyActionFailure(result));
  }

  async function viewVersion(target: number) {
    if (busy) return;
    setBusy("view");
    const result = await loadReviewDetail(head.reviewRef, target);
    setBusy(null);
    if (!result.ok) {
      setFailure(classifyActionFailure(result));
      return;
    }
    setDetail(result.data);
    setFailure(null);
    setNotice(null);
    const url = new URL(window.location.href);
    url.searchParams.set("version", String(target));
    window.history.replaceState(window.history.state, "", url);
  }

  const supersededBy = version?.status === "SUPERSEDED" ? version.supersededByVersion : null;
  const viewingHistorical = version !== null && (version.status === "SUPERSEDED" || (head.currentFinalizedVersion !== null && version.status === "FINALIZED" && head.currentFinalizedVersion !== version.version));
  const commercialGoverned = version?.snapshot.commercial.governingAgreement ?? null;

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">PARTNER REVIEWS / MONTHLY REVIEW</div>
          <h1>
            {partnerName} · {month}
          </h1>
          <p>Monthly review · production, compliance and performance stay independent</p>
        </div>
        <div className="actions">
          <Link href={partnerHistoryHref(head.partnerRef, { month: head.periodKey })} className="btn">
            Partner history
          </Link>
          <Link href={workspaceHref({ month: head.periodKey })} className="btn">
            Back to workspace
          </Link>
        </div>
      </div>

      <div className="detailcontext">
        <div>
          <small>Status</small>
          {version ? <Pill tone={lifecycleTone(version.status)}>{LIFECYCLE_LABELS[version.status]}</Pill> : <b>—</b>}
          {supersededBy !== null && <small style={{ marginTop: 4 }}>Superseded by version {supersededBy}</small>}
        </div>
        <div>
          <small>Version</small>
          <b>{version ? `Version ${version.version} of ${head.latestVersion}` : "—"}</b>
          {viewingHistorical && <small style={{ marginTop: 4 }}>Historical version · read only</small>}
          {version && head.currentFinalizedVersion === version.version && <small style={{ marginTop: 4 }}>Current finalized version</small>}
        </div>
        <div>
          <small>Freshness</small>
          {freshnessState ? <Pill tone={freshnessTone(freshnessState)}>{FRESHNESS_LABELS[freshnessState]}</Pill> : <b>Unavailable</b>}
          {detail.freshness && <small style={{ marginTop: 4 }}>Checked {absoluteTime(detail.freshness.evaluatedAt)}</small>}
        </div>
        <div>
          <small>Evidence cutoff</small>
          <b>{version ? absoluteTime(version.evidenceCutoff) : "—"}</b>
          <small style={{ marginTop: 4 }}>
            {version?.finalizedAt ? `Finalized ${dateOnly(version.finalizedAt)}` : "Not finalized"} · {commercialGoverned ? "Agreement-governed evidence" : "No governing Agreement"}
          </small>
        </div>
      </div>

      <div className="workflow" role="tablist" aria-label="Review sections">
        {DETAIL_TABS.map((key) => {
          const isCurrent = key === tab;
          return (
            <button key={key} type="button" role="tab" aria-selected={isCurrent} className={`step ${isCurrent ? "current" : ""}`} onClick={() => selectTab(key)}>
              {DETAIL_TAB_LABELS[key]}
            </button>
          );
        })}
      </div>

      {notices.map((text) => (
        <div key={text} className="banner" role="status" style={{ marginBottom: 12 }}>
          {text}
        </div>
      ))}

      {failure && <FailureBanner failure={failure} canRefresh={action.canRefresh} busy={busy !== null} onRefresh={() => void doRefresh()} onReload={() => void reload()} />}
      {notice && (
        <div className="banner" role="status" style={{ marginBottom: 12 }}>
          {notice.text}
        </div>
      )}

      {(action.any || detail.freshness) && (
        <section className="panel" style={{ marginBottom: 18 }} aria-label="Review actions">
          <div className="panelbody">
            <div className="actions" style={{ alignItems: "center" }}>
              {action.canRefresh && (
                <button type="button" className="btn" disabled={busy !== null} style={busy !== null ? DISABLED_BUTTON_STYLE : undefined} onClick={() => void doRefresh()}>
                  {busy === "refresh" ? "Refreshing…" : "Refresh evidence"}
                </button>
              )}
              {action.canSubmit && (
                <button type="button" className="btn primary" disabled={busy !== null} style={busy !== null ? DISABLED_BUTTON_STYLE : undefined} onClick={() => void doSubmit()}>
                  {busy === "submit" ? "Submitting…" : "Submit for review"}
                </button>
              )}
              {action.canFinalize && (
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy !== null}
                  style={busy !== null ? DISABLED_BUTTON_STYLE : undefined}
                  onClick={() => {
                    setDialogError(null);
                    setDialog("finalize");
                  }}
                >
                  Finalize
                </button>
              )}
              {action.canCreateRevision && (
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy !== null}
                  style={busy !== null ? DISABLED_BUTTON_STYLE : undefined}
                  onClick={() => {
                    setDialogError(null);
                    setDialog("revision");
                  }}
                >
                  Create revision
                </button>
              )}
              {!action.any && <span className="foundationnote">{viewingHistorical ? "Historical versions are immutable." : version?.status === "FINALIZED" ? "This finalized version is current and immutable." : "No action is available for you on this version."}</span>}
            </div>
            {detail.freshness && <p className="foundationnote" style={{ margin: "8px 0 0" }}>{FRESHNESS_EXPLANATIONS[detail.freshness.state]}</p>}
          </div>
        </section>
      )}

      {tab === "overview" && <OverviewSection detail={detail} freshnessState={freshnessState} />}
      {tab === "production" && <ProductionSection detail={detail} />}
      {tab === "compliance" && <ComplianceSection detail={detail} />}
      {tab === "performance" && <PerformanceSection detail={detail} />}
      {tab === "history" && <VersionHistorySection detail={detail} freshnessState={freshnessState} viewingVersion={version?.version ?? null} busy={busy !== null} onViewVersion={(target) => void viewVersion(target)} />}

      <DialogShell
        open={dialog === "finalize"}
        title="Finalize this review?"
        onClose={() => {
          if (busy !== "finalize") setDialog((current) => (current === "finalize" ? null : current));
        }}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setDialog(null)} disabled={busy === "finalize"} style={busy === "finalize" ? DISABLED_BUTTON_STYLE : undefined}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void confirmFinalize()} disabled={busy === "finalize"} style={busy === "finalize" ? DISABLED_BUTTON_STYLE : undefined}>
              {busy === "finalize" ? "Finalizing…" : "Finalize review"}
            </button>
          </>
        }
      >
        <p className="detailcopy">
          Version {version?.version} of {partnerName} · {month} will be frozen as the current finalized review. Finalized evidence is immutable; a later change can only be captured in a new revision.
        </p>
        <p className="foundationnote">Finalizing never refreshes evidence. If upstream records changed since this version was captured you will be asked to refresh first.</p>
        {dialogError && (
          <div className="banner" role="alert">
            {dialogError}
          </div>
        )}
      </DialogShell>

      <DialogShell
        open={dialog === "revision"}
        title="Create a revision?"
        onClose={() => {
          if (busy !== "revision") setDialog((current) => (current === "revision" ? null : current));
        }}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setDialog(null)} disabled={busy === "revision"} style={busy === "revision" ? DISABLED_BUTTON_STYLE : undefined}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void confirmRevision()} disabled={busy === "revision"} style={busy === "revision" ? DISABLED_BUTTON_STYLE : undefined}>
              {busy === "revision" ? "Creating…" : "Create revision"}
            </button>
          </>
        }
      >
        <p className="detailcopy">A new Draft version will capture the current upstream evidence for {partnerName} · {month}.</p>
        <p className="foundationnote">The finalized version stays current and unchanged until the replacement is finalized; finalizing it then supersedes the earlier one, which remains readable.</p>
        {dialogError && (
          <div className="banner" role="alert">
            {dialogError}
          </div>
        )}
      </DialogShell>
    </>
  );
}

function FailureBanner({ failure, canRefresh, busy, onRefresh, onReload }: { failure: ActionFailure; canRefresh: boolean; busy: boolean; onRefresh: () => void; onReload: () => void }) {
  if (failure.kind === "refresh_required") {
    return (
      <div className="banner" role="alert" style={{ marginBottom: 12 }}>
        <b>Refresh required.</b> The evidence in this In Review version is out of date - upstream records changed after it was captured. Refresh the evidence, review what changed, then finalize. Finalize never refreshes on its own.
        {canRefresh && (
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn primary" disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} onClick={onRefresh}>
              Refresh evidence
            </button>
          </div>
        )}
      </div>
    );
  }
  if (failure.kind === "changed_elsewhere") {
    return (
      <div className="banner" role="alert" style={{ marginBottom: 12 }}>
        <b>This review changed elsewhere.</b> {failure.message}
        <div style={{ marginTop: 8 }}>
          <button type="button" className="btn primary" disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} onClick={onReload}>
            Reload review
          </button>
        </div>
      </div>
    );
  }
  if (failure.kind === "revision_not_needed") {
    return (
      <div className="banner" role="status" style={{ marginBottom: 12 }}>
        <b>No revision needed.</b> The finalized evidence still matches the current upstream evidence.
      </div>
    );
  }
  return (
    <div className="banner" role="alert" style={{ marginBottom: 12 }}>
      {failure.message}
    </div>
  );
}
