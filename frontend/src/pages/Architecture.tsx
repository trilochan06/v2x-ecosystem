import { useState } from "react";
import { Link } from "react-router-dom";

import { CONFIGS } from "../sim/engine";
import { REFERENCE } from "../sim/reference";
import type { ArchitectureConfigState, ReferenceData } from "../types";

const FLAGS: { key: keyof ArchitectureConfigState; label: string }[] = [
  { key: "v2v_enabled", label: "Direct V2V" },
  { key: "rsu_edge_ai", label: "Edge AI at RSU" },
  { key: "federated_learning", label: "Federated learning" },
  { key: "digital_twin_sync", label: "Digital twin sync" },
  { key: "predictive_rerouting", label: "Predictive rerouting" },
  { key: "emergency_corridor", label: "Emergency corridor" },
];

/** Where each layer can actually be watched working, so the traceability
 *  table is a way into the system rather than a dead end. */
const LAYER_DEMOS: Record<string, { to: string; label: string }> = {
  L1: { to: "/street", label: "Watch vehicles sense the road" },
  L2: { to: "/demo", label: "Watch a warning spread peer-to-peer" },
  L3: { to: "/control", label: "See edge inference per roadside unit" },
  L4: { to: "/federated", label: "Open the federated learning monitor" },
  L5: { to: "/control", label: "See digital-twin divergence" },
  L6: { to: "/experiments", label: "See the measured comparison" },
};

export function Architecture() {
  const ref: ReferenceData = REFERENCE;
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const selected = ref.layers.find((l) => l.id === selectedLayer) ?? null;
  const configs: ArchitectureConfigState[] = Object.values(CONFIGS);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Architecture &amp; module traceability</h1>
          <p className="muted">
            {ref.team.title} — {ref.team.subtitle}
          </p>
        </div>
      </div>

      <section className="panel wide">
        <h2>Six-layer architecture</h2>
        <p className="muted small layer-hint">
          Pick a layer to see what implements it and where to watch it working.
        </p>
        {/* Every layer used to be fully expanded at once: six headings, six
            component lists and every module pill on screen together. Selecting
            one shows the same material at a depth a reader can follow, and
            gives them somewhere to go next. */}
        <div className="layer-stack">
          {ref.layers.map((layer) => {
            const open = layer.id === selectedLayer;
            return (
              <button
                key={layer.id}
                aria-expanded={open}
                className={open ? "layer open" : "layer"}
                onClick={() => setSelectedLayer(open ? null : layer.id)}
              >
                <span className="layer-id">{layer.id}</span>
                <span className="layer-body">
                  <span className="layer-name">{layer.name}</span>
                  {open && <span className="layer-components">{layer.components}</span>}
                  {open && <span className="layer-function">{layer.function}</span>}
                </span>
                <span className="layer-modules">
                  {layer.implemented_by.map((m) => (
                    <span key={m} className="pill">
                      {m}
                    </span>
                  ))}
                </span>
              </button>
            );
          })}
        </div>

        {selected && (
          <div className="layer-detail">
            <h3>
              {selected.id} · {selected.name} — what implements it
            </h3>
            <div className="layer-detail-modules">
              {ref.modules
                .filter((m) => selected.implemented_by.includes(m.id))
                .map((m) => (
                  <div key={m.id} className="layer-module">
                    <span className="pill">{m.id}</span>
                    <div>
                      <strong>{m.name}</strong>
                      <p className="muted small">{m.description}</p>
                      <p className="mono-sm">{m.source}</p>
                    </div>
                  </div>
                ))}
            </div>
            {LAYER_DEMOS[selected.id] && (
              <Link className="btn tiny" to={LAYER_DEMOS[selected.id].to}>
                {LAYER_DEMOS[selected.id].label} →
              </Link>
            )}
          </div>
        )}
        <p className="muted small">
          Information flows up and decisions flow back down, but no layer is a single point of failure: L1–L3 keep
          operating with L5 unreachable, which is what the outage experiment measures.
        </p>
      </section>

      <section className="panel wide">
        <h2>Modules M1–M12, and where each one lives</h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Module</th>
                <th>Responsibility</th>
                <th>Source</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {ref.modules.map((m) => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.id}</strong>
                  </td>
                  <td>{m.name}</td>
                  <td className="muted">{m.description}</td>
                  <td>
                    <code>{m.source}</code>
                  </td>
                  <td className="muted small">{m.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel wide">
        <h2>Experimental configurations</h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Capability</th>
                {configs.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FLAGS.map((f) => (
                <tr key={String(f.key)}>
                  <td>{f.label}</td>
                  {configs.map((c) => (
                    <td key={c.key}>{c[f.key] ? <span className="pill good">yes</span> : <span className="pill">no</span>}</td>
                  ))}
                </tr>
              ))}
              <tr>
                <td>Cloud round trip</td>
                {configs.map((c) => (
                  <td key={c.key}>{c.cloud_round_trip_ticks} ticks</td>
                ))}
              </tr>
              <tr>
                <td>Fails without cloud</td>
                {configs.map((c) => (
                  <td key={c.key}>
                    {c.cloud_dependent ? <span className="pill bad">yes</span> : <span className="pill good">no</span>}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel wide">
        <h2>Project team</h2>
        <div className="team">
          {ref.team.members.map((m) => (
            <div key={m.reg} className="member">
              <strong>{m.name}</strong>
              <span className="muted">{m.reg}</span>
            </div>
          ))}
          <div className="member">
            <strong>{ref.team.mentor}</strong>
            <span className="muted">Mentor</span>
          </div>
        </div>
      </section>
    </div>
  );
}
