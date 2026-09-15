// Chart primitives built from the golden master's own `.chart` / `.ringrow`
// / `.barrow` vocabulary (docs/reference/CreatorOps_UI_Golden_Master.html).
// The source hardcoded one example conic-gradient/polyline; these compute
// the same shapes from real data instead of a fixed sample.
"use client";

const SERIES_COLORS = ["var(--bright)", "#5a87bc", "#98bba9", "#c9a15a"];

export function ChartSummary({ value, label }: { value: string; label: string }) {
  return (
    <div className="chartsummary">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

export function TrendLine({
  points,
  color = "var(--bright)",
  height = 60,
}: {
  points: number[];
  color?: string;
  height?: number;
}) {
  const width = 220;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = i * step;
    const y = height - ((p - min) / range) * (height - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} height={height}>
      <line x1={0} y1={height - 4} x2={width} y2={height - 4} className="gridline" />
      <polyline points={coords.join(" ")} fill="none" stroke={color} strokeWidth={2} />
    </svg>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map((item) => (
        <span key={item.label}>
          <i className="swatch" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function DonutRing({
  segments,
  total,
  totalLabel,
}: {
  segments: { label: string; value: number }[];
  total: number;
  totalLabel: string;
}) {
  const { stops } = segments.reduce<{ stops: string[]; cursor: number }>(
    (acc, segment, i) => {
      const pct = (segment.value / total) * 100;
      const end = acc.cursor + pct;
      const stop = `${SERIES_COLORS[i % SERIES_COLORS.length]} ${acc.cursor.toFixed(1)}% ${end.toFixed(1)}%`;
      return { stops: [...acc.stops, stop], cursor: end };
    },
    { stops: [], cursor: 0 },
  );

  return (
    <div className="ringrow">
      <div className="ring" style={{ background: `conic-gradient(${stops.join(",")})` }}>
        <div className="ringinner">
          <b>{total}</b>
          <small>{totalLabel}</small>
        </div>
      </div>
      <div className="ringlegend">
        {segments.map((segment, i) => (
          <div key={segment.label}>
            <span className="swatch" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            {segment.label}
            <b>{segment.value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StageBars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <>
      {rows.map((row) => (
        <div className="barrow" key={row.label}>
          <div className="barlabel">
            <span>{row.label}</span>
            <b>{row.value}</b>
          </div>
          <div className="bar">
            <i style={{ width: `${(row.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </>
  );
}
