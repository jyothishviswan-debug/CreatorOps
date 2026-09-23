"use client";

import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Pill } from "@/ui/Badge";

import { WORKSPACE_TABLE_CAPTION } from "./workspace-copy";
import { initialsOfName, type WorkspaceRowView } from "./workspace-view-model";

// Step 16B: the two renderings of one page of Invoice rows - the accepted `.tablewrap` table
// (desktop, columns scroll INSIDE the wrapper, never the document) and the accepted `.recordgrid`/
// `.record` stacked cards for narrow screens. Both read the same WorkspaceRowView, so they can
// never disagree.
const WRAP_STYLE = { whiteSpace: "normal", overflowWrap: "anywhere" } as const;

function CounterpartyLink({ view }: { view: WorkspaceRowView }) {
  return (
    <Link className="rowlink person" href={view.detailHref} aria-label={`Open Invoice ${view.invoiceRef} for ${view.counterpartyName}`}>
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

export function InvoicesTable({ rows }: { rows: WorkspaceRowView[] }) {
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
            <th scope="col">Invoice</th>
            <th scope="col">Counterparty</th>
            <th scope="col">Invoice number</th>
            <th scope="col">Payable</th>
            <th scope="col">Declared total</th>
            <th scope="col">Reconciliation</th>
            <th scope="col">Status</th>
            <th scope="col">Updated</th>
            <th scope="col">
              <span className="sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((view) => (
            <tr key={view.key} data-testid="invoice-row" data-invoice-ref={view.invoiceRef} style={{ cursor: "pointer" }} onClick={(event) => openRow(event, view.detailHref)}>
              <td>
                <span data-testid="invoice-reference" style={WRAP_STYLE}>
                  {view.invoiceRef}
                </span>
                <small style={{ display: "block" }}>{view.commercialPeriod}</small>
              </td>
              <td>
                <CounterpartyLink view={view} />
              </td>
              <td style={WRAP_STYLE}>{view.invoiceNumber}</td>
              <td>
                <Link className="textlink" href={view.payableHref} style={WRAP_STYLE}>
                  {view.payableRef}
                </Link>
              </td>
              <td>
                <b>{view.amountText}</b>
              </td>
              <td>
                <Pill tone={view.reconciliation.tone}>{view.reconciliation.label}</Pill>
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
                <Link className="btn" href={view.detailHref} aria-label={`Open Invoice ${view.invoiceRef}`} data-testid="open-invoice">
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

export function InvoiceCards({ rows }: { rows: WorkspaceRowView[] }) {
  return (
    <div className="recordgrid">
      {rows.map((view) => (
        <article className="record" key={view.key} data-testid="invoice-card" data-invoice-ref={view.invoiceRef} style={{ minWidth: 0 }}>
          <CounterpartyLink view={view} />
          <div style={{ marginTop: 12 }}>
            <CardLine label="Invoice">
              <span data-testid="invoice-reference">{view.invoiceRef}</span>
            </CardLine>
            <CardLine label="Invoice number">{view.invoiceNumber}</CardLine>
            <CardLine label="Declared total">
              <b>{view.amountText}</b>
            </CardLine>
            <CardLine label="Reconciliation">
              <Pill tone={view.reconciliation.tone}>{view.reconciliation.label}</Pill>
            </CardLine>
            <CardLine label="Status">
              <Pill tone={view.status.tone}>{view.status.label}</Pill>
            </CardLine>
            <CardLine label="Payable">
              <Link className="textlink" href={view.payableHref}>
                {view.payableRef}
              </Link>
            </CardLine>
            <CardLine label="Updated">
              <time dateTime={view.updatedIso} suppressHydrationWarning>
                {view.updated}
              </time>
            </CardLine>
          </div>
          <div style={{ marginTop: 14 }}>
            <Link className="btn" href={view.detailHref} style={{ width: "100%" }} data-testid="open-invoice">
              Open
            </Link>
          </div>
        </article>
      ))}
    </div>
  );
}
