/**
 * Cartography, shared by the two maps.
 *
 * The city used to be drawn as what it is internally — a graph of nodes and
 * edges on a dark field. That is honest about the data structure and useless
 * as a picture: nothing says "this is a city", roads have no names, and a
 * viewer has to be told what every mark means before they can read any of it.
 *
 * So it is drawn as a map instead, in the visual language everybody already
 * knows from the one in their pocket: pale land, white roads with a casing,
 * green for parks, labelled streets, traffic as a coloured overlay rather than
 * as the road colour itself. None of the underlying model changed. What
 * changed is that the picture now uses conventions the viewer brings with
 * them, so there is less to explain before anything can be understood.
 *
 * It stays light in a dark application on purpose — a map reads as a map, and
 * legibility was the whole complaint.
 */

export const MAP = {
  /** Ground, and the blocks standing on it. */
  land: "#EFEBE2",
  landEdge: "#E2DDD2",
  block: "#E1DCD0",
  blockEdge: "#D2CBBC",
  park: "#CFE3C1",
  parkEdge: "#BBD4AC",
  water: "#A9D4EA",

  /** Roads: a white carriageway on a grey casing, as every road map does it. */
  roadCasing: "#CFC7B7",
  road: "#FFFFFF",
  roadMinorCasing: "#D6CFC1",

  /** Type. A halo keeps a label readable wherever it falls. */
  label: "#4B463E",
  labelMuted: "#7C756A",
  labelHalo: "#F6F4EF",
  district: "#8D8578",

  /** Live traffic, drawn beside the road rather than instead of it, so the
   *  street stays legible underneath — the same trick the navigation apps use. */
  flowing: "#34A853",
  slow: "#F2B33D",
  heavy: "#EC7B39",
  jammed: "#D64541",

  /** Anything wrong, and anything selected. */
  incident: "#D6453D",
  suspect: "#9B59D0",
  selection: "#1F6FEB",
  corridor: "#2E9BD6",

  vehicle: "#3D4A5C",
  ambulance: "#E14B4B",
  attacker: "#9B59D0",
  wreck: "#8A7F7A",
} as const;

/**
 * Live traffic colour for an occupancy in 0..1.
 *
 * `FREE_FLOWING` is the threshold below which the traffic layer draws nothing
 * at all. Colouring every road including the empty ones is what turned the
 * map back into a diagram of coloured lines: the eye has nowhere to go and
 * the streets vanish underneath. A road that is flowing is just a road.
 */
export const FREE_FLOWING = 0.35;

export function trafficColor(occupancy: number): string {
  if (occupancy < FREE_FLOWING) return MAP.flowing;
  if (occupancy < 0.6) return MAP.slow;
  if (occupancy < 0.82) return MAP.heavy;
  return MAP.jammed;
}

export function trafficWord(occupancy: number): string {
  if (occupancy < 0.35) return "flowing";
  if (occupancy < 0.6) return "slowing";
  if (occupancy < 0.82) return "heavy";
  return "at a standstill";
}

/**
 * A viewport over the map, in world units.
 *
 * Zoom and pan are what make a dense map usable: a city with thirty vehicles
 * on it is unreadable at one fixed scale no matter how well it is drawn, and
 * being able to go and look at the corner where something is happening is the
 * difference between a diagram and a map.
 */
export interface MapView {
  /** Centre, in world coordinates. */
  cx: number;
  cy: number;
  /** Scale. 1 fits the whole city. */
  k: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

export function clampView(view: MapView, width: number, height: number): MapView {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k));
  const halfW = width / (2 * k);
  const halfH = height / (2 * k);
  return {
    k,
    cx: Math.min(width - halfW, Math.max(halfW, view.cx)),
    cy: Math.min(height - halfH, Math.max(halfH, view.cy)),
  };
}

export function viewBoxOf(view: MapView, width: number, height: number): string {
  const w = width / view.k;
  const h = height / view.k;
  return `${view.cx - w / 2} ${view.cy - h / 2} ${w} ${h}`;
}

/** Where a world point falls inside the drawn box, as a 0..1 fraction — which
 *  is what an HTML overlay needs in order to sit on top of the right place. */
export function screenFraction(
  view: MapView,
  width: number,
  height: number,
  wx: number,
  wy: number,
): { left: number; top: number; visible: boolean } {
  const w = width / view.k;
  const h = height / view.k;
  const left = (wx - (view.cx - w / 2)) / w;
  const top = (wy - (view.cy - h / 2)) / h;
  return { left, top, visible: left >= -0.05 && left <= 1.05 && top >= -0.05 && top <= 1.05 };
}

/** Which overlays are drawn. Every one of them is something a viewer might
 *  reasonably want out of the way while they look at something else. */
export interface MapLayers {
  traffic: boolean;
  incidents: boolean;
  radio: boolean;
  labels: boolean;
  infrastructure: boolean;
}

export const DEFAULT_LAYERS: MapLayers = {
  traffic: true,
  incidents: true,
  radio: false,
  labels: true,
  infrastructure: true,
};

export const LAYER_LABELS: { key: keyof MapLayers; label: string; hint: string }[] = [
  { key: "traffic", label: "Traffic", hint: "How busy each road is, right now" },
  { key: "incidents", label: "Incidents", hint: "Crashes, hazards and what the network believes" },
  { key: "radio", label: "Radio", hint: "Every frame going out, and who decoded it" },
  { key: "infrastructure", label: "Roadside units", hint: "Radio units and signalised junctions" },
  { key: "labels", label: "Street names", hint: "Road and district names" },
];
