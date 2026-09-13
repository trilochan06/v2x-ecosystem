import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ArchitectureConfigState, ReferenceData } from "../types";

const FLAGS: { key: keyof ArchitectureConfigState; label: string }[] = [
  { key: "v2v_enabled", label: "Direct V2V" },
  { key: "rsu_edge_ai", label: "Edge AI at RSU" },
  { key: "federated_learning", label: "Federated learning" },
  { key: "digital_twin_sync", label: "Digital twin sync" },
  { key: "predictive_rerouting", label: "Predictive rerouting" },
  { key: "emergency_corridor", label: "Emergency corridor" },
];

export function Architecture() {
  const [ref, setRef] = useState<ReferenceData | null>(null);
  const [configs, setConfigs] = useState<ArchitectureConfigState[]>([]);

  useEffect(() => {
    api.reference().then(setRef).catch(() => setRef(null));
    api.architectures().then((r) => setConfigs(r.configs)).catch(() => setConfigs([]));
  }, []);

  if (!ref) {
    return <div className="loading">Loading the design reference…</div>;
  }

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
        <div className="layer-stack">
          {ref.layers.map((layer) => (
            <div key={layer.id} className="layer">
              <span className="layer-id">{layer.id}</span>
              <div className="layer-body">
                <h3>{layer.name}</h3>
                <p className="muted small">{layer.components}</p>
                <p>{layer.function}</p>
              </div>
              <div className="layer-modules">
                {layer.implemented_by.map((m) => (
                  <span key={m} className="pill">
                    {m}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
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
