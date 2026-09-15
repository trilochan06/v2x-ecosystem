/**
 * The guided stories have to finish — in front of an audience, on a seed
 * nobody chose.
 *
 * The demo page builds its city from a random seed every time it is reset, so
 * "it worked when I tried it" is not evidence of anything. These run each
 * story over a spread of seeds and require every non-optional beat to land on
 * every one of them. A story that only mostly works is a story that will fail
 * during the one run that matters.
 *
 * This is also the test that would have caught the regression it was written
 * for: with too little traffic, a crash has no second witness, corroboration
 * never happens, and the fourth beat of the headline story stays dark about
 * one run in six.
 */
import { describe, expect, it } from "vitest";

import { SimulationEngine } from "./engine";
import { GUIDED_GRID_SIZE, GUIDED_RSU_COUNT, GUIDED_VEHICLE_COUNT } from "./guidedRuntime";
import { ALL_SCENARIOS, baselineOf } from "./scenarios";
import type { Scenario } from "./scenarios";

const WARM_UP_TICKS = 90;
const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];

/** Play one story to its end and report which beats landed. */
function play(scenario: Scenario, seed: number): (number | null)[] {
  const engine = new SimulationEngine({
    seed,
    gridSize: GUIDED_GRID_SIZE,
    numRsus: GUIDED_RSU_COUNT,
    numVehicles: GUIDED_VEHICLE_COUNT,
    autoHazards: false,
  });
  for (let i = 0; i < WARM_UP_TICKS; i++) engine.step();

  const baseline = baselineOf(engine.stateSnapshot());
  scenario.setup(engine);

  const achieved: (number | null)[] = scenario.beats.map(() => null);
  // Generous: the declared length is how long the story is expected to take,
  // and a viewer can always leave it running. What must not happen is a beat
  // that never lands at all.
  for (let t = 0; t < scenario.ticks * 3 + 60; t++) {
    engine.step();
    const state = engine.stateSnapshot();
    scenario.beats.forEach((beat, i) => {
      if (achieved[i] === null && beat.done(state, baseline)) achieved[i] = state.tick;
    });
  }
  return achieved;
}

describe("every guided story completes on every seed", () => {
  for (const scenario of ALL_SCENARIOS) {
    it(`${scenario.id}: ${scenario.title}`, () => {
      const failures: string[] = [];
      for (const seed of SEEDS) {
        const achieved = play(scenario, seed);
        scenario.beats.forEach((beat, i) => {
          if (!beat.optional && achieved[i] === null)
            failures.push(`seed ${seed}: “${beat.text}” never happened`);
        });
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("the stories are honest about what may not happen", () => {
  it("marks as optional exactly those beats that genuinely miss sometimes", () => {
    // A beat that always fires should not be hedged, and a beat that sometimes
    // does not must be — otherwise a dark line reads as a broken demo rather
    // than as a lossy radio behaving correctly, and an audience learns to
    // discount the hedges that do matter.
    const overHedged: string[] = [];
    for (const scenario of ALL_SCENARIOS) {
      const runs = SEEDS.map((seed) => play(scenario, seed));
      for (const [i, beat] of scenario.beats.entries()) {
        if (!beat.optional) continue;
        if (runs.every((achieved) => achieved[i] !== null))
          overHedged.push(`${scenario.id}: “${beat.text}” fired on all ${SEEDS.length} seeds`);
      }
    }
    expect(overHedged).toEqual([]);
  });
});
