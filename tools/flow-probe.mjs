// Does the skill ceiling exist, and does the game pay for it?
//
//   node tools/flow-probe.mjs [app-url]
//   WORLD=forest node tools/flow-probe.mjs
//
// A run played to *seek* the good moments rather than to survive them: the autopilot dodges only what
// is in its lane, holds the middle whenever the two side lanes are blocked at the same z (a `pair`
// with the middle left open — the one geometry that is a thread), and otherwise stays put. Then it
// checks the three claims the flow feature makes:
//
//   - near misses build the meter, and a hit wipes it (read from `window.__runfield()`, which reports
//     the flow value, the gap count, the run's clock and where the camera has been dollied to);
//   - a gap taken threads it: the count goes up, the world is told (`GAP ×N` in the feed), the run's
//     clock drops below 1 for a moment (the slow-motion), and the camera dollies closer;
//   - the meter *pays*: the ground's own trickle is `12 + flow × 18` points a second, so the score
//     gained per second at high flow has to be measurably above the same figure at low flow — with the
//     tokens subtracted out, since those pay separately.
//
// A dev server (`npm run dev`), because the readout is development-only.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_URL = process.argv[2] ?? "http://[::1]:5199/";
const PORT = Number(process.env.CDP_PORT ?? 9344);
// The forest by default: its hazard is a change of visibility, so the probe's own lane is what it
// thinks it is. The desert's storm moves the runner without a key, which is exactly the confound this
// probe must not have.
const WORLD = process.env.WORLD ?? "forest";
const DEADLINE_MS = Number(process.env.DEADLINE_MS ?? 300_000);
/** The safe opening: distance played without taking a single near miss, for the baseline window. */
const CAUTIOUS_METRES = Number(process.env.CAUTIOUS_METRES ?? 120);

const profile = mkdtempSync(join(tmpdir(), "watchme-flow-"));
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
const round = (value) => Math.round(value * 100) / 100;

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

/** Every token the HUD paid, so the flow measurement can subtract what the coins gave. */
const RECORDER = `(() => {
  if (window.__flowProbe) {
    window.__flowProbe = { coins: [], feed: [] };
    return true;
  }
  window.__flowProbe = { coins: [], feed: [] };
  const coinObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || !node.classList?.contains("token-gain")) continue;
        window.__flowProbe.coins.push({
          value: Number(String(node.textContent).replace(/[^0-9.]/g, "")),
          at: performance.now(),
        });
      }
    }
  });
  coinObserver.observe(document.body, { childList: true, subtree: true });
  const feedObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || node.tagName !== "LI") continue;
        window.__flowProbe.feed.push({
          line: node.querySelector("b")?.textContent ?? "",
          detail: node.querySelector("span")?.textContent ?? "",
        });
      }
    }
  });
  feedObserver.observe(document.body, { childList: true, subtree: true });
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
      if (/three|shader|program|webgl|geometry|nan|dispose|error/i.test(text)) logs.push(`[${stamp()}] ${text}`.slice(0, 260));
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
    const box = await json(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
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
      await sleep(400);
    }
    return false;
  };

  await waitFor(`Boolean(document.querySelector(".world-card") && document.querySelector(".start-button"))`, 150);

  // Two runs at most: the first is played for flow, and if the meter never got off the ground the
  // second is played for it again rather than reporting the first as the only evidence.
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt === 1) {
      const picked = await evaluate(`(() => {
        const el = document.querySelector(".world-card.world-${WORLD}");
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!picked) {
        faults.push(`${WORLD}: no world card`);
        break;
      }
      await sleep(700);
      await evaluate(`document.querySelector(".start-button").click()`);
    }
    if (!(await waitFor(`document.documentElement.dataset.surface === "run" && Boolean(window.__runfield)`, 150))) {
      faults.push(`${WORLD}: the run never came up`);
      break;
    }
    await evaluate(RECORDER);

    const samples = [];
    const slowmo = [];
    const hudFlow = [];
    const hits = [];
    let myLane = 1;
    let lastLaneChange = 0;
    let over = false;
    const deadline = Date.now() + DEADLINE_MS / 2;

    while (Date.now() < deadline) {
      const field = await json(`(() => {
        const reading = window.__runfield?.() ?? null;
        return reading ? { ...reading, perf: performance.now() } : null;
      })()`);
      if (!field) {
        await sleep(200);
        continue;
      }
      const hud = await json(`(() => {
        const el = document.querySelector(".hud-flow");
        const card = Boolean(document.querySelector(".run-over-card"));
        return el ? { flow: el.dataset.flow, width: el.querySelector(".hud-flow-fill")?.style.width ?? null, text: el.textContent.trim().replace(/\\s+/g, " ") } : { card };
      })()`);

      // The page's own clock is the one the tokens are stamped with; the wall clock here drifts from it
      // by every CDP round trip, and the trickle measurement subtracts tokens by timestamp.
      myLane = field.lane;
      samples.push({
        at: Date.now(),
        perf: field.perf,
        distance: field.distance,
        damage: field.damage,
        score: field.score,
        flow: field.flow,
        threads: field.threads,
        speed: field.speed,
        timeScale: field.timeScale,
        cameraZ: field.cameraZ,
      });
      if (hud.flow) hudFlow.push({ flow: hud.flow, width: hud.width, text: hud.text, distance: field.distance });

      if (field.timeScale < 0.9) {
        slowmo.push({ distance: field.distance, timeScale: field.timeScale, cameraZ: field.cameraZ, flow: field.flow, threads: field.threads });
        console.log(
          `${stamp()} slow-motion at ${field.distance} m: clock ${field.timeScale}, camera z ${field.cameraZ}, flow ${field.flow}, gaps ${field.threads}`,
        );
      }
      if (field.threads > (samples[samples.length - 2]?.threads ?? 0)) {
        console.log(`${stamp()} gap threaded at ${field.distance} m (${field.threads} total)`);
      }
      const previousDamage = samples[samples.length - 2]?.damage ?? 0;
      if (field.damage > previousDamage) {
        // The sample just pushed *is* the wiped one: the reading that matters is the one before it.
        const before = samples[samples.length - 2]?.flow ?? 0;
        console.log(`${stamp()} hit at ${field.distance} m: flow ${before} → ${field.flow}`);
        hits.push({ distance: field.distance, before, after: field.flow });
      }

      if (hud.card) {
        over = true;
        break;
      }

      /* ---- the risk autopilot ---------------------------------------------------------------
         A dodge only happens when something is in the lane: every other obstacle is deliberately
         passed close by, which is what builds flow. The exception is the thread — two blocked side
         lanes and a free middle — which it holds on purpose. */
      const ahead = (field.obstacles ?? []).filter((obstacle) => obstacle.z < 3 && obstacle.z > 3 - 30);
      const inLane = ahead.filter((obstacle) => obstacle.lane === myLane).sort((a, b) => b.z - a.z)[0];
      // The opening seconds are played *safe*: nothing passed close, nothing threaded, so the trickle
      // measurement has a window of real low flow to compare against. A probe that is risky from the
      // first metre builds the meter before the first sample and can never report the baseline.
      const cautious = field.distance < CAUTIOUS_METRES;
      // A thread is a `pair` with the middle left open: an obstacle in each side lane at the same z.
      const sides = ahead.filter((obstacle) => obstacle.lane !== myLane);
      const threading =
        myLane === 1 &&
        sides.some((one) => sides.some((other) => other.lane !== one.lane && Math.abs(other.z - one.z) < 4));

      const clear = [0, 1, 2]
        .filter((other) => other !== myLane && !ahead.some((o) => o.lane === other))
        .sort((a, b) => Math.abs(a - myLane) - Math.abs(b - myLane));
      const move = async (wanted) => {
        if (wanted === undefined || Date.now() - lastLaneChange < 250) return;
        await press(wanted > myLane ? "ArrowRight" : "ArrowLeft");
        myLane = wanted;
        lastLaneChange = Date.now();
        await sleep(70);
      };

      if (cautious) {
        // Safe: nothing is passed close at all, so the meter stays where it started.
        if (inLane) await move(clear[0]);
      } else if (threading) {
        // Nothing to do: holding the middle *is* the thread.
      } else if (inLane && inLane.z > 3 - 13) {
        await press(inLane.kind === "gate" ? "ArrowDown" : "ArrowUp");
      } else if (inLane && inLane.z > 3 - 22) {
        // Late, and only when it must move: the near miss that follows is the point.
        await move(clear[0]);
      } else if (!inLane && myLane !== 1 && !ahead.some((obstacle) => obstacle.lane === 1)) {
        // Back to the middle: it is the only lane a pair can be threaded through.
        await move(1);
      }

      await sleep(140);
    }

    const recorded = await json(`window.__flowProbe ?? { coins: [], feed: [] }`);
    attempts.push({ samples, slowmo, hudFlow, hits, recorded, over });
    const gaps = samples[samples.length - 1]?.threads ?? 0;
    const peakFlow = Math.max(...samples.map((sample) => sample.flow), 0);
    console.log(
      `${stamp()} run ${attempt}: ended ${over} | peak flow ${peakFlow} | gaps ${gaps} | slow-mo samples ${slowmo.length} | feed ${recorded.feed.map((entry) => entry.line).join(" | ") || "(none)"}`,
    );

    if (gaps > 0 && slowmo.length > 0) break;
    await clickAt(".run-again");
    if (!(await waitFor(`Boolean(document.querySelector(".run-over-card")) === false`, 40))) {
      notes.push("run again did not start a second run");
      break;
    }
  }

  const all = attempts.flatMap((attempt) => attempt.samples);
  const slowmo = attempts.flatMap((attempt) => attempt.slowmo);
  const feed = attempts.flatMap((attempt) => attempt.recorded.feed);
  const coins = attempts.flatMap((attempt) => attempt.recorded.coins);
  const peakFlow = Math.max(...all.map((sample) => sample.flow), 0);
  const peakThreads = Math.max(...all.map((sample) => sample.threads), 0);
  const hudFlow = attempts.flatMap((attempt) => attempt.hudFlow);

  console.log(`\nsamples: ${all.length} | peak flow ${peakFlow} | gaps ${peakThreads} | tokens paid: ${coins.length}`);
  console.log(`hud: ${[...new Set(hudFlow.map((entry) => `${entry.width} ${entry.text}`))].slice(0, 8).join(" | ") || "(never shown)"}`);

  // The paid rate, tokens removed: the trickle is `12 + flow × 18` a second, so the claim is that a
  // window at high flow pays visibly more per real second than a window at low flow did.
  /* The trickle is `12 + flow × 18` a second, so the claim is a *line*, and the evidence should be the
     whole line rather than two points on it: every interval between two samples is bucketed by the flow
     it was run at, its score gain has the tokens that landed inside it subtracted (coins pay separately
     and are not part of this claim), and each bucket is compared against the formula. */
  const tokenLog = attempts.flatMap((attempt) => attempt.recorded.coins);
  const bands = [
    { label: "flow 0.00–0.20", low: 0, high: 0.2, paid: 0, tokens: 0, seconds: 0, flow: 0 },
    { label: "flow 0.20–0.45", low: 0.2, high: 0.45, paid: 0, tokens: 0, seconds: 0, flow: 0 },
    { label: "flow 0.45–0.70", low: 0.45, high: 0.7, paid: 0, tokens: 0, seconds: 0, flow: 0 },
    { label: "flow 0.70–1.00", low: 0.7, high: 1.01, paid: 0, tokens: 0, seconds: 0, flow: 0 },
  ];
  for (let index = 1; index < all.length; index += 1) {
    const before = all[index - 1];
    const after = all[index];
    const dt = (after.at - before.at) / 1000;
    if (dt <= 0 || dt > 1) continue;
    const flow = (before.flow + after.flow) / 2;
    const band = bands.find((entry) => flow > entry.low && flow <= entry.high);
    if (!band) continue;
    band.paid += after.score - before.score;
    band.seconds += dt;
    band.flow += flow * dt;
    for (const coin of tokenLog) {
      if (coin.at > before.perf && coin.at <= after.perf) band.tokens += coin.value;
    }
  }
  const tokenTotal = coins.reduce((total, entry) => total + entry.value, 0);
  console.log(`\nground trickle by flow band (tokens subtracted, from the score the run actually gained):`);
  for (const band of bands) {
    if (band.seconds < 0.3) {
      console.log(`  ${band.label}: ${round(band.seconds)}s — too little time to measure`);
      continue;
    }
    const meanFlow = band.flow / band.seconds;
    const measured = (band.paid - band.tokens) / band.seconds;
    const expected = 12 + meanFlow * 18;
    console.log(
      `  ${band.label}: ${round(band.seconds)}s at flow ${round(meanFlow)} → ${round(measured)}/s (the line says ${round(expected)}/s)`,
    );
  }
  console.log(`  tokens paid over the runs: ${round(tokenTotal)} (subtracted band by band)`);
  const measurable = bands.filter((band) => band.seconds >= 1);
  const measuredRate = (band) => (band.paid - band.tokens) / band.seconds;
  const expectedRate = (band) => 12 + (band.flow / band.seconds) * 18;
  const drift = measurable.map((band) => Math.abs(measuredRate(band) - expectedRate(band)) / expectedRate(band));

  const hits = attempts.flatMap((attempt) => attempt.hits);
  console.log(
    `\nwhat a hit did to the meter: ${hits.map((hit) => `${hit.distance} m ${hit.before} → ${hit.after}`).join(" | ") || "(no hit landed)"}`,
  );

  const gapLines = feed.filter((entry) => /^GAP ×/.test(entry.line));
  console.log(`\nfeed, the gap lines: ${gapLines.map((entry) => `${entry.line} — ${entry.detail}`).join(" | ") || "(none)"}`);

  /* ---- verdict ---- */
  if (peakFlow < 0.6) faults.push(`flow only reached ${peakFlow}`);
  if (peakThreads < 1) faults.push("no gap was ever threaded");
  if (slowmo.length === 0) faults.push("the run's clock never slowed down");
  if (!gapLines.length) faults.push("a gap was threaded without a GAP line in the feed");
  if (!hudFlow.some((entry) => entry.flow === "true")) faults.push("the HUD never showed the meter in flow");
  if (!hits.length) notes.push("no hit landed, so the wipe was not measured");
  else if (!hits.every((hit) => hit.after < 0.05)) faults.push("a hit did not wipe the meter");
  if (!hudFlow.length) faults.push("the HUD never showed the flow meter at all");
  if (measurable.length < 2) {
    notes.push(`only ${measurable.length} flow bands had enough time to measure`);
  } else {
    const slowest = measuredRate(measurable[0]);
    const fastest = measuredRate(measurable[measurable.length - 1]);
    if (fastest <= slowest * 1.5) faults.push(`the top band paid ${round(fastest)}/s against ${round(slowest)}/s at the bottom`);
    if (drift.some((value) => value > 0.25)) {
      faults.push(`a band drifted ${round(Math.max(...drift) * 100)}% from the line 12 + flow × 18`);
    }
  }
  if (all.some((sample) => sample.cameraZ !== null && sample.cameraZ < 11.2)) {
    console.log(`camera dollied to ${Math.min(...all.map((sample) => sample.cameraZ ?? 11.5))}`);
  } else if (slowmo.length) {
    notes.push("the camera never dollied inside 11.2 m, which is what a thread should do");
  }

  console.log(`\nconsole:`);
  console.log(logs.slice(-12).join("\n") || "  (nothing matching)");
  console.log(`\nnotes: ${notes.join("; ") || "(none)"}`);
  console.log(`verdict: ${faults.length ? faults.join("; ") : "no faults"}`);
  if (faults.length) process.exitCode = 1;

  await evaluate(`window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }))`);
  await sleep(2000);
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
