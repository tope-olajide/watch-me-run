// Does the temporary Orbis switch hold (see src/orbis/orbis-switch.ts)?
//
//   node tools/orbis-off-probe.mjs [app-url]
//   WORLD=forest node tools/orbis-off-probe.mjs
//
// With `ORBIS_DISABLED` on, this plays a real run and checks the four claims the switch makes:
//
//   - no session and no SDK: `WorldLayer` is never mounted (no `.world-layer`, `window.__orbisTrace`
//     undefined), the snapshot stays `idle`, and no resource fetched by the page matches
//     reactor/visko/WorldLayer;
//   - a fast start: the run hands over as soon as the loader's minimum is paid, not after the 55 s
//     Orbis fallback — measured from the Start press to the run surface;
//   - a live game: `window.__runfield()` reports the distance climbing and the runner moving;
//   - a working feed: the local chunk metronome drives the director, so the world-answers card
//     still receives the deal's `TERMS` line, and the prompts built along the way are journaled as
//     dropped rather than silently vanishing (`window.__orbisPrompts`).
//
// A dev server (`npm run dev`), because every readout is development-only.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_URL = process.argv[2] ?? "http://[::1]:5199/";
const PORT = Number(process.env.CDP_PORT ?? 9348);
const WORLD = process.env.WORLD ?? "forest";
/** How long the probe plays, in wall-clock seconds. Enough for the terms ask and a few answers. */ 
const PLAY_SECONDS = Number(process.env.PLAY_SECONDS ?? 16);
const EXPECTED_NOTE = "Orbis paused for testing";
const SOURCE_PATTERN = /WorldLayer|reactor|visko|orbis-sdk/i;

const profile = mkdtempSync(join(tmpdir(), "watchme-orbis-off-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--enable-unsafe-swiftshader",
    "--mute-audio",
    "--window-size=1280,720",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const round = (value) => Math.round(value * 10) / 10;

async function devtools(path, init) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
      if (response.ok) return response.json();
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("DevTools endpoint never came up");
}

function cdpSocket(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = [];
  let id = 0;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", (error) => reject(error));
  });

  return {
    ready,
    send(method, params = {}) {
      id += 1;
      const messageId = id;
      socket.send(JSON.stringify({ id: messageId, method, params }));
      return new Promise((resolve, reject) => pending.set(messageId, { resolve, reject }));
    },
    on(listener) {
      listeners.push(listener);
    },
    close: () => socket.close(),
  };
}

/**
 * Every line the world-answers card ever showed, recorded as it is added.
 *
 * The card keeps only its three newest entries, and the deal's `TERMS` line is one of the earliest,
 * so a read at the end of the run would miss it on a busy feed — the evidence has to be the record.
 */
const RECORDER = `(() => {
  window.__offProbe = { feed: [] };
  // The first entry mounts the whole <ul> in one DOM operation, so its <li> never appears as an
  // added node of its own — the added subtree has to be searched, not just the added node.
  const capture = (root) => {
    const items = [];
    if (root.matches?.(".director-feed li")) items.push(root);
    for (const item of root.querySelectorAll?.(".director-feed li") ?? []) items.push(item);
    for (const item of items) {
      window.__offProbe.feed.push({
        at: Date.now(),
        line: item.querySelector("b")?.textContent ?? "",
        detail: item.querySelector("span")?.textContent ?? "",
      });
    }
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) capture(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return true;
})()`;

const logs = [];
const faults = [];
const notes = [];

try {
  await devtools("/json/version");
  const targets = await devtools("/json/list");
  const blank = targets.find((target) => target.type === "page");
  const browserSocket = cdpSocket(blank.webSocketDebuggerUrl);
  await browserSocket.ready;
  const { targetId } = await browserSocket.send("Target.createTarget", { url: APP_URL });
  await sleep(1500);

  const pages = await devtools("/json/list");
  const page = pages.find((target) => target.id === targetId) ?? pages.find((t) => t.url.startsWith("http"));
  const pageSocket = cdpSocket(page.webSocketDebuggerUrl);
  await pageSocket.ready;

  pageSocket.on((message) => {
    if (message.method === "Runtime.consoleAPICalled") {
      const text = (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
      if (/orbis|reactor|visko/i.test(text)) logs.push(`[${stamp()}] ${text}`.slice(0, 260));
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      const text = details.exception?.description ?? details.text;
      logs.push(`[${stamp()}] exception ${text}`.slice(0, 400));
      faults.push(`exception: ${text}`.slice(0, 160));
    }
  });

  await pageSocket.send("Page.enable");
  await pageSocket.send("Runtime.enable");
  await pageSocket.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const result = await pageSocket.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  const json = async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`));

  const keyCodes = { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40 };
  const press = async (key) => {
    const code = keyCodes[key];
    await pageSocket.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, code: key, key });
    await pageSocket.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, code: key, key });
  };
  const clickAt = async (selector) => {
    // Scrolled into view first: a click dispatched at a point below the fold lands on nothing, which
    // is how the start button silently ignored the first version of this probe.
    const box = await json(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) return false;
    await pageSocket.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await pageSocket.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await pageSocket.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    return true;
  };
  const waitFor = async (expression, attempts = 100) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await evaluate(expression)) return true;
      await sleep(300);
    }
    return false;
  };

  await waitFor(`Boolean(document.querySelector(".world-card") && document.querySelector(".start-button"))`, 150);

  const before = await json(`(() => {
    const chip = document.querySelector(".engine-chip");
    return {
      chip: chip?.textContent?.trim() ?? null,
      layer: Boolean(document.querySelector(".world-layer")),
      local: Boolean(document.querySelector(".world-local")),
      trace: window.__orbisTrace !== undefined,
      status: window.__orbisWorld?.()?.status ?? null,
      resources: performance.getEntriesByType("resource").map((entry) => entry.name),
    };
  })()`);
  console.log(`${stamp()} menu: chip ${JSON.stringify(before.chip)} | world-layer ${before.layer} | world-local ${before.local} | trace ${before.trace} | status ${before.status}`);
  if (!before.chip?.includes(EXPECTED_NOTE)) faults.push(`the menu chip does not say the world is off: ${JSON.stringify(before.chip)}`);
  if (before.layer) faults.push("a world layer is mounted while Orbis is disabled");
  if (!before.local) faults.push("the local backdrop is missing");
  if (before.trace) faults.push("the world layer module was evaluated");
  if (before.status !== "idle") faults.push(`the snapshot reports ${before.status} before any run`);

  const picked = await evaluate(`(() => {
    const el = document.querySelector(".world-card.world-${WORLD}");
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!picked) faults.push(`${WORLD}: no world card`);
  await sleep(700);

  const pressedAt = Date.now();
  await clickAt(".start-button");

  // The loader is on screen for its minimum only; catch its copy while it is up.
  let loaderLine = null;
  let loaderStage = null;
  while (Date.now() - pressedAt < 8_000) {
    const surface = await evaluate(`document.documentElement.dataset.surface`);
    if (surface === "loading") {
      loaderLine = await evaluate(`document.querySelector(".loader-line")?.textContent ?? null`);
      loaderStage = await evaluate(`document.querySelector(".world-loader")?.dataset.stage ?? null`);
      break;
    }
    if (surface === "run") break;
    await sleep(120);
  }

  const runUp = await waitFor(`document.documentElement.dataset.surface === "run" && Boolean(window.__runfield)`, 60);
  const startMs = Date.now() - pressedAt;
  console.log(`${stamp()} loader: stage ${loaderStage} | ${JSON.stringify(loaderLine)}`);
  console.log(`${stamp()} run surface after ${startMs} ms (Orbis fallback would be 55 s)`);
  if (!runUp) faults.push("the run never came up");
  if (startMs > 12_000) faults.push(`the run took ${startMs} ms to start`);
  if (runUp) await evaluate(RECORDER);

  const samples = [];
  let myLane = 1;
  let lastLaneChange = 0;
  let over = false;
  const deadline = Date.now() + PLAY_SECONDS * 1000;

  while (runUp && Date.now() < deadline) {
    const field = await json(`window.__runfield?.() ?? null`);
    if (!field) {
      await sleep(200);
      continue;
    }
    samples.push({ distance: round(field.distance), speed: round(field.speed), score: Math.round(field.score), flow: round(field.flow), hits: field.damage, lane: field.lane });
    if (await evaluate(`Boolean(document.querySelector(".run-over-card"))`)) {
      over = true;
      break;
    }

    // Survival only: dodge what is in the lane, as early as a clear lane exists.
    const ahead = (field.obstacles ?? []).filter((obstacle) => obstacle.z < 3 && obstacle.z > 3 - 40);
    const inLane = ahead.filter((obstacle) => obstacle.lane === myLane).sort((a, b) => b.z - a.z)[0];
    if (inLane) {
      const metres = 3 - inLane.z;
      const clear = [0, 1, 2]
        .filter((other) => other !== myLane && !ahead.some((o) => o.lane === other && 3 - o.z < metres + 6))
        .sort((a, b) => Math.abs(a - myLane) - Math.abs(b - myLane));
      if (metres < 26 && clear.length && Date.now() - lastLaneChange > 250) {
        await press(clear[0] > myLane ? "ArrowRight" : "ArrowLeft");
        myLane = clear[0];
        lastLaneChange = Date.now();
      } else if (metres < 11) {
        await press(inLane.kind === "gate" ? "ArrowDown" : "ArrowUp");
      }
    }
    await sleep(140);
  }

  const after = await json(`(() => ({
    world: window.__orbisWorld?.() ?? null,
    journal: window.__orbisPrompts ?? [],
    resources: performance.getEntriesByType("resource").map((entry) => entry.name),
    trace: window.__orbisTrace !== undefined,
    layer: Boolean(document.querySelector(".world-layer")),
    chip: document.querySelector(".orbis-label")?.textContent?.trim() ?? null,
    feed: window.__offProbe?.feed ?? [],
  }))()`);

  const distance = samples[samples.length - 1]?.distance ?? 0;
  const peakSpeed = Math.max(...samples.map((sample) => sample.speed), 0);
  console.log(`\nplay: ${samples.length} samples | ${distance} m | peak speed ${peakSpeed} | over ${over}`);
  console.log(`hud chip: ${JSON.stringify(after.chip)}`);
  console.log(`feed: ${after.feed.map((entry) => `${entry.line} — ${entry.detail}`).join(" | ") || "(none)"}`);
  const dropped = after.journal.filter((entry) => entry.dropped).length;
  const accepted = after.journal.filter((entry) => entry.ok).length;
  console.log(`journal: ${after.journal.length} asks, ${dropped} dropped at the bus, ${accepted} accepted`);
  console.log(`journal tail: ${after.journal.slice(-10).map((entry) => `${entry.reason}@${entry.chunk ?? "?"}${entry.dropped ? " dropped" : entry.ok ? " ok" : ""}`).join(" | ") || "(none)"}`);
  const leaked = [...new Set([...before.resources, ...after.resources])].filter((name) => SOURCE_PATTERN.test(name));
  console.log(`resources matching react|visko|WorldLayer: ${leaked.length ? leaked.join(", ") : "none"}`);

  /* ---- verdict ---- */
  if (after.trace) faults.push("the world layer module was evaluated during the run");
  if (after.layer) faults.push("a world layer mounted during the run");
  if (after.world?.status !== "idle") faults.push(`the session status is ${after.world?.status}`);
  if (after.world?.sessionId) faults.push(`a session id exists: ${after.world.sessionId}`);
  if (after.world?.session?.started !== false) faults.push("a session reported itself started");
  if (!after.world?.session?.chunk) faults.push("the local chunk metronome never ticked");
  if (!after.chip?.includes(EXPECTED_NOTE)) faults.push(`the run chip does not say the world is off: ${JSON.stringify(after.chip)}`);
  if (leaked.length) faults.push(`Orbis code was fetched: ${leaked.join(", ")}`);
  if (samples.length < 5) faults.push("the run produced too few samples to judge");
  if (distance < 30) faults.push(`the run only reached ${distance} m`);
  if (peakSpeed <= 0) faults.push("the runner never moved");
  if (!after.journal.length) faults.push("no prompts were built at all");
  if (accepted) faults.push(`${accepted} prompts were accepted by a session that should not exist`);
  if (!dropped) faults.push("no prompt was journaled as dropped");
  if (!after.feed.some((entry) => /^TERMS/.test(entry.line))) faults.push("the deal's TERMS answer never reached the feed");
  if (over) notes.push("the probe's autopilot died inside the play window");
  if (loaderLine && !/paused for gameplay testing/i.test(loaderLine)) faults.push(`the loader line reads ${JSON.stringify(loaderLine)}`);
  if (loaderStage !== null && loaderStage !== "4") notes.push(`the loader showed stage ${loaderStage}`);

  console.log(`\nconsole:`);
  console.log(logs.filter((line) => /contract_taken|terms/i.test(line)).slice(0, 8).join("\n") || "  (no contract logs)");
  console.log(logs.slice(-8).join("\n") || "  (nothing matching)");
  console.log(`\nnotes: ${notes.join("; ") || "(none)"}`);
  console.log(`verdict: ${faults.length ? faults.join("; ") : "no faults"}`);
  if (faults.length) process.exitCode = 1;

  await evaluate(`window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }))`);
  await sleep(1500);
  await browserSocket.send("Target.closeTarget", { targetId: page.id });
} finally {
  chrome.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* the browser may still hold a handle */
  }
}
