import { useState } from "react";

import { SERIES_COLORS } from "./palette";

export interface BarDatum {
  label: string;
  value: number;
  color?: string;
}

interface Props {
  title: string;
  unit: string;
  data: BarDatum[];
  /** Lower values are better for latency/overhead; higher for availability. */
  lowerIsBetter?: boolean;
  caption?: string;
  precision?: number;
}

const ROW_H = 38;
const BAR_H = 14;
const LABEL_W = 176;
const VALUE_W = 92;

export function BarComparison({ title, unit, data, lowerIsBetter, caption, precision = 2 }: Props) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const max = Math.max(...data.map((d) => d.value), 0.0001);
  const plotW = 320;
  const height = data.length * ROW_H + 8;

  const best =
    lowerIsBetter === undefined
      ? null
      : data.reduce((acc, d, i) => {
          const better = lowerIsBetter ? d.value < data[acc].value : d.value > data[acc].value;
          return better ? i : acc;
        }, 0);

  const fmt = (v: number) => v.toFixed(precision).replace(/\.?0+$/, "") || "0";

  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{title}</span>
        <span className="chart-unit">{unit}</span>
        <button className="chart-toggle" onClick={() => setShowTable((s) => !s)}>
          {showTable ? "chart" : "table"}
        </button>
      </figcaption>

      {showTable ? (
        <table className="chart-table">
          <thead>
            <tr>
              <th>Configuration</th>
              <th>{unit}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.label}>
                <td>{d.label}</td>
                <td>{fmt(d.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <svg viewBox={`0 0 ${LABEL_W + plotW + VALUE_W} ${height}`} className="chart-svg" role="img" aria-label={title}>
          {data.map((d, i) => {
            const y = i * ROW_H + 10;
            const w = Math.max(3, (d.value / max) * plotW);
            const color = d.color ?? SERIES_COLORS[i % SERIES_COLORS.length];
            return (
              <g
                key={d.label}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                className="bar-row"
              >
                <rect x={0} y={y - 8} width={LABEL_W + plotW + VALUE_W} height={ROW_H - 6} fill="transparent" />
                <text x={0} y={y + BAR_H - 3} className="bar-label">
                  {d.label}
                </text>
                <rect x={LABEL_W} y={y} width={plotW} height={BAR_H} rx={4} className="bar-track" />
                <rect
                  x={LABEL_W}
                  y={y}
                  width={w}
                  height={BAR_H}
                  rx={4}
                  fill={color}
                  opacity={hovered === null || hovered === i ? 1 : 0.55}
                />
                <text x={LABEL_W + plotW + 10} y={y + BAR_H - 2} className="bar-value">
                  {fmt(d.value)}
                  {best === i && <tspan className="bar-best"> ✓</tspan>}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {caption && <p className="chart-caption">{caption}</p>}
    </figure>
  );
}
