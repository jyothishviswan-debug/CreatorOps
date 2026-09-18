import type { CSSProperties } from "react";
import Link from "next/link";

import { Icon } from "@/ui/icons";
import { OverviewPanel, TONES } from "@/ui/Overview";

// Step 12B: src/ui/Overview.tsx's own shared AttentionRows component
// renders plain, non-navigable `<button>` rows - its prop shape has no
// href/onClick. The task requires each Ingestion Exceptions row to
// actually navigate to its Explorer/Import History deep-link target.
// Rather than modify the frozen shared Overview.tsx (other modules also
// depend on its exact current behavior), this component renders the
// SAME "Ingestion Exceptions" panel body itself - reusing the exported
// OverviewPanel wrapper (so the chrome/title/span/foot stay pixel-for-
// pixel identical to every other panel) and the exact same
// "ov-attention"/"ov-attention-row" CSS classes AttentionRows itself
// uses - but as real `<Link>`s wherever a destination exists.
function toneVars(index: number): CSSProperties {
  const t = TONES[index % TONES.length];
  return { "--ov-tone": t.tone, "--ov-tint": t.tint, "--ov-accent": t.tone } as CSSProperties;
}

export function IngestionExceptionsPanel({
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
    <OverviewPanel span={span} icon="alert" tone={tone} title="Ingestion Exceptions" note={note} foot={foot} link>
      {rows.length === 0 ? (
        <p className="foundationnote">No ingestion exceptions right now.</p>
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
