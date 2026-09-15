import { useEffect, useState } from "react";

import { Narration } from "../components/Narration";
import { StreetMap } from "../components/StreetMap";
import { SPEEDS, guided, useGuided } from "../sim/guidedRuntime";
import { ALL_SCENARIOS } from "../sim/scenarios";
import type { SimulationState } from "../types";

/**
 * The demo you put in front of someone who has never heard of V2X.
 *
 * The control centre answers "how well does this perform"; the street view is
 * a sandbox to poke at. Neither answers the question an audience actually
 * has, which is "what is this thing doing and why should I care". That needs
 * a story with a beginning and an end, and a way to see the story's claims
 * being met — or not met — by the live system rather than by an animation.
 *
 * Hence the checklist down the right-hand side. Each line is something the
 * scenario says will happen; it ticks off, with the tick number it happened
 * on, only when the running simulation actually does it.
 */
export function GuidedDemo() {
  const { state, story, playing, speedIndex } = useGuided();
  const [selectedVehicle, setSelectedVehicle] = useState<string | null>(null);
  const [selectedSegment, setSelectedSegment] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  /**
   * Keyboard control, because this page is meant to be presented.
   *
   * Space to play and pause, arrow to step, R for a fresh city, 1-7 to pick a
   * story. Hunting for a button mid-sentence is the difference between talking
   * over a demo and being interrupted by one.
   *
   * Ignored while a control has focus, so Space on a focused button still
   * activates that button rather than doing two things at once.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(el.tagName))
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === " ") {
        e.preventDefault();
        if (guided.playing) guided.pause();
        else guided.play();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        guided.stepOnce();
      } else if (e.key === "r" || e.key === "R") {
        guided.reset();
      } else if (/^[1-9]$/.test(e.key)) {
        const pick = ALL_SCENARIOS[Number(e.key) - 1];
        if (pick) guided.runScenario(pick.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!state) return <div className="loading">Starting the simulator…</div>;

  const elapsed = story.scenario ? state.tick - story.startedTick : 0;
  const doneCount = story.achieved.filter((a) => a !== null).length;
  // Progress is measured in steps taken, not ticks elapsed. These cascades
  // finish in a handful of ticks, so a tick bar would sit near zero for a
  // story that has already told itself — the opposite of the truth.
  const required = story.scenario?.beats.filter((b) => !b.optional).length ?? 0;
  const requiredDone =
    story.scenario?.beats.filter((b, i) => !b.optional && story.achieved[i] !== null).length ?? 0;
  const progress = required ? (requiredDone / required) * 100 : 0;

  return (
    <div className="stack guided">
      <div className="page-head">
        <div>
          <h1>Guided demo</h1>
          <p className="muted">
            Pick a story below. Everything you see is the real simulation running in this tab — the
            checklist ticks off only when the system actually does the thing, so a step that fails
            stays dark.
          </p>
        </div>
      </div>

      {/* ------------------------------------------------- scenario picker */}
      <section className="scenario-picker" role="group" aria-label="Choose a scenario">
        {ALL_SCENARIOS.map((s) => (
          <button
            key={s.id}
            className={story.scenario?.id === s.id ? "scenario-card active" : "scenario-card"}
            onClick={() => {
              guided.runScenario(s.id);
              setSelectedSegment(null);
              setSelectedVehicle(null);
            }}
          >
            <span className="scenario-icon">{s.icon}</span>
            <span className="scenario-title">{s.title}</span>
          </button>
        ))}
      </section>

      <div className="guided-body">
        <section className="panel guided-map-panel">
          {story.scenario && (
            <div className="story-hook">
              <strong>
                {story.scenario.icon} {story.scenario.title}
              </strong>
              <p>{story.scenario.hook}</p>
            </div>
          )}

          <div className="guided-map">
            <StreetMap
              state={state}
              selectedVehicle={selectedVehicle}
              onSelectVehicle={setSelectedVehicle}
              selectedSegment={selectedSegment}
              onSelectSegment={setSelectedSegment}
            />
          </div>

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
              <i className="key-crash" /> wreck
            </span>
            <span>
              <i className="key-ped" /> pedestrian
            </span>
            <span>
              <i className="key-ring" style={{ borderColor: "#3987e5" }} /> “here I am”
            </span>
            <span>
              <i className="key-ring" style={{ borderColor: "#e66767" }} /> “something happened”
            </span>
            <span>
              <i className="key-ring" style={{ borderColor: "#f0b429" }} /> “someone is here”
            </span>
            <span>
              <i className="key-ring" style={{ borderColor: "#199e70" }} /> signal phase
            </span>
          </div>

          {/* ------------------------------------------------- transport */}
          <div className="guided-transport">
            <button className="btn primary" onClick={() => (playing ? guided.pause() : guided.play())}>
              {playing ? "⏸ Pause" : "▶ Play"}
            </button>
            <button className="btn" onClick={() => guided.stepOnce()}>
              ⏭ Step
            </button>
            <button
              className="btn"
              onClick={() => {
                guided.reset();
                setSelectedVehicle(null);
                setSelectedSegment(null);
              }}
            >
              ↺ Reset city
            </button>
            <div className="transport-speed" role="group" aria-label="Speed">
              {SPEEDS.map((s, i) => (
                <button
                  key={s.label}
                  className={i === speedIndex ? "chip active" : "chip"}
                  onClick={() => guided.setSpeed(i)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <span className="transport-tick">
              tick <strong>{state.tick}</strong>
            </span>
            <p className="muted small shortcut-hint">
              <kbd>Space</kbd> play/pause · <kbd>→</kbd> step · <kbd>R</kbd> reset ·{" "}
              <kbd>1</kbd>–<kbd>7</kbd> pick a story
            </p>
          </div>
        </section>

        <aside className="side">
          {/* ----------------------------------------------- the checklist */}
          <div className="panel story-panel">
            <h2>
              What should happen
              {story.scenario && (
                <span className="story-count">
                  {doneCount}/{story.scenario.beats.length}
                </span>
              )}
            </h2>

            {!story.scenario ? (
              <p className="muted small">
                Choose a story above and it will play out here, step by step. Nothing is scripted —
                each step lights up when the simulation genuinely does it.
              </p>
            ) : (
              <>
                <div className="story-progress">
                  <div className="story-bar">
                    <div className="story-fill" style={{ width: `${progress}%` }} />
                  </div>
                  <span className="small muted">
                    {story.finished ? `done in ${elapsed} ticks` : `${requiredDone} of ${required}`}
                  </span>
                </div>

                <ol className="beats">
                  {story.scenario.beats.map((beat, i) => {
                    const at = story.achieved[i];
                    return (
                      <li
                        key={beat.text}
                        className={[
                          "beat",
                          at !== null ? "done" : "",
                          beat.optional && at === null ? "optional" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        <span className="beat-mark">{at !== null ? "✓" : i + 1}</span>
                        <span className="beat-body">
                          <span className="beat-text">{beat.text}</span>
                          {at !== null && <span className="beat-tick">tick {at}</span>}
                          {/* A step that legitimately may not fire has to say
                              so, or a dark line reads as a broken demo rather
                              than as a lossy radio behaving honestly. */}
                          {beat.optional && at === null && (
                            <span className="beat-maybe">doesn’t happen every run</span>
                          )}
                          {showDetail && beat.detail && (
                            <span className="beat-detail">{beat.detail}</span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ol>

                <button className="btn tiny" onClick={() => setShowDetail((d) => !d)}>
                  {showDetail ? "Hide the standards detail" : "Show the standards detail"}
                </button>

                {story.finished && (
                  <p className="story-done">
                    {doneCount === story.scenario.beats.length
                      ? `Every step happened, in ${elapsed} ${elapsed === 1 ? "tick" : "ticks"}.`
                      : "Every step that had to happen, happened — the greyed ones depend on the radio and the road layout."}{" "}
                    {story.pausedOnFinish
                      ? "Paused here so you can look at it — press Play to carry on, or pick another story."
                      : "Press Play to carry on, or pick another story."}
                  </p>
                )}

                {story.ticks >= 200 && !story.finished && (
                  <p className="muted small story-slow">
                    This is the long one — it needs a few hundred ticks of evidence. Try{" "}
                    <strong>Fast</strong>.
                  </p>
                )}
              </>
            )}
          </div>

          <KeyNumbers state={state} />
          <Narration state={state} lines={7} />
        </aside>
      </div>
    </div>
  );
}

/**
 * The handful of numbers worth saying out loud, in words rather than jargon.
 *
 * The control centre has twelve metrics because it is an instrument. An
 * audience can hold about five.
 */
function KeyNumbers({ state }: { state: SimulationState }) {
  const m = state.metrics;
  const rows: { label: string; value: string; note: string }[] = [
    {
      label: "Cars talking to each other",
      value: String(state.vehicles.length),
      note: `${m.communication.messages_sent.toLocaleString()} messages sent so far`,
    },
    {
      label: "Warned about something unseen",
      value: String(state.perception.warned_blind),
      note: "acted on a road user they had no line of sight to",
    },
    {
      label: "Incidents the network confirmed",
      value: String(state.segments.filter((s) => s.confirmed_incident).length),
      note: `spotted in ${m.communication.avg_alert_latency_ticks} ticks on average`,
    },
    {
      label: "Learning rounds completed",
      value: String(state.federated.rounds_completed),
      note: `${state.federated.total_raw_kilobytes_avoided.toFixed(0)} KB of raw data never uploaded`,
    },
    {
      label: "Radio actually delivered",
      value: `${Math.round(m.communication.packet_delivery_ratio * 100)}%`,
      note: "the rest was lost on the air, as it would be in the field",
    },
  ];

  return (
    <div className="panel key-numbers">
      <h2>Worth saying out loud</h2>
      {rows.map((r) => (
        <div key={r.label} className="key-row">
          <span className="key-value">{r.value}</span>
          <span className="key-body">
            <span className="key-label">{r.label}</span>
            <span className="key-note">{r.note}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
