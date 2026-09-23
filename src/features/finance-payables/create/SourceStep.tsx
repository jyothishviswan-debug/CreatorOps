"use client";

import { useEffect, useState } from "react";

import type { PayableSourcePreviewDto } from "@/server/finance-payables/client-dto";
import type { PayableCounterpartyType } from "@/server/finance-payables/types";

import { determinationChip } from "../format";
import { listVendorAgreements, searchCounterparties, type CounterpartyOption, type VendorAgreementOption } from "./counterparty-picker";
import { sourceEvidenceSummary, type SourceReadiness } from "./create-view";
import type { SourceSelection } from "./PayableCreatePage";

const COUNTERPARTY_SEARCH_DEBOUNCE_MS = 250;

// Step 15B: Create Payable - Stage 1 (Source). 7/12 left (source selection), 5/12 right (eligibility /
// source evidence summary). Blockers are shown in plain language straight from the backend's own
// `PayableSourceBlocker.message` - nothing here invents a reason generation was refused.
export function SourceStep({
  selection,
  onChange,
  preview,
  loading,
  error,
  readiness,
}: {
  selection: SourceSelection;
  onChange: (change: Partial<SourceSelection>) => void;
  preview: PayableSourcePreviewDto | null;
  loading: boolean;
  error: string | null;
  readiness: SourceReadiness;
}) {
  const [counterpartyQuery, setCounterpartyQuery] = useState(selection.counterpartyDisplayName);
  const [counterpartyOptions, setCounterpartyOptions] = useState<CounterpartyOption[]>([]);
  const [vendorAgreements, setVendorAgreements] = useState<VendorAgreementOption[]>([]);

  // Whether the query text is a real, uncommitted search (not the label of what's already selected).
  const shouldSearchCounterparty = Boolean(selection.counterpartyType) && counterpartyQuery.trim().length >= 2 && counterpartyQuery !== selection.counterpartyDisplayName;

  useEffect(() => {
    if (!shouldSearchCounterparty || !selection.counterpartyType) return;
    const type = selection.counterpartyType;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchCounterparties(type, counterpartyQuery.trim(), controller.signal).then((options) => {
        if (!controller.signal.aborted) setCounterpartyOptions(options);
      });
    }, COUNTERPARTY_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [selection.counterpartyType, counterpartyQuery, shouldSearchCounterparty]);

  useEffect(() => {
    if (selection.counterpartyType !== "VENDOR" || !selection.counterpartyRef) return;
    const ref = selection.counterpartyRef;
    const controller = new AbortController();
    void listVendorAgreements(ref, controller.signal).then((options) => {
      if (!controller.signal.aborted) setVendorAgreements(options);
    });
    return () => controller.abort();
  }, [selection.counterpartyType, selection.counterpartyRef]);

  const visibleCounterpartyOptions = shouldSearchCounterparty ? counterpartyOptions : [];
  const visibleVendorAgreements = selection.counterpartyType === "VENDOR" && selection.counterpartyRef ? vendorAgreements : [];

  function pickCounterparty(option: CounterpartyOption) {
    setCounterpartyOptions([]);
    setCounterpartyQuery(option.displayName);
    onChange({ counterpartyRef: option.ref, counterpartyDisplayName: option.displayName, agreementRef: "" });
  }

  return (
    <div className="grid">
      <section className="panel s7">
        <div className="panelhead">
          <div>
            <h2>Source selection</h2>
            <p>Counterparty and commercial period</p>
          </div>
        </div>
        <div className="panelbody">
          <div className="fields">
            <div className="field">
              <label htmlFor="payable-counterparty-type">Counterparty type</label>
              <select
                id="payable-counterparty-type"
                value={selection.counterpartyType ?? ""}
                onChange={(event) => {
                  const value = (event.target.value || null) as PayableCounterpartyType | null;
                  setCounterpartyQuery("");
                  onChange({ counterpartyType: value, counterpartyRef: "", counterpartyDisplayName: "", agreementRef: "" });
                }}
              >
                <option value="">Select type…</option>
                <option value="PARTNER">Partner</option>
                <option value="VENDOR">Vendor</option>
              </select>
            </div>

            <div className="field" style={{ position: "relative" }}>
              <label htmlFor="payable-counterparty">Counterparty</label>
              <input
                id="payable-counterparty"
                type="text"
                autoComplete="off"
                placeholder={selection.counterpartyType ? "Search by name…" : "Choose a type first"}
                disabled={!selection.counterpartyType}
                value={counterpartyQuery}
                onChange={(event) => {
                  setCounterpartyQuery(event.target.value);
                  if (selection.counterpartyRef) onChange({ counterpartyRef: "", counterpartyDisplayName: "", agreementRef: "" });
                }}
              />
              {visibleCounterpartyOptions.length > 0 && (
                <div className="searchresults" role="listbox" aria-label="Counterparty results" style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "white", border: "1px solid var(--line)", borderRadius: 8, zIndex: 5 }}>
                  {visibleCounterpartyOptions.map((option) => (
                    <button key={option.ref} type="button" role="option" aria-selected={false} onClick={() => pickCounterparty(option)}>
                      {option.displayName}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="field">
              <label htmlFor="payable-period">Commercial period</label>
              <input id="payable-period" type="month" value={selection.commercialPeriod} onChange={(event) => onChange({ commercialPeriod: event.target.value })} />
            </div>

            {selection.counterpartyType === "VENDOR" && (
              <div className="field">
                <label htmlFor="payable-agreement">Agreement</label>
                <select id="payable-agreement" value={selection.agreementRef} onChange={(event) => onChange({ agreementRef: event.target.value })} disabled={!selection.counterpartyRef}>
                  <option value="">{selection.counterpartyRef ? "Select the governing Agreement…" : "Choose a counterparty first"}</option>
                  {visibleVendorAgreements.map((agreement) => (
                    <option key={agreement.agreementRef} value={agreement.agreementRef}>
                      {agreement.agreementRef} · {agreement.status}
                    </option>
                  ))}
                </select>
                <small>Vendor payables are Agreement-only: no Partner Review evidence exists for a Vendor.</small>
              </div>
            )}

            {selection.counterpartyType === "PARTNER" && (
              <div className="field full">
                <label>Source type</label>
                <small>Partner payables always resolve to the finalized Partner Review for this period.</small>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="panel s5">
        <div className="panelhead">
          <div>
            <h2>Eligibility / source evidence</h2>
            <p>Resolved after a counterparty and period are chosen</p>
          </div>
        </div>
        <div className="panelbody">
          {loading && <p className="foundationnote">Resolving source evidence…</p>}
          {error && (
            <div className="banner" role="alert">
              <b>Couldn’t resolve the source.</b> {error}
            </div>
          )}
          {!loading && !error && !preview && <p className="foundationnote">Choose a counterparty and commercial period to see the resolved evidence.</p>}
          {preview && (
            <>
              <div className="kv">
                <span>Determination</span>
                <b>{determinationChip(preview.determinationState).label}</b>
              </div>
              {sourceEvidenceSummary(preview).map((row) => (
                <div className="kv" key={row.label}>
                  <span>{row.label}</span>
                  <b>{row.value}</b>
                </div>
              ))}

              {readiness.blocked && readiness.blockerMessages.length > 0 && (
                <div className="banner" role="alert" style={{ marginTop: 14 }}>
                  <b>This source is blocked:</b>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {readiness.blockerMessages.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </div>
              )}

              {!readiness.blocked && readiness.reviewMessages.length > 0 && (
                <div className="banner" style={{ marginTop: 14 }}>
                  <b>Finance review will be needed:</b>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {readiness.reviewMessages.map((message) => (
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
