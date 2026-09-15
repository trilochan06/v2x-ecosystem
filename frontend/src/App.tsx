import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Home } from "./pages/Home";
import { GuidedDemo } from "./pages/GuidedDemo";
import { Pipeline } from "./pages/Pipeline";
import { StreetView } from "./pages/StreetView";
import { ControlCenter } from "./pages/ControlCenter";
import { Federated } from "./pages/Federated";
import { Security } from "./pages/Security";
import { Experiments } from "./pages/Experiments";
import { Architecture } from "./pages/Architecture";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/demo", label: "Guided Demo" },
  { to: "/pipeline", label: "How It Works" },
  { to: "/street", label: "Street View" },
  { to: "/control", label: "Control Centre" },
  { to: "/federated", label: "Federated Learning" },
  { to: "/security", label: "Security & Trust" },
  { to: "/experiments", label: "Experiments" },
  { to: "/architecture", label: "Architecture" },
];

export default function App() {
  const location = useLocation();

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="masthead">
        <NavLink to="/" className="brand">
          <span className="brand-mark">V2X</span>
          <span className="brand-text">
            <strong>Intelligent Decentralized V2X Ecosystem</strong>
            <em>Edge intelligence · federated learning · digital twin</em>
          </span>
        </NavLink>
        <nav className="mainnav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? "navlink active" : "navlink")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="page" id="main">
        {/* Keyed on the route so navigating away from a broken page clears
            the error instead of trapping the user on the fallback. */}
        <ErrorBoundary key={location.pathname} area="This page">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/demo" element={<GuidedDemo />} />
            <Route path="/pipeline" element={<Pipeline />} />
            <Route path="/street" element={<StreetView />} />
            <Route path="/control" element={<ControlCenter />} />
            <Route path="/federated" element={<Federated />} />
            <Route path="/security" element={<Security />} />
            <Route path="/experiments" element={<Experiments />} />
            <Route path="/architecture" element={<Architecture />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </main>

      <footer className="footer">
        <span>B.Tech CSE Project-I · Rahul Anand Y (23BCE1650) · Trilochan P (23BCE1889) · Vijay P (23BCE5025)</span>
        <span>Mentor: Dr. Malathi</span>
      </footer>
    </div>
  );
}
