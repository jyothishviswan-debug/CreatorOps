import { describe, expect, it } from "vitest";

import { chipListWindow, pillClassName, resolveMaskedValue } from "./display-logic";

describe("pillClassName", () => {
  it("uses the existing .pill classes: default tone is the base class, others add their tone", () => {
    expect(pillClassName(undefined)).toBe("pill");
    expect(pillClassName("default")).toBe("pill");
    expect(pillClassName("orange")).toBe("pill orange");
    expect(pillClassName("gray")).toBe("pill gray");
    expect(pillClassName("purple")).toBe("pill purple");
  });
});

describe("resolveMaskedValue - a restricted value is never rendered", () => {
  it("masks whenever restricted, ignoring any value the caller passes", () => {
    expect(resolveMaskedValue({ restricted: true, value: "ABCDE1234F" })).toEqual({ text: "Restricted", masked: true });
    expect(resolveMaskedValue({ restricted: true, value: 123456 })).toEqual({ text: "Restricted", masked: true });
    expect(resolveMaskedValue({ restricted: true })).toEqual({ text: "Restricted", masked: true });
    expect(JSON.stringify(resolveMaskedValue({ restricted: true, value: "ABCDE1234F" }))).not.toContain("ABCDE1234F");
  });
  it("lets the caller reword the mask", () => {
    expect(resolveMaskedValue({ restricted: true, value: "x", restrictedText: "Restricted — no access" })).toEqual({ text: "Restricted — no access", masked: true });
  });
  it("shows a visible value as text and an empty one as a dash", () => {
    expect(resolveMaskedValue({ restricted: false, value: "hello" })).toEqual({ text: "hello", masked: false });
    expect(resolveMaskedValue({ restricted: false, value: 42 })).toEqual({ text: "42", masked: false });
    expect(resolveMaskedValue({ restricted: false, value: null })).toEqual({ text: "—", masked: false });
    expect(resolveMaskedValue({ restricted: false, value: "   " })).toEqual({ text: "—", masked: false });
    expect(resolveMaskedValue({ restricted: false, value: undefined, emptyText: "Not available in CreatorOps" })).toEqual({ text: "Not available in CreatorOps", masked: false });
  });
});

describe("chipListWindow", () => {
  it("shows everything under the cap", () => {
    expect(chipListWindow(["a", "b"], 5)).toEqual({ visible: [{ label: "a" }, { label: "b" }], hiddenCount: 0 });
  });
  it("summarizes the overflow", () => {
    const window = chipListWindow(["a", "b", "c", "d"], 2);
    expect(window.visible.map((item) => item.label)).toEqual(["a", "b"]);
    expect(window.hiddenCount).toBe(2);
  });
  it("keeps tones and copes with degenerate caps and empty lists", () => {
    expect(chipListWindow([{ label: "x", tone: "orange" }], 3).visible[0]).toEqual({ label: "x", tone: "orange" });
    expect(chipListWindow(["a"], 0)).toEqual({ visible: [], hiddenCount: 1 });
    expect(chipListWindow(["a"], -2)).toEqual({ visible: [], hiddenCount: 1 });
    expect(chipListWindow([], 3)).toEqual({ visible: [], hiddenCount: 0 });
  });
});
