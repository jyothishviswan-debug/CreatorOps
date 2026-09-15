// Components matching the golden master's "refined-overview" panel content
// exactly (docs/reference/CreatorOps_UI_Golden_Master.html — ovContent(),
// ovRenderPanel(), the ovTones/ovPalette color tables, and the donut/trend
// SVG algorithms), rendered inside this app's one global shell instead of
// the source's own duplicate nested topbar/sidebar.
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";

import { Icon, type IconName } from "./icons";
import type { OverviewPanelData } from "@/features/shared/types";

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
    <div className="ov-kpis" style={{ "--ov-n": items.length } as CSSProperties}>
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

export function OverviewRow({ children, secondary }: { children: ReactNode; secondary?: boolean }) {
  return <div className={secondary ? "ov-row ov-row-secondary" : "ov-row"}>{children}</div>;
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
  items: { icon: IconName; title: string; detail: string; href?: string }[];
}) {
  return (
    <div className="ov-events">
      {items.map((item, i) => {
        const content = (
          <>
            <span className="ov-mini">
              <Icon name={item.icon} />
            </span>
            <div>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </div>
          </>
        );
        return item.href ? (
          <Link className="ov-event" href={item.href} key={item.title} style={toneVars(i)}>
            {content}
          </Link>
        ) : (
          <div className="ov-event" key={item.title} style={toneVars(i)}>
            {content}
          </div>
        );
      })}
    </div>
  );
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 20;

export function CampaignBoard({ rows }: { rows: { name: string; completed: number; required: number }[] }) {
  return (
    <div className="ov-campaign-board">
      {rows.map((row, i) => {
        const rate = row.completed / row.required;
        const color = TONES[i % TONES.length].tone;
        return (
          <div className="ov-campaign-card" key={row.name}>
            <svg viewBox="0 0 50 50" role="img" aria-label={`${row.name}: ${row.completed} of ${row.required} completed`}>
              <circle cx="25" cy="25" r="20" stroke="#edf2f7" strokeWidth="5" fill="none" />
              <circle
                cx="25"
                cy="25"
                r="20"
                stroke={color}
                strokeWidth="5"
                fill="none"
                strokeDasharray={`${rate * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
                transform="rotate(-90 25 25)"
              />
              <text x="25" y="28" fontSize="10" fill="#344963" textAnchor="middle">
                {Math.round(rate * 100)}%
              </text>
            </svg>
            <div>
              <b>{row.name}</b>
              <strong>
                {row.completed} <small>/ {row.required}</small>
              </strong>
              <small>deliverables completed</small>
            </div>
          </div>
        );
      })}
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

const FUNNEL_COLORS = ["#ffc495", "#ffa45f", "#ff8c36", "#f37013", "#d45b05"];

export function Funnel({ rows }: { rows: { label: string; value: number }[] }) {
  const max = rows[0]?.value || 1;
  return (
    <div className="ov-pipeline">
      {rows.map((row, i) => (
        <div className="ov-pipeline-stage" key={row.label}>
          <strong>{row.value}</strong>
          <div className="ov-stage-area">
            <div
              className="ov-stage-fill"
              style={{ height: `${(row.value / max) * 100}%`, background: FUNNEL_COLORS[i % FUNNEL_COLORS.length] }}
            />
          </div>
          <span className="ov-pipeline-name">{row.label}</span>
        </div>
      ))}
    </div>
  );
}

export function ColumnChart({ rows, unit = "count" }: { rows: { label: string; value: number }[]; unit?: string }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="ov-column-chart" style={{ "--ov-columns": rows.length } as CSSProperties}>
      <div className="ov-column-unit">
        <span>0 &rarr; {max.toLocaleString()}</span>
        <span>{unit}</span>
      </div>
      <div className="ov-columns">
        {rows.map((row, i) => (
          <div className="ov-col" key={row.label}>
            <b>{row.value.toLocaleString()}</b>
            <div
              className="ov-column"
              style={{ height: `${(row.value / max) * 78}%`, background: TONES[i % TONES.length].tone }}
            />
          </div>
        ))}
      </div>
      <div className="ov-column-labels">
        {rows.map((row) => (
          <span key={row.label}>{row.label}</span>
        ))}
      </div>
    </div>
  );
}

export function Checks({ rows }: { rows: { label: string; detail: string; badge: string }[] }) {
  return (
    <div className="ov-checks">
      {rows.map((row) => (
        <div className="ov-check" key={row.label}>
          <div className="ov-check-text">
            {row.label}
            <small>{row.detail}</small>
          </div>
          <span className="ov-badge" style={badgeVars(row.badge)}>
            {row.badge}
          </span>
        </div>
      ))}
    </div>
  );
}

function badgeVars(text: string): CSSProperties {
  if (/action|review|due|check|partial/i.test(text)) return { "--ov-badge-ink": "#a8550b", "--ov-badge-bg": "#fff3df" } as CSSProperties;
  if (/demo|required|policy|coverage|current/i.test(text)) return { "--ov-badge-ink": "#275eae", "--ov-badge-bg": "#edf4ff" } as CSSProperties;
  if (/upcoming|scheduled/i.test(text)) return { "--ov-badge-ink": "#7355a6", "--ov-badge-bg": "#f5f0fc" } as CSSProperties;
  return { "--ov-badge-ink": "#08734c", "--ov-badge-bg": "#e6f9ef" } as CSSProperties;
}

export function OverviewPanels({ panels, secondary }: { panels: OverviewPanelData[]; secondary?: boolean }) {
  return (
    <OverviewRow secondary={secondary}>
      {panels.map((panel, i) => (
        <OverviewPanel
          key={panel.title}
          span={panel.span}
          icon={panel.icon}
          tone={i}
          title={panel.title}
          note={panel.note}
          foot={panel.foot}
          link
        >
          <PanelBody panel={panel} />
        </OverviewPanel>
      ))}
    </OverviewRow>
  );
}

function PanelBody({ panel }: { panel: OverviewPanelData }) {
  switch (panel.kind) {
    case "funnel":
      return <Funnel rows={panel.rows} />;
    case "donut":
      return (
        <DonutRing
          total={panel.total}
          totalLabel={panel.totalLabel}
          healthPalette={panel.healthPalette}
          segments={panel.segments}
        />
      );
    case "columns":
      return <ColumnChart rows={panel.rows} />;
    case "trends":
      return <TrendGrid series={panel.series} />;
    case "stages":
      return <Stages rows={panel.rows} />;
    case "checks":
      return <Checks rows={panel.rows} />;
    case "attention":
      return (
        <AttentionRows
          items={panel.rows.map((r) => ({ icon: "alert", title: r.title, hint: r.detail, count: r.count }))}
        />
      );
    case "activity":
      return <Events items={panel.rows.map((r) => ({ icon: "clock", title: r.title, detail: r.detail, href: r.href }))} />;
    case "rank":
      return <Rankings rows={panel.rows.map((r, i) => ({ rank: i + 1, name: r.name, value: r.value, initials: r.initials }))} />;
    case "actions":
      return <ActionGrid actions={panel.rows.map((r) => ({ label: r.label, icon: r.icon }))} />;
    case "campaignboard":
      return <CampaignBoard rows={panel.rows} />;
  }
}
