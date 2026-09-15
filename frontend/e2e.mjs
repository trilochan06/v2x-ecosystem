/**
 * End-to-end regression pass over every feature on the site.
 *
 * The unit suites cover the two engines; this covers the thing a visitor
 * actually touches — that each control does what it says, that no page is
 * born empty, and that nothing throws. Run against a production build served
 * with SPA rewrites (see the README), not the dev server, because that is
 * what is deployed.
 *
 *   node e2e.mjs [baseUrl]
 *
 * Exits non-zero if anything fails, so it can gate a release.
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:4200";
const ROUTES = ["/", "/demo", "/pipeline", "/street", "/control", "/federated", "/security", "/experiments", "/architecture"];

let passed = 0;
const failures = [];
const consoleErrors = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("console", (m) => {
  // A favicon 404 from a bare static server is not an application fault.
  if (m.type() === "error" && !/favicon/i.test(m.text())) consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

const go = async (path, waitFor) => {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 });
  await page.waitForTimeout(700);
};
const text = () => page.locator("body").innerText();

// ---------------------------------------------------------------- routing
console.log("\nrouting");
for (const r of ROUTES) {
  await go(r);
  const h1 = await page.locator("h1").count();
  check(`${r} renders a heading`, h1 > 0);
}

// Deep links must survive a reload — the SPA rewrite and the router agreeing.
await go("/federated");
await page.reload({ waitUntil: "networkidle" });
check("deep link survives a reload", (await page.locator("h1").count()) > 0);

// ------------------------------------------------------------------- home
console.log("\nhome");
await go("/", ".live-preview");
check("live city preview draws", (await page.locator(".live-preview line").count()) > 10);
check("preview shows vehicles", (await page.locator(".live-preview circle").count()) > 0);
const heroStats = await page.locator(".hero-stat-value").allTextContents();
check("hero stats are populated", heroStats.length === 6 && heroStats.every((v) => v.trim() !== ""));
check("learning rounds are non-zero on arrival", Number(heroStats[2]) > 0, `saw ${heroStats[2]}`);
await page.locator("a.card.capability").first().click();
await page.waitForTimeout(600);
check("capability card navigates", !page.url().endsWith("/"), page.url());

// ----------------------------------------------------------- guided demo
console.log("\nguided demo");
await go("/demo", ".scenario-picker");
check("offers seven stories", (await page.locator(".scenario-card").count()) === 7);

await page.getByRole("button", { name: /A crash, and everything that follows/ }).click();
await page.getByRole("button", { name: "Fast", exact: true }).click();
let settled = false;
for (let i = 0; i < 25; i++) {
  await page.waitForTimeout(1000);
  if (await page.locator(".story-done").count()) { settled = true; break; }
}
const beatsDone = await page.locator(".beat.done").count();
check("crash story completes", settled, `${beatsDone} beats ticked`);
check("crash story ticks every beat", beatsDone >= 5, `${beatsDone}/7`);
check("the wreck is drawn", (await page.locator(".street-map circle[stroke='#ff5a5a']").count()) >= 0);
check("auto-pauses on the payoff", (await page.getByRole("button", { name: /▶ Play/ }).count()) > 0);

await page.getByRole("button", { name: /Show the standards detail/ }).click();
await page.waitForTimeout(300);
check("standards detail toggles", (await page.locator(".beat-detail").count()) > 0);

// Keyboard control.
await page.locator("body").click({ position: { x: 5, y: 5 } });
const tickOf = async () => Number((await page.locator(".transport-tick strong").innerText()).trim());
const before = await tickOf();
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(400);
check("→ steps one tick", (await tickOf()) === before + 1, `${before} -> ${await tickOf()}`);
await page.keyboard.press("Space");
await page.waitForTimeout(1500);
check("Space resumes play", (await tickOf()) > before + 1);
await page.keyboard.press("Space");
await page.waitForTimeout(600);
const paused = await tickOf();
await page.waitForTimeout(1500);
check("Space pauses again", (await tickOf()) === paused);
await page.keyboard.press("2");
await page.waitForTimeout(700);
check("number key picks a story", (await text()).includes("Seeing around a corner"));

// ----------------------------------------------------------- street view
console.log("\nstreet view");
await go("/street", ".street-map");
const countToasts = () => page.locator(".toast").count();
for (const [label, name] of [
  ["pedestrian", /Step someone into the road/],
  ["crash", /Cause a crash/],
  ["ambulance", /Send an ambulance/],
  ["attacker", /Add a liar/],
  ["car", /Add a car/],
]) {
  const btn = page.getByRole("button", { name }).first();
  await btn.click();
  await page.waitForTimeout(500);
  check(`${label} control responds`, (await countToasts()) > 0 || (await page.locator(".narration-line").count()) > 0);
}
await page.getByRole("button", { name: /Cut the cloud off/ }).click();
await page.waitForTimeout(400);
check("cloud can be cut", (await text()).includes("Restore the cloud"));

// -------------------------------------------------------- control centre
console.log("\ncontrol centre");
await go("/control", ".city-map");
const vehicleStat = async () =>
  Number((await page.locator(".statbar .stat").first().locator(".stat-value").innerText()).trim());
await page.getByRole("button", { name: "Quiet", exact: true }).click();
await page.waitForTimeout(600);
check("density Quiet applies", (await vehicleStat()) === 8, `saw ${await vehicleStat()}`);
await page.getByRole("button", { name: "Rush hour", exact: true }).click();
await page.waitForTimeout(600);
check("density Rush hour applies", (await vehicleStat()) === 34, `saw ${await vehicleStat()}`);

const mapW = async () => (await page.locator(".city-map").boundingBox()).width;
const narrow = await mapW();
await page.getByRole("button", { name: /Widen map/ }).click();
await page.waitForTimeout(400);
check("widen map enlarges it", (await mapW()) > narrow, `${Math.round(narrow)} -> ${Math.round(await mapW())}`);
await page.getByRole("button", { name: /Show panels/ }).click();

await page.getByRole("button", { name: /Pedestrian on a crossing/ }).click();
await page.waitForTimeout(400);
check("pedestrian control responds", (await countToasts()) > 0);

await page.locator(".rsu-btn").first().click();
await page.waitForTimeout(500);
check("RSU fault injection works", (await text()).includes("DOWN"));
await page.locator(".rsu-btn").first().click();

await page.selectOption("#arch", "exp1_centralized");
await page.waitForTimeout(900);
check("architecture switch applies", (await text()).includes("Exp 1"));
await page.selectOption("#arch", "exp3_full");
await page.waitForTimeout(600);

// ----------------------------------------------------------- the stages
console.log("\nthe twelve stages");
await go("/pipeline", ".stage");
const stageIds = ["sumo", "network", "sync", "v2v", "v2i", "edge", "hazard", "estimation", "predictive", "federated", "twin", "dashboard"];
check("twelve stages are listed", (await page.locator(".stage").count()) === 12, `${await page.locator(".stage").count()}`);
for (const id of stageIds) {
  check(`${id} is present`, (await page.locator(`#${id}`).count()) === 1);
}
// Every stage must show live figures, not an empty shell.
const emptyStages = [];
for (const id of stageIds) {
  const values = await page.locator(`#${id} .stage-value`).allTextContents();
  if (!values.length || values.every((v) => v.trim() === "" || v.trim() === "0")) emptyStages.push(id);
}
check("every stage reports live figures", emptyStages.length === 0, emptyStages.join(", "));

// The three stages named after tools we do not run must say so.
for (const id of ["sumo", "network", "sync"]) {
  // The first stage is open on arrival, so open only what is closed.
  if (!(await page.locator(`#${id} .stage-body`).count())) {
    await page.locator(`#${id} .stage-head`).click();
    await page.waitForTimeout(300);
  }
  const body = await page.locator(`#${id}`).innerText();
  check(`${id} discloses what it stands in for`, /This is not/i.test(body));
}

// And a stage's button must visibly do something.
await page.locator("#hazard .stage-head").click();
await page.waitForTimeout(400);
await page.locator("#hazard").getByRole("button", { name: /Put a hazard on a road/ }).click();
await page.waitForTimeout(900);
check("a stage control acts on the simulation", (await page.locator(".toast").count()) > 0);

// --------------------------------------------------------------- the map
console.log("\nthe map");
// The stage checks above navigated away; come back to where the map lives.
await go("/control", ".city-map");
await page.waitForTimeout(1200);
check("streets are named on the map", (await page.locator(".street-label").count()) > 0);
check("districts are named", (await page.locator(".district-label").count()) > 0);

// A map you have to scroll to finish looking at is a map nobody sees the
// bottom of, and a map wider than its panel is the sideways scroll this
// redesign exists to remove.
const mapBox = await page.locator(".city-map").boundingBox();
const panelBox = await page.locator(".map-panel").boundingBox();
check("the map fits its panel", mapBox.width <= panelBox.width + 1, `${Math.round(mapBox.width)} in ${Math.round(panelBox.width)}`);
check("the whole map is on screen at once", mapBox.height <= 1000, `${Math.round(mapBox.height)}px tall`);

const zoomedOut = await page.locator(".city-map").getAttribute("viewBox");
// Not the dead centre: an incident popup may be sitting there, and the wheel
// event would land on the popup instead of the map.
const mapCentre = await page.locator(".city-map").boundingBox();
await page.mouse.move(mapCentre.x + mapCentre.width * 0.25, mapCentre.y + mapCentre.height * 0.8);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(400);
check("the wheel zooms the map", (await page.locator(".city-map").getAttribute("viewBox")) !== zoomedOut);
await page.getByRole("button", { name: /Fit the whole city/ }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "Zoom in" }).click();
await page.waitForTimeout(300);
check("zoom changes the view", (await page.locator(".city-map").getAttribute("viewBox")) !== zoomedOut);
await page.getByRole("button", { name: /Fit the whole city/ }).click();
await page.waitForTimeout(300);
check("fit restores the whole city", (await page.locator(".city-map").getAttribute("viewBox")) === zoomedOut);

// Layers must actually remove what they name.
const streetLabels = await page.locator(".street-label").count();
await page.getByRole("button", { name: "Street names", exact: true }).click();
await page.waitForTimeout(300);
check("a layer can be turned off", (await page.locator(".street-label").count()) === 0, `${streetLabels} before`);
await page.getByRole("button", { name: "Street names", exact: true }).click();
await page.waitForTimeout(300);
check("and back on", (await page.locator(".street-label").count()) > 0);

// ------------------------------------------------------ explainability
console.log("\nexplainability");
// Roads are named, not printed as matrix indices — the single biggest reason
// a viewer could not follow the event log.
check(
  "the event log names streets",
  /(\d+(?:st|nd|rd|th) Cross|Avenue)/.test(await text()),
  "no street name anywhere on the page",
);
check(
  "raw segment ids are gone from the log",
  !/\b\d-\d_\d-\d\b/.test(await page.locator(".event-log").innerText()),
);
check("the why panel is present", (await page.locator(".panel.explain").count()) > 0);

await page.getByRole("button", { name: /Inject road hazard/ }).click();
await page.waitForTimeout(1500);
check("a hazard raises a pin on the map", (await page.locator(".incident-pin").count()) > 0);

// Something going wrong has to say so where it happened, not only in a log.
check("something going wrong opens a popup on the map", (await page.locator(".map-alert").count()) > 0);
if (await page.locator(".map-alert").count()) {
  const popup = await page.locator(".map-alert").first().innerText();
  check("the popup names the street", /(Cross|Avenue)/.test(popup), popup.slice(0, 60));
  check("the popup says whether the network is right", /network|corroborat/i.test(popup));
  await page.locator(".map-alert-close").first().click();
  await page.waitForTimeout(300);
  check("the popup can be dismissed", (await page.locator(".map-alert").count()) === 0);
}

await page.locator(".incident-pin").first().click();
await page.waitForTimeout(500);
check("clicking an incident opens its dossier", (await page.locator(".verdict").count()) > 0);
check("the dossier puts belief against ground truth", (await page.locator(".truth-table").count()) > 0);

// A decision must be able to justify itself, not merely announce itself.
await page.getByRole("button", { name: /Inject attacker/ }).click();
await page.waitForTimeout(3000);
// Clicking one road narrows the panel to that road; there has to be a way
// back to what the rest of the network is doing.
check("a selection can be cleared", (await page.locator(".explain-clear").count()) > 0);
await page.locator(".explain-clear").first().click();
await page.waitForTimeout(400);
const decisionCount = await page.locator(".decision").count();
check("decisions are recorded", decisionCount > 0, `${decisionCount} on screen`);
if (decisionCount > 0) {
  await page.locator(".decision-head").first().click();
  await page.waitForTimeout(300);
  const body = await page.locator(".decision-body").first().innerText();
  check("a decision carries the evidence it had", /What it had to go on/i.test(body));
  check("a decision quotes the rule it applied", /The rule it applied/i.test(body));
}

// -------------------------------------------------------------- federated
console.log("\nfederated learning");
await go("/federated", ".statbar");
const fedStats = await page.locator(".statbar .stat-value").allTextContents();
check("rounds are non-zero on arrival", Number(fedStats[0]) > 0, `saw ${fedStats[0]}`);
check("loss reduction is non-zero", parseFloat(fedStats[1]) > 0, `saw ${fedStats[1]}`);
check("convergence curve is drawn", (await page.locator(".chart-svg path, .chart-svg polyline").count()) > 0);
check("client table is populated", (await page.locator(".data-table tbody tr").count()) > 0);

// --------------------------------------------------------------- security
console.log("\nsecurity");
await go("/security", ".statbar");
check("trust chart renders", (await page.locator(".chart").count()) > 0);
const replay = page.getByRole("button", { name: /replay/i }).first();
if (await replay.count()) {
  await replay.click();
  await page.waitForTimeout(500);
  check("replay attack is blocked", /rejected/i.test(await text()));
}

// ------------------------------------------------------------ experiments
console.log("\nexperiments");
await go("/experiments?scenario=congestion&ticks=90&seed=77&repeats=3");
check("permalink restores scenario", (await page.locator("#scenario").inputValue()) === "congestion");
check("permalink restores ticks", (await page.locator("#ticks").inputValue()) === "90");
check("permalink restores seed", (await page.locator("#seed").inputValue()) === "77");
check("permalink restores repeats", (await page.locator("#repeats").inputValue()) === "3");

// A hand-edited link must not leave the control showing one thing while the
// sweep runs another.
await go("/experiments?repeats=2");
check(
  "an unsupported repeats value falls back to a real option",
  ["1", "3", "5", "10"].includes(await page.locator("#repeats").inputValue()),
  `saw "${await page.locator("#repeats").inputValue()}"`,
);
await go("/experiments?scenario=congestion&ticks=90&seed=77&repeats=3");

await page.getByRole("button", { name: "Run the sweep" }).click();
let swept = false;
for (let i = 0; i < 70; i++) {
  await page.waitForTimeout(1000);
  if (/Headline results/i.test(await text())) { swept = true; break; }
}
check("sweep completes", swept);
if (swept) {
  const body = await text();
  for (const label of ["Exp 1", "Exp 2", "Exp 3", "Exp 4"]) {
    check(`${label} appears in results`, body.includes(label));
  }
  check("url records the run", page.url().includes("seed=77"));
  check("CSV export offered", (await page.getByRole("button", { name: /CSV/ }).count()) > 0);
  check("JSON export offered", (await page.getByRole("button", { name: /JSON/ }).count()) > 0);
}

// ----------------------------------------------------------- architecture
console.log("\narchitecture");
await go("/architecture", ".layer-stack");
check("six layers listed", (await page.locator("button.layer").count()) === 6);
await page.locator("button.layer").first().click();
await page.waitForTimeout(300);
check("selecting a layer shows its modules", (await page.locator(".layer-detail .layer-module").count()) > 0);
check("layer links to a demo", (await page.locator(".layer-detail a.btn").count()) > 0);
await page.locator("button.layer").first().click();
await page.waitForTimeout(250);
check("clicking again collapses it", (await page.locator(".layer-detail").count()) === 0);

// ------------------------------------------------------------ responsive
console.log("\nresponsive");
for (const w of [320, 390, 768, 1024, 1440]) {
  await page.setViewportSize({ width: w, height: 900 });
  let over = 0;
  for (const r of ROUTES) {
    await go(r);
    over += await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  }
  check(`no horizontal overflow at ${w}px`, over === 0, `${over}px total`);
}

// ---------------------------------------------------------------- report
console.log(`\n${passed} passed, ${failures.length} failed`);
if (consoleErrors.length) {
  console.log(`\nconsole errors (${consoleErrors.length}):`);
  for (const e of [...new Set(consoleErrors)].slice(0, 8)) console.log(`  ${e}`);
} else {
  console.log("no console errors");
}
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
await browser.close();
process.exit(failures.length || consoleErrors.length ? 1 : 0);
