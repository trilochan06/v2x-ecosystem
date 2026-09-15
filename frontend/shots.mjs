/**
 * One screenshot per stage, from the running site.
 *
 * Opens each stage, lets the simulation get somewhere interesting first, and
 * clips to the stage's own panel so the picture is of that stage rather than
 * of a page with that stage somewhere on it.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "shots";
mkdirSync(OUT, { recursive: true });

const STAGES = [
  ["01", "sumo", "SUMO Traffic Simulation"],
  ["02", "network", "V2X Network Simulation"],
  ["03", "sync", "SUMO to Veins Synchronisation"],
  ["04", "v2v", "V2V Message Exchange"],
  ["05", "v2i", "Vehicle-to-RSU Communication"],
  ["06", "edge", "RSU Edge Processing"],
  ["07", "hazard", "Hazard Detection"],
  ["08", "estimation", "Traffic-State Estimation"],
  ["09", "predictive", "Predictive Intelligence"],
  ["10", "federated", "Federated Learning"],
  ["11", "twin", "Transportation Digital Twin"],
  ["12", "dashboard", "Visualization Dashboard"],
];

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2 });

await p.goto("http://localhost:4200/pipeline", { waitUntil: "networkidle" });
// Let the city build up a history so every stage has something to show:
// federated rounds, corroborated incidents, handovers, forecasts.
await p.waitForTimeout(12000);

for (const [n, id, label] of STAGES) {
  const section = p.locator(`#${id}`);
  await section.scrollIntoViewIfNeeded();
  // Open this stage and close the rest, so the shot is of one thing.
  const isOpen = await section.locator(".stage-body").count();
  if (!isOpen) await section.locator(".stage-head").click();
  await p.waitForTimeout(900);
  await section.scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
  await section.screenshot({ path: `${OUT}/${n}-${id}.png` });
  console.log(`${n} ${label}`);
  await section.locator(".stage-head").click();
  await p.waitForTimeout(250);
}

// And the two pages the stages are about, for context.
await p.goto("http://localhost:4200/control", { waitUntil: "networkidle" });
await p.waitForTimeout(4000);
await p.getByRole("button", { name: /Inject road hazard/ }).click();
await p.waitForTimeout(2500);
await p.screenshot({ path: `${OUT}/00-control-centre.png` });
console.log("00 Control centre");

await p.goto("http://localhost:4200/street", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
await p.getByRole("button", { name: /^▶ Play/ }).click();
await p.waitForTimeout(6000);
await p.screenshot({ path: `${OUT}/00-street-view.png` });
console.log("00 Street view");

await b.close();
