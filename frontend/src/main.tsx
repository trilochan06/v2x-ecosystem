import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";

// Hosts that cannot rewrite unknown paths back to index.html build with
// VITE_ROUTER=hash so a deep link survives a reload. Vercel installs that
// rewrite (see vercel.json), so it keeps clean URLs.
const Router = import.meta.env.VITE_ROUTER === "hash" ? HashRouter : BrowserRouter;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Router>
      <App />
    </Router>
  </React.StrictMode>
);
