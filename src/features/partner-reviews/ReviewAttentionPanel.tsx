import type { CSSProperties } from "react";
import Link from "next/link";

import { Icon } from "@/ui/icons";
import { OverviewPanel, TONES } from "@/ui/Overview";

// Step 13B: mirrors src/features/campaigns/ExecutionExceptionsPanel.tsx's wrapper pattern exactly, for
// the same reason: the shared Overview's AttentionRows renders plain non-navigable `<button>` rows and
// the frozen shared file is not modified. This renders the SAME "Needs Attention" panel body - the
// exported OverviewPanel chrome (title / span / foot unchanged) and the very same `ov-attention` /
// `ov-attention-row` classes - but every row is a real link to the Workspace filtered to it.
function toneVars(index: number): CSSProperties {
  const t = TONES[index % TONES.length];
  return { "--ov-tone": t.tone, "--ov-tint": t.tint, "--ov-accent": t.tone } as CSSProperties;
}

export function ReviewAttentionPanel({
  span,
  tone,
  title,
  note,
  foot,
  rows,
  links,
}: {
  span: number;
  tone: number;
  title: string;
  note?: string;
  foot: string;
  rows: { title: string; detail: string; count: string }[];
  links: Record<string, string>;
}) {
  return (
    <OverviewPanel span={span} icon="alert" tone={tone} title={title} note={note} foot={foot} link>
      {rows.length === 0 ? (
        <p className="foundationnote">No actionable category is non-zero right now.</p>
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
