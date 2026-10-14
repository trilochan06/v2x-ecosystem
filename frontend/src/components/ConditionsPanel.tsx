import { useState } from "react";
import { commands } from "../sim/runtime";
import { buildReport, reportFilename } from "../sim/report";
import type { PovState } from "../sim/pov";
import type { SimulationState } from "../types";

/**
 * Weather, and getting a record of the run out of the page.
 *
 * The copy button is the primary action and the download the convenience,
 * not the other way round: a hosted page is sometimes sandboxed against
 * downloads it starts itself, and a button that silently does nothing is
 * worse than one that is clearly secondary.
 */
export function ConditionsPanel({
  state,
  pov,
}: {
  state: SimulationState;
  pov: PovState | null;
}) {
  const [note, setNote] = useState<string | null>(null);

  const say = (message: string) => {
    setNote(message);
    window.setTimeout(() => setNote(null), 4000);
  };

  const weather = (kind: "rain" | "fog") => {
    commands.applyIntervention({ kind });
    say(
      kind === "rain"
        ? "Rain across the city. Grip is down, so vehicles slow and roads hold more traffic at the same flow."
        : "Fog across the city. Visibility is down and the same applies, harder.",
    );
  };

  const copyReport = async () => {
    const text = buildReport(state, pov);
    try {
      await navigator.clipboard.writeText(text);
      say("Report copied. Paste it straight into your document.");
    } catch {
      say("The browser refused clipboard access — use Download instead.");
    }
  };

  const downloadReport = () => {
    const text = buildReport(state, pov);
    try {
      const blob = new Blob([text], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = reportFilename(state);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      say(`Saved ${reportFilename(state)}.`);
    } catch {
      say("This page cannot start a download here — use Copy instead.");
    }
  };

  return (
    <div className="panel conditions">
      <h2>Conditions &amp; report</h2>
      <p className="muted small">
        Weather applies to every road at once, which is how weather works. Preview it on the twin
        first if you want to see the forecast before committing it.
      </p>
      <div className="conditions__row">
        <button type="button" onClick={() => weather("rain")}>
          Heavy rain
        </button>
        <button type="button" onClick={() => weather("fog")}>
          Fog
        </button>
      </div>

      <h3 className="conditions__subhead">Record of this run</h3>
      <p className="muted small">
        Everything on screen at this instant — the traffic mix, what the network believed against
        what was real, the twin&rsquo;s divergence, and federated learning against its centralized
        counterfactual — as Markdown.
      </p>
      <div className="conditions__row">
        <button type="button" onClick={copyReport}>
          Copy report
        </button>
        <button type="button" onClick={downloadReport}>
          Download .md
        </button>
      </div>

      {note && <p className="conditions__note small">{note}</p>}
    </div>
  );
}
