import { UNEQUIPPED_KINDS, VEHICLE_STYLE, VRU_KINDS } from "./map/mapStyle";

/** Order the legend reads in: bulk traffic, then two-wheelers, then the
 *  vehicles that only appear when something is happening. */
const GROUPS: { title: string; kinds: string[]; note?: string }[] = [
  { title: "Traffic", kinds: ["car", "rickshaw", "bus", "truck"] },
  {
    title: "Unprotected",
    kinds: ["motorbike", "bicycle"],
    note: "Vehicles slow harder for these. A bicycle carries no on-board unit, so the network knows it is there only because another vehicle saw it and shared a CPM — it is drawn with a hollow centre.",
  },
  {
    title: "Dispatched",
    kinds: ["ambulance", "fire", "police", "malicious"],
    note: "Emergency vehicles hold their route and get a signal-preempted corridor; everything else is told to yield.",
  },
];

function Swatch({ kind }: { kind: string }) {
  const style = VEHICLE_STYLE[kind];
  if (!style) return null;
  const w = Math.max(14, Math.min(26, 18 * style.scale));
  const h = Math.max(8, Math.min(13, 10 * Math.min(style.scale, 1.18)));
  // Two tags plus a name do not fit a half-width cell, and a legend that
  // abbreviates "Bicycle" to "B.." has failed at the one thing it is for.
  const tags = (VRU_KINDS.has(kind) ? 1 : 0) + (UNEQUIPPED_KINDS.has(kind) ? 1 : 0);
  return (
    <li className={`fleet-legend__item${tags > 1 ? " fleet-legend__item--wide" : ""}`}>
      <svg width={28} height={16} viewBox="-14 -8 28 16" aria-hidden="true">
        <rect
          x={-w / 2}
          y={-h / 2}
          width={w}
          height={h}
          rx={2.5}
          fill={style.color}
          stroke="#FFFFFF"
          strokeWidth={1.2}
        />
        {UNEQUIPPED_KINDS.has(kind) && <circle r={2} fill="#FFFFFF" opacity={0.92} />}
      </svg>
      <span>{style.label}</span>
      {VRU_KINDS.has(kind) && <em className="fleet-legend__tag">VRU</em>}
      {UNEQUIPPED_KINDS.has(kind) && <em className="fleet-legend__tag">no OBU</em>}
    </li>
  );
}

/**
 * What is on the road, and which differences the network acts on.
 *
 * Deliberately more than a colour key. Two of these distinctions change
 * behaviour rather than appearance — an unprotected user is one everything
 * else slows for, and an unequipped one is invisible to the network except
 * through somebody else's sensors — so the legend says so where the viewer is
 * looking at the map, rather than leaving it to the write-up.
 */
export function FleetLegend() {
  return (
    <div className="panel fleet-legend">
      <h2>Who is on the road</h2>
      {GROUPS.map((group) => (
        <div key={group.title} className="fleet-legend__group">
          <h3>{group.title}</h3>
          <ul>
            {group.kinds.map((kind) => (
              <Swatch key={kind} kind={kind} />
            ))}
          </ul>
          {group.note && <p className="muted small">{group.note}</p>}
        </div>
      ))}
      <p className="muted small">
        Road space is counted in passenger-car units, so a bus weighs 2.5 cars on a lane and a
        bicycle 0.2. Marker size follows the same figure.
      </p>
    </div>
  );
}
