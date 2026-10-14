/**
 * The help panel's answers.
 *
 * Rule-based on purpose, not as a fallback. The site is a static bundle with
 * no server, so any API key shipped with it is readable by every visitor —
 * there is nowhere to keep a secret. That constraint turns out to cost less
 * than it sounds, because the questions people ask here are about *this*
 * simulation, and this simulation can be read directly. "Why did I get a
 * collision warning?" is better answered by looking at the alert that fired
 * and the vehicle that caused it than by a language model guessing from a
 * description of it.
 *
 * Two kinds of answer live here. Definitions explain a term — what a CPM is,
 * what FedAvg does — and are the same every time. Readings answer a question
 * about the run in front of you, and are assembled from live state, so they
 * cite the actual numbers and change as the simulation does. Where an answer
 * would be a guess, it says so rather than inventing one.
 */
import type { PovAlert, PovState } from "./pov";
import type { SimulationState } from "../types";

export interface Answer {
  title: string;
  /** Paragraphs. Kept as an array so the panel can space them properly. */
  body: string[];
  /** Follow-ups worth offering after this answer. */
  related: string[];
}

export interface Topic {
  id: string;
  /** What the viewer sees on the suggestion chip. */
  question: string;
  /** Words that should match this topic, beyond those in the question. */
  keywords: string[];
  answer: (ctx: AssistantContext) => Answer;
}

export interface AssistantContext {
  state: SimulationState | null;
  pov: PovState | null;
  /** The alert the viewer clicked "Explain this" on, if any. */
  alert: PovAlert | null;
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

// --------------------------------------------------------------- topics

const TOPICS: Topic[] = [
  {
    id: "cpm",
    question: "What is a CPM, and why does it matter here?",
    keywords: ["cpm", "collective", "perception", "sensor", "share", "see"],
    answer: () => ({
      title: "Collective perception (CPM)",
      body: [
        "A Collective Perception Message is how one vehicle tells its neighbours what its sensors can see — not where it is, which is what a CAM does, but what else is on the road.",
        "It earns its bandwidth in two places in this simulation. A vehicle turning into a crossing cannot see the pedestrian on it, because the corner is in the way; a vehicle already on that road can, and says so. And a bicycle carries no radio at all, so a CPM from a passing car is the only way the network ever learns a cyclist is in the lane.",
        "Both cases have the same shape: the vehicle that needs to know cannot see, and the vehicle that can see has no need to act. That gap is the whole argument for spending the airtime.",
      ],
      related: ["vru", "pov-empty"],
    }),
  },
  {
    id: "vru",
    question: "Why does a bicycle get no alerts?",
    keywords: ["bicycle", "cycle", "bike", "vru", "unprotected", "obu", "equipped", "silent"],
    answer: ({ pov }) => ({
      title: "A bicycle has no on-board unit",
      body: [
        "It is a road user, not a network node. It transmits no CAM, no DENM, no intent, and it announces nothing even after a collision — and because it has no receiver either, nothing can be sent to it.",
        pov && !pov.equipped
          ? `That is why ${pov.vehicleId} shows an empty alert list. It is not a fault in the display: there is genuinely nothing reaching it.`
          : "Select a bicycle and enter its view: the alert list is empty however much is happening around it. Then select a car on the same road and watch it being warned about the cyclist.",
        "This is the case collective perception exists for. The network knows the cyclist is there only because an equipped vehicle saw them and shared it, under the ETSI cause code for a human on the road with the subcause for a cyclist — which is what lets a receiver tell a cyclist in the lane from a pedestrian on a crossing.",
      ],
      related: ["cpm", "pcu"],
    }),
  },
  {
    id: "pcu",
    question: "Why is a bus 'worth' more than a bicycle on a road?",
    keywords: ["pcu", "passenger car unit", "occupancy", "size", "bus", "truck", "space"],
    answer: ({ state }) => ({
      title: "Road space is counted in car-equivalents",
      body: [
        "Occupancy here is not a headcount. Each road user contributes its passenger-car units — the standard way traffic engineering counts mixed traffic — so a bus weighs 2.5 cars, a truck 2, an auto-rickshaw 0.5, a motorbike 0.35 and a bicycle 0.2. Four car-equivalents saturate a 250 m segment.",
        "This is not cosmetic. Occupancy is an input to the congestion model, so counting a bicycle and an articulated truck as one vehicle each would have taught the model that a cycle route is congested and a bus corridor is clear.",
        state
          ? `Right now the busiest road in the city is at ${pct(
              [...state.segments].sort((a, b) => b.occupancy - a.occupancy)[0]?.occupancy ?? 0,
            )} of jam density.`
          : "",
      ].filter(Boolean),
      related: ["vru", "congestion"],
    }),
  },
  {
    id: "twin",
    question: "What is the digital twin actually doing?",
    keywords: ["twin", "replica", "mirror", "divergence", "sync", "stale"],
    answer: ({ state }) => ({
      title: "The twin, and how far it can be trusted",
      body: [
        "It is a separate replica of every road's state, refreshed on a bounded schedule rather than continuously — which is the point. A replica that was always perfect would be a view onto the data, not a model of it, and would have nothing to say about what synchronisation costs.",
        state
          ? `It has synced ${state.digital_twin.syncs} times, was last refreshed ${state.digital_twin.staleness_ticks} ticks ago, and its mean error against the physical road is ${state.digital_twin.divergence}.`
          : "",
        "Because it is entitled to compare its own belief against physical truth, it doubles as a detector. An unmodelled incident is a real hazard nobody corroborated — the network is blind to something. A phantom incident is a confirmation with nothing behind it, which is what a successful injection looks like from outside.",
        "And it is what the what-if panel forecasts on, which is why every forecast is printed with the divergence beside it: a prediction from a replica is worth what the replica is worth.",
      ].filter(Boolean),
      related: ["whatif", "trust"],
    }),
  },
  {
    id: "whatif",
    question: "How does the what-if forecast work?",
    keywords: ["what if", "whatif", "forecast", "predict", "close", "rain", "fog", "preview"],
    answer: () => ({
      title: "Asking the twin before asking the city",
      body: [
        "It runs the same congestion model that serves every other forecast on this site over the twin's replica twice: once on the state as synced, once on the state as the change would leave it. The difference between those two forecasts is the predicted impact.",
        "It is not a second traffic simulator, and deliberately so — using the project's own model means the what-if is only as good as that model, which is the honest place for its accuracy to come from.",
        "Read the peak beside the mean. Closing a road spreads its traffic over the roads that meet it, which lowers an average while raising one junction, so the mean alone can call a change that concentrates pressure an improvement.",
        "Nothing moves on the road until you press apply. Preview and apply are separate controls on purpose.",
      ],
      related: ["twin", "congestion"],
    }),
  },
  {
    id: "federated",
    question: "What does federated learning gain, and what does it cost?",
    keywords: ["federated", "fedavg", "learning", "privacy", "weights", "model", "aggregate"],
    answer: ({ state }) => ({
      title: "Federated learning, and its measured price",
      body: [
        "Each roadside unit trains a congestion model on the observations it received and uploads parameters only. The samples never leave the unit that collected them; the aggregator sees weights and sample counts, nothing else.",
        "Aggregation is weighted by the corroboration-derived trust of each unit's sources, not purely by how much data it holds — plain FedAvg hands the loudest vote to whichever compromised unit sits on the busiest road.",
        state
          ? `Across ${state.federated.rounds_completed} rounds so far, the federated model scores ${state.federated.current_loss.toFixed(
              4,
            )} against ${state.federated.centralized_loss.toFixed(4)} for the same model trained on all the data pooled together — a difference of ${state.federated.privacy_cost_pct.toFixed(
              2,
            )}%. ${state.federated.total_raw_kilobytes_avoided.toFixed(0)} KB of observations stayed local; ${state.federated.total_weights_kilobytes.toFixed(
              2,
            )} KB of parameters crossed the network.`
          : "",
        "That gap is the whole claim, and it is measured every round rather than asserted.",
      ].filter(Boolean),
      related: ["trust", "twin"],
    }),
  },
  {
    id: "trust",
    question: "How does the network decide who to believe?",
    keywords: ["trust", "corroborat", "attacker", "malicious", "revoke", "quarantine", "security"],
    answer: ({ state }) => ({
      title: "Corroboration, not cryptography",
      body: [
        "Every message is signed, and every signature verifies — including the attacker's. Cryptography proves who sent a frame; it says nothing about whether the frame is true. An insider with a valid certificate is exactly the case signatures cannot address.",
        "So a hazard is believed only when independent witnesses report it within a window. A vehicle whose reports are never corroborated loses trust, is quarantined below a threshold, and has its certificate revoked if it keeps going.",
        state
          ? `There are ${Object.keys(state.trust ?? {}).length} stations in the trust registry right now.`
          : "",
        "Watch it on the Security page: inject an attacker from the control centre and follow its trust score down.",
      ].filter(Boolean),
      related: ["federated", "twin"],
    }),
  },
  {
    id: "congestion",
    question: "What is the congestion model predicting?",
    keywords: ["congestion", "model", "predict", "forecast", "occupancy", "risk", "explain"],
    answer: () => ({
      title: "The congestion forecast",
      body: [
        "Gradient-boosted trees, fitted offline in the Python pipeline and shipped as the exact same trees to the browser — the two agree to within 5e-07, so what you see here is what the report measured.",
        "It reads recent occupancy lags for a road, the time of day, whether an incident is confirmed on it, and the pressure on neighbouring roads. It predicts occupancy one horizon ahead.",
        "The explanation beside each prediction is an occlusion attribution: how far the forecast moves if one feature is set to its dataset-typical value. That says what drove *this* prediction, which a global importance score cannot.",
      ],
      related: ["whatif", "federated"],
    }),
  },
  {
    id: "pov-empty",
    question: "Why is this vehicle's alert list empty?",
    keywords: ["no alerts", "empty", "nothing", "quiet"],
    answer: ({ pov }) => ({
      title: pov ? `${pov.vehicleId} is not being told anything` : "An empty alert list",
      body: pov
        ? pov.equipped
          ? [
              "It is connected and listening — there is simply nothing to report. The road ahead is clear, no one nearby is braking, and the signal it is approaching is not holding it up.",
              "An empty list on an equipped vehicle is the normal state. Inject a hazard or dispatch an ambulance from the control centre and watch it fill.",
            ]
          : [
              "This road user has no on-board unit. It cannot receive anything, so the list is empty by construction rather than because the road happens to be quiet.",
              "Select a car on the same road to see what is being said about this one.",
            ]
        : ["Select a vehicle and enter its view first."],
      related: ["vru", "cpm"],
    }),
  },
];

// ------------------------------------------------------------ retrieval

/**
 * Words that carry no topic information.
 *
 * Without this list the matcher scored "the", "does" and "how" as hits, which
 * are in every topic's question, so any sentence of ordinary English matched
 * everything and the highest score went to whichever topic happened to be
 * wordiest. "What is the airspeed velocity of an unladen swallow" came back
 * as an explanation of the digital twin.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "has",
  "have", "was", "were", "this", "that", "with", "what", "why", "how", "does",
  "did", "when", "who", "which", "from", "into", "about", "there", "here",
  "its", "it's", "get", "got", "getting", "being", "been", "would", "could",
  "should", "will", "shall", "may", "might", "must", "them", "they", "their",
  "than", "then", "some", "such", "each", "other", "more", "most", "very",
  "work", "works", "working", "mean", "means", "happen", "happens", "tell",
  "show", "shows", "explain", "say", "says", "thing", "things", "one", "two",
]);

/**
 * Score a topic against a question.
 *
 * Whole words, not substrings — "car" must not match "cryptography" — and
 * keyword hits count double, because a topic's keyword list is what it is
 * actually about while its question is a sentence with grammar in it.
 *
 * A question this corpus does not cover has to fall through to a refusal
 * rather than to the nearest topic sharing a preposition, so the score is a
 * fraction of *meaningful* query words matched and the caller sets a floor.
 */
function score(topic: Topic, query: string): number {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (!words.length) return 0;

  const questionWords = new Set(
    topic.question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
  const keywords = topic.keywords.map((k) => k.toLowerCase());

  let hits = 0;
  for (const w of words) {
    // A keyword may be a phrase ("passenger car unit") or a stem ("corroborat"),
    // so a keyword matches if either contains the other.
    const keyed = keywords.some((k) => k.includes(w) || w.includes(k));
    if (keyed) hits += 2;
    else if (questionWords.has(w)) hits += 1;
  }
  return hits / (words.length * 2);
}

/** What an alert's `kind` is about, so "Explain this" lands on the right
 *  topic rather than on a keyword coincidence. */
const ALERT_TOPIC: Record<string, string> = {
  vulnerable_road_user: "vru",
  pedestrian: "cpm",
  forward_collision: "cpm",
  emergency_brake: "cpm",
  emergency_vehicle: "trust",
  hazard_ahead: "trust",
  congestion: "congestion",
  signal_phase: "congestion",
  road_condition: "whatif",
  speed_limit: "pcu",
  school_zone: "pcu",
  collision: "trust",
  priority_run: "trust",
};

export const SUGGESTIONS = TOPICS.map((t) => ({ id: t.id, question: t.question }));

export function explainAlert(alert: PovAlert, ctx: AssistantContext): Answer {
  const topic = TOPICS.find((t) => t.id === ALERT_TOPIC[alert.kind]);
  const base: Answer = {
    title: alert.title,
    body: [
      alert.detail,
      alert.advice ? `What to do: ${alert.advice}` : "",
      `This is a ${alert.priority} alert. Its machine name is "${alert.kind}".`,
    ].filter(Boolean),
    related: topic ? [topic.id] : [],
  };
  if (!topic) return base;
  const deeper = topic.answer(ctx);
  return {
    title: base.title,
    body: [...base.body, "", ...deeper.body],
    related: deeper.related,
  };
}

export function ask(query: string, ctx: AssistantContext): Answer {
  const trimmed = query.trim();
  if (!trimmed)
    return {
      title: "Ask about anything on screen",
      body: ["Pick a question below, or type one. It reads the running simulation, so answers cite the numbers in front of you."],
      related: TOPICS.slice(0, 3).map((t) => t.id),
    };

  const ranked = TOPICS.map((t) => ({ t, s: score(t, trimmed) })).sort((a, b) => b.s - a.s);
  const best = ranked[0];

  // A low score means the corpus does not cover it. Saying so is better than
  // answering a question that was not asked, which is the failure mode a
  // keyword matcher falls into most easily.
  if (!best || best.s < 0.25) {
    return {
      title: "I do not have an answer for that one",
      body: [
        "This panel answers from a fixed set of explanations about this simulation and from the live state of the run — it is not a language model, and it will not guess.",
        "These are the things it does cover:",
      ],
      related: TOPICS.map((t) => t.id),
    };
  }
  return best.t.answer(ctx);
}

export function answerFor(topicId: string, ctx: AssistantContext): Answer | null {
  const topic = TOPICS.find((t) => t.id === topicId);
  return topic ? topic.answer(ctx) : null;
}

export function questionFor(topicId: string): string {
  return TOPICS.find((t) => t.id === topicId)?.question ?? topicId;
}
