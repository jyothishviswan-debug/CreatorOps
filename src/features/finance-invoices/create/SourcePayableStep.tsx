"use client";

import { useEffect, useState } from "react";

import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";

import { loadEligiblePayables } from "../api-client";
import { isCommercialPeriod } from "../workspace/workspace-query";
import { selectedPayableSummary, sourceReadiness, toEligiblePayableRowView, type EligiblePayableSourceRow, type SourceReadiness } from "./create-view";
import type { PreviewInvoiceEligibilityDto } from "@/server/finance-invoices/invoice-service";

const SEARCH_DEBOUNCE_MS = 300;

// Step 16B: Create Invoice - Stage 1 (Source Payable). Approx 8/12 left (eligible Payables table +
// compact filters), 4/12 right (selected Payable's commercial summary). Only server-eligible
// READY_FOR_INVOICE Payables are ever listed here - never a Draft or Void one (Payables' own
// workspace endpoint is asked for exactly that status; nothing is filtered client-side beyond it).
export function SourcePayableStep({
  selectedPayableRef,
  onSelect,
  preview,
  previewLoading,
  previewError,
}: {
  selectedPayableRef: string | null;
  onSelect: (payableRef: string) => void;
  preview: PreviewInvoiceEligibilityDto | null;
  previewLoading: boolean;
  previewError: string | null;
}) {
  const [counterpartyRefText, setCounterpartyRefText] = useState("");
  const [commercialPeriod, setCommercialPeriod] = useState("");
  const [rows, setRows] = useState<EligiblePayableSourceRow[] | null>(null);
  const [amountsVisible, setAmountsVisible] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setListLoading(true);
      void loadEligiblePayables({ counterpartyRef: counterpartyRefText.trim() || undefined, commercialPeriod: commercialPeriod || undefined, limit: 25 }, { signal: controller.signal }).then((result) => {
        if (!result.ok) {
          if (!result.aborted) {
            setListError(result.message);
            setListLoading(false);
          }
          return;
        }
        setRows(result.data.rows);
        setAmountsVisible(result.data.permissions.canViewAmounts);
        setListError(null);
        setListLoading(false);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [counterpartyRefText, commercialPeriod]);

  const views = (rows ?? []).map((row) => toEligiblePayableRowView(row, amountsVisible));
  const readiness: SourceReadiness = sourceReadiness(preview);

  return (
    <div className="grid">
      <section className="panel s8">
        <div className="panelhead">
          <div>
            <h2>Eligible Payables</h2>
            <p>Payables that are READY_FOR_INVOICE and not yet invoiced</p>
          </div>
        </div>
        <div className="panelbody">
          <div className="fields" style={{ marginBottom: 14 }}>
            <div className="field">
              <label htmlFor="source-counterparty-ref">Counterparty ref</label>
              <input id="source-counterparty-ref" type="search" placeholder="Counterparty ref…" value={counterpartyRefText} onChange={(event) => setCounterpartyRefText(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="source-period">Commercial period</label>
              <input id="source-period" type="month" value={commercialPeriod} onChange={(event) => (event.target.value === "" || isCommercialPeriod(event.target.value) ? setCommercialPeriod(event.target.value) : undefined)} />
            </div>
          </div>

          {listError && (
            <div className="banner" role="alert">
              {listError}
            </div>
          )}

          {listLoading ? (
            <Skeleton lines={4} />
          ) : views.length === 0 ? (
            <EmptyState title="No eligible Payables" description="No Payable in your scope is currently READY_FOR_INVOICE for these filters." icon="search" />
          ) : (
            <div className="tablewrap">
              <table className="compact">
                <thead>
                  <tr>
                    <th scope="col">Payable</th>
                    <th scope="col">Counterparty</th>
                    <th scope="col">Period</th>
                    <th scope="col">Currency</th>
                    <th scope="col">Total</th>
                    <th scope="col">Agreement</th>
                    <th scope="col">
                      <span className="sr">Select</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {views.map((view) => (
                    <tr key={view.key} data-testid="eligible-payable-row" data-payable-ref={view.payableRef} className={view.payableRef === selectedPayableRef ? "active" : undefined}>
                      <td>{view.payableRef}</td>
                      <td>
                        <b>{view.counterpartyName}</b>
                        <small style={{ display: "block" }}>{view.counterpartyTypeLabel}</small>
                      </td>
                      <td>{view.commercialPeriod}</td>
                      <td>{view.currency}</td>
                      <td>{view.totalText}</td>
                      <td>{view.agreementText}</td>
                      <td>
                        <button type="button" className={view.payableRef === selectedPayableRef ? "btn primary" : "btn"} onClick={() => onSelect(view.payableRef)} data-testid="select-payable">
                          {view.payableRef === selectedPayableRef ? "Selected" : "Select"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="panel s4">
        <div className="panelhead">
          <div>
            <h2>Selected Payable</h2>
          </div>
        </div>
        <div className="panelbody">
          {!selectedPayableRef && <p className="foundationnote">Select an eligible Payable to see its commercial summary.</p>}
          {selectedPayableRef && previewLoading && <p className="foundationnote">Resolving the Payable…</p>}
          {previewError && (
            <div className="banner" role="alert">
              {previewError}
            </div>
          )}
          {selectedPayableRef && !previewLoading && preview && (
            <>
              {preview.eligible && (
                <div className="kv">
                  <span>Status</span>
                  <b>
                    <Pill>Ready for invoice</Pill>
                  </b>
                </div>
              )}
              {selectedPayableSummary(preview).map((row) => (
                <div className="kv" key={row.label}>
                  <span>{row.label}</span>
                  <b>{row.value}</b>
                </div>
              ))}
              {preview.existingInvoiceRef && (
                <div className="banner" role="status" style={{ marginTop: 14 }}>
                  An Invoice already exists for this Payable ({preview.existingInvoiceRef}).
                </div>
              )}
              {readiness.blocked && readiness.blockerMessages.length > 0 && (
                <div className="banner" role="alert" style={{ marginTop: 14 }}>
                  <b>This Payable cannot found an Invoice:</b>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {readiness.blockerMessages.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
