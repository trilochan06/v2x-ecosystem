import { useState } from "react";
import { CERTIFICATE_BYTES, CERTIFICATE_DIGEST_BYTES } from "../sim/core";
import { commands, useSimulation } from "../sim/runtime";

export function Security() {
  const { state } = useSimulation();
  const [lastAttack, setLastAttack] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!state) {
    return <div className="loading">Connecting to the simulation engine…</div>;
  }

  const { pseudonyms, replay, certificates } = state.security;
  const trustRows = Object.entries(state.trust)
    .filter(([, t]) => t.reports_seen > 0)
    .sort((a, b) => a[1].trust_score - b[1].trust_score)
    .slice(0, 12);

  const runReplay = () => {
    setBusy(true);
    const res = commands.replayAttack();
    setLastAttack(`${res.blocked} of ${res.attempted} replayed frames rejected.`);
    setBusy(false);
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Security &amp; trust (M11)</h1>
          <p className="muted">
            Pseudonymous identities that rotate, replay defence on every receiver, and misbehaviour detection that
            survives rotation.
          </p>
        </div>
      </div>

      <div className="statbar">
        <Stat label="Certificates issued" value={pseudonyms.certificates_issued} />
        <Stat label="Rotations" value={pseudonyms.rotations} />
        <Stat label="Pseudonyms / vehicle" value={pseudonyms.avg_pseudonyms_per_vehicle} />
        <Stat label="Certificate lifetime" value={`${pseudonyms.lifetime_ticks}t`} />
        <Stat label="Revoked" value={pseudonyms.revoked_vehicles} warn={pseudonyms.revoked_vehicles > 0} />
        <Stat label="Replays blocked" value={replay.replays_blocked} />
        <Stat label="Stale dropped" value={replay.stale_dropped} />
        <Stat label="Frames accepted" value={replay.accepted} />
      </div>

      <section className="panel wide">
        <h2>Certificate attachment (IEEE 1609.2 / ETSI TS 103 097)</h2>
        <p className="muted">
          Signing every frame with a full certificate would be ruinous at 10 Hz, so a station
          attaches its certificate roughly once a second and otherwise sends an 8-byte HashedId8
          digest, trusting receivers to have cached it. That is a {CERTIFICATE_BYTES}-byte
          credential replaced by {CERTIFICATE_DIGEST_BYTES} bytes on {certificates.digests_attached}{" "}
          of {certificates.frames_secured} secured frames so far.
        </p>
        <div className="stat-grid">
          <Stat label="Frames secured" value={certificates.frames_secured} />
          <Stat label="Full certificates" value={certificates.certificates_attached} />
          <Stat label="Digests instead" value={certificates.digests_attached} />
          <Stat label="Saved by digests" value={`${certificates.kilobytes_saved} KB`} />
        </div>
        <p className="muted small">
          Privacy is not free here. Receivers cache a certificate against the pseudonym that sent
          it, so every rotation throws that cache away and the next frame must carry the full
          certificate again. Rotating faster buys unlinkability and spends bandwidth.
          {pseudonyms.rotations > 0
            ? ` ${pseudonyms.rotations} rotation${pseudonyms.rotations === 1 ? " has" : "s have"} forced a re-attach so far.`
            : " No vehicle has rotated yet in this run."}
        </p>
      </section>

      <div className="two-col">
        <section className="panel">
          <h2>The rotation / accountability tension</h2>
          <p className="muted">
            Rotating pseudonyms often enough to stop roadside tracking normally destroys the long-lived identity that
            misbehaviour detection depends on — rotate, and a fabricator walks away from its reputation.
          </p>
          <p className="muted">
            The split modelled here is the one real C-V2X deployments use. RSUs receive a pseudonym and can verify it was
            validly issued, but cannot link two pseudonyms to the same vehicle. Only the misbehaviour authority holds
            that mapping, so evidence accumulates against the durable identity while the air interface still shows an
            identifier that changes every {pseudonyms.lifetime_ticks} ticks.
          </p>
          <div className="attack-box">
            <button disabled={busy} onClick={runReplay}>
              Replay a captured frame
            </button>
            {lastAttack && <p className="attack-result">{lastAttack}</p>}
            <p className="muted small">
              The frame is re-sent with its original timestamp (rejected by the freshness window) and again with a fresh
              one (rejected by the receiver's nonce memory).
            </p>
          </div>
        </section>

        <section className="panel">
          <h2>Trust scores — lowest first</h2>
          <div className="table-scroll">
            <table className="data-table">
            <thead>
              <tr>
                <th>Node</th>
                <th>Trust</th>
                <th>Reports</th>
                <th>Confirmed</th>
              </tr>
            </thead>
            <tbody>
              {trustRows.map(([id, t]) => (
                <tr key={id} className={t.quarantined ? "bad-row" : ""}>
                  <td>
                    {id} {t.quarantined && <span className="pill bad">quarantined</span>}
                  </td>
                  <td>{t.trust_score.toFixed(2)}</td>
                  <td>{t.reports_seen}</td>
                  <td>{t.reports_corroborated}</td>
                </tr>
              ))}
              {trustRows.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No hazard reports observed yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
          <p className="muted small">
            Trust follows a vehicle's corroboration rate, but a report no other vehicle was positioned to witness is not
            scored at all — an empty road is not evidence of lying. Attackers, who fabricate hazards on clear roads that
            others actively contradict, sink; honest vehicles on quiet streets do not.
          </p>
        </section>
      </div>

      <section className="panel wide">
        <h2>Threats addressed</h2>
        <div className="grid-3">
          <article className="card">
            <h3>False hazard injection</h3>
            <p>
              Fabricated reports need independent corroboration before they can flip a segment's state, and the
              fabricator's trust decays toward revocation.
            </p>
          </article>
          <article className="card">
            <h3>Replay attacks</h3>
            <p>
              Every receiver enforces a freshness window of {replay.freshness_window_ticks} ticks plus per-receiver
              nonce memory, so a captured frame cannot be re-injected later.
            </p>
          </article>
          <article className="card">
            <h3>Location tracking</h3>
            <p>
              Identifiers on the air rotate every {pseudonyms.lifetime_ticks} ticks; an observer sees a stream of
              unrelated pseudonyms rather than one traceable vehicle.
            </p>
          </article>
        </div>
        <p className="muted small">
          Not addressed in this prototype: a coordinated Sybil attack, where several colluding nodes corroborate each
          other's fabrications. Defeating that needs certificate-issuance limits per real identity, which is documented
          as future work rather than implemented.
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className={warn ? "stat warn" : "stat"}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
