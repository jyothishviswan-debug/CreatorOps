import { pillClassName, chipListWindow, type ChipListItem } from "./display-logic";

// A wrapped row of small chips (platforms, formats, evidence types ...). At most `max` are shown; the rest are
// summarized as "+N more" so a long list can never blow up the layout.
export function ChipList({ items, max = 8, emptyText = "—", ariaLabel }: { items: readonly ChipListItem[]; max?: number; emptyText?: string; ariaLabel?: string }) {
  if (items.length === 0) return <span className="muted">{emptyText}</span>;
  const { visible, hiddenCount } = chipListWindow(items, max);
  return (
    <span role="list" aria-label={ariaLabel} style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
      {visible.map((item, index) => (
        <span key={`${item.label}-${index}`} role="listitem" className={pillClassName(item.tone)}>
          {item.label}
        </span>
      ))}
      {hiddenCount > 0 && (
        <span role="listitem" className="pill gray">
          +{hiddenCount} more
        </span>
      )}
    </span>
  );
}
