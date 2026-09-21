import type { ReactNode } from "react";

// The accepted `.kv` label / value row (Golden Master detail panels). No exported equivalent exists in src/ui,
// so this is the one shared copy for the Finance Agreements screens.
export function KeyValueRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <b style={{ minWidth: 0, overflowWrap: "anywhere" }}>{children}</b>
    </div>
  );
}
