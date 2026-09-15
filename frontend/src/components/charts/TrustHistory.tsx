import type { TrustSample } from "../../sim/runtime";

/**
 * Honest trust against attacker trust, over time.
 *
 * The security page listed every vehicle's current score, which shows where
 * trust ended up but not the thing the argument rests on: the two populations
 * separating as corroboration accumulates. One line per vehicle would be
 * fourteen tangled lines; two means are legible and make the same point.
 *
 * Deliberately not drawn when there is no attacker in the city — an empty
 * second series would imply the defence is idle rather than untested.
 */

const W = 640;
const H = 200;
const PAD = { top: 14, right: 16, bottom: 28, left: 42 };

const HONEST = "#199e70";
const ATTACKER = "#c084fc";

export function TrustHistory({ samples }: { samples: TrustSample[] }) {
  const points = samples.filter((s) => Number.isFinite(s.honest));
  const everAttacked = points.some((s) => s.attackers > 0);

  if (points.length < 2) {
    return (
      <figure className="chart">
        <figcaption>
          <span className="chart-title">Trust over time</span>
        </figcaption>
        <p className="chart-empty">
          Collecting — trust is an exponential moving average, so it needs a few reports before it says
          anything.
        </p>
      </figure>
    );
  }

  const x0 = points[0].tick;
  const x1 = points[points.length - 1].tick;
  const spanX = Math.max(x1 - x0, 1);
  const px = (tick: number) => PAD.left + ((tick - x0) / spanX) * (W - PAD.left - PAD.right);
  // Trust is a 0..1 score, so the axis is fixed rather than auto-scaled: a
  // rescaling axis would make a flat, healthy network look dramatic.
  const py = (v: number) => PAD.top + (1 - v) * (H - PAD.top - PAD.bottom);

  const path = (pick: (s: TrustSample) => number | null) => {
    let d = "";
    let pen = false;
    for (const s of points) {
      const v = pick(s);
      if (v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${px(s.tick).toFixed(1)} ${py(v).toFixed(1)} `;
      pen = true;
    }
    return d.trim();
  };

  const revocations = points.filter(
    (s, i) => i > 0 && s.revoked > points[i - 1].revoked,
  );

  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">Trust over time</span>
        <span className="chart-unit">corroboration-derived score, 0–1</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="Mean trust of honest vehicles compared with attackers over time">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={PAD.left} y1={py(v)} x2={W - PAD.right} y2={py(v)} className="grid-line" />
            <text x={PAD.left - 8} y={py(v) + 4} textAnchor="end" className="axis-label">
              {v.toFixed(2)}
            </text>
          </g>
        ))}

        {/* The revocation threshold, so a falling line has somewhere to fall to. */}
        <line
          x1={PAD.left}
          y1={py(0.12)}
          x2={W - PAD.right}
          y2={py(0.12)}
          stroke="#e66767"
          strokeWidth={1.2}
          strokeDasharray="5 4"
          opacity={0.75}
        />
        <text x={W - PAD.right} y={py(0.12) - 6} textAnchor="end" className="axis-label">
          revocation threshold
        </text>

        {revocations.map((s) => (
          <line
            key={s.tick}
            x1={px(s.tick)}
            y1={PAD.top}
            x2={px(s.tick)}
            y2={H - PAD.bottom}
            stroke="#e66767"
            strokeWidth={1}
            opacity={0.5}
          />
        ))}

        <path d={path((s) => s.honest)} fill="none" stroke={HONEST} strokeWidth={2} />
        {everAttacked && (
          <path d={path((s) => s.attacker)} fill="none" stroke={ATTACKER} strokeWidth={2} />
        )}

        <text x={PAD.left} y={H - 8} className="axis-label">
          tick {x0}
        </text>
        <text x={W - PAD.right} y={H - 8} textAnchor="end" className="axis-label">
          tick {x1}
        </text>
      </svg>

      <div className="chart-key">
        <span>
          <i style={{ background: HONEST }} /> honest vehicles
        </span>
        {everAttacked ? (
          <span>
            <i style={{ background: ATTACKER }} /> attackers
          </span>
        ) : (
          <span className="muted">
            no attacker in the city — add one on the Control Centre to see the two separate
          </span>
        )}
      </div>
    </figure>
  );
}
