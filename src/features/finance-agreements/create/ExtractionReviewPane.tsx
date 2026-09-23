"use client";

// EXECUTE_HARD_RESET Section 8: the right pane - a status banner over the review tabs. Raw backend warning codes
// never reach here (the adapter's dedupedWarnings already humanized them).
import type { AgreementPartyView, ExtractedFieldView, ExtractionUiState, KeyClauseView } from "./agreement-create-view";
import { ReviewTabs } from "./ReviewTabs";
import styles from "./AgreementCreatePage.module.css";

const BANNER: Record<ExtractionUiState, { title: string; copy: string; tone: "success" | "warning" | "error" | "info" } | null> = {
  idle: null,
  uploading: { title: "Uploading...", copy: "Uploading the signed Agreement.", tone: "info" },
  extracting: { title: "Extracting...", copy: "Reading the Agreement and proposing values.", tone: "info" },
  complete: { title: "Extraction completed", copy: "We found information in your Agreement. Review and verify the extracted details.", tone: "success" },
  partial: { title: "Extraction completed with items to review", copy: "Some details could not be read automatically. Review and complete them below.", tone: "warning" },
  manual_review: { title: "Manual review required", copy: "This Agreement needs to be reviewed and entered manually.", tone: "warning" },
  error: { title: "Extraction failed", copy: "Something went wrong reading this Agreement. Try again, or enter its details manually.", tone: "error" },
};

export function ExtractionReviewPane({
  state,
  fields,
  keyClauses,
  primaryParty,
  platforms,
  warnings,
  onShowLog,
  onEditField,
}: {
  state: ExtractionUiState;
  fields: readonly ExtractedFieldView[];
  keyClauses: readonly KeyClauseView[];
  primaryParty: AgreementPartyView | null;
  platforms: string[];
  warnings: readonly string[];
  onShowLog: () => void;
  onEditField: (key: string) => void;
}) {
  const banner = BANNER[state];

  return (
    <div>
      {banner && (
        <div
          className="scopebox"
          style={{ marginBottom: 18, borderColor: banner.tone === "error" ? "var(--red)" : banner.tone === "success" ? "var(--green)" : undefined }}
        >
          <b>{banner.title}</b>
          <p style={{ marginTop: 4 }}>{banner.copy}</p>
          {state !== "idle" && state !== "uploading" && state !== "extracting" && (
            <button type="button" className={styles.optOutBtn} style={{ marginTop: 6 }} onClick={onShowLog}>
              View extraction log
            </button>
          )}
        </div>
      )}

      {state === "idle" && <p className="muted">Upload the signed Agreement to see extraction results here.</p>}

      {state !== "idle" && (
        <>
          <ReviewTabs fields={fields} keyClauses={keyClauses} primaryParty={primaryParty} platforms={platforms} onEditField={onEditField} />
          <p className="muted" style={{ fontSize: 11, marginTop: 16 }}>
            Some details may not be captured automatically. Review the full Agreement and complete missing information before confirmation.
          </p>
          {warnings.length > 0 && (
            <ul style={{ marginTop: 8 }}>
              {warnings.map((warning) => (
                <li key={warning} style={{ fontSize: 11, color: "var(--muted)" }}>
                  {warning}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
