import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LifecycleDialog, type LifecycleDialogProps } from "./LifecycleDialog";

// Step 14B.1: a refused activation (the server's `agreement_document_not_stored`) is shown in the Activate dialog as ONE banner carrying the server's plain
// reason - not as a confirm-style "go to field" list, and not duplicated by a generic error line.
const base: LifecycleDialogProps = {
  dialog: "activate",
  busy: null,
  error: null,
  blockers: null,
  reason: "",
  onReasonChange: () => undefined,
  agreementRef: "agr_0123456789abcdef0123",
  counterpartyType: "PARTNER",
  counterpartyName: "Asha Rao",
  openVersion: 2,
  governingVersion: 1,
  latestVersion: 2,
  canManage: true,
  onClose: () => undefined,
  onSubmit: () => undefined,
};

describe("Activate dialog: not_ready blockers", () => {
  const blockers = [{ code: "agreement_document_not_stored", message: "Store the signed Agreement document before activating this version." }];

  it("surfaces the server's plain blocker message once, with the way to fix it", () => {
    const html = renderToStaticMarkup(createElement(LifecycleDialog, { ...base, error: "Store the signed Agreement document before activating this version.", blockers }));
    expect(html).toContain('data-testid="activate-blockers"');
    expect(html).toContain("Not ready to activate.");
    expect(html.split("Store the signed Agreement document before activating this version.").length - 1).toBe(1);
    expect(html).toContain("store the Agreement document from the Agreement document panel on the Overview");
    // not the confirm-style list
    expect(html).not.toContain("Not ready to confirm.");
    expect(html).not.toContain("Go to field");
  });

  it("a plain error (no blockers) still shows as before", () => {
    const html = renderToStaticMarkup(createElement(LifecycleDialog, { ...base, error: "Version 2 is not the open confirmed version and cannot be activated." }));
    expect(html).toContain("Version 2 is not the open confirmed version and cannot be activated.");
    expect(html).not.toContain("Not ready to activate.");
  });

  it("the confirm dialog keeps its own blocker list (unchanged)", () => {
    const html = renderToStaticMarkup(createElement(LifecycleDialog, { ...base, dialog: "confirm", error: "x", blockers: [{ code: "field_undecided", message: "Currency", fieldKey: "currency" }] }));
    expect(html).toContain("Not ready to confirm.");
    expect(html).not.toContain("Not ready to activate.");
  });
});
