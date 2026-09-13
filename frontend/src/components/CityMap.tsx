import { useEffect, useRef, useState } from "react";
import type { SimulationState, VehicleState } from "../types";

const CELL = 130;
const PAD = 60;
const MARGIN_TOP = 110;
const FOG_ROW_Y = 46;
const ROAD_WIDTH = 22;

function parseNode(node: string): [number, number] {
  const [x, y] = node.split("-").map(Number);
  return [x, y];
}

function nodeXY(node: string): [number, number] {
  const [x, y] = parseNode(node);
  return [PAD + x * CELL, MARGIN_TOP + y * CELL];
}

function headingDegrees(node: string, nextNode: string | null): number {
  if (!nextNode) return 0;
  const [ax, ay] = parseNode(node);
  const [bx, by] = parseNode(nextNode);
  return (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
}

function occupancyColor(o: number): string {
  if (o < 0.35) return "#22c55e";
  if (o < 0.65) return "#eab308";
  if (o < 0.85) return "#f97316";
  return "#ef4444";
}

// Deterministic pseudo-random-ish hash so block styling stays stable across re-renders
function hash(a: number, b: number): number {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

const BLOCK_PALETTE = ["#1c2436", "#20293c", "#232c3f", "#1e2738"];
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
  const height = MARGIN_TOP + PAD + (size - 1) * CELL;

  const [justRerouted, setJustRerouted] = useState<Set<string>>(new Set());
  const rerouteCountsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const prev = rerouteCountsRef.current;
    const changed: string[] = [];
    for (const v of state.vehicles) {
      const before = prev.get(v.id) ?? v.reroute_count;
      if (v.reroute_count > before) changed.push(v.id);
      prev.set(v.id, v.reroute_count);
    }
    if (changed.length === 0) return;
    setJustRerouted((cur) => new Set([...cur, ...changed]));
    const timer = window.setTimeout(() => {
      setJustRerouted((cur) => {
        const next = new Set(cur);
        for (const id of changed) next.delete(id);
        return next;
      });
    }, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tick]);

  const corridorSegments = new Set(
    state.vehicles.filter((v) => v.yielding || v.kind === "ambulance").map((v) => v.segment_id).filter(Boolean)
  );

  const rsuByNode = new Map(state.rsus.map((r) => [r.node, r]));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="city-map" role="img" aria-label="Live city digital twin">
      <defs>
        <radialGradient id="fogGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#f97316" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#f97316" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* city blocks */}
      {Array.from({ length: size - 1 }).map((_, bx) =>
        Array.from({ length: size - 1 }).map((_, by) => {
          const [x0, y0] = nodeXY(`${bx}-${by}`);
          const [x1, y1] = nodeXY(`${bx + 1}-${by + 1}`);
          const inset = ROAD_WIDTH / 2 + 8;
          const isPark = Math.floor(hash(bx, by) * 6) === 0;
          const color = isPark ? "#16321f" : BLOCK_PALETTE[Math.floor(hash(bx + 1, by + 2) * BLOCK_PALETTE.length)];
          const bw = x1 - x0 - inset * 2;
          const bh = y1 - y0 - inset * 2;
          return (
            <g key={`block-${bx}-${by}`}>
              <rect x={x0 + inset} y={y0 + inset} width={bw} height={bh} rx={6} fill={color} stroke="#0b1120" strokeWidth={1} />
              {!isPark && bw > 30 && bh > 30 && (
                <rect
                  x={x0 + inset + bw * 0.22}
                  y={y0 + inset + bh * 0.22}
                  width={bw * 0.56}
                  height={bh * 0.56}
                  rx={4}
                  fill="#0000"
                  stroke="#334155"
                  strokeWidth={1}
                  opacity={0.6}
                />
              )}
              {isPark && (
                <>
                  <circle cx={x0 + inset + bw * 0.3} cy={y0 + inset + bh * 0.4} r={Math.min(bw, bh) * 0.12} fill="#22c55e" opacity={0.5} />
                  <circle cx={x0 + inset + bw * 0.65} cy={y0 + inset + bh * 0.6} r={Math.min(bw, bh) * 0.1} fill="#22c55e" opacity={0.4} />
                </>
              )}
            </g>
          );
        })
      )}

      {/* roads */}
      {state.segments.map((seg) => {
        const [ax, ay] = nodeXY(seg.a);
        const [bx, by] = nodeXY(seg.b);
        const isCorridor = corridorSegments.has(seg.id);
        const isSelected = selectedSegment === seg.id;
        return (
          <g key={seg.id} onClick={() => onSelectSegment(seg.id)} className="segment-group">
            <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#1e2532" strokeWidth={ROAD_WIDTH} strokeLinecap="round" />
            <line
              x1={ax}
              y1={ay}
              x2={bx}
              y2={by}
              stroke={occupancyColor(seg.occupancy)}
              strokeWidth={ROAD_WIDTH}
              strokeLinecap="round"
              opacity={isSelected ? 0.75 : 0.5}
            />
            {isSelected && (
              <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#e2e8f0" strokeWidth={ROAD_WIDTH + 6} strokeLinecap="round" opacity={0.12} />
            )}
            <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#facc15" strokeWidth={1.5} strokeDasharray="10 10" opacity={0.35} />
            {/* Physical hazard on the road. */}
            {seg.hazard_active && (
              <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#e66767" strokeWidth={4} strokeDasharray="4 6" className="incident-pulse" />
            )}
            {/* What the network has corroborated. Drawn separately from the
                hazard itself so missed and false detections are visible on
                the map rather than buried in a metric. */}
            {seg.confirmed_incident && (
              <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#eda100" strokeWidth={2} strokeDasharray="1 6" />
            )}
            {isCorridor && (
              <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#38bdf8" strokeWidth={3} strokeDasharray="2 10" className="corridor-pulse" />
            )}
            <line x1={ax} y1={ay} x2={bx} y2={by} stroke="transparent" strokeWidth={26} />
          </g>
        );
      })}

      {/* fog computing layer */}
      {state.fog_nodes.map((fog) => {
        const fx = PAD + fog.x * CELL;
        const fy = FOG_ROW_Y;
        return (
          <g key={fog.id}>
            {fog.member_rsu_ids.map((rsuId) => {
              const rsu = state.rsus.find((r) => r.id === rsuId);
              if (!rsu) return null;
              const [rx, ry] = nodeXY(rsu.node);
              return (
                <line
                  key={rsuId}
                  x1={fx}
                  y1={fy + 22}
                  x2={rx}
                  y2={ry - 22}
                  stroke={fog.alert ? "#f97316" : "#334155"}
                  strokeWidth={1.5}
                  strokeDasharray="3 5"
                  opacity={0.7}
                />
              );
            })}
            {fog.alert && <circle cx={fx} cy={fy} r={34} fill="url(#fogGlow)" className="incident-pulse" />}
            <g transform={`translate(${fx}, ${fy})`}>
              <path
                d="M -24 6 Q -30 -8 -14 -10 Q -10 -20 4 -17 Q 18 -20 22 -8 Q 32 -6 26 6 Q 30 14 18 15 L -20 15 Q -30 14 -24 6 Z"
                fill={fog.alert ? "#7c2d12" : "#0f2942"}
                stroke={fog.alert ? "#fb923c" : "#38bdf8"}
                strokeWidth={1.5}
              />
              <text x={0} y={4} textAnchor="middle" fontSize={9} fontWeight={700} fill={fog.alert ? "#fed7aa" : "#bae6fd"}>
                FOG
              </text>
            </g>
            <text x={fx} y={fy + 34} textAnchor="middle" fontSize={9} fill="#64748b">
              {fog.id} &middot; {(fog.avg_occupancy * 100).toFixed(0)}%
            </text>
          </g>
        );
      })}

      {/* RSU towers */}
      {state.rsus.map((rsu) => {
        const [x, y] = nodeXY(rsu.node);
        const color = rsu.alive ? "#60a5fa" : "#f87171";
        return (
          <g key={rsu.id} transform={`translate(${x}, ${y})`}>
            <circle r={17} fill={rsu.alive ? "#132038" : "#3a1212"} stroke={color} strokeWidth={2} />
            <line x1={0} y1={-8} x2={0} y2={-24} stroke={color} strokeWidth={2.5} />
            <circle cx={0} cy={-24} r={3} fill={color} />
            {rsu.alive && (
              <>
                <path d="M -8 -18 A 11 11 0 0 1 8 -18" stroke={color} strokeWidth={1.6} fill="none" opacity={0.8} />
                <path d="M -13 -22 A 17 17 0 0 1 13 -22" stroke={color} strokeWidth={1.6} fill="none" opacity={0.45} />
              </>
            )}
            <text x={0} y={4} textAnchor="middle" fontSize={8.5} fontWeight={600} fill={color}>
              RSU
            </text>
          </g>
        );
      })}

      {/* traffic lights */}
      {state.traffic_lights.map((light) => {
        const [x, y] = nodeXY(light.node);
        return (
          <g key={light.id} transform={`translate(${x + 22}, ${y - 16})`}>
            <rect x={-3} y={0} width={6} height={12} fill="#334155" />
            <rect x={-7} y={-16} width={14} height={17} rx={3} fill="#0f172a" stroke="#334155" />
            <circle cx={0} cy={-8} r={4.5} fill={light.phase === "green" ? "#22c55e" : "#ef4444"}>
              {light.preempted && <animate attributeName="opacity" values="1;0.3;1" dur="0.6s" repeatCount="indefinite" />}
            </circle>
            {light.preempted && <circle cx={0} cy={-8} r={8} fill="none" stroke="#38bdf8" strokeWidth={1.5} className="corridor-pulse" />}
          </g>
        );
      })}

      {/* vehicles */}
      {state.vehicles.map((v) => (
        <VehicleIcon key={v.id} v={v} justRerouted={justRerouted.has(v.id)} />
      ))}
    </svg>
  );
}

function VehicleIcon({ v, justRerouted }: { v: VehicleState; justRerouted: boolean }) {
  const px = PAD + v.x * CELL;
  const py = MARGIN_TOP + v.y * CELL;
  const heading = headingDegrees(v.node, v.next_node);
  const color = VEHICLE_COLOR[v.kind] ?? "#7dd3fc";
  const isFlagged = v.trust_hint < 0.35;
  const isAmbulance = v.kind === "ambulance";

  return (
    <g
      style={{
        transform: `translate(${px}px, ${py}px)`,
        transition: "transform 0.75s linear",
      }}
    >
      <g style={{ transform: `rotate(${heading}deg)`, transition: "transform 0.75s linear" }}>
        {v.yielding && <circle r={11} fill="#38bdf8" opacity={0.25} />}
        {isFlagged && <circle r={11} fill="#facc15" opacity={0.3} className="incident-pulse" />}
        {justRerouted && <circle r={13} fill="none" stroke="#a3e635" strokeWidth={2} className="reroute-ping" />}
        <rect x={-7} y={-4} width={14} height={8} rx={3} fill={isAmbulance ? "#fff1f2" : color} stroke="#0b1120" strokeWidth={0.8} />
        {isAmbulance && (
          <>
            <rect x={-2.5} y={-3.5} width={1.5} height={7} fill="#ef4444" />
            <rect x={-4.25} y={-1.75} width={5} height={1.5} fill="#ef4444" />
          </>
        )}
        {!isAmbulance && <rect x={-2} y={-3} width={5} height={6} rx={1} fill="#0b1120" opacity={0.35} />}
        <circle cx={6} cy={-2.5} r={1.1} fill="#fef3c7" />
        <circle cx={6} cy={2.5} r={1.1} fill="#fef3c7" />
      </g>
      <title>
        {v.id} ({v.kind}) trust={v.trust_hint.toFixed(2)} reroutes={v.reroute_count}
      </title>
    </g>
  );
}
