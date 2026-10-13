/**
 * What one vehicle knows, assembled for a driver's display.
 *
 * Every field here is read from simulation state that already existed; none
 * of it is generated for the display. That is the point of the view: if the
 * HUD says a cyclist is ahead, it is because this vehicle's `seenVrus` or
 * `toldVrus` says so, and if it says the road ahead is blocked it is because
 * a DENM it received and believed says so. A dashboard that invented its own
 * alerts would be a screensaver.
 *
 * The consequence worth noticing while demonstrating: select an unequipped
 * road user and almost every alert disappears. A bicycle has no receiver, so
 * it gets no warnings about anything. The empty display is the honest one.
 */
import { VEHICLE_PROFILES, isEmergency } from "./agents";
import type { Vehicle, VehicleKind } from "./agents";
import { junctionName, roadName } from "./core";
import type { CityGrid } from "./core";

export type AlertPriority = "critical" | "warning" | "info";

export interface PovAlert {
  /** Stable across ticks for the same cause, so the display can keep one
   *  alert on screen rather than restarting it every tick. */
  id: string;
  /** Machine name. The help panel keys its explanations off this. */
  kind: string;
  priority: AlertPriority;
  title: string;
  detail: string;
  /** What to do about it, where there is something to do. */
  advice?: string;
  /** Where it applies, for the map to highlight. */
  where?: string | null;
}

export interface PovStep {
  instruction: string;
  road: string;
  junction: string;
  distanceM: number;
}

export interface PovNeighbour {
  id: string;
  label: string;
  kind: string;
  /** "ahead", "behind", "same road", "crossing" — in words, because a bearing
   *  in degrees is not what a driver reads. */
  relation: string;
  distanceM: number;
  vulnerable: boolean;
  equipped: boolean;
}

export interface PovState {
  vehicleId: string;
  kind: VehicleKind;
  label: string;
  equipped: boolean;
  vulnerable: boolean;
  speedKmh: number;
  speedLimitKmh: number;
  /** Advisory below the posted limit — a school zone, or GLOSA. */
  advisoryKmh: number | null;
  road: string;
  roadOccupancy: number;
  destination: string;
  tripPurpose: string;
  distanceToDestinationM: number;
  etaTicks: number | null;
  steps: PovStep[];
  signal: { junction: string; phase: "green" | "red"; distanceM: number } | null;
  neighbours: PovNeighbour[];
  alerts: PovAlert[];
  parked: boolean;
  crashed: boolean;
}

/** Roughly how far along the current road the vehicle still has to go. */
const remainingOnSegment = (v: Vehicle, lengthM: number) => Math.max(0, (1 - v.progress) * lengthM);

/** Land uses where a lower speed is advised. The city already knows what each
 *  junction is for, so a school zone does not need inventing — it is the
 *  civic quarter, which is where the schools are. */
const SCHOOL_ZONE_ADVISORY_KMH = 25;

function turnWords(grid: CityGrid, from: string, via: string, to: string): string {
  const [ax, ay] = grid.coords(from);
  const [bx, by] = grid.coords(via);
  const [cx, cy] = grid.coords(to);
  const inbound = [bx - ax, by - ay];
  const outbound = [cx - bx, cy - by];
  // Sign of the 2-D cross product: positive is one way round, negative the
  // other. Screen y grows downward, which is why left and right read swapped
  // against the usual maths convention.
  const cross = inbound[0] * outbound[1] - inbound[1] * outbound[0];
  const dot = inbound[0] * outbound[0] + inbound[1] * outbound[1];
  if (Math.abs(cross) < 1e-9) return dot < 0 ? "Turn around" : "Continue straight";
  return cross > 0 ? "Turn right" : "Turn left";
}

export function buildPov(
  vehicle: Vehicle,
  grid: CityGrid,
  tick: number,
  all: Iterable<Vehicle>,
  signalPhase: (node: string) => "green" | "red" | null,
): PovState {
  const profile = VEHICLE_PROFILES[vehicle.kind];
  const segId = vehicle.currentSegmentId;
  const seg = segId ? grid.segments.get(segId) : undefined;
  const lengthM = seg?.lengthM ?? 250;
  const aheadM = remainingOnSegment(vehicle, lengthM);

  // --- route, as turn-by-turn ------------------------------------------
  const steps: PovStep[] = [];
  let cumulative = aheadM;
  for (let i = 1; i < vehicle.route.length - 1 && steps.length < 6; i++) {
    const from = vehicle.route[i - 1];
    const via = vehicle.route[i];
    const to = vehicle.route[i + 1];
    const legId = grid.segmentBetween(via, to).id;
    steps.push({
      instruction: turnWords(grid, from, via, to),
      road: roadName(legId),
      junction: junctionName(via),
      distanceM: Math.round(cumulative),
    });
    cumulative += grid.segmentBetween(via, to).lengthM;
  }
  const distanceToDestinationM = Math.round(
    vehicle.route.length >= 2
      ? aheadM +
          vehicle.route
            .slice(1, -1)
            .reduce((sum, node, i) => sum + grid.segmentBetween(node, vehicle.route[i + 2]).lengthM, 0)
      : 0,
  );

  // --- neighbours -------------------------------------------------------
  const [vx, vy] = vehicle.positionXY();
  const neighbours: PovNeighbour[] = [];
  for (const other of all) {
    if (other.id === vehicle.id) continue;
    const [ox, oy] = other.positionXY();
    // Grid coordinates are in cells; one cell is one block.
    const metres = Math.hypot(ox - vx, oy - vy) * lengthM;
    if (metres > lengthM * 1.2) continue;
    const sameRoad = other.currentSegmentId === segId;
    const relation = sameRoad
      ? other.progress > vehicle.progress
        ? "ahead"
        : "behind"
      : other.node === vehicle.nextNode
        ? "at the junction"
        : "crossing";
    neighbours.push({
      id: other.id,
      label: VEHICLE_PROFILES[other.kind].label,
      kind: other.kind,
      relation,
      distanceM: Math.round(metres),
      vulnerable: other.vulnerable,
      equipped: other.equipped,
    });
  }
  neighbours.sort((a, b) => a.distanceM - b.distanceM);

  // --- signal ahead -----------------------------------------------------
  const nextNode = vehicle.nextNode;
  const phase = nextNode ? signalPhase(nextNode) : null;
  const signal =
    nextNode && phase
      ? { junction: junctionName(nextNode), phase, distanceM: Math.round(aheadM) }
      : null;

  // --- advisory speed ---------------------------------------------------
  const schoolZone = nextNode ? grid.landUse(nextNode) === "civic" : false;
  const advisories: number[] = [];
  if (vehicle.glosaAdvice !== null) advisories.push(vehicle.glosaAdvice);
  if (schoolZone) advisories.push(SCHOOL_ZONE_ADVISORY_KMH);
  const advisoryKmh = advisories.length ? Math.min(...advisories) : null;

  const alerts: PovAlert[] = [];
  const add = (a: PovAlert) => alerts.push(a);

  // An unequipped road user receives nothing. Everything below this point
  // arrived over the air, so for a bicycle the list is simply empty — which
  // is the most informative thing the display can show about it.
  if (vehicle.equipped) {
    if (vehicle.brakingTicks > 0)
      add({
        id: "eebl",
        kind: "emergency_brake",
        priority: "critical",
        title: "Emergency braking",
        detail: "You are braking hard. The vehicles behind are being told over the air right now.",
        where: segId,
      });

    const braking = neighbours.find((n) => n.relation === "ahead" && n.distanceM < lengthM * 0.45);
    const aheadBraking = [...all].find(
      (o) => o.id === braking?.id && o.brakingTicks > 0 && o.currentSegmentId === segId,
    );
    if (aheadBraking)
      add({
        id: `fcw-${aheadBraking.id}`,
        kind: "forward_collision",
        priority: "critical",
        title: "Vehicle braking ahead",
        detail: `${VEHICLE_PROFILES[aheadBraking.kind].label} ${aheadBraking.id} is braking hard ${braking?.distanceM} m ahead.`,
        advice: "Slow down now — you were told before you could see it.",
        where: segId,
      });

    if (vehicle.crashed)
      add({
        id: "wreck",
        kind: "collision",
        priority: "critical",
        title: "You have been in a collision",
        detail: `Immobile and blocking the lane. Recovery arrives in ${vehicle.recoveryTicks} ticks.`,
        where: segId,
      });

    if (vehicle.yieldInstruction)
      add({
        id: "corridor",
        kind: "emergency_vehicle",
        priority: "critical",
        title: "Emergency vehicle approaching",
        detail: "A green corridor has been opened through your road.",
        advice: "Give way — signals ahead are being held green for it.",
        where: segId,
      });

    if (segId && vehicle.knowsVruOn(segId, tick))
      add({
        id: "vru",
        kind: "vulnerable_road_user",
        priority: "warning",
        title: "Cyclist in your lane",
        detail:
          "An unprotected road user is on this road. They carry no on-board unit, so this came from another vehicle's sensors, not from them.",
        advice: "Slow and leave room.",
        where: segId,
      });

    if (segId && vehicle.knowsPedestrianOn(segId, tick))
      add({
        id: "ped",
        kind: "pedestrian",
        priority: "warning",
        title: "Pedestrian on the carriageway",
        detail: vehicle.pedestrianKnownOnlyFromPeers(segId, tick)
          ? "Shared by a vehicle that can see them. You cannot — the corner is in the way."
          : "In your line of sight ahead.",
        advice: "Be ready to stop.",
        where: segId,
      });

    for (const [warnedSeg, heard] of vehicle.hazardWarnings) {
      if (tick - heard > 20) continue;
      add({
        id: `hazard-${warnedSeg}`,
        kind: "hazard_ahead",
        priority: warnedSeg === segId ? "critical" : "warning",
        title: warnedSeg === segId ? "Hazard on this road" : "Hazard ahead",
        detail: `Reported on ${roadName(warnedSeg)} and corroborated by the network.`,
        advice: warnedSeg === segId ? "Slow down." : "A diversion around it is available.",
        where: warnedSeg,
      });
    }

    if (seg && seg.hazardActive)
      add({
        id: "weather",
        kind: "road_condition",
        priority: "warning",
        title: `Road condition: ${seg.hazardType.replace(/_/g, " ")}`,
        detail: "Grip or visibility is reduced on this stretch.",
        advice: "Reduce speed and increase following distance.",
        where: segId,
      });

    if (signal && signal.phase === "red")
      add({
        id: "spat",
        kind: "signal_phase",
        priority: "info",
        title: `Red at ${signal.junction}`,
        detail:
          vehicle.glosaAdvice !== null
            ? `Hold ${Math.round(vehicle.glosaAdvice)} km/h and you arrive on green instead of stopping.`
            : `${signal.distanceM} m ahead.`,
        where: segId,
      });

    if (seg && seg.occupancy > 0.6)
      add({
        id: "congestion",
        kind: "congestion",
        priority: "info",
        title: "Congestion on this road",
        detail: `Occupancy ${(seg.occupancy * 100).toFixed(0)}% of jam density. Your speed is being held down by the traffic, not by the limit.`,
        where: segId,
      });

    if (schoolZone)
      add({
        id: "school",
        kind: "school_zone",
        priority: "info",
        title: "Civic quarter ahead",
        detail: `Advisory ${SCHOOL_ZONE_ADVISORY_KMH} km/h through the crossings.`,
        where: segId,
      });

    // `seg` is undefined for a vehicle parked at the end of its route: it is
    // on a junction, not on a road, so there is no posted limit to be over.
    if (seg && vehicle.lastSpeedKmh > seg.speedLimitKmh + 1)
      add({
        id: "speeding",
        kind: "speed_limit",
        priority: "warning",
        title: "Over the posted limit",
        detail: `${Math.round(vehicle.lastSpeedKmh)} km/h in a ${seg.speedLimitKmh} zone.`,
        where: segId,
      });
  }

  if (isEmergency(vehicle.kind))
    add({
      id: "priority",
      kind: "priority_run",
      priority: "info",
      title: "Priority run",
      detail: "Signals ahead are being preempted for you and other traffic is told to yield.",
      where: segId,
    });

  const rank: Record<AlertPriority, number> = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => rank[a.priority] - rank[b.priority]);

  return {
    vehicleId: vehicle.id,
    kind: vehicle.kind,
    label: profile.label,
    equipped: vehicle.equipped,
    vulnerable: vehicle.vulnerable,
    speedKmh: Math.round(vehicle.lastSpeedKmh),
    speedLimitKmh: seg?.speedLimitKmh ?? 45,
    advisoryKmh: advisoryKmh === null ? null : Math.round(advisoryKmh),
    road: segId ? roadName(segId) : "—",
    roadOccupancy: seg?.occupancy ?? 0,
    destination: junctionName(vehicle.destination),
    tripPurpose: vehicle.tripPurpose,
    distanceToDestinationM,
    etaTicks:
      vehicle.lastSpeedKmh > 0.5
        ? Math.round(distanceToDestinationM / ((vehicle.lastSpeedKmh * 1000) / 3600))
        : null,
    steps,
    signal,
    neighbours: neighbours.slice(0, 6),
    alerts,
    parked: vehicle.dwellTicks > 0,
    crashed: vehicle.crashed,
  };
}
