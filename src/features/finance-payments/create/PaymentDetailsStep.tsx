"use client";

import type { InvoicePaymentSettlementDto } from "@/server/finance-payments/client-dto";
import type { PaymentMethod } from "@/server/finance-payments/types";

import { PAYMENT_METHOD_OPTIONS } from "../format";
import { overpaymentWarning, RECORDED_NOT_SETTLED_NOTE, RECORD_TRANSFER_NOTE, remainingAfterThisPayment, settlementImpactRows, type PaymentDetailsForm } from "./create-view";
import { parseMoneyInputToMinor } from "../format";

// Step 17B: Record Payment - Stage 2 (Payment Details). Approx 7/12 left (the declared fields),
// 5/12 right (Invoice settlement impact - section 7/17). Never a bank-execution button: this stage
// only records what already happened outside CreatorOps (RECORD_TRANSFER_NOTE).
export function PaymentDetailsStep({
  form,
  onChange,
  currency,
  settlement,
}: {
  form: PaymentDetailsForm;
  onChange: (change: Partial<PaymentDetailsForm>) => void;
  currency: string | null;
  settlement: InvoicePaymentSettlementDto | null;
}) {
  const parsedAmount = form.amountText.trim().length > 0 ? parseMoneyInputToMinor(form.amountText) : null;
  const thisPaymentMinor = parsedAmount && parsedAmount.ok ? parsedAmount.amountMinor : null;
  const remainingMinor = settlement?.summary.remainingMinor ?? null;
  const warning = overpaymentWarning(remainingMinor, thisPaymentMinor);
  const remainingAfter = remainingAfterThisPayment(remainingMinor, thisPaymentMinor);
  const amountsVisible = settlement?.amountsVisible ?? true;

  const rows = settlementImpactRows({
    expectedNetPaymentMinor: settlement?.summary.expectedNetPaymentMinor ?? null,
    confirmedPaidMinor: settlement?.summary.confirmedPaidMinor ?? null,
    remainingMinor,
    thisPaymentMinor,
    currency,
    amountsVisible,
  });

  return (
    <div className="grid">
      <section className="panel s7">
        <div className="panelhead">
          <div>
            <h2>Payment details</h2>
            <p>Enter the details of the money movement.</p>
          </div>
        </div>
        <div className="panelbody">
          <p className="foundationnote" style={{ marginBottom: 14 }} data-testid="record-transfer-note">
            {RECORD_TRANSFER_NOTE}
          </p>

          {parsedAmount && !parsedAmount.ok && (
            <div className="banner" role="alert" style={{ marginBottom: 14 }}>
              {parsedAmount.message}
            </div>
          )}
          {warning && (
            <div className="banner" role="alert" style={{ marginBottom: 14 }} data-testid="overpayment-warning">
              {warning}
            </div>
          )}

          <div className="fields">
            <div className="field">
              <label htmlFor="payment-amount">Payment amount</label>
              <input id="payment-amount" type="text" inputMode="decimal" placeholder="0.00" value={form.amountText} onChange={(event) => onChange({ amountText: event.target.value })} data-testid="payment-amount-input" />
            </div>
            <div className="field">
              <label htmlFor="payment-date">Payment date</label>
              <input id="payment-date" type="date" value={form.paymentDate} onChange={(event) => onChange({ paymentDate: event.target.value })} data-testid="payment-date-input" />
            </div>
            <div className="field">
              <label htmlFor="payment-currency">Currency</label>
              <input id="payment-currency" type="text" value={currency ?? ""} readOnly disabled />
            </div>
            <div className="field">
              <label htmlFor="payment-method">Payment method</label>
              <select id="payment-method" value={form.method} onChange={(event) => onChange({ method: event.target.value as PaymentMethod | "" })} data-testid="payment-method-select">
                <option value="">Select a method</option>
                {PAYMENT_METHOD_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="payment-reference">External payment reference / UTR</label>
              <input id="payment-reference" type="text" maxLength={120} value={form.externalReference} onChange={(event) => onChange({ externalReference: event.target.value })} data-testid="payment-reference-input" />
            </div>
            <div className="field full">
              <label htmlFor="payment-memo">Note / memo (optional)</label>
              <textarea id="payment-memo" maxLength={1000} value={form.memo} onChange={(event) => onChange({ memo: event.target.value })} />
            </div>
          </div>
        </div>
      </section>

      <section className="panel s5">
        <div className="panelhead">
          <div>
            <h2>Invoice settlement</h2>
          </div>
        </div>
        <div className="panelbody">
          {rows.map((row) => (
            <div className="kv" key={row.label}>
              <span>{row.label}</span>
              <b>{row.value}</b>
            </div>
          ))}
          <p className="foundationnote" style={{ marginTop: 14 }} data-testid="recorded-not-settled-note">
            {RECORDED_NOT_SETTLED_NOTE}
          </p>
          {remainingAfter === 0 && thisPaymentMinor !== null && !warning && (
            <p className="foundationnote" style={{ marginTop: 8 }}>
              Confirming this Payment would fully settle the Invoice.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
