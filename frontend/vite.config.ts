import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // VITE_BASE="./" emits relative asset URLs so the bundle also works when it
  // is served from a sub-path rather than a domain root.
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/ws": {
        target: "ws://localhost:8000",
        ws: true,
      },
    },
  },
});
