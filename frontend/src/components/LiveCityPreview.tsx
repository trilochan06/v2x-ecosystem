import type { SimulationState } from "../types";

/**
 * A compact, chrome-free view of the city that is running right now.
 *
 * The landing page used to say "simulation live · tick 412" in one grey line,
 * which is a claim rather than evidence. This draws the thing: roads shaded by
 * how busy they are, vehicles moving, and a ring wherever a frame just went
 * out. No labels, no legend, no controls — it is not for operating the system,
 * only for making it obvious at a glance that there is a system.
 */

const PAD = 14;
const SPAN = 272;
/** Ticks a broadcast stays drawn. Long enough to catch the eye, short enough
 *  that the picture is "now" rather than a smear of everything. */
const TRACE_TICKS = 2;

const FRAME_COLOR: Record<string, string> = {
  CAM: "#3987e5",
  DENM: "#e66767",
  CPM: "#f0b429",
  SPATEM: "#199e70",
  SREM: "#c084fc",
  SSEM: "#c084fc",
  MCM: "#7dd3fc",
};

export function LiveCityPreview({ state }: { state: SimulationState }) {
  const size = state.grid_size;
  const step = SPAN / Math.max(size - 1, 1);
  const px = (v: number) => PAD + v * step;
  const nodeXY = (node: string): [number, number] => {
    const [x, y] = node.split("-").map(Number);
    return [px(x), px(y)];
  };

  const total = SPAN + PAD * 2;
  const live = state.transmissions.filter((t) => state.tick - t.tick <= TRACE_TICKS);

  return (
    <svg
      viewBox={`0 0 ${total} ${total}`}
      className="live-preview"
      role="img"
      aria-label={`The simulated city: ${state.vehicles.length} vehicles across ${state.rsus.length} roadside units, tick ${state.tick}`}
    >
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
              : "#22303f";
        return (
          <line
            key={seg.id}
            x1={ax}
            y1={ay}
            x2={bx}
            y2={by}
            stroke={stroke}
            strokeWidth={3.5}
            strokeLinecap="round"
            opacity={0.9}
          />
        );
      })}

      {/* Radio in flight — the point of the whole picture. */}
      {live.map((t) => {
        const rsu = state.rsus.find((r) => r.id === t.sender_id);
        const vehicle = state.vehicles.find((v) => v.id === t.sender_id);
        const from = rsu
          ? nodeXY(rsu.node)
          : t.sender_id.startsWith("light-")
            ? nodeXY(t.sender_id.slice("light-".length))
            : vehicle
              ? ([px(vehicle.x), px(vehicle.y)] as [number, number])
              : null;
        if (!from) return null;
        const age = state.tick - t.tick;
        return (
          <circle
            key={`${t.id}-${t.tick}`}
            cx={from[0]}
            cy={from[1]}
            r={6 + age * 9}
            fill="none"
            stroke={FRAME_COLOR[t.designator] ?? "#9fb0c3"}
            strokeWidth={1.4}
            opacity={0.5 * (1 - age / (TRACE_TICKS + 1))}
          />
        );
      })}

      {state.rsus.map((rsu) => {
        const [x, y] = nodeXY(rsu.node);
        return (
          <rect
            key={rsu.id}
            x={x - 3.5}
            y={y - 3.5}
            width={7}
            height={7}
            rx={1.5}
            fill={rsu.alive ? "#16212f" : "#3a1a1a"}
            stroke={rsu.alive ? "#3987e5" : "#e66767"}
            strokeWidth={1.4}
          />
        );
      })}

      {state.vehicles.map((v) => (
        <circle
          key={v.id}
          cx={px(v.x)}
          cy={px(v.y)}
          r={v.kind === "ambulance" ? 3.4 : 2.6}
          fill={v.kind === "ambulance" ? "#f87171" : v.kind === "malicious" ? "#c084fc" : "#7dd3fc"}
        />
      ))}
    </svg>
  );
}
