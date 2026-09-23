"use client";

import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Pill } from "@/ui/Badge";

import { WORKSPACE_TABLE_CAPTION } from "./workspace-copy";
import { initialsOfName, type WorkspaceRowView } from "./workspace-view-model";

// Step 15B: the two renderings of one page of Payable rows - the accepted `.tablewrap` table (desktop,
// columns scroll INSIDE the wrapper, never the document) and the accepted `.recordgrid`/`.record`
// stacked cards for narrow screens. Both read the same WorkspaceRowView, so they can never disagree.
const WRAP_STYLE = { whiteSpace: "normal", overflowWrap: "anywhere" } as const;

function CounterpartyLink({ view }: { view: WorkspaceRowView }) {
  return (
    <Link className="rowlink person" href={view.detailHref} aria-label={`Open Payable ${view.payableRef} for ${view.counterpartyName}`}>
      <span className="avatar" aria-hidden="true">
        {initialsOfName(view.counterpartyName)}
      </span>
      <span style={{ ...WRAP_STYLE, minWidth: 0 }}>
        <b>{view.counterpartyName}</b>
        <small style={{ display: "block" }}>{view.counterpartyTypeLabel}</small>
      </span>
    </Link>
  );
}

function AmountCell({ view }: { view: WorkspaceRowView }) {
  return (
    <div style={{ ...WRAP_STYLE }}>
      <b>{view.amountText}</b>
      {view.determination.label !== "Deterministic" && <small style={{ display: "block" }}>{view.determination.label === "Blocked" ? "Not finalized" : "Not final · pending review"}</small>}
    </div>
  );
}

export function PayablesTable({ rows }: { rows: WorkspaceRowView[] }) {
  const router = useRouter();

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
            <th scope="col">Payable</th>
            <th scope="col">Counterparty</th>
            <th scope="col">Commercial period</th>
            <th scope="col">Review / source</th>
            <th scope="col">Amount</th>
            <th scope="col">Determination</th>
            <th scope="col">Status</th>
            <th scope="col">Updated</th>
            <th scope="col">
              <span className="sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((view) => (
            <tr key={view.key} data-testid="payable-row" data-payable-ref={view.payableRef} style={{ cursor: "pointer" }} onClick={(event) => openRow(event, view.detailHref)}>
              <td>
                <span data-testid="payable-reference" style={WRAP_STYLE}>
                  {view.payableRef}
                </span>
              </td>
              <td>
                <CounterpartyLink view={view} />
              </td>
              <td>{view.commercialPeriod}</td>
              <td>
                {view.sourceTypeLabel}
                {view.openReviewCount > 0 && (
                  <small style={{ display: "block" }} data-testid="open-review-count">
                    {view.openReviewCount} open review {view.openReviewCount === 1 ? "item" : "items"}
                  </small>
                )}
              </td>
              <td>
                <AmountCell view={view} />
              </td>
              <td>
                <Pill tone={view.determination.tone}>{view.determination.label}</Pill>
              </td>
              <td>
                <Pill tone={view.status.tone}>{view.status.label}</Pill>
              </td>
              <td>
                <time dateTime={view.updatedIso} suppressHydrationWarning>
                  {view.updated}
                </time>
              </td>
              <td>
                <Link className="btn" href={view.detailHref} aria-label={`Open Payable ${view.payableRef}`} data-testid="open-payable">
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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

export function PayableCards({ rows }: { rows: WorkspaceRowView[] }) {
  return (
    <div className="recordgrid">
      {rows.map((view) => (
        <article className="record" key={view.key} data-testid="payable-card" data-payable-ref={view.payableRef} style={{ minWidth: 0 }}>
          <CounterpartyLink view={view} />
          <div style={{ marginTop: 12 }}>
            <CardLine label="Payable">
              <span data-testid="payable-reference">{view.payableRef}</span>
            </CardLine>
            <CardLine label="Period">{view.commercialPeriod}</CardLine>
            <CardLine label="Amount">
              <AmountCell view={view} />
            </CardLine>
            <CardLine label="Determination">
              <Pill tone={view.determination.tone}>{view.determination.label}</Pill>
            </CardLine>
            <CardLine label="Status">
              <Pill tone={view.status.tone}>{view.status.label}</Pill>
            </CardLine>
            <CardLine label="Source">{view.sourceTypeLabel}</CardLine>
            <CardLine label="Updated">
              <time dateTime={view.updatedIso} suppressHydrationWarning>
                {view.updated}
              </time>
            </CardLine>
          </div>
          <div style={{ marginTop: 14 }}>
            <Link className="btn" href={view.detailHref} style={{ width: "100%" }} data-testid="open-payable">
              Open
            </Link>
          </div>
        </article>
      ))}
    </div>
  );
}
