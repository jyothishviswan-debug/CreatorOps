import type { CSSProperties } from "react";
import Link from "next/link";

import { Icon } from "@/ui/icons";
import { OverviewPanel, TONES } from "@/ui/Overview";

// Step 12C: mirrors src/features/analytics/IngestionExceptionsPanel.tsx's
// own wrapper pattern exactly, for the exact same reason - src/ui/
// Overview.tsx's shared AttentionRows component renders plain,
// non-navigable `<button>` rows (its ListRow prop shape has no href), and
// the frozen shared Overview.tsx is never modified (other modules depend
// on its exact current behavior). This component renders the SAME
// "Execution Exceptions" panel body itself - reusing the exported
// OverviewPanel wrapper (chrome/title/span/foot stay pixel-for-pixel
// identical to every other panel) and the exact same "ov-attention"/
// "ov-attention-row" CSS classes AttentionRows itself uses - but as real
// `<Link>`s wherever a destination exists.
function toneVars(index: number): CSSProperties {
  const t = TONES[index % TONES.length];
  return { "--ov-tone": t.tone, "--ov-tint": t.tint, "--ov-accent": t.tone } as CSSProperties;
}

export function ExecutionExceptionsPanel({
  span,
  tone,
  note,
  foot,
  rows,
  links,
}: {
  span: number;
  tone: number;
  note?: string;
  foot: string;
  rows: { title: string; detail: string; count: string }[];
  links: Record<string, string>;
}) {
  return (
    <OverviewPanel span={span} icon="alert" tone={tone} title="Execution Exceptions" note={note} foot={foot} link>
      {rows.length === 0 ? (
        <p className="foundationnote">No execution exceptions right now.</p>
      ) : (
        <div className="ov-attention">
          {rows.map((row, i) => {
            const href = links[row.title];
            const content = (
              <>
                <span className="ov-mini">
                  <Icon name="alert" />
                </span>
                <span className="ov-attention-name">{row.title}</span>
                <span className="ov-attention-count">{row.count}</span>
                <span className="ov-attention-arrow">&rarr;</span>
              </>
            );
            return href ? (
              <Link className="ov-attention-row" href={href} key={row.title} style={toneVars(i)}>
                {content}
              </Link>
            ) : (
              <div className="ov-attention-row" key={row.title} style={toneVars(i)}>
                {content}
              </div>
            );
          })}
        </div>
      )}
    </OverviewPanel>
  );
}
