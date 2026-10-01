"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import type { PayableCounterpartyType } from "@/server/finance-payables/types";

import { createPayablesForItems, type BulkPayableItemResultDto, type PayableSourceRequestInput } from "../api-client";
import { listVendorAgreements, searchCounterparties, type CounterpartyOption, type VendorAgreementOption } from "./counterparty-picker";

const SEARCH_DEBOUNCE_MS = 250;

// Finding #62: bulk Create Payable - one logical orchestration request over any number of
// counterparty x period items. Deliberately a SEPARATE, simpler flow from the single-item
// Source -> Review amount -> Confirm wizard (PayableCreatePage.tsx): bulk items carry no manual
// adjustment (that stays a per-Payable follow-up action on the created Payable's own detail page -
// never a new financial dimension invented here), and every item is created through the exact same
// canonical createPayable() the single-item flow uses, via one server-side bulk request
// (POST /api/finance/payables/bulk) - never a client-side loop of individual creates.
//
// "Never silently create an unseen cartesian product": the explicit item list (selected
// counterparties x selected periods, minus any individually removed pairs) is always shown before
// submit, and any single pair can be removed from that list.
type CounterpartySelection = { ref: string; displayName: string };

export function PayableBulkCreatePage() {
  const [counterpartyType, setCounterpartyType] = useState<PayableCounterpartyType>("PARTNER");
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<CounterpartyOption[]>([]);
  const [selected, setSelected] = useState<Map<string, CounterpartySelection>>(new Map());

  const [vendorAgreements, setVendorAgreements] = useState<Map<string, VendorAgreementOption[]>>(new Map());
  const [agreementByVendor, setAgreementByVendor] = useState<Map<string, string>>(new Map());

  const [periodInput, setPeriodInput] = useState("");
  const [periods, setPeriods] = useState<string[]>([]);

  const [removedPairs, setRemovedPairs] = useState<Set<string>>(new Set());

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [results, setResults] = useState<Array<BulkPayableItemResultDto & { counterpartyDisplayName: string }> | null>(null);

  const shouldSearch = query.trim().length >= 2;

  useEffect(() => {
    if (!shouldSearch) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchCounterparties(counterpartyType, query.trim(), controller.signal).then((rows) => {
        if (!controller.signal.aborted) setOptions(rows);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [counterpartyType, query, shouldSearch]);

  const visibleOptions = shouldSearch ? options : [];

  function addCounterparty(option: CounterpartyOption) {
    setSelected((current) => {
      const next = new Map(current);
      next.set(option.ref, { ref: option.ref, displayName: option.displayName });
      return next;
    });
    setQuery("");
    setOptions([]);
    if (counterpartyType === "VENDOR" && !vendorAgreements.has(option.ref)) {
      void listVendorAgreements(option.ref).then((agreements) => {
        setVendorAgreements((current) => new Map(current).set(option.ref, agreements));
      });
    }
  }

  function removeCounterparty(ref: string) {
    setSelected((current) => {
      const next = new Map(current);
      next.delete(ref);
      return next;
    });
  }

  function addPeriod() {
    if (!periodInput || periods.includes(periodInput)) return;
    setPeriods((current) => [...current, periodInput].sort());
    setPeriodInput("");
  }

  function removePeriod(period: string) {
    setPeriods((current) => current.filter((p) => p !== period));
  }

  function pairKey(ref: string, period: string): string {
    return `${ref}|${period}`;
  }

  function togglePair(ref: string, period: string) {
    setRemovedPairs((current) => {
      const key = pairKey(ref, period);
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // The explicit, already-expanded item set - exactly what will be submitted. Never sent to the
  // server as two separate arrays for it to cross-multiply.
  const previewItems: Array<{ ref: string; displayName: string; period: string }> = [];
  for (const counterparty of selected.values()) {
    for (const period of periods) {
      if (removedPairs.has(pairKey(counterparty.ref, period))) continue;
      previewItems.push({ ref: counterparty.ref, displayName: counterparty.displayName, period });
    }
  }

  const missingVendorAgreement = counterpartyType === "VENDOR" && previewItems.some((item) => !agreementByVendor.get(item.ref));
  const canSubmit = previewItems.length > 0 && !missingVendorAgreement && !submitting;

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    setResults(null);

    const items: PayableSourceRequestInput[] = previewItems.map((item) => ({
      counterpartyType,
      counterpartyRef: item.ref,
      commercialPeriod: item.period,
      ...(counterpartyType === "VENDOR" ? { agreementRef: agreementByVendor.get(item.ref) } : {}),
    }));

    const result = await createPayablesForItems(items);
    setSubmitting(false);
    if (!result.ok) {
      setSubmitError(result.message);
      return;
    }
    const byRef = new Map(previewItems.map((item) => [item.ref, item.displayName]));
    setResults(result.data.results.map((row) => ({ ...row, counterpartyDisplayName: byRef.get(row.item.counterpartyRef) ?? row.item.counterpartyRef })));
  }

  return (
    <div className="grid">
      <section className="panel s7">
        <div className="panelhead">
          <div>
            <h2>Counterparties and periods</h2>
            <p>Select as many as you need - each combination becomes one payable item below.</p>
          </div>
        </div>
        <div className="panelbody">
          <div className="fields">
            <div className="field">
              <label htmlFor="bulk-counterparty-type">Counterparty type</label>
              <select
                id="bulk-counterparty-type"
                value={counterpartyType}
                onChange={(event) => {
                  setCounterpartyType(event.target.value as PayableCounterpartyType);
                  setSelected(new Map());
                  setQuery("");
                  setOptions([]);
                  setResults(null);
                }}
                disabled={selected.size > 0}
              >
                <option value="PARTNER">Partner</option>
                <option value="VENDOR">Vendor</option>
              </select>
              {selected.size > 0 && <small>Remove every selected counterparty to change type.</small>}
            </div>

            <div className="field" style={{ position: "relative" }}>
              <label htmlFor="bulk-counterparty-search">Add counterparty</label>
              <input id="bulk-counterparty-search" type="text" autoComplete="off" placeholder="Search by name…" value={query} onChange={(event) => setQuery(event.target.value)} />
              {visibleOptions.length > 0 && (
                <div className="searchresults" role="listbox" aria-label="Counterparty results" style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "white", border: "1px solid var(--line)", borderRadius: 8, zIndex: 5 }}>
                  {visibleOptions.map((option) => (
                    <button key={option.ref} type="button" role="option" aria-selected={selected.has(option.ref)} disabled={selected.has(option.ref)} onClick={() => addCounterparty(option)}>
                      {option.displayName}
                      {selected.has(option.ref) && <small> · already added</small>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selected.size > 0 && (
              <div className="field full">
                <label>Selected counterparties ({selected.size})</label>
                <div className="banner" style={{ flexDirection: "column", alignItems: "flex-start", gap: 6, marginBottom: 0 }}>
                  {[...selected.values()].map((counterparty) => (
                    <span key={counterparty.ref} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                      <b style={{ flex: 1 }}>{counterparty.displayName}</b>
                      {counterpartyType === "VENDOR" && (
                        <select
                          aria-label={`Governing Agreement for ${counterparty.displayName}`}
                          value={agreementByVendor.get(counterparty.ref) ?? ""}
                          onChange={(event) => setAgreementByVendor((current) => new Map(current).set(counterparty.ref, event.target.value))}
                        >
                          <option value="">Select Agreement…</option>
                          {(vendorAgreements.get(counterparty.ref) ?? []).map((agreement) => (
                            <option key={agreement.agreementRef} value={agreement.agreementRef}>
                              {agreement.agreementRef} · {agreement.status}
                            </option>
                          ))}
                        </select>
                      )}
                      <button type="button" className="btn ghost" onClick={() => removeCounterparty(counterparty.ref)}>
                        Remove
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="field">
              <label htmlFor="bulk-period">Add commercial period</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input id="bulk-period" type="month" value={periodInput} onChange={(event) => setPeriodInput(event.target.value)} />
                <button type="button" className="btn" onClick={addPeriod} disabled={!periodInput}>
                  Add
                </button>
              </div>
            </div>

            {periods.length > 0 && (
              <div className="field full">
                <label>Selected periods ({periods.length})</label>
                <div className="publictags">
                  {periods.map((period) => (
                    <span className="pill gray" key={period}>
                      {period}{" "}
                      <button type="button" className="btn ghost" style={{ padding: "0 4px", minHeight: "auto" }} aria-label={`Remove period ${period}`} onClick={() => removePeriod(period)}>
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="panel s5">
        <div className="panelhead">
          <div>
            <h2>Item preview</h2>
            <p>Exactly what will be submitted - nothing here is a hidden cartesian product.</p>
          </div>
        </div>
        <div className="panelbody">
          {previewItems.length === 0 ? (
            <p className="foundationnote">Select at least one counterparty and one period to see the resulting items.</p>
          ) : (
            <>
              <p className="foundationnote" style={{ marginBottom: 10 }}>
                {previewItems.length} item{previewItems.length === 1 ? "" : "s"}
              </p>
              {[...selected.values()].map((counterparty) =>
                periods.length === 0 ? null : (
                  <div key={counterparty.ref} style={{ marginBottom: 10 }}>
                    <b style={{ fontSize: 12 }}>{counterparty.displayName}</b>
                    {periods.map((period) => {
                      const removed = removedPairs.has(pairKey(counterparty.ref, period));
                      return (
                        <label key={period} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "3px 0", opacity: removed ? 0.5 : 1 }}>
                          <input type="checkbox" checked={!removed} onChange={() => togglePair(counterparty.ref, period)} />
                          {period}
                        </label>
                      );
                    })}
                  </div>
                ),
              )}
              {missingVendorAgreement && (
                <div className="banner" role="alert">
                  Select a governing Agreement for every Vendor before submitting.
                </div>
              )}
              {submitError && (
                <div className="banner" role="alert">
                  {submitError}
                </div>
              )}
              <button type="button" className="btn primary" disabled={!canSubmit} onClick={handleSubmit} style={{ marginTop: 10 }}>
                {submitting ? "Creating…" : `Create ${previewItems.length} payable${previewItems.length === 1 ? "" : "s"}`}
              </button>
            </>
          )}

          {results && (
            <div style={{ marginTop: 20 }}>
              <p className="foundationnote" style={{ marginBottom: 10 }}>
                Results
              </p>
              <div className="tablewrap">
                <table className="compact">
                  <thead>
                    <tr>
                      <th>Counterparty</th>
                      <th>Period</th>
                      <th>Outcome</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((row, index) => (
                      <tr key={index}>
                        <td>{row.counterpartyDisplayName}</td>
                        <td>{row.item.commercialPeriod}</td>
                        <td>
                          <span className={`pill ${row.outcome === "created" ? "" : row.outcome === "existing" ? "blue" : "red"}`}>{row.outcome}</span>
                        </td>
                        <td>
                          {row.payableRef ? (
                            <Link href={`/finance/payables/${row.payableRef}`} className="textlink">
                              Open
                            </Link>
                          ) : (
                            row.error
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

