import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgreementDocumentDto, CounterpartyAgreementDocumentsDto } from "@/server/finance-agreements/client-dto";

import { PartnerFinanceTile } from "./PartnerDetail";

// Step 14B.1: the Partner detail's Context-tab Finance tile lists the signed Agreement documents when the server page supplies the projection (only for an
// actor holding the Finance feature). Without it the tile is exactly as it was: the description and the two Finance links.
const stored = (over: Partial<AgreementDocumentDto> = {}): AgreementDocumentDto => ({ status: "STORED", fileName: "Asha Rao Agreement.pdf", storedAt: "2026-09-03T09:30:00.000Z", hasLink: true, link: "https://drive.invalid/fake/file_1", attemptCount: 1, message: null, canStore: false, ...over });
const projection = (documents: CounterpartyAgreementDocumentsDto["documents"]): CounterpartyAgreementDocumentsDto => ({ counterpartyType: "PARTNER", ref: "p_1", documents, hasMore: false, linksVisible: true });
const entry = (version: number, document: AgreementDocumentDto) => ({ agreementRef: "agr_1", version, lifecycle: "ACTIVE" as const, confirmed: true, headStatus: "ACTIVE" as const, effectiveFrom: "2026-09-01", effectiveTo: null, document });

describe("PartnerFinanceTile", () => {
  it("without the projection: the old tile (description + two links), no document list", () => {
    const html = renderToStaticMarkup(createElement(PartnerFinanceTile, { label: "Finance", partnerRef: "p_1" }));
    expect(html).toContain("<h2>Finance</h2>");
    expect(html).toContain("Review this Partner&#x27;s Agreements or start a new one from the Finance module.");
    expect(html).toContain('href="/finance/agreements?counterpartyType=PARTNER"');
    expect(html).toContain('href="/finance/agreements/new?counterpartyType=PARTNER&amp;ref=p_1"');
    expect(html).not.toContain("agreement-documents");
    expect(html).not.toContain("Open Agreement document");
  });

  it("with the projection: the same file name, version, stored date and link the Finance detail carries", () => {
    const html = renderToStaticMarkup(createElement(PartnerFinanceTile, { label: "Finance", partnerRef: "p_1", agreementDocuments: projection([entry(2, stored({ fileName: "v2.pdf", link: "https://drive.invalid/fake/v2" })), entry(1, stored({ fileName: "v1.pdf", link: "https://drive.invalid/fake/v1" }))]) }));
    expect(html).toContain("Agreement document");
    expect(html).toContain("v2.pdf");
    expect(html).toContain("v1.pdf");
    expect(html).toContain("Agreement version 2");
    expect(html).toContain('href="https://drive.invalid/fake/v2"');
    expect(html).toContain('href="https://drive.invalid/fake/v1"');
    expect(html).toMatch(/Stored \d{1,2} \w+ 2026/);
    // v1 and v2 stay distinct references
    expect(html.split("Open Agreement document").length - 1).toBe(2);
    // the links into Finance are unchanged
    expect(html).toContain("Open Finance Agreements");
  });

  it("Step 14C: a confirmed-but-not-active version reads 'Activation pending', never 'Draft' (an unconfirmed draft still reads 'Draft')", () => {
    const awaiting = { ...entry(1, stored()), lifecycle: "DRAFT" as const, headStatus: "DRAFT" as const, confirmed: true };
    const html = renderToStaticMarkup(createElement(PartnerFinanceTile, { label: "Finance", partnerRef: "p_1", agreementDocuments: projection([awaiting]) }));
    expect(html).toContain("Agreement version 1");
    expect(html).toContain("Activation pending");
    expect(html).not.toMatch(/\bDraft\b/);
    const draft = { ...awaiting, confirmed: false };
    expect(renderToStaticMarkup(createElement(PartnerFinanceTile, { label: "Finance", partnerRef: "p_1", agreementDocuments: projection([draft]) }))).toMatch(/\bDraft\b/);
  });

  it("no link in the projection: a neutral 'Agreement document on file' and no link, no matter what", () => {
    const html = renderToStaticMarkup(createElement(PartnerFinanceTile, { label: "Finance", partnerRef: "p_1", agreementDocuments: projection([entry(1, stored({ link: undefined }))]) }));
    expect(html).toContain("Agreement document on file");
    expect(html).not.toContain("Open Agreement document");
    expect(html).not.toContain("drive.invalid");
  });

  it("every non-stored state is honest and carries no link", () => {
    const html = renderToStaticMarkup(
      createElement(PartnerFinanceTile, {
        label: "Finance",
        partnerRef: "p_1",
        agreementDocuments: projection([
          entry(4, { status: "NOT_APPLICABLE", fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: "No new signed document for this version", canStore: false }),
          entry(3, { status: "NOT_CONFIGURED", fileName: "x.pdf", storedAt: null, hasLink: false, attemptCount: 1, message: "Drive storage not configured", canStore: true }),
          entry(2, { status: "FAILED", fileName: "x.pdf", storedAt: null, hasLink: false, attemptCount: 1, message: "Drive is temporarily unavailable. Try again.", canStore: true }),
          entry(1, { status: "PENDING", fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: null, canStore: true }),
        ]),
      }),
    );
    for (const text of ["No new signed document for this version", "Drive storage not configured", "Storage failed", "Not stored yet"]) expect(html).toContain(text);
    expect(html).not.toContain("Open Agreement document");
  });

  it("an empty projection says so (no fabricated document)", () => {
    const html = renderToStaticMarkup(createElement(PartnerFinanceTile, { label: "Finance", partnerRef: "p_1", agreementDocuments: projection([]) }));
    expect(html).toContain("No Agreement document yet.");
  });
});
