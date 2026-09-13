import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { Home } from "./pages/Home";
import { ControlCenter } from "./pages/ControlCenter";
import { Federated } from "./pages/Federated";
import { Security } from "./pages/Security";
import { Experiments } from "./pages/Experiments";
import { Architecture } from "./pages/Architecture";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/control", label: "Control Centre" },
  { to: "/federated", label: "Federated Learning" },
  { to: "/security", label: "Security & Trust" },
  { to: "/experiments", label: "Experiments" },
  { to: "/architecture", label: "Architecture" },
];

export default function App() {
  return (
    <div className="app">
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

      <main className="page">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/control" element={<ControlCenter />} />
          <Route path="/federated" element={<Federated />} />
          <Route path="/security" element={<Security />} />
          <Route path="/experiments" element={<Experiments />} />
          <Route path="/architecture" element={<Architecture />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <footer className="footer">
        <span>B.Tech CSE Project-I · Rahul Anand Y (23BCE1650) · Trilochan P (23BCE1889) · Vijay P (23BCE5025)</span>
        <span>Mentor: Dr. Malathi</span>
      </footer>
    </div>
  );
}
