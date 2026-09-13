import { useState } from "react";

export interface LinePoint {
  x: number;
  y: number;
  meta?: string;
}

interface Props {
  title: string;
  yLabel: string;
  xLabel: string;
  points: LinePoint[];
  color?: string;
  /** Drawn as a dashed reference line, e.g. the convergence target. */
  target?: { value: number; label: string };
}

const W = 640;
const H = 240;
const PAD = { top: 16, right: 20, bottom: 34, left: 54 };

export function ConvergenceLine({ title, yLabel, xLabel, points, color = "#3987e5", target }: Props) {
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <figure className="chart">
        <figcaption>
          <span className="chart-title">{title}</span>
        </figcaption>
        <p className="chart-empty">No rounds recorded yet — the first aggregation happens once RSUs have enough local samples.</p>
      </figure>
    );
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs, xMin + 1);
  const yMax = Math.max(...ys, target?.value ?? 0) * 1.1 || 1;

  const px = (x: number) => PAD.left + ((x - xMin) / (xMax - xMin)) * (W - PAD.left - PAD.right);
  const py = (y: number) => H - PAD.bottom - (y / yMax) * (H - PAD.top - PAD.bottom);

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const xTicks = Array.from(
    new Set([xMin, Math.round((xMin + xMax) / 2), xMax].filter((t) => Number.isFinite(t)))
  );

  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{title}</span>
        <span className="chart-unit">{yLabel}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label={title}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} y1={py(t)} x2={W - PAD.right} y2={py(t)} className="grid-line" />
            <text x={PAD.left - 8} y={py(t) + 4} className="axis-label" textAnchor="end">
              {t.toFixed(3)}
            </text>
          </g>
        ))}

        {target && (
          <g>
            <line
              x1={PAD.left}
              y1={py(target.value)}
              x2={W - PAD.right}
              y2={py(target.value)}
              stroke="#c98500"
              strokeWidth={1.5}
              strokeDasharray="5 4"
            />
            <text x={W - PAD.right} y={py(target.value) - 6} className="axis-label" textAnchor="end">
              {target.label}
            </text>
          </g>
        )}

        <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {/* Past ~24 rounds the markers crowd into each other and break the
            line up visually, so they retire and only the hovered point is
            drawn. The hit targets stay regardless. */}
        {points.map((p, i) => {
          const showMarker = points.length <= 24 || hover === i || i === points.length - 1;
          return (
            <g key={p.x} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <circle cx={px(p.x)} cy={py(p.y)} r={10} fill="transparent" />
              {showMarker && (
                <circle
                  cx={px(p.x)}
                  cy={py(p.y)}
                  r={hover === i ? 5.5 : 4}
                  fill={color}
                  stroke="#0d1524"
                  strokeWidth={2}
                />
              )}
            </g>
          );
        })}

        {xTicks.map((t) => (
          <text key={t} x={px(t)} y={H - PAD.bottom + 16} className="axis-label" textAnchor="middle">
            {t}
          </text>
        ))}

        {hover !== null && (
          <g>
            <line
              x1={px(points[hover].x)}
              y1={PAD.top}
              x2={px(points[hover].x)}
              y2={H - PAD.bottom}
              className="crosshair"
            />
            <text
              x={Math.min(px(points[hover].x) + 8, W - 190)}
              y={PAD.top + 14}
              className="tooltip-text"
            >
              round {points[hover].x} · {points[hover].y.toFixed(4)}
              {points[hover].meta ? ` · ${points[hover].meta}` : ""}
            </text>
          </g>
        )}

        <text x={(W + PAD.left) / 2} y={H - 6} className="axis-label" textAnchor="middle">
          {xLabel}
        </text>
      </svg>
    </figure>
  );
}
