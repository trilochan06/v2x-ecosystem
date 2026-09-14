import { Link } from "react-router-dom";
import { LiveCityPreview } from "../components/LiveCityPreview";
import { useSimulation } from "../sim/runtime";

const PROBLEMS = [
  {
    title: "Cloud dependency",
    body: "Today's connected-vehicle services route decisions through a central cloud. When the uplink degrades, safety-relevant messaging degrades with it.",
  },
  {
    title: "Latency where it matters",
    body: "A hazard 200 metres ahead cannot wait for a round trip to a data centre. Warnings that arrive after the driver has already reached the obstruction are not warnings.",
  },
  {
    title: "Raw telemetry exposure",
    body: "Continuously uploading per-vehicle position traces is expensive on the uplink and creates a permanent record of where every driver has been.",
  },
  {
    title: "No regional context at the edge",
    body: "Purely local V2V decisions have no view beyond the next junction, so they cannot anticipate congestion building two streets away.",
  },
];

const CAPABILITIES = [
  {
    tag: "M2 · M3",
    title: "Direct hazard dissemination",
    to: "/demo",
    cta: "Watch a crash propagate",
    body: "Vehicles detect events on board and gossip them peer-to-peer with a hop-limited TTL. No infrastructure is required for the warning to spread.",
  },
  {
    tag: "M4 · M6",
    title: "Intelligent RSUs",
    to: "/control",
    cta: "See the edge predictions",
    body: "Roadside units aggregate, filter for relevance and run congestion inference locally, forwarding only compact digests upstream.",
  },
  {
    tag: "M7",
    title: "Federated learning",
    to: "/federated",
    cta: "Open the learning monitor",
    body: "RSUs train on what they observe and upload model weights only. Observations never leave the edge, and the uplink cost collapses.",
  },
  {
    tag: "M8",
    title: "Transportation digital twin",
    to: "/control",
    cta: "See twin divergence",
    body: "A continuously synchronized replica of the road network, held separately so synchronization lag and divergence stay measurable.",
  },
  {
    tag: "M10",
    title: "Predictive emergency corridors",
    to: "/demo",
    cta: "Run the ambulance story",
    body: "An ambulance's near-term path is projected, signals ahead of it preempt, and vehicles on the route are told to yield before it arrives.",
  },
  {
    tag: "M11",
    title: "Pseudonymous trust",
    to: "/security",
    cta: "Open the trust console",
    body: "Rotating pseudonym certificates prevent tracking, while a misbehaviour authority still accumulates evidence against fabricators.",
  },
];

export function Home() {
  const { state, connected } = useSimulation();

  return (
    <div className="home">
      <section className="hero">
        <p className="eyebrow">B.Tech CSE · Project-I</p>
        {/* No hard break: the line wraps on its own at this measure, and a
            forced one left "working" stranded on a line of its own. */}
        <h1>Transport intelligence that keeps working when the cloud does not.</h1>
        <p className="lede">
          A decentralized Vehicle-to-Everything ecosystem in which every vehicle is a compute node, every roadside unit
          runs its own AI, and the regional model is trained by federated learning — so warnings travel in milliseconds,
          raw location data never leaves the edge, and a severed uplink does not take safety messaging down with it.
        </p>
        <div className="hero-actions">
          {/* The guided demo explains the system; the control centre measures
              it. Someone arriving cold needs the first one. */}
          <Link className="btn primary" to="/demo">
            Start the guided demo
          </Link>
          <Link className="btn" to="/control">
            Open the control centre
          </Link>
          <Link className="btn" to="/experiments">
            See the measured results
          </Link>
        </div>
      </section>

      {/* Evidence rather than a claim: this is the city running in this tab. */}
      {state && (
        <section className="hero-live">
          <div className="hero-live-map">
            <LiveCityPreview state={state} />
          </div>
          <div className="hero-live-body">
            <p className="hero-live-title">
              <span className={connected ? "dot live" : "dot"} /> Running in this browser tab, right now
            </p>
            <p className="muted small">
              Nothing is pre-recorded and nothing is fetched from a server. Every dot is a vehicle deciding for
              itself, every ring is a frame actually going out, and every road is shaded by how busy it
              currently is.
            </p>
            <div className="hero-stats">
              <HeroStat value={state.vehicles.length} label="vehicles" />
              <HeroStat value={state.rsus.length} label="roadside units" />
              <HeroStat value={state.federated.rounds_completed} label="learning rounds" />
              <HeroStat
                value={state.metrics.communication.messages_sent.toLocaleString()}
                label="frames on the air"
              />
              <HeroStat
                value={`${state.metrics.communication.uplink_kilobytes_per_tick} KB`}
                label="uplink / tick"
              />
              <HeroStat value={state.tick} label="ticks elapsed" />
            </div>
          </div>
        </section>
      )}

      <section className="band">
        <h2>The problem this addresses</h2>
        <p className="section-lede">
          Existing ITS and connected-vehicle deployments provide increasingly capable V2X communication, but the way
          intelligence is placed in the network creates four practical failures.
        </p>
        <div className="grid-2">
          {PROBLEMS.map((p) => (
            <article key={p.title} className="card problem">
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="band">
        <h2>What the system does</h2>
        <p className="section-lede">
          Six layers, twelve modules. Intelligence sits at the vehicle and the roadside; the cloud becomes one
          participant rather than the brain.
        </p>
        <div className="grid-3">
          {CAPABILITIES.map((c) => (
            <Link key={c.title} to={c.to} className="card capability">
              <span className="tag">{c.tag}</span>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
              <span className="capability-cta">{c.cta} →</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="band">
        <h2>Honest scope</h2>
        <div className="scope">
          <p>
            This is a working simulation of the proposed architecture, not a licensed-spectrum radio deployment. The
            physical layer is modelled — hop-limited broadcast with a density-dependent loss model — rather than
            implemented over real C-V2X hardware, and the security layer uses HMAC-based certificates in place of a full
            IEEE 1609.2 PKI.
          </p>
          <p>
            Everything above that line is real code that runs: on-board event detection, peer-to-peer dissemination,
            edge inference, FedAvg aggregation over per-RSU local training, digital-twin synchronization, corroboration-based
            trust, and the comparative evaluation of all three architectures on the{" "}
            <Link to="/experiments">experiments page</Link>.
          </p>
        </div>
      </section>
    </div>
  );
}

function HeroStat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="hero-stat">
      <span className="hero-stat-value">{value}</span>
      <span className="hero-stat-label">{label}</span>
    </div>
  );
}
