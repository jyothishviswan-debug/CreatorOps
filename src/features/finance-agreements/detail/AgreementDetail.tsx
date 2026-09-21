"use client";

import { useEffect, useRef, useState, useTransition, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Pill } from "@/ui/Badge";
import type { AgreementDetailDto, AgreementHeadDto, AgreementVersionDto, AgreementVersionSummaryDto } from "@/server/finance-agreements/client-dto";
import type { AgreementKycStatusDto } from "@/server/finance-agreements/kyc-status-service";
import type { AgreementReconciliationDto } from "@/server/finance-agreements/reconciliation-service";
import type { FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

import {
  activateAgreementVersion,
  confirmAgreementVersion,
  createAgreementRevision,
  endAgreement,
  getAgreementDetail,
  getAgreementReconciliation,
  resumeAgreement,
  storeAgreementDocument,
  suspendAgreement,
  type FinanceApiFailure,
  type FinanceApiResult,
} from "../api-client";
import { describeStoreOutcome, documentPanelRows, type DocumentNotice } from "../document-view";
import { DISABLED_BUTTON_STYLE, counterpartyTypeLabel, formatEffectivePeriod, formatPlatformList, lifecycleChip } from "../format";
import { ActivityTab } from "./ActivityTab";
import { AGREEMENTS_WORKSPACE_HREF, DETAIL_TABS, DETAIL_TAB_LABELS, TAB_PANEL_ID, intakeHref, tabElementId, tabKeyTarget, type DetailTab } from "./detail-model";
import type { TabContext } from "./detail-types";
import { KycTab } from "./KycTab";
import { LifecycleActionsPanel, type LifecycleDialogKey } from "./LifecycleActionsPanel";
import { LifecycleDialog } from "./LifecycleDialog";
import { classifyActionFailure, computeAgreementActionState, isPageLevelFailure, reasonIssue, type ActionFailureView } from "./lifecycle-actions";
import { OverviewTab } from "./OverviewTab";
import { buildRevisionChanges } from "./revision-changes";
import { TermsTab } from "./TermsTab";
import { VerificationTab } from "./VerificationTab";
import { VersionsTab } from "./VersionsTab";
import { currentVersionNumber, priorVersionNumber } from "./versions-view";

type Busy = LifecycleDialogKey | "view" | "document" | null;

// "Reload latest" refreshes the server render, and the page REMOUNTS on the fresh data (its key carries the head's version), which would drop
// a message set before the refresh. The flag survives the remount (module scope) and is consumed by the next mount's initial state.
const RELOADED_NOTICE = "Reloaded the latest version of this Agreement.";
let reloadNoticePending = false;
function consumeReloadNotice(): string | null {
  if (!reloadNoticePending) return null;
  reloadNoticePending = false;
  return RELOADED_NOTICE;
}

export type AgreementDetailProps = {
  initialHead: AgreementHeadDto;
  initialVersions: AgreementVersionSummaryDto[];
  initialHasMoreVersions: boolean;
  // The full documents the server already read (the viewed version, the open version, and the version each is compared with).
  initialDocs: AgreementVersionDto[];
  initialViewNumber: number;
  initialTab: DetailTab;
  // Server-computed from real grants: they decide which buttons EXIST (every action is re-authorized by the server again).
  permissions: FinanceAgreementPermissionsDto;
  initialReconciliation: AgreementReconciliationDto | null;
  kycStatus: AgreementKycStatusDto | null;
  notices: string[];
};

// Step 14B: the Agreement detail. The accepted detail layout (`.head` + `.detailcontext` + a local `.workflow role=tablist` + panels), never a
// second sidebar or module tab row. The server renders the first view; a lifecycle button opens a confirmation dialog and calls the accepted
// route with the right optimistic-concurrency counter (HEAD docVersion for activate / revise / suspend / resume / end, the VERSION's for confirm);
// every success REPLACES local state with the response and a stale / conflicting write is a banner with "Reload latest" - never a silent overwrite.
export function AgreementDetail(props: AgreementDetailProps) {
  const router = useRouter();
  const { permissions, kycStatus, notices } = props;
  const [head, setHead] = useState(props.initialHead);
  const [versions, setVersions] = useState(props.initialVersions);
  const [hasMoreVersions, setHasMoreVersions] = useState(props.initialHasMoreVersions);
  const [docs, setDocs] = useState<Record<number, AgreementVersionDto>>(() => Object.fromEntries(props.initialDocs.map((doc) => [doc.version, doc])));
  const [recon, setRecon] = useState<Record<number, AgreementReconciliationDto>>(() => (props.initialReconciliation ? { [props.initialReconciliation.version]: props.initialReconciliation } : {}));
  const [reconFailed, setReconFailed] = useState<Record<number, true>>({});
  const [viewNumber, setViewNumber] = useState(props.initialViewNumber);
  const [tab, setTab] = useState<DetailTab>(props.initialTab);

  const [busy, setBusy] = useState<Busy>(null);
  const busyRef = useRef<Busy>(null);
  const [dialog, setDialog] = useState<LifecycleDialogKey | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogBlockers, setDialogBlockers] = useState<{ code: string; message: string; fieldKey?: string }[] | null>(null);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<ActionFailureView | null>(null);
  const [notice, setNotice] = useState<string | null>(consumeReloadNotice);
  const [reloading, startReload] = useTransition();
  // The signed Agreement document: which version's store call is running and what the last one said (announced politely in the panel).
  const [documentBusyVersion, setDocumentBusyVersion] = useState<number | null>(null);
  const [documentNotice, setDocumentNotice] = useState<(DocumentNotice & { version: number }) | null>(null);

  const aliveRef = useRef(true);
  const requestedDocs = useRef(new Set<number>());
  const requestedRecon = useRef(new Set<number>());
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const agreementRef = head.agreementRef;
  const viewed = versions.find((entry) => entry.version === viewNumber) ?? null;
  const openSummary = head.openVersion === null ? null : (versions.find((entry) => entry.version === head.openVersion) ?? null);
  const priorNumber = viewed ? priorVersionNumber(head, viewed) : null;
  const openPriorNumber = head.openVersion === null ? null : (head.activeVersion ?? head.lastEndedVersion);
  const viewedDoc = docs[viewNumber] ?? null;
  const priorDoc = priorNumber === null ? null : (docs[priorNumber] ?? null);
  const openDoc = head.openVersion === null ? null : (docs[head.openVersion] ?? null);
  const openPriorDoc = openPriorNumber === null ? null : (docs[openPriorNumber] ?? null);

  const actions = computeAgreementActionState({ permissions, head, versions });
  const counterpartyName = head.counterpartyDisplayName ?? counterpartyTypeLabel(head.counterparty.type);
  const current = versions.find((entry) => entry.version === currentVersionNumber(head)) ?? null;

  // --- Loading what the page needs beyond the server's first read ------------------------------------------------------------------
  // Missing version documents (e.g. after choosing a version on the Versions tab): read once each; a failure is not retried in a loop.
  useEffect(() => {
    for (const version of new Set([viewNumber, priorNumber, head.openVersion, openPriorNumber])) {
      if (version === null || docs[version] || requestedDocs.current.has(version)) continue;
      requestedDocs.current.add(version);
      void getAgreementDetail(agreementRef, { version }).then((result) => {
        if (!aliveRef.current || !result.ok || !result.data.selectedVersion) return;
        const doc = result.data.selectedVersion;
        setDocs((previous) => (previous[doc.version] ? previous : { ...previous, [doc.version]: doc }));
      });
    }
  }, [agreementRef, docs, head.openVersion, openPriorNumber, priorNumber, viewNumber]);

  // The live comparison of the viewed version with CreatorOps records (Overview + Verification), read once per version.
  useEffect(() => {
    if (tab !== "overview" && tab !== "verification") return;
    if (recon[viewNumber] || requestedRecon.current.has(viewNumber)) return;
    requestedRecon.current.add(viewNumber);
    const version = viewNumber;
    void getAgreementReconciliation(agreementRef, { version }).then((result) => {
      if (!aliveRef.current) return;
      if (result.ok) setRecon((previous) => ({ ...previous, [version]: result.data }));
      else setReconFailed((previous) => ({ ...previous, [version]: true }));
    });
  }, [agreementRef, recon, tab, viewNumber]);

  const reconciliation = recon[viewNumber] ?? null;
  const reconciliationState: TabContext["reconciliationState"] = reconciliation ? "ready" : reconFailed[viewNumber] ? "error" : "loading";

  // --- URL state (?tab= & ?version=), kept without a server round trip ---------------------------------------------------------------
  function replaceUrl(next: { tab?: DetailTab; version?: number | null }) {
    const url = new URL(window.location.href);
    const nextTab = next.tab ?? tab;
    if (nextTab === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", nextTab);
    if (next.version !== undefined) {
      if (next.version === null || next.version === currentVersionNumber(head)) url.searchParams.delete("version");
      else url.searchParams.set("version", String(next.version));
    }
    window.history.replaceState(window.history.state, "", url);
  }

  function selectTab(next: DetailTab) {
    setTab(next);
    replaceUrl({ tab: next });
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, from: DetailTab) {
    const target = tabKeyTarget(from, event.key);
    if (!target) return;
    event.preventDefault();
    selectTab(target);
    document.getElementById(tabElementId(target))?.focus();
  }

  // --- State from a server response (ALWAYS replace, never merge a guess) -------------------------------------------------------------
  function applyDetail(detail: AgreementDetailDto) {
    setHead(detail.head);
    setVersions(detail.versions);
    setHasMoreVersions(detail.hasMoreVersions);
    const selected = detail.selectedVersion;
    if (selected) {
      setDocs((previous) => ({ ...previous, [selected.version]: selected }));
      // Its state changed: the comparison is read again the next time it is needed.
      requestedRecon.current.delete(selected.version);
      setRecon((previous) => without(previous, selected.version));
      setReconFailed((previous) => without(previous, selected.version));
    }
  }

  function openDialog(key: LifecycleDialogKey) {
    if (busyRef.current) return;
    setDialogError(null);
    setDialogBlockers(null);
    setFailure(null);
    setReason("");
    setDialog(key);
  }

  function closeDialog() {
    if (busyRef.current) return;
    setDialog(null);
  }

  async function execute(key: LifecycleDialogKey, call: () => Promise<FinanceApiResult<AgreementDetailDto>>, success: string, after?: (data: AgreementDetailDto) => void) {
    if (busyRef.current) return;
    busyRef.current = key;
    setBusy(key);
    setDialogError(null);
    setDialogBlockers(null);
    setFailure(null);
    setNotice(null);
    const result = await call();
    busyRef.current = null;
    if (!aliveRef.current) return;
    setBusy(null);
    if (result.ok) {
      setDialog(null);
      applyDetail(result.data);
      setNotice(success);
      after?.(result.data);
      focusPanelIfFocusLost();
      return;
    }
    handleFailure(result);
  }

  function handleFailure(result: FinanceApiFailure) {
    const view = classifyActionFailure(result);
    // Stale / denied / not found are shown on the page with their own recovery; anything else stays beside the action that failed.
    if (isPageLevelFailure(view)) {
      setDialog(null);
      setFailure(view);
      return;
    }
    setDialogError(view.message);
    setDialogBlockers(view.kind === "not_ready" ? (view.blockers ?? []) : null);
  }

  function submitDialog() {
    if (!dialog) return;
    const headVersion = head.docVersion;
    switch (dialog) {
      case "confirm": {
        if (!openSummary) return;
        void execute("confirm", () => confirmAgreementVersion(agreementRef, { version: openSummary.version, expectedDocVersion: openSummary.docVersion }), `Version ${openSummary.version} confirmed. Its terms are frozen; activate it to put it in force.`);
        return;
      }
      case "activate": {
        if (!openSummary) return;
        const number = openSummary.version;
        void execute("activate", () => activateAgreementVersion(agreementRef, { version: number, expectedDocVersion: headVersion }), `Version ${number} is now the version in force.`, () => {
          setViewNumber(number);
          setTab("overview");
          const url = new URL(window.location.href);
          url.searchParams.delete("version");
          url.searchParams.delete("tab");
          window.history.replaceState(window.history.state, "", url);
        });
        return;
      }
      case "revise":
        void execute("revise", () => createAgreementRevision(agreementRef, { expectedDocVersion: headVersion }), "Revision created as a new draft. The version in force stays unchanged until the replacement is activated.", (data) => {
          const created = data.selectedVersion?.version ?? data.head.openVersion;
          // Only someone who may edit Agreements continues into the intake editor.
          if (permissions.canManage && created !== null) router.push(intakeHref(agreementRef, created));
        });
        return;
      case "suspend":
        if (reasonIssue(reason) !== null) return;
        void execute("suspend", () => suspendAgreement(agreementRef, { expectedDocVersion: headVersion, reason: reason.trim() }), "Agreement suspended.");
        return;
      case "resume":
        void execute("resume", () => resumeAgreement(agreementRef, { expectedDocVersion: headVersion }), "Agreement resumed.");
        return;
      case "end":
        if (reasonIssue(reason) !== null) return;
        void execute("end", () => endAgreement(agreementRef, { expectedDocVersion: headVersion, reason: reason.trim() }), "Agreement ended. Its versions stay readable.");
        return;
    }
  }

  // Store (or retry) the ORIGINAL signed Agreement of one CONFIRMED version in Drive. Idempotent on the server; a Drive failure is a successful call
  // whose outcome is "failed" (retriable). Every response REPLACES local state; the version's own docVersion is the concurrency counter.
  async function storeDocument(version: number) {
    if (busyRef.current) return;
    const target = versions.find((entry) => entry.version === version);
    if (!target) return;
    busyRef.current = "document";
    setBusy("document");
    setDocumentBusyVersion(version);
    setDocumentNotice(null);
    setFailure(null);
    setNotice(null);
    const result = await storeAgreementDocument(agreementRef, { version, expectedDocVersion: target.docVersion });
    busyRef.current = null;
    if (!aliveRef.current) return;
    setBusy(null);
    setDocumentBusyVersion(null);
    if (result.ok) {
      applyDetail(result.data.agreement);
      setDocumentNotice({ version, ...describeStoreOutcome(result.data) });
      focusPanelIfFocusLost();
      return;
    }
    const view = classifyActionFailure(result);
    if (isPageLevelFailure(view)) setFailure(view);
    else setDocumentNotice({ version, tone: "error", text: `The Agreement document was not stored. ${view.message}` });
  }

  // View one version read-only (Terms + Verification follow it).
  async function viewVersion(target: number) {
    if (busyRef.current) return;
    busyRef.current = "view";
    setBusy("view");
    const result = await getAgreementDetail(agreementRef, { version: target });
    busyRef.current = null;
    if (!aliveRef.current) return;
    setBusy(null);
    if (!result.ok) {
      setFailure(classifyActionFailure(result));
      return;
    }
    applyDetail(result.data);
    setViewNumber(target);
    setFailure(null);
    setNotice(null);
    setTab("terms");
    replaceUrl({ tab: "terms", version: target });
  }

  // "Reload latest": ask the server for the current truth; the page remounts on the fresh data (its key carries the head's version).
  function reloadLatest() {
    startReload(() => {
      setFailure(null);
      setNotice(RELOADED_NOTICE);
      reloadNoticePending = true;
      router.refresh();
    });
  }

  const ctx: TabContext = {
    head,
    versions,
    hasMoreVersions,
    permissions,
    viewNumber,
    viewed,
    viewedDoc,
    priorDoc,
    revision: buildRevisionChanges({ viewed: viewedDoc, prior: priorDoc }),
    openDoc,
    openRevision: buildRevisionChanges({ viewed: openDoc, prior: openPriorDoc }),
    counterpartyName,
    reconciliation,
    reconciliationState,
    kycStatus,
  };

  const platformScope = head.counterparty.platformScope;
  const headerActionsExist = actions.canContinueDraft || actions.canCreateRevision;
  const busyForButtons = busy !== null;

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">FINANCE / AGREEMENT DETAIL</div>
          <h1>{counterpartyName}</h1>
          <p style={{ overflowWrap: "anywhere" }}>
            Agreement {agreementRef}
            {head.counterparty.type === "PARTNER" && platformScope.length > 0 ? ` · ${formatPlatformList(platformScope)}` : ""}
          </p>
        </div>
        <div className="actions">
          <Link href={AGREEMENTS_WORKSPACE_HREF} className="btn">
            Back to agreements
          </Link>
          {actions.canContinueDraft && head.openVersion !== null && (
            <Link href={intakeHref(agreementRef, head.openVersion)} className="btn primary">
              Continue draft
            </Link>
          )}
          {actions.canCreateRevision && (
            <button type="button" className="btn primary" disabled={busyForButtons} style={busyForButtons ? DISABLED_BUTTON_STYLE : undefined} onClick={() => openDialog("revise")}>
              Create revision
            </button>
          )}
        </div>
      </div>

      <div className="detailcontext">
        <div>
          <small>Agreement</small>
          <b style={{ overflowWrap: "anywhere" }}>{agreementRef}</b>
          <small style={{ marginTop: 4 }}>{counterpartyTypeLabel(head.counterparty.type)} Agreement</small>
        </div>
        <div>
          <small>{counterpartyTypeLabel(head.counterparty.type)}</small>
          <b>{counterpartyName}</b>
          <small style={{ marginTop: 4 }}>{head.counterparty.type === "PARTNER" ? `Platforms: ${formatPlatformList(platformScope)}` : "Vendor"}</small>
        </div>
        <div>
          <small>Status</small>
          <Pill tone={lifecycleChip(head.status).tone}>{lifecycleChip(head.status).label}</Pill>
          <small style={{ marginTop: 4 }}>
            Current version {currentVersionNumber(head)} of {head.latestVersion}
            {head.openVersion !== null && head.openVersion !== currentVersionNumber(head) ? ` · draft version ${head.openVersion} open` : ""}
          </small>
        </div>
        <div>
          <small>Effective period</small>
          <b>{current?.confirmed ? formatEffectivePeriod(current.effectiveFrom, current.effectiveTo) : "Set when confirmed"}</b>
          <small style={{ marginTop: 4 }}>Version {current?.version ?? currentVersionNumber(head)}</small>
        </div>
      </div>

      <div className="workflow" role="tablist" aria-label="Agreement sections">
        {DETAIL_TABS.map((key) => {
          const isCurrent = key === tab;
          return (
            <button
              key={key}
              id={tabElementId(key)}
              type="button"
              role="tab"
              aria-selected={isCurrent}
              aria-controls={TAB_PANEL_ID}
              tabIndex={isCurrent ? 0 : -1}
              className={`step ${isCurrent ? "current" : ""}`}
              onClick={() => selectTab(key)}
              onKeyDown={(event) => onTabKeyDown(event, key)}
            >
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
      {failure && <FailureBanner failure={failure} reloading={reloading} onReload={reloadLatest} />}
      <div aria-live="polite" role="status">
        {notice && (
          <div className="banner" style={{ marginBottom: 12 }}>
            {notice}
          </div>
        )}
      </div>

      {viewed && viewed.version !== currentVersionNumber(head) && head.openVersion !== viewed.version && (
        <div className="banner" role="status" style={{ marginBottom: 12 }}>
          <span>
            <b>Version {viewed.version}</b> is an earlier version and is read only. The version in force is version {currentVersionNumber(head)}.{" "}
            <button type="button" className="btn" disabled={busyForButtons} style={busyForButtons ? DISABLED_BUTTON_STYLE : undefined} onClick={() => void viewVersion(currentVersionNumber(head))}>
              Show the version in force
            </button>
          </span>
        </div>
      )}

      <div role="tabpanel" id={TAB_PANEL_ID} aria-labelledby={tabElementId(tab)} tabIndex={-1} style={{ outline: "none" }}>
        {tab === "overview" && (
          <OverviewTab
            ctx={ctx}
            onOpenTab={selectTab}
            documentPanel={{
              rows: documentPanelRows({ versions, head, viewNumber }),
              canManage: permissions.canManage,
              busyVersion: documentBusyVersion,
              anyBusy: busyForButtons,
              notice: documentNotice,
              onStore: (version) => void storeDocument(version),
            }}
            lifecycle={<LifecycleActionsPanel state={actions} busy={busyForButtons} onOpen={openDialog} headerActionsExist={headerActionsExist} />}
          />
        )}
        {tab === "terms" && <TermsTab ctx={ctx} />}
        {tab === "verification" && <VerificationTab ctx={ctx} />}
        {tab === "kyc" && <KycTab ctx={ctx} />}
        {tab === "versions" && <VersionsTab ctx={ctx} busy={busyForButtons} onView={(target) => void viewVersion(target)} />}
        {tab === "activity" && <ActivityTab agreementRef={agreementRef} refreshKey={`${head.docVersion}:${head.updatedAt}`} />}
      </div>

      <LifecycleDialog
        dialog={dialog}
        busy={busy !== null && busy !== "view" && busy !== "document" ? busy : null}
        error={dialogError}
        blockers={dialogBlockers}
        reason={reason}
        onReasonChange={setReason}
        agreementRef={agreementRef}
        counterpartyType={head.counterparty.type}
        counterpartyName={counterpartyName}
        openVersion={head.openVersion}
        governingVersion={actions.governingVersion}
        latestVersion={head.latestVersion}
        canManage={permissions.canManage}
        onClose={closeDialog}
        onSubmit={submitDialog}
      />
    </>
  );
}

// The dialog's trigger may disappear with the action it started (e.g. "Create revision"): keep keyboard focus on the page instead of losing it to <body>.
function focusPanelIfFocusLost() {
  window.setTimeout(() => {
    if (!document.activeElement || document.activeElement === document.body) document.getElementById(TAB_PANEL_ID)?.focus({ preventScroll: true });
  }, 60);
}

function without<T>(record: Record<number, T>, key: number): Record<number, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function FailureBanner({ failure, reloading, onReload }: { failure: ActionFailureView; reloading: boolean; onReload: () => void }) {
  const recoverable = failure.kind === "stale" || failure.kind === "conflict" || failure.kind === "network" || failure.kind === "error";
  return (
    <div className="banner" role="alert" style={{ marginBottom: 12, display: "block" }}>
      <b>{failure.kind === "stale" ? "Changed elsewhere." : failure.kind === "denied" ? "Not allowed." : failure.kind === "not_found" ? "Not found." : "Couldn’t complete that."}</b> {failure.message}
      {(recoverable || failure.kind === "not_found") && (
        <div style={{ marginTop: 8 }}>
          <button type="button" className="btn primary" disabled={reloading} style={reloading ? DISABLED_BUTTON_STYLE : undefined} onClick={onReload}>
            {reloading ? "Reloading…" : "Reload latest"}
          </button>
        </div>
      )}
    </div>
  );
}
