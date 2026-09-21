import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VendorPayeeContextPanel } from "./VendorPayeeContextPanel";

// Step 14B: the Vendor detail's "Agreements" panel becomes a contextual link into Finance ONLY when the server page says the actor holds
// the Finance feature. The four panel headings stay exactly as before (vendors.spec asserts them) and the other three keep "Not yet built".
const count = (html: string, text: string) => html.split(text).length - 1;

describe("VendorPayeeContextPanel Agreements panel", () => {
  it("without Finance access it is exactly the old state: four headings, four 'Not yet built', no link", () => {
    const html = renderToStaticMarkup(createElement(VendorPayeeContextPanel, { vendorRef: "v_1" }));
    for (const heading of ["Agreements", "Payables", "Invoices", "Payments"]) expect(html).toContain(`<h2>${heading}</h2>`);
    expect(count(html, "Not yet built")).toBe(4);
    expect(html).not.toContain("/finance/agreements");
    expect(html).not.toContain("Open Finance Agreements");
  });

  it("with Finance access the Agreements heading is kept and its body links to the Agreements list and the new-Agreement form", () => {
    const html = renderToStaticMarkup(createElement(VendorPayeeContextPanel, { vendorRef: "v_1", canOpenFinance: true }));
    for (const heading of ["Agreements", "Payables", "Invoices", "Payments"]) expect(html).toContain(`<h2>${heading}</h2>`);
    expect(html).toContain('href="/finance/agreements?counterpartyType=VENDOR"');
    expect(html).toContain("Open Finance Agreements");
    expect(html).toContain('href="/finance/agreements/new?counterpartyType=VENDOR&amp;ref=v_1"');
    expect(html).toContain("New Agreement");
    // Only the Agreements panel changed: Payables / Invoices / Payments still say "Not yet built".
    expect(count(html, "Not yet built")).toBe(3);
  });

  it("encodes the Vendor ref in the new-Agreement link", () => {
    const html = renderToStaticMarkup(createElement(VendorPayeeContextPanel, { vendorRef: "v 1&x", canOpenFinance: true }));
    expect(html).toContain("ref=v%201%26x");
  });
});

// Step 14B.1: the Agreements panel lists the signed Agreement documents when the server page passes the projection (only for an actor with the Finance
// feature). The prop is OPTIONAL and everything above still holds without it.
import type { AgreementDocumentDto, CounterpartyAgreementDocumentDto, CounterpartyAgreementDocumentsDto } from "@/server/finance-agreements/client-dto";

const stored = (over: Partial<AgreementDocumentDto> = {}): AgreementDocumentDto => ({ status: "STORED", fileName: "Studio Co Agreement.pdf", storedAt: "2026-09-03T09:30:00.000Z", hasLink: true, link: "https://drive.invalid/fake/file_1", attemptCount: 1, message: null, canStore: false, ...over });
const row = (over: Partial<CounterpartyAgreementDocumentDto> = {}): CounterpartyAgreementDocumentDto => ({ agreementRef: "agr_1", version: 1, lifecycle: "ACTIVE", confirmed: true, headStatus: "ACTIVE", effectiveFrom: "2026-09-01", effectiveTo: null, document: stored(), ...over });
const projection = (documents: CounterpartyAgreementDocumentDto[], over: Partial<CounterpartyAgreementDocumentsDto> = {}): CounterpartyAgreementDocumentsDto => ({ counterpartyType: "VENDOR", ref: "v_1", documents, hasMore: false, linksVisible: true, ...over });

describe("VendorPayeeContextPanel Agreement documents (Step 14B.1)", () => {
  it("without the projection nothing changes: no document list, the same four headings and the same 'Not yet built' counts", () => {
    for (const html of [renderToStaticMarkup(createElement(VendorPayeeContextPanel, { vendorRef: "v_1", canOpenFinance: true })), renderToStaticMarkup(createElement(VendorPayeeContextPanel, { vendorRef: "v_1", canOpenFinance: true, agreementDocuments: null })), renderToStaticMarkup(createElement(VendorPayeeContextPanel, { vendorRef: "v_1" }))]) {
      expect(html).not.toContain("agreement-documents");
      expect(html).not.toContain("Open Agreement document");
    }
    const plain = renderToStaticMarkup(createElement(VendorPayeeContextPanel, { vendorRef: "v_1" }));
    expect(count(plain, "Not yet built")).toBe(4);
  });

  it("a projection WITHOUT Finance access is never rendered (the panel keeps its old 'Not yet built' body)", () => {
    const html = renderToStaticMarkup(createElement(VendorPayeeContextPanel, { vendorRef: "v_1", agreementDocuments: projection([row()]) }));
    expect(html).not.toContain("Studio Co Agreement.pdf");
    expect(html).not.toContain("Open Agreement document");
    expect(count(html, "Not yet built")).toBe(4);
  });

  it("with the projection the Agreements heading is kept, the documents are listed and the other three panels are unchanged", () => {
    const html = renderToStaticMarkup(createElement(VendorPayeeContextPanel, { vendorRef: "v_1", canOpenFinance: true, agreementDocuments: projection([row()]) }));
    for (const heading of ["Agreements", "Payables", "Invoices", "Payments"]) expect(html).toContain(`<h2>${heading}</h2>`);
    expect(count(html, "Not yet built")).toBe(3);
    expect(html).toContain('data-testid="agreement-documents"');
    expect(html).toContain("Studio Co Agreement.pdf");
    expect(html).toContain("Agreement version 1");
    expect(html).toContain('href="https://drive.invalid/fake/file_1"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Open Agreement document");
    // the Finance links are still there
    expect(html).toContain("Open Finance Agreements");
    expect(html).toContain("New Agreement");
  });

  it("a projection without links (finance access, no contract-detail category): 'Agreement document on file' and no link", () => {
    const noLink = projection([row({ document: stored({ link: undefined }) })], { linksVisible: false });
    const html = renderToStaticMarkup(createElement(VendorPayeeContextPanel, { vendorRef: "v_1", canOpenFinance: true, agreementDocuments: noLink }));
    expect(html).toContain("Agreement document on file");
    expect(html).not.toContain("Open Agreement document");
    expect(html).not.toContain("drive.invalid");
  });

  it("an empty projection says there is no document yet; a version without a file says so instead of showing another one", () => {
    const empty = renderToStaticMarkup(createElement(VendorPayeeContextPanel, { vendorRef: "v_1", canOpenFinance: true, agreementDocuments: projection([]) }));
    expect(empty).toContain("No Agreement document yet.");
    const manual = renderToStaticMarkup(
      createElement(VendorPayeeContextPanel, { vendorRef: "v_1", canOpenFinance: true, agreementDocuments: projection([row({ version: 2, document: { status: "NOT_APPLICABLE", fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: "No new signed document for this version", canStore: false } }), row()]) }),
    );
    expect(manual).toContain("No new signed document for this version");
    expect(manual).toContain("Agreement version 2");
    expect(manual).toContain("Agreement version 1");
  });

  it("long file names wrap instead of widening the panel", () => {
    const name = `${"very-long-agreement-file-name-".repeat(6)}.pdf`;
    const html = renderToStaticMarkup(createElement(VendorPayeeContextPanel, { vendorRef: "v_1", canOpenFinance: true, agreementDocuments: projection([row({ document: stored({ fileName: name }) })]) }));
    expect(html).toContain(name);
    expect(html).toContain("overflow-wrap:anywhere");
  });
});
