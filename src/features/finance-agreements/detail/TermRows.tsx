import { KeyValueRow, StatusChip } from "../components";
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import type { FieldChange } from "../revision-diff";
import type { TermRow } from "./terms-view";

// A read-only list of term rows in the accepted `.kv` idiom. A row whose field differs from the prior confirmed version carries a visible
// "Changed" chip and its earlier value (text, never colour alone).
export function TermRows({ rows, changes, priorVersion }: { rows: readonly TermRow[]; changes?: ReadonlyMap<AgreementFieldKey, FieldChange> | null; priorVersion?: number | null }) {
  return (
    <>
      {rows.map((item) => {
        const change = item.fieldKey && changes ? changes.get(item.fieldKey) : undefined;
        return (
          <KeyValueRow key={item.key} label={item.label}>
            <span style={item.multiline ? { whiteSpace: "pre-wrap" } : undefined}>{item.value}</span>
            {item.flag && (
              <>
                {" "}
                <StatusChip label={item.flag} tone="orange" />
              </>
            )}
            {change && (
              <>
                {" "}
                <StatusChip label="Changed" tone="blue" />
              </>
            )}
            {item.detail && <small style={{ display: "block", fontWeight: 400 }}>{item.detail}</small>}
            {change && (
              <small style={{ display: "block", fontWeight: 400 }}>
                Was {change.beforeText}
                {priorVersion ? ` in version ${priorVersion}` : ""}
              </small>
            )}
          </KeyValueRow>
        );
      })}
    </>
  );
}

// Actor refs are opaque; shown quietly, never as a name (the detail DTO carries no display names).
export function ActorNote({ actorRef }: { actorRef: string | null | undefined }) {
  if (!actorRef) return null;
  return (
    <small className="muted" style={{ display: "block", fontWeight: 400, overflowWrap: "anywhere" }}>
      by {actorRef}
    </small>
  );
}
