// Components matching the golden master's "refined-overview" panel content
// exactly (docs/reference/CreatorOps_UI_Golden_Master.html — ovContent(),
// ovRenderPanel(), the ovTones/ovPalette color tables, and the donut/trend
// SVG algorithms), rendered inside this app's one global shell instead of
// the source's own duplicate nested topbar/sidebar.
import type { CSSProperties, ReactNode } from "react";

import { Icon, type IconName } from "./icons";

export const TONES: { tone: string; tint: string }[] = [
  { tone: "#2878fa", tint: "#edf4ff" },
  { tone: "#03a97e", tint: "#eafbf5" },
  { tone: "#8b4aff", tint: "#f4efff" },
  { tone: "#ee416e", tint: "#fff0f5" },
  { tone: "#ff7109", tint: "#fff4e9" },
  { tone: "#00a7a0", tint: "#eafaf8" },
];

const HEALTH_DONUT_COLORS = ["#03bc8d", "#2878fa", "#ff9829", "#954cff", "#f54d69"];

function toneVars(index: number): CSSProperties {
  const t = TONES[index % TONES.length];
  return { "--ov-tone": t.tone, "--ov-tint": t.tint, "--ov-accent": t.tone } as CSSProperties;
}

export function ContextBanner({
  icon,
  title,
  description,
  chips,
}: {
  icon: IconName;
  title: string;
  description: string;
  chips: string[];
}) {
  return (
    <div className="ov-context">
      <div className="ov-context-icon">
        <Icon name={icon} />
      </div>
      <div>
        <strong>{title}</strong>
        <small>{description}</small>
      </div>
      <div className="ov-context-chips">
        {chips.map((chip, i) => (
          <span className={i === 0 ? "pill orange" : "pill gray"} key={chip}>
            {chip}
          </span>
        ))}
      </div>
    </div>
  );
}

export function OverviewKpiRow({
  items,
}: {
  items: { icon: IconName; label: string; value: string; hint: string }[];
}) {
  return (
    <div className="ov-kpis">
      {items.map((item, i) => (
        <div className="ov-kpi" style={toneVars(i)} key={item.label}>
          <span className="ov-kpi-icon">
            <Icon name={item.icon} />
          </span>
          <span className="ov-kpi-text">
            <span className="ov-kpi-label">{item.label}</span>
            <div className="ov-kpi-value">{item.value}</div>
            <small>{item.hint}</small>
          </span>
        </div>
      ))}
    </div>
  );
}

export function OverviewRow({ children }: { children: ReactNode }) {
  return <div className="ov-row">{children}</div>;
}

export function OverviewPanel({
  span,
  icon,
  tone,
  title,
  note,
  foot,
  link,
  children,
}: {
  span: number;
  icon: IconName;
  tone: number;
  title: string;
  note?: string;
  foot: string;
  link?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className="ov-panel"
      style={{ "--ov-span": span, ...toneVars(tone) } as CSSProperties}
    >
      <div className="ov-panel-head">
        <span className="ov-panel-icon">
          <Icon name={icon} />
        </span>
        <h2>{title}</h2>
        {link && <button className="ov-panel-link">View ↗</button>}
      </div>
      {note && <div className="ov-panel-note">{note}</div>}
      <div className="ov-panel-body">{children}</div>
      <div className="ov-panel-foot">
        <Icon name="check" />
        <span>{foot}</span>
        <span className="ov-chev">›</span>
      </div>
    </section>
  );
}

export function DonutRing({
  segments,
  total,
  totalLabel,
  healthPalette = false,
}: {
  segments: { label: string; value: number }[];
  total: number;
  totalLabel: string;
  healthPalette?: boolean;
}) {
  const r = 48;
  const circumference = 2 * Math.PI * r;
  const { arcs } = segments.reduce<{ arcs: ReactNode[]; offset: number }>(
    (acc, segment, i) => {
      const len = (segment.value / total) * circumference;
      const color = healthPalette
        ? HEALTH_DONUT_COLORS[i % HEALTH_DONUT_COLORS.length]
        : TONES[i % TONES.length].tone;
      const arc = (
        <circle
          key={segment.label}
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="14"
          strokeDasharray={`${len} ${circumference - len}`}
          strokeDashoffset={-acc.offset}
        />
      );
      return { arcs: [...acc.arcs, arc], offset: acc.offset + len };
    },
    { arcs: [], offset: 0 },
  );

  return (
    <div className="ov-donut-layout">
      <div className="ov-ring">
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r={r} fill="none" stroke="#eff3f7" strokeWidth="14" />
          {arcs}
        </svg>
        <div className="ov-ring-center">
          {total}
          <small>{totalLabel}</small>
        </div>
      </div>
      <div className="ov-legend">
        {segments.map((segment, i) => {
          const color = healthPalette
            ? HEALTH_DONUT_COLORS[i % HEALTH_DONUT_COLORS.length]
            : TONES[i % TONES.length].tone;
          return (
            <div className="ov-legend-item" key={segment.label}>
              <span className="ov-swatch" style={{ background: color }} />
              <span>{segment.label}</span>
              <b>{segment.value}</b>
              <small>{Math.round((segment.value / total) * 100)}%</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TrendGrid({
  series,
}: {
  series: { label: string; color: string; values: number[]; unit: string }[];
}) {
  return (
    <div className="ov-trend-grid">
      {series.map((s) => {
        const points = s.values.map((n, j) => `${j * 65},${98 - (n / 20) * 85}`).join(" ");
        const last = s.values.at(-1)!;
        const prev = s.values.at(-2)!;
        const deltaPct = (((last - prev) / prev) * 100).toFixed(1);
        return (
          <div key={s.label}>
            <div className="ov-trend-label">
              <span className="ov-swatch" style={{ background: s.color, width: 7, height: 7 }} />
              {s.label}
            </div>
            <div className="ov-trend-value">
              {last}
              {s.unit}
              <small>{deltaPct}% vs Jul</small>
            </div>
            <div className="ov-trend">
              <svg viewBox="-4 0 272 110">
                <path d="M0 100H260M0 55H260M0 10H260" fill="none" stroke="#e9eef5" />
                <polygon points={`0,100 ${points} 260,100`} fill={s.color} opacity={0.09} />
                <polyline points={points} fill="none" stroke={s.color} strokeWidth={2.5} />
                {s.values.map((n, j) => (
                  <circle
                    key={j}
                    cx={j * 65}
                    cy={98 - (n / 20) * 85}
                    r={3.2}
                    fill="white"
                    stroke={s.color}
                    strokeWidth={2}
                  />
                ))}
              </svg>
              <div className="ov-axis">
                <span>Apr</span>
                <span>May</span>
                <span>Jun</span>
                <span>Jul</span>
                <span>Aug</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Stages({ rows }: { rows: { label: string; value: number }[] }) {
  return (
    <div className="ov-stages">
      {rows.map((row, i) => (
        <div className="ov-stage-item" key={row.label}>
          <div className="ov-step">{i + 1}</div>
          <span>{row.label}</span>
          <b>{row.value}</b>
        </div>
      ))}
    </div>
  );
}

export function Rankings({ rows }: { rows: { name: string; value: string; initials: string }[] }) {
  return (
    <div className="ov-rankings">
      {rows.map((row, i) => (
        <div className="ov-rank-item" key={row.name}>
          <span className="ov-rank-no">{String(i + 1).padStart(2, "0")}</span>
          <span className="ov-initials" style={toneVars(i)}>
            {row.initials}
          </span>
          <span>{row.name}</span>
          <b>{row.value}</b>
        </div>
      ))}
    </div>
  );
}

export function AttentionRows({
  items,
}: {
  items: { icon: IconName; title: string; hint: string; count: string }[];
}) {
  return (
    <div className="ov-attention">
      {items.map((item, i) => (
        <button className="ov-attention-row" type="button" key={item.title} style={toneVars(i)}>
          <span className="ov-mini">
            <Icon name={item.icon} />
          </span>
          <span className="ov-attention-name">{item.title}</span>
          <span className="ov-attention-count">{item.count}</span>
          <span className="ov-attention-arrow">→</span>
        </button>
      ))}
    </div>
  );
}

export function Events({
  items,
}: {
  items: { icon: IconName; title: string; detail: string }[];
}) {
  return (
    <div className="ov-events">
      {items.map((item, i) => (
        <div className="ov-event" key={item.title} style={toneVars(i)}>
          <span className="ov-mini">
            <Icon name={item.icon} />
          </span>
          <div>
            <strong>{item.title}</strong>
            <small>{item.detail}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ActionGrid({ actions }: { actions: { label: string; icon: IconName }[] }) {
  return (
    <div className="ov-action-grid">
      {actions.map((action) => (
        <button type="button" key={action.label}>
          <Icon name={action.icon} />
          {action.label}
        </button>
      ))}
    </div>
  );
}
