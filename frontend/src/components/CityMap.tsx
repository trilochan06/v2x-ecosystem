import { useEffect, useRef, useState } from "react";

import {
  LAND_USE_LABEL,
  avenueName,
  crossName,
  junctionName,
  landUseOf,
  roadName,
} from "../sim/core";
import {
  DEFAULT_LAYERS,
  MAP,
  MIN_ZOOM,
  clampView,
  screenFraction,
  trafficColor,
  trafficWord,
  viewBoxOf,
} from "./map/mapStyle";
import type { MapLayers, MapView } from "./map/mapStyle";
import { MapAlert } from "./map/MapAlert";
import type { MapAlertContent } from "./map/MapAlert";
import type { SimulationState, VehicleState } from "../types";

/**
 * The city, drawn as a map.
 *
 * It used to be drawn as the graph it is internally: nodes, edges, a dark
 * field. That is faithful to the data structure and unreadable as a picture —
 * roads had no names, nothing looked like a city, and every mark had to be
 * explained before any of it could be followed.
 *
 * Now it borrows the conventions of the map everybody already knows: pale
 * land, white carriageways on a grey casing, green parks, named streets, and
 * live traffic drawn *beside* the road rather than instead of it so the street
 * stays legible underneath. The model behind it is unchanged. What changed is
 * that the viewer arrives already knowing how to read it.
 *
 * Three things make it a map rather than a picture of one: it can be panned
 * and zoomed, its overlays can be turned off, and when something goes wrong it
 * says so where it happened instead of in a log somewhere else.
 */

const CELL = 130;
const PAD = 72;
const ROAD_W = 26;
const MINOR_ROAD_W = 20;
/** Which block band each set of street names runs through — see the labels
 *  block for why the two cannot share one. Halves, so they sit over built-up
 *  land rather than over a junction. */
const LABEL_ROW = 0.5;
const LABEL_COLUMN = 2.5;

function parseNode(node: string): [number, number] {
  const [x, y] = node.split("-").map(Number);
  return [x, y];
}

function nodeXY(node: string): [number, number] {
  const [x, y] = parseNode(node);
  return [PAD + x * CELL, PAD + y * CELL];
}

function headingDegrees(node: string, nextNode: string | null): number {
  if (!nextNode) return 0;
  const [ax, ay] = parseNode(node);
  const [bx, by] = parseNode(nextNode);
  return (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
}

/** Stable pseudo-random, so block styling does not shimmer between renders. */
function hash(a: number, b: number): number {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

interface Props {
  state: SimulationState;
  selectedSegment: string | null;
  onSelectSegment: (id: string) => void;
  selectedVehicle?: string | null;
  onSelectVehicle?: (id: string | null) => void;
  layers?: MapLayers;
}

export function CityMap({
  state,
  selectedSegment,
  onSelectSegment,
  selectedVehicle,
  onSelectVehicle,
  layers = DEFAULT_LAYERS,
}: Props) {
  const size = state.grid_size;
  const width = PAD * 2 + (size - 1) * CELL;
  const height = PAD * 2 + (size - 1) * CELL;

  const [view, setView] = useState<MapView>({ cx: width / 2, cy: height / 2, k: 1 });
  const [dismissed, setDismissed] = useState<string | null>(null);
  /** Keep the selected vehicle in the middle of the map. Zoomed in, a car
   *  leaves the frame in a few seconds and following it by hand is the whole
   *  of your attention — which is attention not being spent on what it does. */
  const [follow, setFollow] = useState(false);
  const dragRef = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const zoomBy = (factor: number) =>
    setView((v) => clampView({ ...v, k: v.k * factor }, width, height));

  /**
   * Zoom about a point on screen, so the thing under the cursor stays under
   * the cursor. Zooming about the middle instead — which is the easy version —
   * makes the map shove whatever you were looking at off the edge, and is most
   * of why zooming felt wrong.
   */
  const zoomAt = (factor: number, clientX: number, clientY: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return zoomBy(factor);
    setView((v) => {
      const next = Math.min(4, Math.max(MIN_ZOOM, v.k * factor));
      if (next === v.k) return v;
      // The drawing is letterboxed inside the element, so the cursor has to be
      // converted through the drawn area rather than the element's box.
      const drawn = Math.min(box.width, box.height);
      const originX = box.x + (box.width - drawn) / 2;
      const originY = box.y + (box.height - drawn) / 2;
      const w = width / v.k;
      const worldX = v.cx - w / 2 + ((clientX - originX) / drawn) * w;
      const worldY = v.cy - w / 2 + ((clientY - originY) / drawn) * w;
      const ratio = 1 - v.k / next;
      return clampView(
        { k: next, cx: v.cx + (worldX - v.cx) * ratio, cy: v.cy + (worldY - v.cy) * ratio },
        width,
        height,
      );
    });
  };

  /** Put a place in the middle of the map, zoomed in enough to see it. */
  const goTo = (id: string, k = 2) => {
    const node = id.includes("_") ? id.split("_")[0] : id;
    const [x, y] = nodeXY(node);
    setView(clampView({ cx: x, cy: y, k }, width, height));
  };

  // --------------------------------------------------- what just went wrong
  // Read from the engine's own event log rather than re-deriving events from
  // state: the engine has already decided what is worth saying, and a second
  // copy of that judgement here would be a second thing to keep in step.
  //
  // Derived, not stored: an alert is simply "the newest incident, unless this
  // exact one has been waved away". That needs no effect, cannot go stale, and
  // survives a reset without special handling.
  const incident = newestIncident(state);
  const alert = incident && alertKey(incident) !== dismissed ? incident : null;

  const alertAnchor = alert
    ? (() => {
        const node = alert.where.includes("_") ? alert.where.split("_")[0] : alert.where;
        if (!state.segments.some((s) => s.a === node || s.b === node)) return null;
        const [ax, ay] = nodeXY(node);
        const other = alert.where.includes("_") ? alert.where.split("_")[1] : null;
        const [bx, by] = other ? nodeXY(other) : [ax, ay];
        return screenFraction(view, width, height, (ax + bx) / 2, (ay + by) / 2);
      })()
    : null;

  /**
   * Wheel zoom.
   *
   * Registered by hand rather than through React's `onWheel`, because React
   * attaches wheel listeners passively and a passive listener cannot call
   * `preventDefault` — so scrolling over the map zoomed *and* scrolled the
   * page underneath it. Every map zooms on the wheel; not doing it is most of
   * what made this one feel broken.
   */
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  // ------------------------------------------------------------- panning
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (view.k <= MIN_ZOOM) return;
    dragRef.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy };
    svgRef.current?.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || !svgRef.current) return;
    const box = svgRef.current.getBoundingClientRect();
    const scale = width / view.k / box.width;
    setView((v) =>
      clampView(
        { ...v, cx: drag.cx - (e.clientX - drag.x) * scale, cy: drag.cy - (e.clientY - drag.y) * scale },
        width,
        height,
      ),
    );
  };
  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    svgRef.current?.releasePointerCapture?.(e.pointerId);
  };

  // ------------------------------------------------------- follow a car
  const followed = follow && selectedVehicle
    ? state.vehicles.find((v) => v.id === selectedVehicle)
    : undefined;
  useEffect(() => {
    if (!followed) return;
    setView((v) =>
      clampView({ ...v, cx: PAD + followed.x * CELL, cy: PAD + followed.y * CELL }, width, height),
    );
  }, [followed?.x, followed?.y, width, height, followed]);

  // -------------------------------------------------------- reroute pings
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
    if (!changed.length) return;
    setJustRerouted((cur) => new Set([...cur, ...changed]));
    const timer = window.setTimeout(
      () =>
        setJustRerouted((cur) => {
          const next = new Set(cur);
          for (const id of changed) next.delete(id);
          return next;
        }),
      1500,
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tick]);

  const corridorSegments = new Set(
    state.vehicles
      .filter((v) => v.yielding || v.kind === "ambulance")
      .map((v) => v.segment_id)
      .filter(Boolean),
  );
  const liveRadio = layers.radio
    ? state.transmissions.filter((t) => state.tick - t.tick <= 1)
    : [];

  return (
    <div className="map-canvas">
      <svg
        ref={svgRef}
        viewBox={viewBoxOf(view, width, height)}
        className={view.k > MIN_ZOOM ? "city-map draggable" : "city-map"}
        role="img"
        aria-label={`Map of the city: ${state.vehicles.length} vehicles, tick ${state.tick}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => zoomAt(e.altKey || e.shiftKey ? 1 / 1.8 : 1.8, e.clientX, e.clientY)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "+" || e.key === "=") zoomBy(1.5);
          else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.5);
          else if (e.key === "0") setView({ cx: width / 2, cy: height / 2, k: 1 });
          else return;
          e.preventDefault();
        }}
      >
        <defs>
          <filter id="pinShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.4" floodColor="#2a2620" floodOpacity="0.28" />
          </filter>
        </defs>

        {/* ------------------------------------------------------- ground */}
        <rect x={0} y={0} width={width} height={height} fill={MAP.land} />

        {/* City blocks, tinted by what the district is for. The centre pulls
            traffic hardest, so it has to look like the centre. */}
        {Array.from({ length: size - 1 }).map((_, bx) =>
          Array.from({ length: size - 1 }).map((_, by) => {
            const [x0, y0] = nodeXY(`${bx}-${by}`);
            const [x1, y1] = nodeXY(`${bx + 1}-${by + 1}`);
            const inset = ROAD_W / 2 + 3;
            const isPark = Math.floor(hash(bx, by) * 7) === 0;
            const w = x1 - x0 - inset * 2;
            const h = y1 - y0 - inset * 2;
            return (
              <g key={`block-${bx}-${by}`}>
                <rect
                  x={x0 + inset}
                  y={y0 + inset}
                  width={w}
                  height={h}
                  rx={4}
                  fill={isPark ? MAP.park : MAP.block}
                  stroke={isPark ? MAP.parkEdge : MAP.blockEdge}
                  strokeWidth={1}
                />
                {/* Building footprints, so a block reads as built-up rather
                    than as an empty rectangle. */}
                {!isPark &&
                  [0, 1, 2].map((i) => {
                    const fw = w * (0.2 + hash(bx + i, by) * 0.22);
                    const fh = h * (0.2 + hash(bx, by + i) * 0.22);
                    return (
                      <rect
                        key={i}
                        x={x0 + inset + (w - fw) * hash(bx + i * 3, by + 1)}
                        y={y0 + inset + (h - fh) * hash(bx + 2, by + i * 3)}
                        width={fw}
                        height={fh}
                        rx={2}
                        fill="#0f172a"
                        opacity={0.055}
                      />
                    );
                  })}
                {isPark && (
                  <>
                    <circle cx={x0 + inset + w * 0.32} cy={y0 + inset + h * 0.4} r={Math.min(w, h) * 0.13} fill={MAP.parkEdge} />
                    <circle cx={x0 + inset + w * 0.64} cy={y0 + inset + h * 0.62} r={Math.min(w, h) * 0.1} fill={MAP.parkEdge} />
                  </>
                )}
              </g>
            );
          }),
        )}

        {/* --------------------------------------------------------- roads */}
        {/* Casing first, carriageway over it — one pass each, so junctions
            join cleanly instead of every road cutting a notch in its
            neighbours. */}
        {state.segments.map((seg) => {
          const [ax, ay] = nodeXY(seg.a);
          const [bx, by] = nodeXY(seg.b);
          const major = seg.a.split("-")[0] === seg.b.split("-")[0];
          const w = major ? ROAD_W : MINOR_ROAD_W;
          return (
            <line
              key={`casing-${seg.id}`}
              x1={ax}
              y1={ay}
              x2={bx}
              y2={by}
              stroke={major ? MAP.roadCasing : MAP.roadMinorCasing}
              strokeWidth={w + 3}
              strokeLinecap="round"
            />
          );
        })}
        {state.segments.map((seg) => {
          const [ax, ay] = nodeXY(seg.a);
          const [bx, by] = nodeXY(seg.b);
          const major = seg.a.split("-")[0] === seg.b.split("-")[0];
          return (
            <line
              key={`road-${seg.id}`}
              x1={ax}
              y1={ay}
              x2={bx}
              y2={by}
              stroke={MAP.road}
              strokeWidth={major ? ROAD_W : MINOR_ROAD_W}
              strokeLinecap="round"
            />
          );
        })}

        {/* Live traffic, as a band down the carriageway — and only where there
            is something to say. Colouring every road including the empty ones
            turns the map back into the coloured-lines diagram it was: the eye
            has nowhere to go, and the streets underneath disappear. Roads that
            are flowing are simply left as roads. */}
        {layers.traffic &&
          state.segments
            .filter((seg) => seg.occupancy >= 0.35)
            .map((seg) => {
              const [ax, ay] = nodeXY(seg.a);
              const [bx, by] = nodeXY(seg.b);
              return (
                <line
                  key={`flow-${seg.id}`}
                  x1={ax}
                  y1={ay}
                  x2={bx}
                  y2={by}
                  stroke={trafficColor(seg.occupancy)}
                  strokeWidth={6}
                  strokeLinecap="round"
                  opacity={0.85}
                />
              );
            })}

        {/* Selection, the corridor, and the two incident states. Ground truth
            and belief stay separate marks, because a missed or fabricated
            detection has to be visible on the map rather than only in a
            metric. */}
        {state.segments.map((seg) => {
          const [ax, ay] = nodeXY(seg.a);
          const [bx, by] = nodeXY(seg.b);
          const isSelected = selectedSegment === seg.id;
          return (
            <g key={`state-${seg.id}`} onClick={() => onSelectSegment(seg.id)} className="segment-group">
              {isSelected && (
                <line x1={ax} y1={ay} x2={bx} y2={by} stroke={MAP.selection} strokeWidth={ROAD_W + 8} strokeLinecap="round" opacity={0.2} />
              )}
              {corridorSegments.has(seg.id) && (
                <line x1={ax} y1={ay} x2={bx} y2={by} stroke={MAP.corridor} strokeWidth={7} strokeDasharray="3 9" strokeLinecap="round" className="corridor-pulse" />
              )}
              {layers.incidents && seg.hazard_active && (
                <line x1={ax} y1={ay} x2={bx} y2={by} stroke={MAP.incident} strokeWidth={9} strokeDasharray="6 7" strokeLinecap="round" className="incident-pulse" />
              )}
              {layers.incidents && seg.confirmed_incident && (
                <line x1={ax} y1={ay} x2={bx} y2={by} stroke={seg.hazard_active ? "#8c2f2a" : MAP.suspect} strokeWidth={3} strokeDasharray="2 7" strokeLinecap="round" />
              )}
              <line x1={ax} y1={ay} x2={bx} y2={by} stroke="transparent" strokeWidth={ROAD_W + 6} style={{ cursor: "pointer" }}>
                <title>
                  {roadName(seg.id)} — traffic {trafficWord(seg.occupancy)} ({Math.round(seg.occupancy * 100)}% full)
                  {seg.hazard_active ? ` · ${seg.hazard_type.replace(/_/g, " ")} on the carriageway` : ""}
                  {seg.confirmed_incident ? " · the network has confirmed an incident here" : ""}
                </title>
              </line>
            </g>
          );
        })}

        {/* ------------------------------------------------ street names */}
        {layers.labels && (
          <g className="map-labels" aria-hidden="true">
            {/* Avenue names run up the first block band; cross names run
                across a band two blocks in. Putting both through the middle of
                the map, which is the obvious thing to do, lands every vertical
                label on top of a horizontal one — and on top of the district
                name as well. Different bands, no collisions, any grid size. */}
            {Array.from({ length: size }).map((_, x) => {
              const [lx] = nodeXY(`${x}-0`);
              const ly = PAD + LABEL_ROW * CELL;
              return (
                <text key={`ave-${x}`} x={lx} y={ly} transform={`rotate(-90 ${lx} ${ly})`} className="street-label">
                  {avenueName(x)}
                </text>
              );
            })}
            {Array.from({ length: size }).map((_, y) => {
              const [, ly] = nodeXY(`0-${y}`);
              return (
                <text key={`cross-${y}`} x={PAD + LABEL_COLUMN * CELL} y={ly} className="street-label">
                  {crossName(y)}
                </text>
              );
            })}
            {/* District names, set in the middle of a block rather than on a
                junction, so they do not land on top of a street name. */}
            {districtLabels(size).map((d) => (
              <text key={d.label} x={d.x} y={d.y} className="district-label">
                {d.label}
              </text>
            ))}
          </g>
        )}

        {/* ------------------------------------------------------- radio */}
        {liveRadio.map((t) => {
          const from = state.rsus.find((r) => r.id === t.sender_id)?.node ??
            state.vehicles.find((v) => v.id === t.sender_id)?.node ??
            (t.sender_id.startsWith("light-") ? t.sender_id.slice(6) : null);
          if (!from || !state.segments.some((s) => s.a === from || s.b === from)) return null;
          const [x, y] = nodeXY(from);
          return <circle key={`${t.id}-${t.tick}`} cx={x} cy={y} r={34} fill="none" stroke={MAP.selection} strokeWidth={1.6} opacity={0.4} />;
        })}

        {/* ---------------------------------------------- infrastructure */}
        {layers.infrastructure &&
          state.rsus.map((rsu) => {
            const [x, y] = nodeXY(rsu.node);
            const color = rsu.alive ? MAP.selection : MAP.incident;
            return (
              <g key={rsu.id} transform={`translate(${x}, ${y})`} filter="url(#pinShadow)">
                <rect x={-11} y={-11} width={22} height={22} rx={7} fill="#FFFFFF" stroke={color} strokeWidth={1.8} />
                <circle cx={0} cy={2} r={2} fill={color} />
                <path d="M -5 -1 A 7 7 0 0 1 5 -1" stroke={color} strokeWidth={1.6} fill="none" />
                {rsu.alive && <path d="M -8 -4 A 11 11 0 0 1 8 -4" stroke={color} strokeWidth={1.4} fill="none" opacity={0.6} />}
                <title>
                  {rsu.id} at {junctionName(rsu.node)} — {rsu.alive ? "online" : "OFFLINE"}
                </title>
              </g>
            );
          })}

        {layers.infrastructure &&
          state.traffic_lights.map((light) => {
            const [x, y] = nodeXY(light.node);
            return (
              <g key={light.id} transform={`translate(${x + 19}, ${y - 19})`}>
                <circle r={5.5} fill="#FFFFFF" stroke={MAP.blockEdge} strokeWidth={1} />
                <circle r={3.2} fill={light.phase === "green" ? MAP.flowing : MAP.incident} />
                {light.preempted && <circle r={9} fill="none" stroke={MAP.corridor} strokeWidth={1.6} className="corridor-pulse" />}
                <title>
                  Signal at {junctionName(light.node)} — {light.phase}
                  {light.preempted ? ", held green for an emergency vehicle" : ""}
                </title>
              </g>
            );
          })}

        {/* ----------------------------------------------------- vehicles */}
        {state.vehicles.map((v) => (
          <VehicleIcon
            key={v.id}
            v={v}
            justRerouted={justRerouted.has(v.id)}
            selected={v.id === selectedVehicle}
            onSelect={onSelectVehicle}
          />
        ))}

        {/* --------------------------------------------------- pedestrians */}
        {(state.pedestrians ?? []).map((ped) => {
          const [a, b] = ped.segment_id.split("_");
          const far = a === ped.node ? b : a;
          const [nx, ny] = nodeXY(ped.node);
          const [fx, fy] = nodeXY(far);
          const x = nx + (fx - nx) * 0.3;
          const y = ny + (fy - ny) * 0.3;
          return (
            <g key={ped.id} transform={`translate(${x} ${y})`}>
              <circle r={11} fill={MAP.slow} opacity={0.3} className="incident-pulse" />
              {ped.known_by.length > 0 && (
                <circle r={15} fill="none" stroke={MAP.slow} strokeWidth={1.4} strokeDasharray="2 3" />
              )}
              <circle r={4} fill="#FFFFFF" stroke={MAP.label} strokeWidth={1.4} />
              <title>
                Someone crossing {roadName(ped.segment_id)} — {ped.seen_by.length} can see them,{" "}
                {ped.known_by.length} were told by radio
              </title>
            </g>
          );
        })}

        {/* Incident markers last, so nothing is drawn over them. */}
        {layers.incidents &&
          (state.dossiers ?? []).map((d) => {
            const [a, b] = d.segment_id.split("_");
            const [ax, ay] = nodeXY(a);
            const [bx, by] = nodeXY(b);
            const isFalse = d.verdict === "confirmed-false";
            return (
              <g
                key={d.segment_id}
                transform={`translate(${(ax + bx) / 2} ${(ay + by) / 2})`}
                className="incident-pin"
                onClick={() => onSelectSegment(d.segment_id)}
                style={{ cursor: "pointer" }}
                filter="url(#pinShadow)"
              >
                <path
                  d="M 0 4 C -9 -4 -12 -9 -12 -14 A 12 12 0 1 1 12 -14 C 12 -9 9 -4 0 4 Z"
                  fill={isFalse ? MAP.suspect : d.ground_truth ? MAP.incident : MAP.slow}
                  stroke="#FFFFFF"
                  strokeWidth={2}
                />
                <text x={0} y={-10} textAnchor="middle" className="pin-glyph">
                  {isFalse ? "?" : "!"}
                </text>
                <title>
                  {d.road} — {d.verdict_text}
                </title>
              </g>
            );
          })}
      </svg>

      {/* ------------------------------------------------------ controls */}
      <div className="map-zoom" role="group" aria-label="Zoom">
        <button onClick={() => zoomBy(1.6)} aria-label="Zoom in">
          +
        </button>
        <button onClick={() => zoomBy(1 / 1.6)} aria-label="Zoom out">
          −
        </button>
        <button
          onClick={() => setView({ cx: width / 2, cy: height / 2, k: 1 })}
          aria-label="Fit the whole city"
          title="Fit the whole city"
        >
          ⤢
        </button>
      </div>
      {selectedVehicle && (
        <button
          className={follow ? "map-follow on" : "map-follow"}
          onClick={() => {
            setFollow((f) => !f);
            if (!follow) setView((v) => clampView({ ...v, k: Math.max(v.k, 2.2) }, width, height));
          }}
          aria-pressed={follow}
        >
          {follow ? `◎ Following ${selectedVehicle}` : `◎ Follow ${selectedVehicle}`}
        </button>
      )}
      {/* Always say what the map can do. Saying nothing until the user has
          already discovered zooming is the wrong way round — not knowing you
          could scroll to zoom is exactly what made it feel like it did not. */}
      <span className="map-zoom-hint">
        {view.k > MIN_ZOOM
          ? `${view.k.toFixed(1)}× · ${follow ? "following" : "drag to pan"}`
          : "scroll to zoom · double-click to zoom in"}
      </span>

      {alert && alertAnchor?.visible && (
        <MapAlert
          alert={alert}
          left={alertAnchor.left}
          top={alertAnchor.top}
          state={state}
          onDismiss={() => setDismissed(alertKey(alert))}
          onExplain={() => {
            onSelectSegment(alert.where);
            goTo(alert.where, Math.max(view.k, 2));
          }}
        />
      )}
      {alert && alertAnchor && !alertAnchor.visible && (
        <button className="map-alert-offscreen" onClick={() => goTo(alert.where, Math.max(view.k, 2))}>
          {alert.title} — off screen, go there →
        </button>
      )}
    </div>
  );
}

/** Identifies one alert, so dismissing it hides that event and not the next. */
function alertKey(a: MapAlertContent): string {
  return `${a.tick}|${a.kind}|${a.where}`;
}

/**
 * The most recent thing worth interrupting someone about.
 *
 * Read out of the engine's own event log rather than re-derived from state:
 * the engine has already decided what is worth saying, and a second copy of
 * that judgement here would be a second thing to keep in step.
 */
function newestIncident(state: SimulationState): MapAlertContent | null {
  const interesting: Record<string, MapAlertContent["kind"]> = {
    collision: "collision",
    hazard: "hazard",
    malicious_spawned: "attack",
    cloud_outage: "outage",
    rsu_fault: "rsu",
    pedestrian: "pedestrian",
  };

  // `events` arrives newest first. The place comes from the engine, which
  // knows exactly where each event happened — recovering it by matching
  // street names out of the message anchored half the alerts to an unrelated
  // road, and then showed that road's dossier as if it were the incident's.
  const event = state.events.find((e) => e.type in interesting && e.where);
  if (!event?.where) return null;

  const titles: Record<MapAlertContent["kind"], string> = {
    collision: "Crash",
    hazard: "Hazard on the road",
    attack: "Someone is lying to the network",
    outage: "Cloud uplink lost",
    rsu: "A roadside unit went down",
    pedestrian: "Someone is crossing",
  };
  const kind = interesting[event.type];
  return { where: event.where, kind, title: titles[kind], body: event.message, tick: event.tick };
}

/**
 * Where each district's name goes.
 *
 * Snapped to the middle of a block, never to a junction. Taking the mean of
 * the district's nodes and nudging it half a cell puts it back on a road
 * whenever the district spans an even number of columns — which is how "CITY
 * CENTRE" ended up printed across "4th Cross".
 */
function districtLabels(size: number): { label: string; x: number; y: number }[] {
  const groups = new Map<string, { xs: number[]; ys: number[] }>();
  for (let x = 0; x < size; x++)
    for (let y = 0; y < size; y++) {
      const use = landUseOf(`${x}-${y}`, size);
      if (use === "residential") continue;
      if (!groups.has(use)) groups.set(use, { xs: [], ys: [] });
      const g = groups.get(use)!;
      g.xs.push(x);
      g.ys.push(y);
    }
  const mean = (xs: number[]) => xs.reduce((s, n) => s + n, 0) / xs.length;
  /** Centre of the block whose top-left corner is the nearest junction. */
  const blockCentre = (v: number) => PAD + (Math.min(size - 2, Math.floor(v)) + 0.5) * CELL;

  return [...groups.entries()].map(([use, g]) => ({
    label: LAND_USE_LABEL[use as keyof typeof LAND_USE_LABEL].toUpperCase(),
    x: blockCentre(mean(g.xs)),
    y: blockCentre(mean(g.ys)),
  }));
}

function VehicleIcon({
  v,
  justRerouted,
  selected,
  onSelect,
}: {
  v: VehicleState;
  justRerouted: boolean;
  selected?: boolean;
  onSelect?: (id: string | null) => void;
}) {
  const px = PAD + v.x * CELL;
  const py = PAD + v.y * CELL;
  const heading = headingDegrees(v.node, v.next_node);
  const isAmbulance = v.kind === "ambulance";
  const color = v.crashed
    ? MAP.wreck
    : isAmbulance
      ? MAP.ambulance
      : v.kind === "malicious"
        ? MAP.attacker
        : MAP.vehicle;

  return (
    <g
      style={{
        transform: `translate(${px}px, ${py}px)`,
        transition: "transform 0.75s linear",
        cursor: onSelect ? "pointer" : undefined,
      }}
      onClick={onSelect ? () => onSelect(selected ? null : v.id) : undefined}
    >
      {/* The icon is small on a large cell; without a hit area a click mostly
          lands on the road underneath it. */}
      <circle r={13} fill="transparent" />
      {selected && <circle r={14} fill="none" stroke={MAP.selection} strokeWidth={2.5} />}
      {justRerouted && <circle r={15} fill="none" stroke={MAP.flowing} strokeWidth={2} className="reroute-ping" />}
      {v.crashed && <circle r={13} fill={MAP.incident} opacity={0.3} className="incident-pulse" />}
      {v.yielding && <circle r={13} fill={MAP.corridor} opacity={0.28} />}
      {v.trust_hint < 0.35 && !v.crashed && (
        <circle r={13} fill={MAP.suspect} opacity={0.3} className="incident-pulse" />
      )}
      <g
        style={{ transform: `rotate(${heading}deg)`, transition: "transform 0.75s linear" }}
        filter="url(#pinShadow)"
      >
        <rect
          x={-10}
          y={-5.5}
          width={20}
          height={11}
          rx={3.5}
          fill={color}
          stroke="#FFFFFF"
          strokeWidth={1.8}
          opacity={v.parked ? 0.5 : 1}
          transform={v.crashed ? "rotate(30)" : undefined}
        />
        {/* A nose flash, so which way it is pointing reads at a glance. */}
        {!v.crashed && <rect x={5} y={-3.5} width={3.5} height={7} rx={1.4} fill="#FFFFFF" opacity={0.8} />}
        {isAmbulance && !v.crashed && (
          <>
            <rect x={-1.2} y={-3.4} width={2.4} height={6.8} fill="#FFFFFF" />
            <rect x={-3.4} y={-1.2} width={6.8} height={2.4} fill="#FFFFFF" />
          </>
        )}
      </g>
      <title>
        {v.id} · {v.kind}
        {v.crashed
          ? " · wrecked, waiting for recovery"
          : v.parked
            ? " · parked at the end of a trip"
            : ` · ${v.trip_purpose || "on a trip"}, for ${junctionName(v.destination)}`}
        {" · "}trust {v.trust_hint.toFixed(2)} · {v.reroute_count} diversion
        {v.reroute_count === 1 ? "" : "s"}
      </title>
    </g>
  );
}
