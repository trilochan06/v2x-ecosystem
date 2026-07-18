import type { SimulationState } from "../types";

const CELL = 110;
const PAD = 60;

function nodeXY(node: string): [number, number] {
  const [x, y] = node.split("-").map(Number);
  return [PAD + x * CELL, PAD + y * CELL];
}

function occupancyColor(o: number): string {
  if (o < 0.35) return "#22c55e";
  if (o < 0.65) return "#eab308";
  if (o < 0.85) return "#f97316";
  return "#ef4444";
}

const VEHICLE_COLOR: Record<string, string> = {
  car: "#7dd3fc",
  ambulance: "#f87171",
  malicious: "#c084fc",
};

interface Props {
  state: SimulationState;
  selectedSegment: string | null;
  onSelectSegment: (id: string) => void;
}

export function CityMap({ state, selectedSegment, onSelectSegment }: Props) {
  const size = state.grid_size;
  const width = PAD * 2 + (size - 1) * CELL;
  const height = PAD * 2 + (size - 1) * CELL;

  const corridorSegments = new Set(
    state.vehicles.filter((v) => v.yielding || v.kind === "ambulance").map((v) => v.segment_id).filter(Boolean)
  );

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="city-map"
      role="img"
      aria-label="Live city digital twin"
    >
      {state.segments.map((seg) => {
        const [ax, ay] = nodeXY(seg.a);
        const [bx, by] = nodeXY(seg.b);
        const isCorridor = corridorSegments.has(seg.id);
        const isSelected = selectedSegment === seg.id;
        return (
          <g key={seg.id} onClick={() => onSelectSegment(seg.id)} className="segment-group">
            <line
              x1={ax}
              y1={ay}
              x2={bx}
              y2={by}
              stroke={occupancyColor(seg.occupancy)}
              strokeWidth={isSelected ? 10 : 7}
              strokeLinecap="round"
              opacity={0.85}
            />
            {seg.incident && (
              <line
                x1={ax}
                y1={ay}
                x2={bx}
                y2={by}
                stroke="#ef4444"
                strokeWidth={3}
                strokeDasharray="4 6"
                className="incident-pulse"
              />
            )}
            {isCorridor && (
              <line
                x1={ax}
                y1={ay}
                x2={bx}
                y2={by}
                stroke="#38bdf8"
                strokeWidth={2}
                strokeDasharray="2 10"
                className="corridor-pulse"
              />
            )}
            {/* wide invisible hit-target for easier clicking */}
            <line x1={ax} y1={ay} x2={bx} y2={by} stroke="transparent" strokeWidth={22} />
          </g>
        );
      })}

      {Object.entries(
        state.rsus.reduce<Record<string, boolean>>((acc, r) => ({ ...acc, [r.node]: r.alive }), {})
      ).map(([node, alive]) => {
        const [x, y] = nodeXY(node);
        return (
          <g key={node}>
            <circle cx={x} cy={y} r={16} fill={alive ? "#1e3a8a" : "#450a0a"} stroke={alive ? "#60a5fa" : "#f87171"} strokeWidth={2} />
            <text x={x} y={y + 4} textAnchor="middle" fontSize={11} fill={alive ? "#bfdbfe" : "#fca5a5"}>
              RSU
            </text>
          </g>
        );
      })}

      {state.traffic_lights.map((light) => {
        const [x, y] = nodeXY(light.node);
        return (
          <circle
            key={light.id}
            cx={x + 20}
            cy={y - 20}
            r={6}
            fill={light.phase === "green" ? "#22c55e" : "#ef4444"}
            stroke={light.preempted ? "#38bdf8" : "none"}
            strokeWidth={light.preempted ? 3 : 0}
          >
            <title>{light.preempted ? light.preempt_reason : `${light.phase} phase`}</title>
          </circle>
        );
      })}

      {state.vehicles.map((v) => {
        const px = PAD + v.x * CELL;
        const py = PAD + v.y * CELL;
        const color = VEHICLE_COLOR[v.kind] ?? "#7dd3fc";
        const isFlagged = v.trust_hint < 0.35;
        return (
          <g key={v.id} transform={`translate(${px}, ${py})`}>
            <circle
              r={v.kind === "ambulance" ? 7 : 5}
              fill={color}
              stroke={isFlagged ? "#facc15" : v.yielding ? "#38bdf8" : "none"}
              strokeWidth={isFlagged || v.yielding ? 3 : 0}
              opacity={0.95}
            >
              <title>
                {v.id} ({v.kind}) trust={v.trust_hint.toFixed(2)}
              </title>
            </circle>
          </g>
        );
      })}
    </svg>
  );
}
