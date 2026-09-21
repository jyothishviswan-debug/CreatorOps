import type { CSSProperties } from "react";

// A table ROW header (`<th scope="row">`) styled as a body cell: the foundation `th` rule is the grey column-header look, which a first-column
// label must not inherit. Inline on purpose (no new global CSS); it mirrors the td look of the same tables.
export const ROW_HEADER_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  borderBottom: "1px solid #edf0f3",
  color: "var(--ink)",
  fontWeight: 550,
  fontSize: 11,
  padding: "8px 18px",
  textAlign: "left",
  overflowWrap: "anywhere",
};
