import { useState } from "react";

import { ExplainPanel } from "../components/ExplainPanel";
import { Narration } from "../components/Narration";
import { StreetMap } from "../components/StreetMap";
import { Toaster } from "../components/Toaster";
import { useToaster } from "../components/useToaster";
import { SPEEDS, demo, useDemo } from "../sim/demoRuntime";
import type { SimulationState } from "../types";
import { roadName } from "../sim/core";

/**
 * The simulator for someone who has never seen V2X.
 *
 * Small scene, few vehicles, nothing happening until you make it happen, and
 * the radio drawn on screen. You can pause and step a single tick, which is
 * the only way to actually watch a hazard travel from the car that saw it to
 * the cars that needed to know.
 */
export function StreetView() {
  const { state, playing, speedIndex } = useDemo();
  const [selectedVehicle, setSelectedVehicle] = useState<string | null>(null);
  const [selectedSegment, setSelectedSegment] = useState<string | null>(null);
  const { toasts, push, dismiss } = useToaster();

  if (!state) return <div className="loading">Starting the simulator…</div>;

  const onHazard = () => {
    const id = demo.injectHazard(selectedSegment ?? undefined);
    if (!id) {
      push("Every road here already has a hazard on it.", "warn");
      return;
    }
    setSelectedSegment(id);
    push(
      `Crash on ${road(id)}. Step forward and watch a car notice it, then tell the others.`,
      "warn",
    );
    if (!playing) demo.stepOnce();
  };

  const onAmbulance = () => {
    const id = demo.spawnAmbulance();
    push(`${id} dispatched. It will ask each junction ahead for a green light.`, "good");
  };

  const onAttacker = () => {
    const id = demo.spawnAttacker();
    push(`${id} joined and will start lying about roads that are clear.`, "bad");
  };

  const onCloud = () => {
    const online = !state.cloud_online;
    demo.setCloud(online);
    push(
      online ? "Cloud back online." : "Cloud cut off. Notice the cars carry on without it.",
      online ? "good" : "warn",
    );
  };

  const onPedestrian = () => {
    const segmentId = demo.spawnPedestrian();
    if (!segmentId) {
      push("No crossing available right now — step a tick and try again.", "warn");
      return;
    }
    setSelectedSegment(segmentId);
    push(
      `Someone stepped onto ${road(segmentId)}. The car that can see them brakes and tells the ` +
        `cars behind and around it — watch who gets warned without ever seeing them.`,
      "warn",
    );
    if (!playing) demo.stepOnce();
  };

  const vehicle = state.vehicles.find((v) => v.id === selectedVehicle) ?? null;
  const perception = state.perception;
  const glosaCar = state.vehicles.find((v) => v.glosa_advice != null) ?? null;

  return (
    <div className="stack street-view">
      <div className="page-head">
        <div>
          <h1>Street view</h1>
          <p className="muted">
            Six vehicles on four blocks, slowed down so you can follow them. Every ring is a real
            radio broadcast and every dotted line is a station that actually decoded it — frames
            that were lost on the air simply have no line.
          </p>
        </div>
      </div>

      {/* ------------------------------------------------------ transport */}
      <section className="panel transport">
        <div className="transport-main">
          <button className="btn primary" onClick={() => (playing ? demo.pause() : demo.play())}>
            {playing ? "⏸ Pause" : "▶ Play"}
          </button>
          <button className="btn" onClick={() => demo.stepOnce()}>
            ⏭ Step one tick
          </button>
          <button
            className="btn"
            onClick={() => {
              demo.reset();
              setSelectedVehicle(null);
              setSelectedSegment(null);
              push("Fresh scene.", "info");
            }}
          >
            ↺ Reset
          </button>
        </div>

        <div className="transport-speed" role="group" aria-label="Speed">
          {SPEEDS.map((s, i) => (
            <button
              key={s.label}
              className={i === speedIndex ? "chip active" : "chip"}
              onClick={() => demo.setSpeed(i)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="transport-tick">
          tick <strong>{state.tick}</strong>
        </div>
      </section>

      <div className="street-body">
        <section className="panel street-panel">
          <StreetMap
            state={state}
            selectedVehicle={selectedVehicle}
            onSelectVehicle={setSelectedVehicle}
            selectedSegment={selectedSegment}
            onSelectSegment={setSelectedSegment}
          />
          <div className="street-legend">
            <span>
              <i className="key-wedge" style={{ background: "#7dd3fc" }} /> car
            </span>
            <span>
              <i className="key-wedge" style={{ background: "#f87171" }} /> ambulance
            </span>
            <span>
              <i className="key-wedge" style={{ background: "#c084fc" }} /> attacker
            </span>
            <span>
              <i className="key-ring" style={{ borderColor: "#3987e5" }} /> CAM — “here I am”
            </span>
            <span>
              <i className="key-ring" style={{ borderColor: "#e66767" }} /> DENM — “something
              happened”
            </span>
            <span>
              <i className="key-ring" style={{ borderColor: "#199e70" }} /> SPaT — signal phase
            </span>
            <span>
              <i className="key-ring" style={{ borderColor: "#f0b429" }} /> CPM — “someone is here”
            </span>
            <span>
              <i className="key-ped" /> pedestrian on a crossing
            </span>
            <span>
              <i className="key-line dashed-amber" /> confirmed incident
            </span>
          </div>
          <p className="muted small street-hint">
            Click any vehicle to see what it personally knows. Click a road to select it, then
            press <strong>Cause a crash</strong> to put the hazard exactly there.
          </p>
        </section>

        <aside className="side">
          <div className="panel">
            <h2>Make something happen</h2>
            <div className="btn-col">
              <button className="btn primary" onClick={onPedestrian}>
                🚶 Step someone into the road
              </button>
              <button onClick={onHazard}>🚧 Cause a crash</button>
              <button onClick={onAmbulance}>🚑 Send an ambulance</button>
              <button onClick={onAttacker}>😈 Add a liar</button>
              <button onClick={() => demo.spawnVehicle()}>🚗 Add a car</button>
              <button className={state.cloud_online ? "" : "danger"} onClick={onCloud}>
                {state.cloud_online ? "📵 Cut the cloud off" : "📶 Restore the cloud"}
              </button>
            </div>
            <p className="muted small">
              Nothing happens on its own here — no random hazards interrupting you mid-explanation.
            </p>
          </div>

          <ThreeThings
            perception={perception}
            glosaCar={glosaCar?.id ?? null}
            onTrigger={onPedestrian}
            onFollowGlosa={() => {
              if (glosaCar) {
                setSelectedVehicle(glosaCar.id);
                push(
                  `${glosaCar.id} is easing to ${Math.round(glosaCar.glosa_advice ?? 0)} km/h so it ` +
                    `reaches the junction as the light turns green.`,
                  "good",
                );
              } else {
                push("No car is approaching a red right now — let it run a few more ticks.", "info");
              }
            }}
          />

          {state.pedestrians.length > 0 && <PedestrianInspector state={state} />}

          {/* Why, not just what. Follows whatever is selected on the map. */}
          <ExplainPanel
            state={state}
            selectedSegment={selectedSegment}
            selectedVehicle={selectedVehicle}
            onClear={() => {
              setSelectedSegment(null);
              setSelectedVehicle(null);
            }}
          />

          <Narration state={state} />

          {vehicle ? (
            <VehicleInspector state={state} vehicleId={vehicle.id} />
          ) : (
            <div className="panel">
              <h2>Inspect a vehicle</h2>
              <p className="muted small">
                Click a car on the map. You&rsquo;ll see the identity it is broadcasting under, what
                hazards it has been told about, and how much the network trusts it.
              </p>
            </div>
          )}
        </aside>
      </div>

      <Toaster toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

const road = roadName;

/**
 * The three things a connected car does that an unconnected one cannot.
 *
 * Every number here is read live off the running simulation — nothing is
 * scripted. The middle one is the interesting one: a car acting on somebody
 * it has no way of seeing.
 */
function ThreeThings({
  perception,
  glosaCar,
  onTrigger,
  onFollowGlosa,
}: {
  perception: SimulationState["perception"];
  glosaCar: string | null;
  onTrigger: () => void;
  onFollowGlosa: () => void;
}) {
  return (
    <div className="panel three-things">
      <h2>Three things the radio does</h2>

      <div className="thing">
        <div className="thing-head">
          <span className="thing-icon">🛑</span>
          <h3>Warns the car behind, instantly</h3>
          <span className={perception.brake_warnings > 0 ? "thing-count live" : "thing-count"}>
            {perception.brake_warnings}
          </span>
        </div>
        <p className="muted small">
          A car brakes hard because someone stepped out. The cars behind are told over the air
          before any driver could notice the brake lights.
        </p>
      </div>

      <div className="thing">
        <div className="thing-head">
          <span className="thing-icon">👁</span>
          <h3>Sees round the corner</h3>
          <span className={perception.warned_blind > 0 ? "thing-count live" : "thing-count"}>
            {perception.warned_blind}
          </span>
        </div>
        <p className="muted small">
          A car turning into a street cannot see the pedestrian on it — the corner is in the way.
          Another car that <em>can</em> see them shares what its sensors report, and the turning car
          slows for someone it has never seen. {perception.shared} such reports sent so far.
        </p>
      </div>

      <div className="thing">
        <div className="thing-head">
          <span className="thing-icon">🚦</span>
          <h3>Arrives on green</h3>
          <span className={perception.glosa_active > 0 ? "thing-count live" : "thing-count"}>
            {perception.glosa_active}
          </span>
        </div>
        <p className="muted small">
          Junctions broadcast what their lights are about to do. A car hearing “red” eases off early
          and rolls through on green instead of racing up and stopping.
        </p>
        <button className="btn tiny" onClick={onFollowGlosa} disabled={!glosaCar}>
          {glosaCar ? `Follow ${glosaCar}` : "Nobody approaching a red yet"}
        </button>
      </div>

      <button className="btn primary wide" onClick={onTrigger}>
        🚶 Try it — step someone into the road
      </button>
    </div>
  );
}

/**
 * Who can see the pedestrian, and who only knows because they were told.
 *
 * This is the clearest thing on the page: the second list is made entirely of
 * cars that would have driven into a blind corner without the radio.
 */
function PedestrianInspector({ state }: { state: SimulationState }) {
  return (
    <div className="panel">
      <h2>On the crossing</h2>
      {state.pedestrians.map((ped) => (
        <div key={ped.id} className="ped-row">
          <p className="small">
            Someone is crossing <strong>{road(ped.segment_id)}</strong> — {ped.ticks_remaining} ticks
            until they are clear.
          </p>
          <dl className="kv">
            <div>
              <dt>Can see them</dt>
              <dd>{ped.seen_by.length ? ped.seen_by.join(", ") : "nobody"}</dd>
            </div>
            <div>
              <dt>Told by radio</dt>
              <dd className={ped.known_by.length ? "good-text" : ""}>
                {ped.known_by.length ? ped.known_by.join(", ") : "—"}
              </dd>
            </div>
          </dl>
          {ped.known_by.length > 0 && (
            <p className="muted small">
              Those cars are slowing for someone they have no line of sight to. Without the radio
              they would arrive at this corner at full speed.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** What one vehicle personally knows — the decentralisation claim, made
 *  concrete. No car here has a view of the whole city. */
function VehicleInspector({ state, vehicleId }: { state: SimulationState; vehicleId: string }) {
  const v = state.vehicles.find((x) => x.id === vehicleId);
  if (!v) return null;

  const trust = state.trust[v.id];
  const heard = state.transmissions.filter((t) => t.delivered_to.includes(v.id));
  const sent = state.transmissions.filter((t) => t.sender_id === v.id);

  return (
    <div className="panel">
      <h2>{v.id}</h2>
      <dl className="kv">
        <div>
          <dt>Type</dt>
          <dd>{v.kind === "malicious" ? "attacker" : v.kind}</dd>
        </div>
        <div>
          <dt>Broadcasting as</dt>
          <dd className="mono-sm">{v.pseudonym || "—"}</dd>
        </div>
        <div>
          <dt>Heading for</dt>
          <dd>{v.next_node ?? "—"}</dd>
        </div>
        <div>
          <dt>Destination</dt>
          <dd>{v.destination}</dd>
        </div>
        <div>
          <dt>Reroutes</dt>
          <dd>{v.reroute_count}</dd>
        </div>
        <div>
          <dt>Trust</dt>
          <dd>{trust ? trust.trust_score.toFixed(2) : "1.00"}</dd>
        </div>
      </dl>
      <p className="muted small">
        Recently sent {sent.length}, received {heard.length}.{" "}
        {v.yielding ? "Currently pulling over for an emergency vehicle." : ""}
        {v.braking ? " Braking hard and telling the traffic behind." : ""}
        {v.glosa_advice != null
          ? ` Holding ${Math.round(v.glosa_advice)} km/h to reach the next junction on green.`
          : ""}
      </p>
      <p className="muted small">
        The identity above rotates on a timer, so an observer at the roadside sees a stream of
        unrelated names rather than one traceable car.
      </p>
    </div>
  );
}
