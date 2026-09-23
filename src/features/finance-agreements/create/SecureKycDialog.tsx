"use client";

// EXECUTE_HARD_RESET Section 17: "use secure focused dialogs for sensitive entry/update... do not send full
// sensitive values in ordinary page hydration." This dialog offers applying the value ALREADY found (and
// reviewed) in the attached extraction into the missing KYC component - the mechanism the owning restricted-
// identity service actually supports from an Agreement. It never collects a freshly-typed raw identity number
// itself (that stays the owning Partner/Vendor record's own form, one link away) - typing a PAN/Aadhaar/bank
// number into a new ad-hoc dialog here would be a second place holding sensitive input for no real benefit over
// the owning record's own, already-audited entry form.
import { DialogShell } from "@/ui/Dialog";

import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { evaluateApplyOption, kycDialogIntro, kycDialogTitle, owningRecordHref, type KycDialogKind } from "../agreement-intake-logic/kyc-ui";
import { useIntake } from "../agreement-intake-logic/intake-context";
import type { KycComponentKey } from "../format";

export function SecureKycDialog({ component, kind, onClose }: { component: KycComponentKey; kind: KycDialogKind; onClose: () => void }) {
  const { counterparty, permissions, flags, extraction, extractionAttached, version, applyExtractedKyc, notify, isBusy } = useIntake();
  if (!counterparty) return null;

  const identityField: AgreementFieldKey | null = component === "bank" ? null : ({ pan: "panNumber", aadhaar: "aadhaarNumber", gst: "gstin" } satisfies Record<Exclude<KycComponentKey, "bank">, AgreementFieldKey>)[component];
  // The per-field decision lives on the draft entry itself (version.draft[key].decision) - NOT on
  // version.fieldProvenance, a different, unrelated DTO field that is null on every draft seen so far. Reading
  // the wrong one meant identityDecision was always null, so "Apply from Agreement" could never become
  // available no matter how the field was actually decided in Cross-verification.
  const identityDecision = identityField ? (version?.draft?.[identityField]?.decision ?? null) : null;
  const option = evaluateApplyOption({
    component,
    counterpartyType: counterparty.type,
    extractionState: !extraction ? "none" : !extractionAttached ? "not_attached" : "attached",
    extractedValueUsable: extractionAttached && extraction !== null,
    identityDecision,
    canViewContractDetail: extraction?.contractDetailVisible ?? false,
    canManageKyc: permissions.byCounterpartyType[counterparty.type].canManageCounterpartyKyc,
    canViewIdentity: flags.canViewIdentity,
    componentMissing: kind === "missing",
  });

  return (
    <DialogShell
      open
      onClose={onClose}
      title={kycDialogTitle(component, kind)}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
          <a className="btn" href={owningRecordHref(counterparty.type, counterparty.ref)} target="_blank" rel="noreferrer">
            Open {counterparty.type === "PARTNER" ? "Partner" : "Vendor"} record
          </a>
          {identityField && (
            <button
              type="button"
              className="btn primary"
              disabled={!option.available || isBusy()}
              onClick={() =>
                void applyExtractedKyc({ components: [component], mode: kind === "missing" ? "FILL_MISSING" : "OVERWRITE_MISMATCH" }).then((result) => {
                  if (result.ok) {
                    notify("success", "KYC updated from the Agreement.");
                    onClose();
                  } else if (!result.aborted) notify("error", result.message);
                })
              }
            >
              Apply from Agreement
            </button>
          )}
        </>
      }
    >
      <p>{kycDialogIntro(component, kind, counterparty.type)}</p>
      {!option.available && (
        <ul>
          {option.reasons.map((reason) => (
            <li key={reason} style={{ fontSize: 12, color: "var(--muted)" }}>
              {reason}
            </li>
          ))}
        </ul>
      )}
    </DialogShell>
  );
}
