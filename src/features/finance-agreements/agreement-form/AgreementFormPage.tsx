"use client";

// FINAL_EXECUTION orchestrator: five major working panels, full Foundation canvas width (no Agreement-specific
// narrow max-width - Section 7), never a second persistent sidebar. Built from zero after the 14C.3 UI was
// deleted; only agreement-intake-logic/* (pure logic/hooks) and @/ui are ever imported from here.
import { Toast } from "@/ui/Dialog";

import { useIntake } from "../agreement-intake-logic/intake-context";

import { KycPanel } from "./KycPanel";
import { AgreementPartiesPanel, VerificationPanel } from "./PartiesVerificationPanel";
import { PartySourcePanel } from "./PartySourcePanel";
import { TargetsReviewPanel } from "./TargetsReviewPanel";
import { TermsPanel } from "./TermsPanel";

export function AgreementFormPage() {
  const { flags, notices, conflict, reloadLatest } = useIntake();

  if (!flags.canManage) {
    return (
      <section className="panel">
        <div className="panelbody">
          <p>You need the Manage Agreements permission to start or edit an Agreement.</p>
        </div>
      </section>
    );
  }

  return (
    <div>
      {conflict && (
        <div className="scopebox" style={{ marginBottom: 18 }}>
          <b>{conflict.message}</b>{" "}
          <button type="button" className="btn" onClick={() => void reloadLatest()}>
            Reload latest
          </button>
        </div>
      )}

      <PartySourcePanel />

      {/* Two compact panels (a short/empty parties table, a status matrix) side by side instead of each
          taking a full-width row on its own. */}
      <div className="grid">
        <div className="s6">
          <AgreementPartiesPanel />
        </div>
        <div className="s6">
          <KycPanel />
        </div>
      </div>

      <VerificationPanel />
      <TermsPanel />
      <TargetsReviewPanel />

      <div aria-live="polite" className="sr">
        {notices.length > 0 ? notices[notices.length - 1]!.message : ""}
      </div>
      <Toast message={null} />
    </div>
  );
}
