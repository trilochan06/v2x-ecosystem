/**
 * The help panel's answers.
 *
 * The property that matters most is the one a keyword matcher gets wrong
 * easiest: answering a question that was not asked. A wrong-but-confident
 * answer about a safety mechanism is worse than no answer, so an unmatched
 * question has to fall through to a refusal rather than to whichever topic
 * shares the most prepositions.
 */
import { describe, expect, it } from "vitest";

import { SUGGESTIONS, answerFor, ask, explainAlert } from "./assistant";
import type { AssistantContext } from "./assistant";
import { SimulationEngine } from "./engine";

const run = (e: SimulationEngine, ticks: number) => {
  for (let i = 0; i < ticks; i++) e.step();
  return e;
};

const context = (): AssistantContext => {
  const e = run(
    new SimulationEngine({ seed: 17, gridSize: 5, numRsus: 6, numVehicles: 26, autoHazards: true }),
    120,
  );
  return { state: e.stateSnapshot(), pov: null, alert: null };
};

const empty: AssistantContext = { state: null, pov: null, alert: null };

describe("the help panel", () => {
  it("answers each of its own suggested questions", () => {
    const ctx = context();
    for (const s of SUGGESTIONS) {
      const answer = answerFor(s.id, ctx);
      expect(answer, s.id).not.toBeNull();
      expect(answer!.title.length).toBeGreaterThan(0);
      expect(answer!.body.length).toBeGreaterThan(0);
      for (const paragraph of answer!.body) expect(typeof paragraph).toBe("string");
    }
  });

  it("refuses a question it has no answer for", () => {
    const a = ask("what is the airspeed velocity of an unladen swallow", empty);
    expect(a.title).toMatch(/do not have an answer/i);
  });

  it("refuses rather than reaching for a loosely related topic", () => {
    // "model" appears in several topics; a bare keyword matcher would happily
    // answer this with the congestion model.
    const a = ask("who manufactures the cars in this city", empty);
    expect(a.title).toMatch(/do not have an answer/i);
  });

  it("finds the right topic from a natural question", () => {
    expect(ask("why does the bicycle get no alerts?", empty).title).toMatch(/on-board unit/i);
    expect(ask("what is a CPM", empty).title).toMatch(/collective perception/i);
    expect(ask("how does federated learning work", empty).title).toMatch(/federated/i);
    expect(ask("how does the network decide who to trust", empty).title).toMatch(/corroboration/i);
  });

  it("quotes the live run rather than generic figures", () => {
    const ctx = context();
    const text = answerFor("federated", ctx)!.body.join(" ");
    expect(text).toContain(ctx.state!.federated.rounds_completed.toString());
    expect(text).toMatch(/KB/);

    const twin = answerFor("twin", ctx)!.body.join(" ");
    expect(twin).toContain(ctx.state!.digital_twin.syncs.toString());
  });

  it("works with no simulation state at all", () => {
    // The panel renders before the first tick publishes.
    for (const s of SUGGESTIONS) {
      const answer = answerFor(s.id, empty);
      expect(answer).not.toBeNull();
      expect(answer!.body.every((p) => typeof p === "string")).toBe(true);
    }
  });

  it("explains an alert and then goes deeper on the mechanism behind it", () => {
    const ctx = context();
    const answer = explainAlert(
      {
        id: "vru",
        kind: "vulnerable_road_user",
        priority: "warning",
        title: "Cyclist in your lane",
        detail: "An unprotected road user is on this road.",
        advice: "Slow and leave room.",
      },
      ctx,
    );
    expect(answer.title).toBe("Cyclist in your lane");
    const text = answer.body.join(" ");
    expect(text).toContain("Slow and leave room");
    // and it carries on into why a cyclist is invisible to the network
    expect(text).toMatch(/on-board unit|collective perception|transmits no/i);
  });

  it("still explains an alert whose kind has no deeper topic", () => {
    const answer = explainAlert(
      {
        id: "odd",
        kind: "not_a_known_kind",
        priority: "info",
        title: "Something",
        detail: "A detail.",
      },
      empty,
    );
    expect(answer.title).toBe("Something");
    expect(answer.body.join(" ")).toContain("A detail.");
  });

  it("offers follow-ups that are real topics", () => {
    const ctx = context();
    const ids = new Set(SUGGESTIONS.map((s) => s.id));
    for (const s of SUGGESTIONS)
      for (const related of answerFor(s.id, ctx)!.related)
        expect(ids.has(related), `${s.id} -> ${related}`).toBe(true);
  });

  it("prompts rather than refusing when asked nothing", () => {
    expect(ask("   ", empty).title).toMatch(/ask about/i);
  });
});
