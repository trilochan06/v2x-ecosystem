import type { SimulationState, Transmission } from "../types";

/**
 * A street-level view of a small neighbourhood.
 *
 * The city map draws twenty-six vehicles as three-pixel dots, which is the
 * right call at that scale and useless for understanding what V2X actually
 * does. Here there are six vehicles on four blocks, each large enough to
 * carry a label and a heading, and — the part that matters — the radio is
 * drawn: every frame on the air shows as a ring expanding from its sender and
 * a pulse on each station that decoded it.
 */

const PAD = 56;
const SPAN = 560;

/**
 * How many ticks a transmission stays drawn.
 *
 * Vehicles emit a CAM every fourth tick, so a shorter trace than this leaves
 * the map visually dead most of the time — on a page whose entire point is
 * watching the radio, that reads as "nothing is happening". Three keeps
 * something on screen almost every tick without becoming a light show.
 */
const TRACE_TICKS = 3;

const FRAME_COLOR: Record<string, string> = {
  CAM: "#3987e5",
  DENM: "#e66767",
  SPATEM: "#199e70",
  SREM: "#c084fc",
  SSEM: "#c084fc",
};

interface Props {
  state: SimulationState;
  selectedVehicle: string | null;
  onSelectVehicle: (id: string | null) => void;
  selectedSegment: string | null;
  onSelectSegment: (id: string | null) => void;
}

export function StreetMap({
  state,
  selectedVehicle,
  onSelectVehicle,
  selectedSegment,
  onSelectSegment,
}: Props) {
  const size = state.grid_size;
  const step = SPAN / Math.max(size - 1, 1);
  const px = (x: number) => PAD + x * step;

  const nodeXY = (node: string): [number, number] => {
    const [x, y] = node.split("-").map(Number);
    return [px(x), px(y)];
  };

  const vehicleXY = (id: string): [number, number] | null => {
    const v = state.vehicles.find((veh) => veh.id === id);
    return v ? [px(v.x), px(v.y)] : null;
  };

  const stationXY = (id: string): [number, number] | null => {
    const rsu = state.rsus.find((r) => r.id === id);
    if (rsu) return nodeXY(rsu.node);
    return vehicleXY(id);
  };

  // Only the last couple of ticks, so the drawing shows "now" rather than
  // everything that has ever been transmitted.
  const live: Transmission[] = state.transmissions.filter(
    (t) => state.tick - t.tick <= TRACE_TICKS,
  );

  const total = SPAN + PAD * 2;

  return (
    <svg
      viewBox={`0 0 ${total} ${total}`}
      className="street-map"
      role="img"
      aria-label={`Street-level view: ${state.vehicles.length} vehicles, tick ${state.tick}`}
    >
      <defs>
        <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* ---------------------------------------------------------- roads */}
      {state.segments.map((seg) => {
        const [ax, ay] = nodeXY(seg.a);
        const [bx, by] = nodeXY(seg.b);
        const busy = seg.occupancy;
        const stroke = seg.hazard_active
          ? "#e66767"
          : busy > 0.66
            ? "#e08a5a"
            : busy > 0.33
              ? "#c9a227"
              : "#2c3a4a";
        return (
          <g key={seg.id}>
            <line
              x1={ax}
              y1={ay}
              x2={bx}
              y2={by}
              stroke={stroke}
              strokeWidth={seg.id === selectedSegment ? 17 : 14}
              strokeLinecap="round"
              opacity={0.95}
            />
            {/* Lane divider, so a road reads as a road. */}
            <line
              x1={ax}
              y1={ay}
              x2={bx}
              y2={by}
              stroke="#0a1018"
              strokeWidth={1.4}
              strokeDasharray="7 9"
              opacity={0.55}
            />
            {seg.hazard_active && (
              <line
                x1={ax}
                y1={ay}
                x2={bx}
                y2={by}
                stroke="#ff5a5a"
                strokeWidth={19}
                strokeLinecap="round"
                opacity={0.28}
                className="incident-pulse"
              />
            )}
            {seg.confirmed_incident && (
              <line
                x1={ax}
                y1={ay}
                x2={bx}
                y2={by}
                stroke="#f0b429"
                strokeWidth={4}
                strokeDasharray="10 6"
                strokeLinecap="round"
              />
            )}
            <line
              x1={ax}
              y1={ay}
              x2={bx}
              y2={by}
              stroke="transparent"
              strokeWidth={22}
              style={{ cursor: "pointer" }}
              onClick={() => onSelectSegment(seg.id === selectedSegment ? null : seg.id)}
            >
              <title>
                {seg.a} → {seg.b} · {Math.round(seg.occupancy * 100)}% full
                {seg.hazard_active ? ` · ${seg.hazard_type}` : ""}
              </title>
            </line>
          </g>
        );
      })}

      {/* ------------------------------------------------- radio in flight */}
      {live.map((t) => {
        const from = stationXY(t.sender_id);
        if (!from) return null;
        const color = FRAME_COLOR[t.designator] ?? "#9fb0c3";
        const age = state.tick - t.tick;
        const fade = 1 - age / (TRACE_TICKS + 1);
        return (
          <g key={`${t.id}-${t.tick}`} opacity={fade}>
            {/* The broadcast itself: one ring, expanding. */}
            <circle
              cx={from[0]}
              cy={from[1]}
              r={26 + age * 26}
              fill="none"
              stroke={color}
              strokeWidth={2}
              opacity={0.55}
            />
            {/* And a line to each station that actually decoded it. Frames
                that were lost simply have no line, which is the honest way
                to draw a lossy channel.

                Only for the newest tick: the ring lingers so a broadcast is
                noticeable, but keeping every hop of the last three ticks on
                screen turns the map into a cat's cradle. */}
            {age === 0 &&
              t.delivered_to.map((rx) => {
                const to = stationXY(rx);
                if (!to) return null;
                return (
                  <line
                    key={rx}
                    x1={from[0]}
                    y1={from[1]}
                    x2={to[0]}
                    y2={to[1]}
                    stroke={color}
                    strokeWidth={1.4}
                    strokeDasharray="3 6"
                    opacity={0.5}
                  />
                );
              })}
          </g>
        );
      })}

      {/* ------------------------------------------------------------ RSUs */}
      {state.rsus.map((rsu) => {
        const [x, y] = nodeXY(rsu.node);
        const light = state.traffic_lights.find((l) => l.node === rsu.node);
        return (
          <g key={rsu.id}>
            <rect
              x={x - 13}
              y={y - 13}
              width={26}
              height={26}
              rx={6}
              fill={rsu.alive ? "#16212f" : "#3a1a1a"}
              stroke={rsu.alive ? "#3987e5" : "#e66767"}
              strokeWidth={2}
            />
            <text x={x} y={y + 4} textAnchor="middle" className="street-rsu-label">
              {rsu.id.replace("rsu-", "R")}
            </text>
            {light && (
              <circle
                cx={x + 17}
                cy={y - 15}
                r={5}
                fill={light.phase === "green" ? "#199e70" : "#e66767"}
                stroke={light.preempted ? "#f0b429" : "none"}
                strokeWidth={2.5}
              />
            )}
            <title>
              {rsu.id} · {rsu.alive ? "online" : "OFFLINE"}
              {light ? ` · light ${light.phase}${light.preempted ? " (preempted)" : ""}` : ""}
            </title>
          </g>
        );
      })}

      {/* -------------------------------------------------------- vehicles */}
      {state.vehicles.map((v) => {
        const [x, y] = nodeXY(v.node);
        const target = v.next_node ? nodeXY(v.next_node) : [x, y];
        // Interpolate along the segment so movement is continuous rather
        // than hopping between intersections.
        const cx = px(v.x);
        const cy = px(v.y);
        const angle = (Math.atan2(target[1] - y, target[0] - x) * 180) / Math.PI;
        const selected = v.id === selectedVehicle;
        const fill =
          v.kind === "ambulance" ? "#f87171" : v.kind === "malicious" ? "#c084fc" : "#7dd3fc";

        return (
          <g
            key={v.id}
            transform={`translate(${cx} ${cy})`}
            style={{ cursor: "pointer" }}
            onClick={() => onSelectVehicle(selected ? null : v.id)}
          >
            {/* A generous invisible hit area. The wedge itself is a thin
                shape, so without this, clicking a car mostly selects the road
                underneath it. */}
            <circle r={14} fill="transparent" />
            {v.yielding && <circle r={20} fill="#f0b429" opacity={0.22} />}
            {selected && <circle r={19} fill="none" stroke="#fff" strokeWidth={2} opacity={0.85} />}
            <g transform={`rotate(${angle})`}>
              {/* A wedge, so heading is readable at a glance. */}
              <path
                d="M 11 0 L -7 7 L -4 0 L -7 -7 Z"
                fill={fill}
                stroke="#0a1018"
                strokeWidth={1.2}
                filter={v.kind === "ambulance" ? "url(#glow)" : undefined}
              />
            </g>
            <text x={0} y={-17} textAnchor="middle" className="street-vehicle-label">
              {shortId(v.id)}
            </text>
            <title>
              {v.id} · {v.kind} · heading {v.next_node ?? "—"} · trust {v.trust_hint.toFixed(2)}
            </title>
          </g>
        );
      })}
    </svg>
  );
}

/** "car-12" → "C12", "ambulance-3" → "A3". Short enough to sit over a car. */
function shortId(id: string): string {
  const [kind, n] = id.split("-");
  return `${kind[0].toUpperCase()}${n}`;
}
