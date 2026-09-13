/**
 * The experiment sweep, off the main thread.
 *
 * A sweep is 3 configurations x N seeds x several hundred ticks of a full
 * simulation. Run inline it blocks the event loop for up to a minute: the
 * page stops repainting, the button stays stuck mid-click, and during a live
 * demo it reads as a crash rather than as work in progress.
 *
 * Here it runs in a worker, so the page stays interactive, progress is
 * reported after every individual run, and the user can cancel — which is
 * just terminating the worker, since nothing is shared.
 */
import { runSuite } from "./experiments";
import type { ExperimentSuite } from "../types";

export interface SweepRequest {
  scenarioKey: string;
  ticks: number;
  seed: number;
  repeats: number;
}

export type SweepResponse =
  | { type: "progress"; done: number; total: number }
  | { type: "done"; suite: ExperimentSuite }
  | { type: "error"; message: string };

const post = (message: SweepResponse) => self.postMessage(message);

self.onmessage = (event: MessageEvent<SweepRequest>) => {
  const { scenarioKey, ticks, seed, repeats } = event.data;
  try {
    const suite = runSuite(scenarioKey, ticks, seed, repeats, (done, total) =>
      post({ type: "progress", done, total }),
    );
    post({ type: "done", suite });
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
