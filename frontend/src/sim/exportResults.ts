import type { ExperimentSuite } from "../types";

/**
 * Getting results out of the page and into a report.
 *
 * Two routes, because one of them does not always work: a hosted artifact
 * sandboxes downloads the page starts itself, so `<a download>` is inert
 * there. Copy-to-clipboard works everywhere, so it is the primary action and
 * the download is the convenience.
 */

/** One row per configuration per metric, which is what pastes into a report. */
export function suiteToCsv(suite: ExperimentSuite): string {
  const rows: string[][] = [
    ["scenario", "ticks", "seeds", "config", "metric", "mean", "ci_half_width", "stdev", "n"],
  ];
  for (const agg of suite.aggregates) {
    for (const [metric, est] of Object.entries(agg.metrics)) {
      rows.push([
        suite.scenario.key,
        String(suite.ticks),
        suite.seeds.join(" "),
        agg.config_key,
        metric,
        String(est.mean),
        String(est.half_width),
        String(est.stdev),
        String(est.n),
      ]);
    }
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

/** Quote only when the value would otherwise break the row. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function suiteToJson(suite: ExperimentSuite): string {
  return JSON.stringify(suite, null, 2);
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Offer the text as a file. Returns false where the host blocks it, so the
 * caller can tell the user to copy instead of silently doing nothing.
 */
export function downloadText(filename: string, text: string, mime: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}

export function suiteFilename(suite: ExperimentSuite, extension: string): string {
  return `v2x-${suite.scenario.key}-${suite.ticks}t-${suite.repeats}seeds.${extension}`;
}
