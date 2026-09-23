"use client";

// EXECUTE_HARD_RESET Section 10: a dense responsive grid (4 wide desktop / 3 normal / 2 tablet / 1 mobile), never
// one row per field. Unknown/not-extracted values show "—", never invented data.
import { fieldLabel } from "../format";

import type { AgreementPartyView, ExtractedFieldView } from "./agreement-create-view";
import styles from "./AgreementCreatePage.module.css";

// Administration first, then commercial, matching the approved reference's grouping; party/platform summary
// comes last since Screen 3 (Parties & KYC) is where that is actually decided.
const SUMMARY_KEYS = ["agreementType", "signedDate", "effectiveDate", "terminationDate", "paymentCycle", "fixedComponent", "currency", "accountTransferFee"] as const;

export function KeyInformationGrid({ fields, primaryParty, platforms, onEditAll }: { fields: readonly ExtractedFieldView[]; primaryParty: AgreementPartyView | null; platforms: string[]; onEditAll: () => void }) {
  const byKey = new Map(fields.map((f) => [f.key, f]));

  const items: Array<{ label: string; value: string }> = [];
  for (const key of SUMMARY_KEYS) {
    const field = byKey.get(key);
    // A field with no draft entry at all (never extracted, never decided) has no ExtractedFieldView - the label
    // must still come from the registry, never the raw camelCase key.
    items.push({ label: field?.label ?? fieldLabel(key), value: field?.displayValue ?? "—" });
  }
  items.push({ label: "Primary counterparty", value: primaryParty?.name ?? "—" });
  items.push({ label: "Platform(s)", value: platforms.length > 0 ? platforms.join(", ") : "—" });

  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panelhead">
        <h2>Key Information</h2>
        <button type="button" className="btn ghost" onClick={onEditAll}>
          Edit all
        </button>
      </div>
      <div className="panelbody">
        <div className={styles.infoGrid}>
          {items.map((item) => (
            <div key={item.label} className={styles.infoField}>
              <small className="muted" style={{ display: "block", marginBottom: 3 }}>
                {item.label}
              </small>
              <div className={`${styles.valueField} ${styles.valueBox}${item.value === "—" ? ` ${styles.empty}` : ""}`}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
