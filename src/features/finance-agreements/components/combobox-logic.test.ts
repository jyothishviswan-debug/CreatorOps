import { describe, expect, it } from "vitest";

import { comboboxInputText, comboboxKeyAction, comboboxStatusText, createRequestGate, shouldSearch, stepActiveIndex } from "./combobox-logic";

describe("stepActiveIndex", () => {
  it("moves down and up without wrapping", () => {
    expect(stepActiveIndex(-1, 1, 3)).toBe(0);
    expect(stepActiveIndex(0, 1, 3)).toBe(1);
    expect(stepActiveIndex(2, 1, 3)).toBe(2);
    expect(stepActiveIndex(2, -1, 3)).toBe(1);
    expect(stepActiveIndex(0, -1, 3)).toBe(0);
    expect(stepActiveIndex(-1, -1, 3)).toBe(0);
  });
  it("returns -1 when there is nothing to highlight", () => {
    expect(stepActiveIndex(-1, 1, 0)).toBe(-1);
    expect(stepActiveIndex(0, 1, 3, [])).toBe(-1);
  });
  it("skips disabled options", () => {
    expect(stepActiveIndex(-1, 1, 4, [1, 3])).toBe(1);
    expect(stepActiveIndex(1, 1, 4, [1, 3])).toBe(3);
    expect(stepActiveIndex(3, 1, 4, [1, 3])).toBe(3);
    expect(stepActiveIndex(3, -1, 4, [1, 3])).toBe(1);
    expect(stepActiveIndex(1, -1, 4, [1, 3])).toBe(1);
  });
});

describe("comboboxKeyAction", () => {
  const closed = { open: false, activeIndex: -1, optionCount: 0 };
  const list = (activeIndex: number, optionCount = 3) => ({ open: true, activeIndex, optionCount });

  it("ArrowDown opens a closed list and highlights the first enabled option", () => {
    expect(comboboxKeyAction("ArrowDown", closed)).toEqual({ type: "open", activeIndex: -1, preventDefault: true });
    expect(comboboxKeyAction("ArrowDown", { open: false, activeIndex: -1, optionCount: 2, enabledIndexes: [1] })).toEqual({ type: "open", activeIndex: 1, preventDefault: true });
  });
  it("ArrowDown / ArrowUp move within an open list", () => {
    expect(comboboxKeyAction("ArrowDown", list(-1))).toEqual({ type: "move", activeIndex: 0, preventDefault: true });
    expect(comboboxKeyAction("ArrowDown", list(1))).toEqual({ type: "move", activeIndex: 2, preventDefault: true });
    expect(comboboxKeyAction("ArrowUp", list(2))).toEqual({ type: "move", activeIndex: 1, preventDefault: true });
    expect(comboboxKeyAction("ArrowUp", list(0))).toEqual({ type: "move", activeIndex: 0, preventDefault: true });
  });
  it("ArrowUp does nothing on a closed list", () => {
    expect(comboboxKeyAction("ArrowUp", closed)).toEqual({ type: "none" });
  });
  it("Enter selects only a highlighted, enabled option and is otherwise left alone (a form is not swallowed)", () => {
    expect(comboboxKeyAction("Enter", list(1))).toEqual({ type: "select", activeIndex: 1, preventDefault: true });
    expect(comboboxKeyAction("Enter", list(-1))).toEqual({ type: "none" });
    expect(comboboxKeyAction("Enter", closed)).toEqual({ type: "none" });
    expect(comboboxKeyAction("Enter", { open: true, activeIndex: 5, optionCount: 3 })).toEqual({ type: "none" });
    expect(comboboxKeyAction("Enter", { open: true, activeIndex: 1, optionCount: 3, enabledIndexes: [0, 2] })).toEqual({ type: "none" });
  });
  it("Escape closes an open list and is left to an enclosing dialog when already closed", () => {
    expect(comboboxKeyAction("Escape", list(0))).toEqual({ type: "close", preventDefault: true });
    expect(comboboxKeyAction("Escape", closed)).toEqual({ type: "none" });
  });
  it("ignores every other key", () => {
    for (const key of ["a", "Tab", "Home", "End", " ", "Backspace"]) expect(comboboxKeyAction(key, list(0))).toEqual({ type: "none" });
  });
});

describe("shouldSearch", () => {
  it("honours the minimum trimmed length", () => {
    expect(shouldSearch("", 0)).toBe(true);
    expect(shouldSearch("  ", 0)).toBe(true);
    expect(shouldSearch("a", 2)).toBe(false);
    expect(shouldSearch(" a ", 2)).toBe(false);
    expect(shouldSearch("ab", 2)).toBe(true);
    expect(shouldSearch("", 1)).toBe(false);
  });
});

describe("comboboxStatusText", () => {
  const base = { optionCount: 0, hasMore: false, noun: "Partner" };
  it("describes every state", () => {
    expect(comboboxStatusText({ ...base, status: "idle" })).toBe("");
    expect(comboboxStatusText({ ...base, status: "loading" })).toBe("Searching…");
    expect(comboboxStatusText({ ...base, status: "error" })).toBe("Couldn’t search Partners. Try again.");
    expect(comboboxStatusText({ ...base, status: "error", errorText: "Boom" })).toBe("Boom");
    expect(comboboxStatusText({ ...base, status: "ready" })).toBe("No matching Partners in your authorized scope");
    expect(comboboxStatusText({ ...base, status: "ready", optionCount: 1 })).toBe("1 Partner found");
    expect(comboboxStatusText({ ...base, status: "ready", optionCount: 3 })).toBe("3 Partners found");
    expect(comboboxStatusText({ ...base, status: "ready", optionCount: 10, hasMore: true })).toBe("Showing the first 10 matches — keep typing to narrow");
  });
  it("asks for more characters below the minimum", () => {
    expect(comboboxStatusText({ ...base, status: "idle", belowMinChars: true, minChars: 2 })).toBe("Type at least 2 characters to search");
    expect(comboboxStatusText({ ...base, status: "idle", belowMinChars: true, minChars: 1 })).toBe("Type at least 1 character to search");
  });
});

describe("createRequestGate - a stale response can never overwrite a newer one", () => {
  it("only the latest token is current", () => {
    const gate = createRequestGate();
    const first = gate.next();
    expect(gate.isCurrent(first)).toBe(true);
    const second = gate.next();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });
  it("invalidate makes every outstanding token stale", () => {
    const gate = createRequestGate();
    const token = gate.next();
    gate.invalidate();
    expect(gate.isCurrent(token)).toBe(false);
    expect(gate.isCurrent(gate.next())).toBe(true);
  });
  it("simulated out-of-order responses commit only the newest", async () => {
    const gate = createRequestGate();
    const committed: string[] = [];
    const run = async (query: string, delay: number) => {
      const token = gate.next();
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (gate.isCurrent(token)) committed.push(query);
    };
    await Promise.all([run("a", 30), run("ab", 5)]);
    expect(committed).toEqual(["ab"]);
  });
});

describe("comboboxInputText", () => {
  it("shows the query while editing and the selected label otherwise", () => {
    expect(comboboxInputText({ editing: true, query: "ab", selectedLabel: "Asha" })).toBe("ab");
    expect(comboboxInputText({ editing: false, query: "ab", selectedLabel: "Asha" })).toBe("Asha");
    expect(comboboxInputText({ editing: false, query: "", selectedLabel: null })).toBe("");
    expect(comboboxInputText({ editing: true, query: "", selectedLabel: "Asha" })).toBe("");
  });
});
