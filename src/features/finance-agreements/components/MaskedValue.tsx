import { Icon } from "@/ui/icons";

import { resolveMaskedValue } from "./display-logic";

// A value that may be restricted. When `restricted` is true the value is NEVER rendered (it is not even read):
// the caller passes `restricted` from the DTO's own state (valueState === "RESTRICTED", state "RESTRICTED", ...).
export function MaskedValue({ restricted, value, emptyText, restrictedText }: { restricted: boolean; value?: string | number | null; emptyText?: string; restrictedText?: string }) {
  const { text, masked } = resolveMaskedValue({ restricted, value, emptyText, restrictedText });
  if (!masked) return <span>{text}</span>;
  return (
    <span className="muted" data-masked="true" title="Restricted - you do not have access to this value" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <Icon name="lock" style={{ width: 12, height: 12 }} />
      {text}
    </span>
  );
}
