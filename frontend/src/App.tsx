import { useState } from "react";
import { useSimulationSocket } from "./api/useSimulationSocket";
import { CityMap } from "./components/CityMap";
import { StatsBar } from "./components/StatsBar";
import { ExplainPanel } from "./components/ExplainPanel";
import { TrustPanel } from "./components/TrustPanel";
import { ControlConsole } from "./components/ControlConsole";
import { EventLog } from "./components/EventLog";

export default function App() {
  const { state, connected } = useSimulationSocket();
  const [selectedSegment, setSelectedSegment] = useState<string | null>(null);

  if (!state) {
    return (
      <div className="loading-screen">
        <p>Connecting to the V2X simulation engine…</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>AI-Driven Decentralized V2X Ecosystem</h1>
        <p className="subtitle">Live digital twin &mdash; edge AI, gossip messaging, self-healing RSUs, emergency corridors</p>
      </header>

      <StatsBar state={state} connected={connected} />

      <main className="app-main">
        <section className="map-section">
          <CityMap state={state} selectedSegment={selectedSegment} onSelectSegment={setSelectedSegment} />
          <Legend />
        </section>
        <aside className="side-panels">
          <ExplainPanel state={state} selectedSegment={selectedSegment} />
          <TrustPanel state={state} />
          <ControlConsole state={state} />
          <EventLog state={state} />
        </aside>
      </main>
    </div>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span>
        <i className="dot" style={{ background: "#7dd3fc" }} /> car
      </span>
      <span>
        <i className="dot" style={{ background: "#f87171" }} /> ambulance
      </span>
      <span>
        <i className="dot" style={{ background: "#c084fc" }} /> malicious
      </span>
      <span>
        <i className="line" style={{ background: "#22c55e" }} /> low occupancy
      </span>
      <span>
        <i className="line" style={{ background: "#ef4444" }} /> high occupancy
      </span>
      <span>
        <i className="line dashed" /> active incident / corridor
      </span>
    </div>
  );
}
