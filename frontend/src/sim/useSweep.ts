import { CONFIG_KEYS } from "./experiments";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SweepRequest, SweepResponse } from "./experiments.worker";
import type { ExperimentSuite } from "../types";

export interface SweepState {
  suite: ExperimentSuite | null;
  running: boolean;
  done: number;
  total: number;
  error: string | null;
}

/**
 * Drives the experiment sweep in a worker.
 *
 * The worker is created per run and terminated when it finishes or is
 * cancelled, so there is never a stale one holding a half-finished sweep.
 */
export function useSweep() {
  const worker = useRef<Worker | null>(null);
  const [state, setState] = useState<SweepState>({
    suite: null,
    running: false,
    done: 0,
    total: 0,
    error: null,
  });

  const stop = useCallback(() => {
    worker.current?.terminate();
    worker.current = null;
  }, []);

  // A sweep must not outlive the page that started it.
  useEffect(() => stop, [stop]);

  const cancel = useCallback(() => {
    stop();
    setState((s) => ({ ...s, running: false, done: 0, total: 0 }));
  }, [stop]);

  const run = useCallback(
    (request: SweepRequest) => {
      stop();
      setState({
        suite: null,
        running: true,
        done: 0,
        // One run per configuration per seed — derived, so adding a
        // configuration cannot silently desynchronise the progress bar.
        total: CONFIG_KEYS.length * request.repeats,
        error: null,
      });

      const w = new Worker(new URL("./experiments.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.current = w;

      w.onmessage = (event: MessageEvent<SweepResponse>) => {
        const message = event.data;
        if (message.type === "progress") {
          setState((s) => ({ ...s, done: message.done, total: message.total }));
          return;
        }
        if (message.type === "done") {
          setState((s) => ({ ...s, suite: message.suite, running: false }));
        } else {
          setState((s) => ({ ...s, error: message.message, running: false }));
        }
        stop();
      };

      w.onerror = (event) => {
        setState((s) => ({
          ...s,
          error: event.message || "The sweep failed to run.",
          running: false,
        }));
        stop();
      };

      // Handlers first, then hand it the work — otherwise a fast worker can
      // reply before anything is listening.
      w.postMessage(request);
    },
    [stop],
  );

  return { ...state, run, cancel };
}
