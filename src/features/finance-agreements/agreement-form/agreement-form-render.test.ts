import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

// The provider only needs a router for navigation after "Start draft"; nothing here navigates.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined }) }));

import { agreementDto, permissionsDto } from "../agreement-intake-logic/intake-fixtures";
import { IntakeProvider, type IntakeProviderProps } from "../agreement-intake-logic/intake-context";

import { AgreementFormPage } from "./AgreementFormPage";

// Step 14C.3: the REAL provider + the rebuilt canonical form, server-rendered (effects do not run) - what a from-scratch
// rebuild on Foundation primitives must never contain, and what it must always show.
function render(permissions: FinanceAgreementPermissionsDto, initial?: IntakeProviderProps["initial"]): string {
  return renderToStaticMarkup(createElement(IntakeProvider, { permissions, initial } as IntakeProviderProps, createElement(AgreementFormPage)));
}

const CAN_MANAGE = permissionsDto({ canManage: true });

describe("the rebuilt canonical Agreement form (Step 14C.3)", () => {
  it("uses the Foundation formlayout archetype - a form.panel beside a right-hand aside checklist, never a full page-width single column", () => {
    const html = render(CAN_MANAGE);
    expect(html).toMatch(/class="formlayout"/);
    expect(html).toMatch(/<aside class="panel"/);
  });

  it("never renders a table anywhere on a fresh form (no comparison table, no extraction table)", () => {
    const html = render(CAN_MANAGE);
    expect(html).not.toMatch(/<table/);
  });

  it("never shows a raw Confidence badge or a 'Contract text' disclosure before any Agreement has been read", () => {
    const html = render(CAN_MANAGE);
    expect(html).not.toContain("Confidence:");
    expect(html).not.toContain("Contract text");
  });

  it("the progress checklist reads the seven-step IA - Agreement party, Source Agreement, Identity review, KYC, Agreement terms, Performance targets, Review - and never the old ten-step list or a separate Extracted-from-Agreement step", () => {
    const html = render(CAN_MANAGE);
    for (const title of ["Agreement party", "Source Agreement", "Identity review", "KYC", "Agreement terms", "Performance targets", "Review"]) {
      expect(html, title).toContain(title);
    }
    expect(html).not.toContain("Extracted from Agreement");
    expect(html).not.toContain("Additional details</span>");
  });

  it("a fresh form (no draft yet) shows the party picker, never the ten old section headings", () => {
    const html = render(CAN_MANAGE);
    expect(html).toContain("Agreement party");
    expect(html).toContain("Partner or Vendor");
    expect(html).not.toContain("Cross-verification");
    expect(html).not.toContain("Commercial terms<");
  });

  it("a resumed draft shows Agreement terms (the merged commercial + additional-details step) and Performance targets as their own sections, with no raw camelCase metric id anywhere", () => {
    const targets = [{ targetRef: "t1", metricId: "followerGrowth", targetValue: 5000, unit: "followers", comparison: "at_least" as const, affectsPayment: false as const }];
    const draft = {
      performanceTargets: { value: targets, extractedValue: targets, origin: "EXTRACTED" as const, decision: "PENDING" as const, decidedByUserRef: null, decidedAt: null, provenance: { label: "Agreement", extractionRunRef: "run_1", page: 4, confidence: "MEDIUM" as const } },
    };
    const agreement = agreementDto({ draft });
    const html = render(CAN_MANAGE, { agreement });
    expect(html).toContain("Agreement terms");
    expect(html).toContain("Performance targets");
    // The raw metric id is a legitimate <option value="followerGrowth"> (needed to submit the right value) - what must
    // never appear is the raw id as VISIBLE text; the humanized label always does instead.
    expect(html).toContain("Follower growth");
    expect(html).not.toMatch(/>followerGrowth</);
    expect(html).toContain("Period not specified");
  });

  it("a viewer without manage rights sees the denial note, not the party picker", () => {
    const html = render(permissionsDto({ canManage: false }));
    expect(html).toContain("Manage Agreements permission");
  });
});
