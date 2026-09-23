"use client";

import { useRef, useState } from "react";

import { formatFileSize, formatSignedMoneyMinor } from "../format";
import { emptyTaxLine, type InvoiceDetailsForm, type TaxLineDraft } from "./create-view";
import type { PreviewInvoiceEligibilityDto } from "@/server/finance-invoices/invoice-service";

export type StagedDocument = { fileName: string; sizeBytes: number; contentBase64: string; previewUrl: string };

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = reader.result as string;
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

// Step 16B: Create Invoice - Stage 2 (Invoice Details). Approx 7/12 left (invoice details + declared
// tax), 5/12 right (Invoice Document + source Payable summary). No client-side tax/GST calculation
// anywhere here - every field is a plain, manual capture of what the supplier invoice states.
export function InvoiceDetailsStep({
  form,
  onChange,
  existingDocument,
  stagedDocument,
  onStageDocument,
  onClearStagedDocument,
  preview,
}: {
  form: InvoiceDetailsForm;
  onChange: (change: Partial<InvoiceDetailsForm>) => void;
  existingDocument: { fileName: string; mimeType: string; sizeBytes: number } | null;
  stagedDocument: StagedDocument | null;
  onStageDocument: (document: StagedDocument) => void;
  onClearStagedDocument: () => void;
  preview: PreviewInvoiceEligibilityDto | null;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  function updateTaxLine(key: string, change: Partial<TaxLineDraft>) {
    onChange({ taxLines: form.taxLines.map((line) => (line.key === key ? { ...line, ...change } : line)) });
  }

  function addTaxLine() {
    onChange({ taxLines: [...form.taxLines, emptyTaxLine(`new-${Date.now()}-${form.taxLines.length}`)] });
  }

  function removeTaxLine(key: string) {
    onChange({ taxLines: form.taxLines.filter((line) => line.key !== key) });
  }

  async function onFilePicked(file: File | undefined) {
    setUploadError(null);
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setUploadError("Only a PDF file can be attached as the original Invoice document.");
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setUploadError("The document is larger than 10 MB.");
      return;
    }
    const contentBase64 = await fileToBase64(file);
    const previewUrl = URL.createObjectURL(file);
    onStageDocument({ fileName: file.name, sizeBytes: file.size, contentBase64, previewUrl });
  }

  return (
    <div className="grid">
      <section className="panel s7">
        <div className="panelhead">
          <div>
            <h2>Invoice details</h2>
            <p>Enter the supplier invoice details exactly as declared</p>
          </div>
        </div>
        <div className="panelbody">
          <div className="fields">
            <div className="field">
              <label htmlFor="invoice-number">Invoice number</label>
              <input id="invoice-number" type="text" maxLength={100} value={form.externalInvoiceNumber} onChange={(event) => onChange({ externalInvoiceNumber: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="invoice-date">Invoice date</label>
              <input id="invoice-date" type="date" value={form.invoiceDate} onChange={(event) => onChange({ invoiceDate: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="invoice-received-date">Received date</label>
              <input id="invoice-received-date" type="date" value={form.receivedDate} onChange={(event) => onChange({ receivedDate: event.target.value })} />
            </div>
          </div>

          <div className="fields" style={{ marginTop: 4 }}>
            <div className="field">
              <label htmlFor="invoice-currency">Currency</label>
              <input id="invoice-currency" type="text" maxLength={3} placeholder="INR" value={form.currency} onChange={(event) => onChange({ currency: event.target.value.toUpperCase() })} />
            </div>
            <div className="field">
              <label htmlFor="invoice-subtotal">Declared subtotal</label>
              <input id="invoice-subtotal" type="text" inputMode="decimal" placeholder="0.00" value={form.subtotalText} onChange={(event) => onChange({ subtotalText: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="invoice-total">Declared total</label>
              <input id="invoice-total" type="text" inputMode="decimal" placeholder="0.00" value={form.declaredTotalText} onChange={(event) => onChange({ declaredTotalText: event.target.value })} />
            </div>
          </div>

          <h3 style={{ margin: "18px 0 8px" }}>Declared tax</h3>
          {form.taxLines.length > 0 && (
            <div className="tablewrap" style={{ marginBottom: 10 }}>
              <table className="compact">
                <thead>
                  <tr>
                    <th scope="col">Tax label</th>
                    <th scope="col">Rate</th>
                    <th scope="col">Amount</th>
                    <th scope="col">
                      <span className="sr">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {form.taxLines.map((line) => (
                    <tr key={line.key}>
                      <td>
                        <input aria-label="Tax label" type="text" maxLength={200} value={line.label} onChange={(event) => updateTaxLine(line.key, { label: event.target.value })} />
                      </td>
                      <td style={{ width: 100 }}>
                        <input aria-label="Tax rate percent" type="text" inputMode="decimal" placeholder="%" value={line.rateText} onChange={(event) => updateTaxLine(line.key, { rateText: event.target.value })} />
                      </td>
                      <td style={{ width: 140 }}>
                        <input aria-label="Tax amount" type="text" inputMode="decimal" placeholder="0.00" value={line.amountText} onChange={(event) => updateTaxLine(line.key, { amountText: event.target.value })} />
                      </td>
                      <td>
                        <button type="button" className="btn ghost" onClick={() => removeTaxLine(line.key)} aria-label={`Remove tax line ${line.label || ""}`}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button type="button" className="btn" onClick={addTaxLine}>
            Add tax line
          </button>

          <div className="field" style={{ marginTop: 16 }}>
            <label htmlFor="invoice-due-date">Due date (optional)</label>
            <input id="invoice-due-date" type="date" value={form.dueDate} onChange={(event) => onChange({ dueDate: event.target.value })} />
          </div>
        </div>
      </section>

      <section className="panel s5">
        <div className="panelhead">
          <div>
            <h2>Invoice Document</h2>
            <p>Attach the exact original supplier invoice file</p>
          </div>
        </div>
        <div className="panelbody">
          {uploadError && (
            <div className="banner" role="alert" style={{ marginBottom: 10 }}>
              {uploadError}
            </div>
          )}
          {stagedDocument ? (
            <div className="record" data-testid="staged-document">
              <b>{stagedDocument.fileName}</b>
              <small style={{ display: "block" }}>PDF · {formatFileSize(stagedDocument.sizeBytes)}</small>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <a className="btn" href={stagedDocument.previewUrl} target="_blank" rel="noreferrer" data-testid="view-document">
                  View document
                </a>
                <button type="button" className="btn ghost" onClick={() => fileInputRef.current?.click()}>
                  Replace file
                </button>
              </div>
            </div>
          ) : existingDocument ? (
            <div className="record" data-testid="existing-document">
              <b>{existingDocument.fileName}</b>
              <small style={{ display: "block" }}>
                {existingDocument.mimeType} · {formatFileSize(existingDocument.sizeBytes)}
              </small>
              <p className="foundationnote" style={{ marginTop: 8 }}>
                Choose a new file to replace it.
              </p>
              <button type="button" className="btn" onClick={() => fileInputRef.current?.click()} style={{ marginTop: 8 }}>
                Replace file
              </button>
            </div>
          ) : (
            <div className="stateempty" style={{ padding: "28px 16px" }}>
              <p>No document attached yet.</p>
              <button type="button" className="btn primary" onClick={() => fileInputRef.current?.click()}>
                Upload PDF
              </button>
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" style={{ display: "none" }} onChange={(event) => void onFilePicked(event.target.files?.[0])} aria-label="Invoice document file" />
          {(stagedDocument || existingDocument) && (
            <button
              type="button"
              className="btn ghost"
              style={{ marginTop: 8 }}
              onClick={() => {
                onClearStagedDocument();
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            >
              Remove staged file
            </button>
          )}

          {preview?.pin && (
            <>
              <h3 style={{ margin: "18px 0 8px" }}>Source Payable</h3>
              <div className="kv">
                <span>Payable ref / version</span>
                <b>
                  {preview.pin.payableRef} · v{preview.pin.payableVersion}
                </b>
              </div>
              <div className="kv">
                <span>Gross expected Invoice total</span>
                <b>{formatSignedMoneyMinor(preview.pin.payableGrossInvoiceExpectedMinor, preview.pin.payableCurrency, { amountsVisible: preview.amountsVisible })}</b>
              </div>
              <div className="kv">
                <span>TDS (payment treatment, separate)</span>
                <b>{formatSignedMoneyMinor(preview.pin.payableTdsMinor, preview.pin.payableCurrency, { amountsVisible: preview.amountsVisible })}</b>
              </div>
              <div className="kv">
                <span>Currency</span>
                <b>{preview.pin.payableCurrency}</b>
              </div>
              <div className="kv">
                <span>Commercial period</span>
                <b>{preview.pin.commercialPeriod.periodKey}</b>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
