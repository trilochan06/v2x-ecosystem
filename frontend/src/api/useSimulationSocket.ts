import { useEffect, useRef, useState } from "react";
import type { SimulationState } from "../types";

const WS_URL = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/state`;

export function useSimulationSocket() {
  const [state, setState] = useState<SimulationState | null>(null);
  const [connected, setConnected] = useState(false);
  const retryRef = useRef(0);

  useEffect(() => {
    let socket: WebSocket;
    let cancelled = false;
    let retryTimer: number | undefined;

    const connect = () => {
      socket = new WebSocket(WS_URL);

      socket.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        retryRef.current = 0;
      };

      socket.onmessage = (event) => {
        if (cancelled) return;
        setState(JSON.parse(event.data));
      };

      socket.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        const delay = Math.min(1000 * 2 ** retryRef.current, 8000);
        retryRef.current += 1;
        retryTimer = window.setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return { state, connected };
}
