import type { SimulationState, Transmission } from "../types";

/**
 * What just happened, in words a person can read.
 *
 * The event feed on the control centre is written for someone who already
 * knows the system. This is written for someone who does not: it turns the
 * last few frames on the air into sentences about cars and roads, because
 * "CAM · 4 recipients" explains nothing to a viewer seeing V2X for the first
 * time.
 */

const CAUSE_NAMES: Record<number, string> = {
  2: "an accident",
  6: "a slippery surface",
  9: "a hazardous road surface",
  12: "someone on the road",
  19: "poor visibility",
  94: "a stopped vehicle",
  95: "an emergency vehicle approaching",
  99: "a dangerous situation",
};

interface Line {
  key: string;
  tick: number;
  tone: "cam" | "denm" | "signal" | "quiet";
  text: string;
}

export function Narration({ state, lines = 9 }: { state: SimulationState; lines?: number }) {
  const story = describe(state).slice(-lines).reverse();

  return (
    <div className="panel narration">
      <h2>What&rsquo;s happening</h2>
      <div className="narration-feed" role="log" aria-live="polite">
        {story.length === 0 && (
          <p className="muted small">
            Nothing on the air yet. Press <strong>Play</strong>, or step one tick at a time.
          </p>
        )}
        {story.map((line) => (
          <div key={line.key} className={`narration-line narration-${line.tone}`}>
            <span className="narration-tick">t{line.tick}</span>
            <span>{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function describe(state: SimulationState): Line[] {
  const out: Line[] = [];
  const name = (id: string) => (id.startsWith("rsu-") ? id.replace("rsu-", "Roadside unit ") : id);

  // Every signalised junction broadcasts on the same duty cycle, so on a
  // dense grid SPaT is most of the traffic and floods out everything worth
  // reading. One line per tick says the same thing and leaves room for the
  // events a viewer actually came to see.
  const spatPerTick = new Map<number, number>();
  for (const t of state.transmissions)
    if (t.designator === "SPATEM") spatPerTick.set(t.tick, (spatPerTick.get(t.tick) ?? 0) + 1);
  const spatEmitted = new Set<number>();

  for (const t of state.transmissions) {
    if (t.designator === "SPATEM") {
      if (spatEmitted.has(t.tick)) continue;
      spatEmitted.add(t.tick);
      const n = spatPerTick.get(t.tick) ?? 1;
      out.push({
        key: `spat-${t.tick}`,
        tick: t.tick,
        tone: "signal",
        text:
          n === 1
            ? `The signal at ${t.origin_node} broadcast its phase so approaching cars know what it will be doing.`
            : `${n} junctions broadcast their phase so approaching cars know what the lights will do.`,
      });
      continue;
    }

    const heard = t.delivered_to.length;
    const audience =
      heard === 0
        ? "nobody was in range to hear it"
        : `${heard} ${heard === 1 ? "station" : "stations"} picked it up`;

    out.push({ key: `${t.id}-${t.tick}`, tick: t.tick, ...phrase(t, name, audience) });
  }

  return out;
}

function phrase(
  t: Transmission,
  name: (id: string) => string,
  audience: string,
): { tone: Line["tone"]; text: string } {
  switch (t.designator) {
    case "CPM":
      // The turning case: one car's sensors, everybody's knowledge.
      return {
        tone: "denm",
        text:
          t.delivered_to.length === 0
            ? `${name(t.sender_id)} shared what its sensors can see on ${road(t.segment_id)} — nobody was in range to hear it.`
            : `${name(t.sender_id)} can see someone on ${road(t.segment_id)} and told ${t.delivered_to.length} nearby ${t.delivered_to.length === 1 ? "station" : "stations"} — including cars with no view of them.`,
      };
    case "DENM": {
      const cause = t.cause_code ? CAUSE_NAMES[t.cause_code] : undefined;
      if (t.type === "denm-eebl") {
        return {
          tone: "denm",
          text: `${name(t.sender_id)} braked hard on ${road(t.segment_id)} — the traffic behind was told before any driver could see the brake lights (${audience}).`,
        };
      }
      if (t.cause_code === 95) {
        return {
          tone: "denm",
          text: `${name(t.sender_id)} warned everyone that an emergency vehicle is coming through — ${audience}.`,
        };
      }
      return {
        tone: "denm",
        text: `${name(t.sender_id)} reported ${cause ?? "a hazard"} on ${road(t.segment_id)} — ${audience}.`,
      };
    }
    case "CAM":
      return {
        tone: "cam",
        text: `${name(t.sender_id)} shared how busy ${road(t.segment_id)} is — ${audience}.`,
      };
    case "SPATEM":
      return {
        tone: "signal",
        text: `The signal at ${t.origin_node} broadcast its phase so approaching cars know what it will be doing.`,
      };
    case "SREM":
      return {
        tone: "signal",
        text:
          t.delivered_to.length === 0
            ? `${name(t.sender_id)} asked the junction ahead for a green light — the request was not heard.`
            : `${name(t.sender_id)} asked the junction ahead for a green light.`,
      };
    case "SSEM":
      return { tone: "signal", text: `The junction granted priority and went green.` };
    default:
      return { tone: "quiet", text: `${name(t.sender_id)} transmitted a ${t.designator} frame.` };
  }
}

function road(segmentId?: string): string {
  if (!segmentId) return "its road";
  return segmentId.replace("_", "→");
}
