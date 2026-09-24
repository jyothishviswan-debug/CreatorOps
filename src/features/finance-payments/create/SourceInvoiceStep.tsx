"use client";

import { useEffect, useState } from "react";

import { EmptyState, Skeleton } from "@/ui/States";
import { Pill } from "@/ui/Badge";
import type { InvoiceDetailDto } from "@/server/finance-invoices/client-dto";
import type { InvoicePaymentSettlementDto } from "@/server/finance-payments/client-dto";

import { getInvoiceForPayment, getInvoicePaymentSettlement, loadEligibleInvoices } from "../api-client";
import { NEVER_SETTLED_NOTE, selectedInvoiceSummary, toEligibleInvoiceRowView, type EligibleInvoiceSource } from "./create-view";

const SEARCH_DEBOUNCE_MS = 300;
const ELIGIBLE_PAGE_LIMIT = 15;
// Only settlement states that still admit a payment - a fully PAID or OVERPAID Invoice is not a
// normal eligible source (section 6: "Prefer unpaid, partially paid, and review-required states").
const NORMAL_ELIGIBLE_STATES = new Set(["UNPAID", "PARTIALLY_PAID", "REVIEW_REQUIRED"]);

// Step 17B: Record Payment - Stage 1 (Source Invoice). Approx 8/12 left (eligible Invoices table +
// compact filter), 4/12 right (selected Invoice's settlement summary). Only APPROVED Invoices are
// ever listed (Invoices' own workspace endpoint is asked for exactly that status - the same
// discipline SourcePayableStep.tsx uses for READY_FOR_INVOICE Payables), and rows whose settlement
// is already PAID/OVERPAID are filtered out client-side from this already-bounded, already-scoped
// page (never a substitute for a wider unbounded fetch - see create-view.ts's own comment on why
// Payments has no dedicated "preview eligibility" endpoint the way Invoices does).
export function SourceInvoiceStep({ selectedInvoiceRef, onSelect }: { selectedInvoiceRef: string | null; onSelect: (invoiceRef: string) => void }) {
  const [counterpartyRefText, setCounterpartyRefText] = useState("");
  const [rows, setRows] = useState<EligibleInvoiceSource[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);

  const [selectedDetail, setSelectedDetail] = useState<InvoiceDetailDto | null>(null);
  const [selectedSettlement, setSelectedSettlement] = useState<InvoicePaymentSettlementDto | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [selectedError, setSelectedError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setListLoading(true);
      setListError(null);
      void (async () => {
        const page = await loadEligibleInvoices({ counterpartyRef: counterpartyRefText.trim() || undefined, limit: ELIGIBLE_PAGE_LIMIT }, { signal: controller.signal });
        if (!page.ok) {
          if (!page.aborted) {
            setListError(page.message);
            setListLoading(false);
          }
          return;
        }
        const amountsVisible = page.data.permissions.canViewAmounts;
        const composed = await Promise.all(
          page.data.rows.map(async (row): Promise<EligibleInvoiceSource | null> => {
            const [detail, settlement] = await Promise.all([getInvoiceForPayment(row.invoiceRef, { signal: controller.signal }), getInvoicePaymentSettlement(row.invoiceRef, { signal: controller.signal })]);
            if (!detail.ok || !settlement.ok) return null;
            const pin = detail.data.selectedVersion?.payablePin ?? null;
            return {
              invoiceRef: row.invoiceRef,
              invoiceNumber: row.externalInvoiceNumber,
              counterpartyType: row.counterparty.type,
              counterpartyName: row.counterparty.displayName?.trim() || "Unnamed counterparty",
              commercialPeriodKey: row.commercialPeriod,
              currency: row.currency,
              grossInvoiceMinor: pin?.payableGrossInvoiceExpectedMinor ?? null,
              tdsMinor: pin?.payableTdsMinor ?? null,
              expectedNetPaymentMinor: settlement.data.summary.expectedNetPaymentMinor,
              confirmedPaidMinor: settlement.data.summary.confirmedPaidMinor,
              remainingMinor: settlement.data.summary.remainingMinor,
              settlementState: settlement.data.summary.state,
              amountsVisible,
            };
          }),
        );
        if (controller.signal.aborted) return;
        setRows(composed.filter((row): row is EligibleInvoiceSource => row !== null && (row.settlementState === null || NORMAL_ELIGIBLE_STATES.has(row.settlementState))));
        setListLoading(false);
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [counterpartyRefText]);

  async function select(invoiceRef: string) {
    onSelect(invoiceRef);
    setSelectedDetail(null);
    setSelectedSettlement(null);
    setSelectedError(null);
    setSelectedLoading(true);
    const [detail, settlement] = await Promise.all([getInvoiceForPayment(invoiceRef), getInvoicePaymentSettlement(invoiceRef)]);
    setSelectedLoading(false);
    if (!detail.ok) {
      setSelectedError(detail.message);
      return;
    }
    setSelectedDetail(detail.data);
    if (settlement.ok) setSelectedSettlement(settlement.data);
  }

  const views = (rows ?? []).map(toEligibleInvoiceRowView);

  return (
    <div className="grid">
      <section className="panel s8">
        <div className="panelhead">
          <div>
            <h2>Eligible Invoices</h2>
            <p>Approved Invoices with an outstanding balance</p>
          </div>
        </div>
        <div className="panelbody">
          <div className="fields" style={{ marginBottom: 14 }}>
            <div className="field">
              <label htmlFor="source-counterparty-ref">Counterparty ref</label>
              <input id="source-counterparty-ref" type="search" placeholder="Counterparty ref…" value={counterpartyRefText} onChange={(event) => setCounterpartyRefText(event.target.value)} />
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
            <EmptyState title="No eligible Invoices" description="No approved Invoice in your scope currently has an outstanding balance." icon="search" />
          ) : (
            <div className="tablewrap">
              <table className="compact">
                <thead>
                  <tr>
                    <th scope="col">Invoice</th>
                    <th scope="col">Counterparty</th>
                    <th scope="col">Period</th>
                    <th scope="col">Gross Invoice</th>
                    <th scope="col">TDS</th>
                    <th scope="col">Expected net</th>
                    <th scope="col">Confirmed paid</th>
                    <th scope="col">Remaining</th>
                    <th scope="col">Settlement</th>
                    <th scope="col">
                      <span className="sr">Select</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {views.map((view) => (
                    <tr key={view.key} data-testid="eligible-invoice-row" data-invoice-ref={view.invoiceRef} className={view.invoiceRef === selectedInvoiceRef ? "active" : undefined}>
                      <td>
                        {view.invoiceRef}
                        <small style={{ display: "block" }}>{view.invoiceNumber}</small>
                      </td>
                      <td>
                        <b>{view.counterpartyName}</b>
                        <small style={{ display: "block" }}>{view.counterpartyTypeLabel}</small>
                      </td>
                      <td>{view.commercialPeriod}</td>
                      <td>{view.grossInvoiceText}</td>
                      <td>{view.tdsText}</td>
                      <td>
                        <b>{view.expectedNetPaymentText}</b>
                      </td>
                      <td>{view.confirmedPaidText}</td>
                      <td>{view.remainingText}</td>
                      <td>{view.settlement && <Pill tone={view.settlement.tone}>{view.settlement.label}</Pill>}</td>
                      <td>
                        <button type="button" className={view.invoiceRef === selectedInvoiceRef ? "btn primary" : "btn"} onClick={() => void select(view.invoiceRef)} data-testid="select-invoice">
                          {view.invoiceRef === selectedInvoiceRef ? "Selected" : "Select"}
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
            <h2>Selected Invoice</h2>
          </div>
        </div>
        <div className="panelbody">
          {!selectedInvoiceRef && <p className="foundationnote">Select an eligible Invoice to see its settlement summary.</p>}
          {selectedInvoiceRef && selectedLoading && <p className="foundationnote">Resolving the Invoice…</p>}
          {selectedError && (
            <div className="banner" role="alert">
              {selectedError}
            </div>
          )}
          {selectedInvoiceRef && !selectedLoading && selectedDetail && (
            <>
              {selectedInvoiceSummaryFor(selectedDetail, selectedSettlement).map((row) => (
                <div className="kv" key={row.label}>
                  <span>{row.label}</span>
                  <b>{row.value}</b>
                </div>
              ))}
              <p className="foundationnote" style={{ marginTop: 14 }} data-testid="net-payment-note">
                {NEVER_SETTLED_NOTE}
              </p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function selectedInvoiceSummaryFor(detail: InvoiceDetailDto, settlement: InvoicePaymentSettlementDto | null) {
  const { head, selectedVersion } = detail;
  const pin = selectedVersion?.payablePin ?? null;
  const bankField = selectedVersion?.payeeIdentity?.fields.find((field) => field.field === "BANK") ?? null;
  return selectedInvoiceSummary({
    counterpartyName: head.counterparty.displayName ?? head.counterparty.ref,
    invoiceNumber: head.externalInvoiceNumber,
    invoiceRef: head.invoiceRef,
    invoiceVersion: head.approvedVersion ?? head.latestVersion,
    payableRef: pin?.payableRef ?? head.payableRef,
    payableVersion: pin?.payableVersion ?? 0,
    currency: head.currency,
    serviceBaseMinor: pin?.payableServiceBaseMinor ?? null,
    gstMinor: pin?.payableGstMinor ?? null,
    grossInvoiceMinor: pin?.payableGrossInvoiceExpectedMinor ?? null,
    tdsMinor: pin?.payableTdsMinor ?? null,
    expectedNetPaymentMinor: settlement?.summary.expectedNetPaymentMinor ?? pin?.payableExpectedNetPaymentMinor ?? null,
    confirmedPaidMinor: settlement?.summary.confirmedPaidMinor ?? null,
    remainingMinor: settlement?.summary.remainingMinor ?? null,
    payeeIdentityStatus: selectedVersion?.payeeIdentity?.overallStatus ?? null,
    bankSafeDisplay: bankField?.safeExpectedDisplay ?? bankField?.safeExtractedDisplay ?? null,
    settlementState: settlement?.summary.state ?? null,
    amountsVisible: detail.amountsVisible,
  });
}
