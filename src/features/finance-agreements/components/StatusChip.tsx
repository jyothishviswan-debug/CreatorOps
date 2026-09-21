import type { ChipSpec, PillTone } from "../format";

import { pillClassName } from "./display-logic";

// A status chip on the existing `.pill` styling. The TEXT always carries the meaning - the tone is only
// supporting emphasis, never the sole signal. Pass either a ready `chip` (from format.ts) or `label` + `tone`.
// `status` is an optional raw code exposed as `data-status` for tests / assistive tooling (never shown).
const CHIP_FIT = { whiteSpace: "normal", maxWidth: "100%", textAlign: "left" } as const;

export function StatusChip({ chip, label, tone, status, testId, title }: { chip?: ChipSpec; label?: string; tone?: PillTone; status?: string; testId?: string; title?: string }) {
  const text = chip?.label ?? label ?? "";
  return (
    // `.pill` never wraps (white-space: nowrap); in a narrow column or card a long status ("Missing in Agreement") would then force the column /
    // page wider or spill over its neighbour. A chip may wrap onto a second line and never exceeds its container.
    <span className={pillClassName(chip?.tone ?? tone)} data-status={status} data-testid={testId} title={title} style={CHIP_FIT}>
      {text}
    </span>
  );
}
