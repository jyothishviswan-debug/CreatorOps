import type { AgreementFieldOrigin } from "@/server/finance-agreements/types";

import { originLabel, MASTER_DATA_SOURCE_NOTE, type PillTone } from "../format";

import { pillClassName } from "./display-logic";

const ORIGIN_TONES: Record<AgreementFieldOrigin, PillTone> = { MASTER_DATA: "blue", EXTRACTED: "gray", MANUAL: "gray" };

// Where a value came from: `CreatorOps master data` | `Agreement` | `Manual`. A master-data value is never
// presented as extracted. `asNote` renders the quiet inline text form ("Source: CreatorOps master data") used
// under a cross-verification value instead of a chip.
export function SourceBadge({ origin, asNote = false }: { origin: AgreementFieldOrigin; asNote?: boolean }) {
  if (asNote) {
    const text = origin === "MASTER_DATA" ? MASTER_DATA_SOURCE_NOTE : `Source: ${originLabel(origin)}`;
    return <small className="muted">{text}</small>;
  }
  return (
    <span className={pillClassName(ORIGIN_TONES[origin])} data-origin={origin}>
      {originLabel(origin)}
    </span>
  );
}
