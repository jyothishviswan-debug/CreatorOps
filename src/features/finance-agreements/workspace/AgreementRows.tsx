"use client";

import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { StatusChip } from "../components";
import { pillClassName } from "../components/display-logic";
import { WORKSPACE_TABLE_CAPTION } from "./workspace-copy";
import { initialsOfName, NOT_SET_TEXT, type WorkspaceRowView } from "./workspace-view-model";

// Step 14B: the two renderings of one page of Agreement rows - the accepted `.tablewrap` table (columns scroll INSIDE the
// wrapper, never the document) and the accepted `.recordgrid` / `.record` stacked cards for narrow screens. Both read the
// same WorkspaceRowView, so they can never disagree. No restricted value can reach here: the view is an allowlist.

const CHIP_ROW_STYLE = { display: "flex", flexWrap: "wrap", gap: 4 } as const;
// Long Agreement numbers / names wrap instead of widening the page.
const WRAP_STYLE = { whiteSpace: "normal", overflowWrap: "anywhere" } as const;

function TypeAndPlatforms({ view, indent }: { view: WorkspaceRowView; indent?: boolean }) {
  return (
    <div style={{ ...CHIP_ROW_STYLE, marginTop: 5, paddingLeft: indent ? 44 : 0 }}>
      <span className={pillClassName(view.counterpartyTypeTone)} data-testid="counterparty-type">
        {view.counterpartyTypeLabel}
      </span>
      {view.platforms.map((platform) => (
        <span key={platform} className={pillClassName("gray")} data-testid="platform-scope">
          {platform}
        </span>
      ))}
    </div>
  );
}

function CounterpartyLink({ view, inTable }: { view: WorkspaceRowView; inTable?: boolean }) {
  return (
    <Link className="rowlink person" href={view.detailHref} aria-label={`Open Agreement ${view.agreementNumber ?? view.reference} for ${view.counterpartyName}`}>
      <span className="avatar" aria-hidden="true">
        {initialsOfName(view.counterpartyName)}
      </span>
      <span style={inTable ? { ...WRAP_STYLE, minWidth: 140, maxWidth: 240 } : { ...WRAP_STYLE, minWidth: 0 }}>
        <b>{view.counterpartyName}</b>
      </span>
    </Link>
  );
}

function ExtractionStatus({ view, alignEnd }: { view: WorkspaceRowView; alignEnd?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: alignEnd ? "flex-end" : "flex-start", gap: 4 }}>
      {view.extraction ? <StatusChip chip={view.extraction} testId="extraction-status" /> : <span className="muted">{view.extractionText}</span>}
      {view.unresolvedCount > 0 ? <StatusChip label={view.unresolvedText} tone="orange" testId="unresolved-fields" /> : <span className="muted">{view.unresolvedText}</span>}
    </div>
  );
}

function UpdatedTime({ view }: { view: WorkspaceRowView }) {
  return (
    <time dateTime={view.lastUpdatedIso} title={view.lastUpdatedTitle} suppressHydrationWarning>
      {view.lastUpdated}
    </time>
  );
}

function PrimaryAction({ view, block }: { view: WorkspaceRowView; block?: boolean }) {
  return (
    <Link className={view.primary.emphasis ? "btn primary" : "btn"} href={view.primary.href} aria-label={view.primary.ariaLabel} data-testid="primary-action" data-action-kind={view.primary.kind} style={block ? { width: "100%" } : undefined}>
      {view.primary.label}
    </Link>
  );
}

// --- Table ------------------------------------------------------------------------------------------------------------------
export function AgreementsTable({ rows }: { rows: WorkspaceRowView[] }) {
  const router = useRouter();

  // A whole-row click opens the Agreement (mouse convenience). Links and buttons inside the row keep their own behavior, and
  // keyboard users always have real links to Tab to - the row itself is not a fake button.
  function openRow(event: MouseEvent<HTMLTableRowElement>, href: string) {
    const target = event.target as HTMLElement;
    if (target.closest("a,button,input,select,textarea")) return;
    if (window.getSelection()?.toString()) return;
    router.push(href);
  }

  return (
    <div className="tablewrap">
      <table className="compact">
        <caption className="sr">{WORKSPACE_TABLE_CAPTION}</caption>
        <thead>
          <tr>
            <th scope="col">Partner / Vendor</th>
            <th scope="col">Agreement</th>
            <th scope="col">Current version</th>
            <th scope="col">Lifecycle</th>
            <th scope="col">Effective dates</th>
            <th scope="col">Commercial type</th>
            <th scope="col">KYC status</th>
            <th scope="col">Extraction · reconciliation</th>
            <th scope="col">Last updated</th>
            <th scope="col">
              <span className="sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((view) => (
            <tr key={view.key} data-testid="agreement-row" data-agreement-ref={view.agreementRef} style={{ cursor: "pointer" }} onClick={(event) => openRow(event, view.detailHref)}>
              <td>
                <CounterpartyLink view={view} inTable />
                <TypeAndPlatforms view={view} indent />
              </td>
              <td>
                <span data-testid="agreement-reference">{view.reference}</span>
                {view.agreementNumber && <small style={{ display: "block", ...WRAP_STYLE, maxWidth: 200 }}>No. {view.agreementNumber}</small>}
              </td>
              <td>
                {view.versionLabel}
                {view.revisionNote && <small style={{ display: "block" }}>{view.revisionNote}</small>}
              </td>
              <td>
                <StatusChip chip={view.lifecycle} testId="lifecycle-status" />
              </td>
              <td>{view.effective === NOT_SET_TEXT ? <span className="muted">{view.effective}</span> : view.effective}</td>
              <td>{view.commercialTypeSet ? view.commercialType : <span className="muted">{view.commercialType}</span>}</td>
              <td>
                <StatusChip chip={view.kyc} testId="kyc-status" />
              </td>
              <td>
                <ExtractionStatus view={view} />
              </td>
              <td>
                <UpdatedTime view={view} />
              </td>
              <td>
                <PrimaryAction view={view} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Cards --------------------------------------------------------------------------------------------------------------------
function CardLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, fontSize: 11, padding: "7px 0", borderBottom: "1px solid #f0f2f5" }}>
      <span className="muted" style={{ flex: "0 0 auto" }}>
        {label}
      </span>
      <span style={{ textAlign: "right", minWidth: 0, ...WRAP_STYLE }}>{children}</span>
    </div>
  );
}

export function AgreementCards({ rows }: { rows: WorkspaceRowView[] }) {
  return (
    <div className="recordgrid">
      {rows.map((view) => (
        <article className="record" key={view.key} data-testid="agreement-card" data-agreement-ref={view.agreementRef} style={{ minWidth: 0 }}>
          <CounterpartyLink view={view} />
          <TypeAndPlatforms view={view} indent />
          <div style={{ marginTop: 12 }}>
            <CardLine label="Lifecycle">
              <StatusChip chip={view.lifecycle} testId="lifecycle-status" />
            </CardLine>
            <CardLine label="Agreement">
              <span data-testid="agreement-reference">{view.reference}</span>
              {view.agreementNumber && <small style={{ display: "block" }}>No. {view.agreementNumber}</small>}
            </CardLine>
            <CardLine label="Current version">
              {view.versionLabel}
              {view.revisionNote && <small style={{ display: "block" }}>{view.revisionNote}</small>}
            </CardLine>
            <CardLine label="Effective dates">{view.effective}</CardLine>
            <CardLine label="Commercial type">{view.commercialType}</CardLine>
            <CardLine label="KYC status">
              <StatusChip chip={view.kyc} testId="kyc-status" />
            </CardLine>
            <CardLine label="Extraction">
              <ExtractionStatus view={view} alignEnd />
            </CardLine>
            <CardLine label="Last updated">
              <UpdatedTime view={view} />
            </CardLine>
          </div>
          <div style={{ marginTop: 14 }}>
            <PrimaryAction view={view} block />
          </div>
        </article>
      ))}
    </div>
  );
}
