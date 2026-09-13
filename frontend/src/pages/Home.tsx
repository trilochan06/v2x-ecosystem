import { Link } from "react-router-dom";
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
    body: "Vehicles detect events on board and gossip them peer-to-peer with a hop-limited TTL. No infrastructure is required for the warning to spread.",
  },
  {
    tag: "M4 · M6",
    title: "Intelligent RSUs",
    body: "Roadside units aggregate, filter for relevance and run congestion inference locally, forwarding only compact digests upstream.",
  },
  {
    tag: "M7",
    title: "Federated learning",
    body: "RSUs train on what they observe and upload model weights only. Observations never leave the edge, and the uplink cost collapses.",
  },
  {
    tag: "M8",
    title: "Transportation digital twin",
    body: "A continuously synchronized replica of the road network, held separately so synchronization lag and divergence stay measurable.",
  },
  {
    tag: "M10",
    title: "Predictive emergency corridors",
    body: "An ambulance's near-term path is projected, signals ahead of it preempt, and vehicles on the route are told to yield before it arrives.",
  },
  {
    tag: "M11",
    title: "Pseudonymous trust",
    body: "Rotating pseudonym certificates prevent tracking, while a misbehaviour authority still accumulates evidence against fabricators.",
  },
];

export function Home() {
  const { state, connected } = useSimulation();

  return (
    <div className="home">
      <section className="hero">
        <p className="eyebrow">B.Tech CSE · Project-I</p>
        <h1>
          Transport intelligence that keeps working
          <br />
          when the cloud does not.
        </h1>
        <p className="lede">
          A decentralized Vehicle-to-Everything ecosystem in which every vehicle is a compute node, every roadside unit
          runs its own AI, and the regional model is trained by federated learning — so warnings travel in milliseconds,
          raw location data never leaves the edge, and a severed uplink does not take safety messaging down with it.
        </p>
        <div className="hero-actions">
          <Link className="btn primary" to="/control">
            Open the live control centre
          </Link>
          <Link className="btn" to="/experiments">
            See the measured results
          </Link>
        </div>

        {state && (
          <div className="live-strip">
            <span className={connected ? "dot live" : "dot"} />
            <span>
              Simulation live · tick {state.tick} · {state.vehicles.length} vehicles · {state.rsus.length} RSUs ·{" "}
              {state.federated.rounds_completed} federated rounds completed
            </span>
          </div>
        )}
      </section>

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
            <article key={c.title} className="card capability">
              <span className="tag">{c.tag}</span>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </article>
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
