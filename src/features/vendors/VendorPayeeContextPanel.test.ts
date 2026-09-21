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
