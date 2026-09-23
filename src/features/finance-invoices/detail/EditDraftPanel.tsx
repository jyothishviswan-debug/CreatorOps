"use client";

import { useState } from "react";

import type { InvoiceDetailDto, InvoiceVersionDto } from "@/server/finance-invoices/client-dto";

import { attachInvoiceDocument, reconcileInvoice, reviseInvoiceDraft } from "../api-client";
import { InvoiceDetailsStep, type StagedDocument } from "../create/InvoiceDetailsStep";
import { ReconciliationStep } from "../create/ReconciliationStep";
import { invoiceDetailsFormFromVersion, reviseFieldsFromForm, type InvoiceDetailsForm } from "../create/create-view";
import { nextVersionWording } from "./detail-view";

// Step 16B section 16: Edit Draft. Not a separate visual language - it reuses the Create wizard's
// Stage 2 (Invoice Details) and Stage 3 (Reconciliation) composition exactly, in place, inside the
// detail page. Saving always creates the NEXT immutable Invoice version (never edits history in
// place); the wording below says so before the person saves, and a reason is required exactly like
// every other revision in this module.
export function EditDraftPanel({ detail, onUpdated, onCancel }: { detail: InvoiceDetailDto; onUpdated: (updated: InvoiceDetailDto) => void; onCancel: () => void }) {
  const [form, setForm] = useState<InvoiceDetailsForm>(() => invoiceDetailsFormFromVersion(detail.selectedVersion!, detail.head.currency ?? "INR"));
  const [reason, setReason] = useState("");
  const [stagedDocument, setStagedDocument] = useState<StagedDocument | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<InvoiceVersionDto | null>(null);

  async function onSave() {
    if (reason.trim().length < 3) {
      setError("Enter a reason for this change (at least 3 characters).");
      return;
    }
    const parsed = reviseFieldsFromForm(form);
    if (!parsed.ok) {
      setError(parsed.errors.join(" "));
      return;
    }
    setSaving(true);
    setError(null);

    const revised = await reviseInvoiceDraft(detail.head.invoiceRef, { expectedDocVersion: detail.head.docVersion, ...parsed.fields, reason: reason.trim() });
    if (!revised.ok) {
      setSaving(false);
      setError(revised.message);
      return;
    }
    let current = revised.data;

    if (stagedDocument) {
      const attached = await attachInvoiceDocument(current.head.invoiceRef, { expectedDocVersion: current.head.docVersion, fileName: stagedDocument.fileName, contentBase64: stagedDocument.contentBase64 });
      if (!attached.ok) {
        setSaving(false);
        setError(attached.message);
        onUpdated(current);
        return;
      }
      current = attached.data;
    }

    setSaving(false);
    onUpdated(current);

    const reconciled = await reconcileInvoice(current.head.invoiceRef);
    if (reconciled.ok) setSaved(reconciled.data);
  }

  return (
    <div>
      <div className="banner" role="status" style={{ marginBottom: 14 }} data-testid="next-version-note">
        {nextVersionWording(detail.head.latestVersion)}
      </div>

      {error && (
        <div className="banner" role="alert" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      <InvoiceDetailsStep
        form={form}
        onChange={(change) => setForm((current) => ({ ...current, ...change }))}
        existingDocument={detail.selectedVersion?.document ?? null}
        stagedDocument={stagedDocument}
        onStageDocument={setStagedDocument}
        onClearStagedDocument={() => setStagedDocument(null)}
        preview={null}
      />

      <div className="field full" style={{ marginTop: 4 }}>
        <label htmlFor="edit-reason">Reason for change</label>
        <textarea id="edit-reason" maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required" />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={() => void onSave()} disabled={saving} data-testid="save-draft-revision">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {saved && (
        <div style={{ marginTop: 18 }}>
          <ReconciliationStep version={saved} loading={false} error={null} amountsVisible={detail.amountsVisible} />
        </div>
      )}
    </div>
  );
}
