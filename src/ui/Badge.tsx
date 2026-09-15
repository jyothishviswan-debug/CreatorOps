import type { ReactNode } from "react";

type PillTone = "default" | "orange" | "blue" | "purple" | "red" | "gray";

export function Pill({ tone = "default", children }: { tone?: PillTone; children: ReactNode }) {
  const toneClass = tone === "default" ? "" : ` ${tone}`;
  return <span className={`pill${toneClass}`}>{children}</span>;
}
