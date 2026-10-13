import { useEffect, useRef } from "react";
import type { PovAlert, PovState } from "../sim/pov";
import { styleFor } from "./map/mapStyle";

const PRIORITY_LABEL: Record<PovAlert["priority"], string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

/**
 * A short tone for a critical alert, synthesised rather than shipped.
 *
 * An audio file would be two hundred kilobytes in the bundle for a beep, and
 * the browser will not play anything at all until the viewer has interacted
 * with the page, so this stays off until they switch it on.
 */
function useChime(enabled: boolean, criticalCount: number) {
  const previous = useRef(criticalCount);
  useEffect(() => {
    const rose = criticalCount > previous.current;
    previous.current = criticalCount;
    if (!enabled || !rose) return;
    try {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.24);
      osc.onended = () => void ctx.close();
    } catch {
      // Audio is a nicety. A browser that refuses it changes nothing else.
    }
  }, [enabled, criticalCount]);
}

function Dial({ pov }: { pov: PovState }) {
  const limit = pov.speedLimitKmh;
  const over = pov.speedKmh > limit + 1;
  return (
    <div className="pov-dial">
      <div className={`pov-dial__speed${over ? " is-over" : ""}`}>
        <strong>{pov.speedKmh}</strong>
        <span>km/h</span>
      </div>
      <div className="pov-dial__limits">
        <span className="pov-limit" title="Posted speed limit">
          {limit}
        </span>
        {pov.advisoryKmh !== null && (
          <span className="pov-advisory" title="Advisory speed">
            advise {pov.advisoryKmh}
          </span>
        )}
      </div>
    </div>
  );
}

export function PovView({
  pov,
  onExit,
  onExplain,
  sound,
  onToggleSound,
}: {
  pov: PovState;
  onExit: () => void;
  onExplain?: (alert: PovAlert) => void;
  sound: boolean;
  onToggleSound: () => void;
}) {
  const critical = pov.alerts.filter((a) => a.priority === "critical").length;
  useChime(sound, critical);
  const style = styleFor(pov.kind);

  return (
    <div className="panel pov">
      <header className="pov__head">
        <span className="pov__badge" style={{ background: style.color }}>
          {style.glyph}
        </span>
        <div>
          <h2>{pov.label}</h2>
          <p className="muted small">
            {pov.vehicleId} · {pov.tripPurpose || "on a trip"}
          </p>
        </div>
        <div className="pov__head-actions">
          <button
            type="button"
            className="pov__sound"
            aria-pressed={sound}
            onClick={onToggleSound}
            title="Sound for critical alerts"
          >
            {sound ? "Sound on" : "Sound off"}
          </button>
          <button type="button" className="pov__exit" onClick={onExit}>
            Exit view
          </button>
        </div>
      </header>

      {!pov.equipped && (
        <p className="pov__silent">
          This road user carries no on-board unit. It receives nothing, so it gets no warnings about
          anything — the empty alert list below is the point, not a bug. Other vehicles know it is
          here only because their sensors can see it.
        </p>
      )}

      <div className="pov__hud">
        <Dial pov={pov} />
        <dl className="pov__facts">
          <div>
            <dt>Road</dt>
            <dd>{pov.road}</dd>
          </div>
          <div>
            <dt>Traffic</dt>
            <dd>{(pov.roadOccupancy * 100).toFixed(0)}% of jam</dd>
          </div>
          <div>
            <dt>Heading for</dt>
            <dd>{pov.destination}</dd>
          </div>
          <div>
            <dt>Distance</dt>
            <dd>{(pov.distanceToDestinationM / 1000).toFixed(2)} km</dd>
          </div>
          <div>
            <dt>ETA</dt>
            <dd>{pov.etaTicks === null ? "stopped" : `${pov.etaTicks} ticks`}</dd>
          </div>
          <div>
            <dt>Signal</dt>
            <dd>
              {pov.signal ? (
                <span className={`pov-phase pov-phase--${pov.signal.phase}`}>
                  {pov.signal.phase} · {pov.signal.distanceM} m
                </span>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
      </div>

      <h3 className="pov__subhead">
        Alerts {pov.alerts.length > 0 && <span className="pov__count">{pov.alerts.length}</span>}
      </h3>
      {pov.alerts.length === 0 ? (
        <p className="muted small">Nothing to report. Road clear, signal green, no one braking.</p>
      ) : (
        <ul className="pov-alerts">
          {pov.alerts.map((a) => (
            <li key={a.id} className={`pov-alert pov-alert--${a.priority}`}>
              <div className="pov-alert__top">
                <span className="pov-alert__pri">{PRIORITY_LABEL[a.priority]}</span>
                <strong>{a.title}</strong>
              </div>
              <p>{a.detail}</p>
              {a.advice && <p className="pov-alert__advice">{a.advice}</p>}
              {onExplain && (
                <button type="button" className="pov-alert__explain" onClick={() => onExplain(a)}>
                  Explain this
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="pov__subhead">Next turns</h3>
      {pov.steps.length === 0 ? (
        <p className="muted small">Arriving.</p>
      ) : (
        <ol className="pov-steps">
          {pov.steps.map((s, i) => (
            <li key={`${s.junction}-${i}`}>
              <span className="pov-steps__dist">{s.distanceM} m</span>
              <span>
                {s.instruction} at {s.junction}
              </span>
              <span className="muted">{s.road}</span>
            </li>
          ))}
        </ol>
      )}

      <h3 className="pov__subhead">Around you</h3>
      {pov.neighbours.length === 0 ? (
        <p className="muted small">No one within a block.</p>
      ) : (
        <ul className="pov-near">
          {pov.neighbours.map((n) => (
            <li key={n.id}>
              <i className="pov-near__dot" style={{ background: styleFor(n.kind).color }} />
              <span>{n.label}</span>
              <span className="muted">
                {n.relation} · {n.distanceM} m
              </span>
              {n.vulnerable && <em className="pov-near__tag">VRU</em>}
              {!n.equipped && <em className="pov-near__tag">no OBU</em>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
