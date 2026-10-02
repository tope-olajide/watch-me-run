// Does the world's own weather actually arrive, and does each world attack what it promised?
//
//   node tools/hazard-probe.mjs [app-url]
//   WORLD=city node tools/hazard-probe.mjs
//   OUT=/tmp node tools/hazard-probe.mjs
//
// A run per attempt, played with an autopilot that dodges what is in its lane and otherwise holds the
// middle. Every lane change is timed against the last key the probe pressed: a lane change with no key
// behind it is the game moving the runner, which is the fault this probe exists to catch — the desert's
// storm once did that, and the shove was removed after it was reported as a bug twice.
//
// A run that ends is restarted through the card and the evidence is gathered per attempt, because a
// hazard can legitimately end a run — the fog arrives with a gate behind it — and an answer the world
// never got to send is not evidence of broken weather.
//
// What is recorded:
//   - `window.__runfield()` sampled every 150 ms: the phase, its intensity, how many hazards the run
//     announced, and the lane, which is where an uncommanded move would show up;
//   - the HUD's `.hud-hazard` badge and the `--weather` intensity the simulation publishes — so "the
//     player was told" is a reading rather than an intention, and a lane that changed itself is a fault;
//   - the director feed, sampled from the DOM as well as watched for insertions, because the feed is
//     three deep and an entry can be born and evicted inside one commit;
//   - frames, as a bracket: two clear ones 1.2 s apart (the world's own drift), one at the peak of the
//     hazard, and one after it has passed if the run lived that long. The blackout and the fog are
//     *pictures*, and the numbers that settle whether they landed come from
//     `node tools/frame-report.mjs <file> --region 0,0,1,1` on those frames — the probe prints them.
//
// A dev server (`npm run dev`), because the readout is development-only.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_URL = process.argv[2] ?? "http://[::1]:5199/";
const OUT = process.argv[3] ?? process.env.OUT ?? tmpdir();
const PORT = Number(process.env.CDP_PORT ?? 9343);
const WORLDS = (process.env.WORLD ?? "desert,city,forest").split(",");
const ATTEMPTS = Number(process.env.ATTEMPTS ?? 5);
/** How long one attempt may play before the probe takes its own run again. */
const RUN_MS = Number(process.env.RUN_MS ?? 90_000);

const profile = mkdtempSync(join(tmpdir(), "watchme-hazard-"));
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
 * The feed, twice over.
 *
 * Insertions are the precise record — a line arrives with its detail and the distance it landed at —
 * and the sampled read is the safety net: the feed is three deep, and an entry pushed while three
 * newer ones are already in the same commit never reaches the DOM at all, so a missing insertion is
 * not proof the world never answered. The array is cleared per attempt; the observers are installed
 * once.
 */
const RECORDER = `(() => {
  if (window.__hazardProbe) {
    window.__hazardProbe.feed = [];
    window.__hazardProbe.seen = [];
    return true;
  }
  window.__hazardProbe = { feed: [], seen: [] };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || node.tagName !== "LI") continue;
        const field = window.__runfield?.() ?? {};
        window.__hazardProbe.feed.push({
          line: node.querySelector("b")?.textContent ?? "",
          detail: node.querySelector("span")?.textContent ?? "",
          distance: field.distance ?? null,
        });
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.__hazardProbeTimer = setInterval(() => {
    const field = window.__runfield?.() ?? {};
    for (const node of document.querySelectorAll(".director-feed li")) {
      const line = node.querySelector("b")?.textContent ?? "";
      const seen = window.__hazardProbe.seen;
      if (!line || seen.some((entry) => entry.line === line)) continue;
      seen.push({ line, distance: field.distance ?? null });
    }
  }, 120);
  return true;
})()`;

const HAZARD_LINE = /SANDSTORM|BLACKOUT|FOG/i;

const logs = [];
const faults = [];

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
  let lastPress = -Infinity;
  const press = async (key) => {
    const code = keyCodes[key];
    lastPress = Date.now();
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
  const shot = async (name) => {
    const { data } = await pageSocket.send("Page.captureScreenshot", { format: "png" });
    const path = join(OUT, name);
    writeFileSync(path, Buffer.from(data, "base64"));
    return path;
  };
  const waitFor = async (expression, attempts = 100) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await evaluate(expression)) return true;
      await sleep(400);
    }
    return false;
  };

  await waitFor(`Boolean(document.querySelector(".world-card") && document.querySelector(".start-button"))`, 150);

  for (const world of WORLDS) {
    console.log(`\n===== ${world} =====`);
    let attempts = 0;
    const evidence = [];
    let complete = false;

    while (attempts < ATTEMPTS && !complete) {
      attempts += 1;
      if (attempts === 1) {
        const picked = await evaluate(`(() => {
          const el = document.querySelector(".world-card.world-${world}");
          if (!el) return false;
          el.click();
          return true;
        })()`);
        if (!picked) {
          faults.push(`${world}: no world card`);
          break;
        }
        await sleep(700);
        await evaluate(`document.querySelector(".start-button").click()`);
      }

      const up = await waitFor(`document.documentElement.dataset.surface === "run" && Boolean(window.__runfield)`, 150);
      if (!up) {
        faults.push(`${world}: the run never came up`);
        break;
      }
      await evaluate(RECORDER);

      const run = {
        attempt: attempts,
        phases: [],
        badges: [],
        // Every lane change the run makes. `mine` flags the probe's own presses; a lane that changed with
        // no key behind it is the fault.
        moves: [],
        frames: {},
        fired: 0,
        ended: false,
        peakDistance: null,
        answered: false,
      };
      let lane = null;
      let myLane = 1;
      let previousPhase = null;
      let clearPair = 0;
      const deadline = Date.now() + RUN_MS;

      while (Date.now() < deadline) {
        const field = await json(`window.__runfield?.() ?? null`);
        if (!field) {
          await sleep(200);
          continue;
        }
        const css = await json(`(() => ({
          kind: document.documentElement.dataset.hazard ?? "",
          phase: document.documentElement.dataset.hazardPhase ?? "",
          weather: Number(document.documentElement.style.getPropertyValue("--weather") || 0),
          badge: document.querySelector(".hud-hazard")?.textContent?.trim().replace(/\\s+/g, " ") ?? null,
          over: Boolean(document.querySelector(".run-over-card")),
        }))()`);
        run.fired = field.hazardFired;

        const from = lane;
        lane = field.lane;
        if (from !== null && lane !== from) {
          // 400 ms of grace: the lane change the probe asked for is read back a frame or two later,
          // and a key press that lands just after the sample is still the probe's.
          const mine = Date.now() - lastPress < 400;
          run.moves.push({
            distance: field.distance,
            from,
            to: lane,
            mine,
            phase: field.hazard.phase,
            kind: field.hazard.kind,
            intensity: field.hazard.intensity,
          });
        }

        if (field.hazard.phase !== previousPhase || !run.phases.length) {
          if (previousPhase !== field.hazard.phase) {
            run.phases.push({ phase: field.hazard.phase, name: field.hazard.name, distance: field.distance, badge: css.badge, kind: css.kind });
            if (field.hazard.phase === "warning") {
              console.log(`${stamp()} run ${attempts}: ${field.distance} m warning ${field.hazard.name} (badge: ${css.badge})`);
            }
            if (field.hazard.phase === "active") {
              console.log(`${stamp()} run ${attempts}: ${field.distance} m ACTIVE ${field.hazard.name} (kind ${css.kind}, weather ${css.weather})`);
            }
          }
          previousPhase = field.hazard.phase;
        }
        if (css.badge && run.badges[run.badges.length - 1]?.badge !== css.badge) {
          run.badges.push({ badge: css.badge, distance: field.distance });
        }

        // The bracket: two clear frames of the same moment a second apart are the world's own drift;
        // the peak frame is the hazard. Anything the hazard does has to clear that pair.
        if (field.hazard.phase === "calm" && !("peak" in run.frames) && clearPair < 2 && field.distance > 80) {
          run.frames[clearPair === 0 ? "clear" : "clear2"] = await shot(`hazard-${world}-clear${clearPair === 0 ? "" : "2"}.png`);
          clearPair += 1;
          if (clearPair === 1) await sleep(1200);
        }
        if (field.hazard.phase === "active" && field.hazard.intensity > 0.9 && !("peak" in run.frames)) {
          run.peakDistance = field.distance;
          run.frames.peak = await shot(`hazard-${world}-peak.png`);
        }
        if ("peak" in run.frames && !("after" in run.frames) && field.hazard.phase === "calm") {
          run.frames.after = await shot(`hazard-${world}-after.png`);
        }

        if (css.over) {
          run.ended = true;
          break;
        }

        // The autopilot: dodge only, and early — the storm steals lanes, and a hazard that ends a run
        // is allowed to, so the probe's job is to survive long enough to watch it.
        const obstacles = (field.obstacles ?? []).filter((obstacle) => obstacle.z < 3 && obstacle.z > 3 - 34);
        const inLane = obstacles.filter((obstacle) => obstacle.lane === myLane).sort((a, b) => b.z - a.z)[0];
        if (inLane && inLane.z > 3 - 13) {
          await press(inLane.kind === "gate" ? "ArrowDown" : "ArrowUp");
        } else if (inLane && inLane.z > 3 - 20) {
          const clear = [0, 1, 2].filter((other) => other !== myLane && !obstacles.some((o) => o.lane === other && o.z > 3 - 26));
          const wanted = clear.sort((a, b) => Math.abs(a - myLane) - Math.abs(b - myLane))[0];
          if (wanted !== undefined) {
            await press(wanted > myLane ? "ArrowRight" : "ArrowLeft");
            myLane = wanted;
            await sleep(70);
          }
        }

        await sleep(150);
      }

      const recorded = await json(`window.__hazardProbe ?? { feed: [], seen: [] }`);
      const lines = [...recorded.feed, ...(recorded.seen ?? [])];
      run.answered = lines.some((entry) => HAZARD_LINE.test(entry.line));
      const answer = recorded.feed.find((entry) => HAZARD_LINE.test(entry.line));
      run.answer = answer ? `${answer.line} — ${answer.detail ?? ""} at ${answer.distance} m` : answer === undefined ? null : answer;
      run.feedLines = [...new Set(recorded.feed.map((entry) => entry.line))];
      evidence.push(run);

      console.log(
        `${stamp()} run ${attempts}: ${run.phases.map((entry) => `${entry.distance}m ${entry.phase}`).join(", ") || "(no hazard seen)"}` +
          ` | fired ${run.fired} | answered ${run.answered ? `yes (${run.answer ?? "seen in the DOM"})` : "no"} | frames ${Object.keys(run.frames).join("+") || "none"}`,
      );
      console.log(`  feed: ${run.feedLines.join(" | ") || "(none)"}`);
      console.log(
        `  lane changes: ${run.moves.map((move) => `${move.distance}m ${move.from}→${move.to}${move.mine ? " (probe)" : " (NO KEY)"}`).join(", ") || "(none)"}`,
      );

      const answered = evidence.some((entry) => entry.answered);
      const bracketed = evidence.some((entry) => entry.frames.clear && entry.frames.peak);
      complete = answered && bracketed;
      if (complete) break;

      // Another run: the card is the fast path, and the menu is the slow one.
      if (run.ended) {
        const restarted = await clickAt(".run-again");
        if (restarted && (await waitFor(`Boolean(document.querySelector(".run-over-card")) === false`, 40))) {
          continue;
        }
      }
      await clickAt(".quiet-button");
      await waitFor(`document.documentElement.dataset.surface === "menu" && Boolean(document.querySelector(".world-card"))`);
      await sleep(600);
      const picked = await evaluate(`(() => {
        const el = document.querySelector(".world-card.world-${world}");
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!picked) {
        faults.push(`${world}: no world card on the way back`);
        break;
      }
      await sleep(600);
      await evaluate(`document.querySelector(".start-button").click()`);
    }

    const answered = evidence.some((entry) => entry.answered);
    const bracketed = evidence.find((entry) => entry.frames.clear && entry.frames.peak);
    // The whole point: a lane change with no key behind it. Zero is the pass.
    const stolen = evidence.reduce((total, entry) => total + entry.moves.filter((move) => !move.mine).length, 0);
    const stolenDuringStorm = evidence.reduce(
      (total, entry) => total + entry.moves.filter((move) => !move.mine && move.kind === "storm").length,
      0,
    );
    const kindsSeen = [...new Set(evidence.flatMap((entry) => entry.phases.map((phase) => phase.kind)).filter(Boolean))];
    const warnings = evidence.filter((entry) => entry.phases.some((phase) => phase.phase === "warning")).length;
    const badges = [...new Set(evidence.flatMap((entry) => entry.badges.map((badge) => badge.badge)))];

    console.log(`\n${world} after ${attempts} attempt(s):`);
    console.log(`  weather seen: ${kindsSeen.join(", ") || "(none)"} | runs with a warning: ${warnings}/${evidence.length}`);
    console.log(`  badges seen: ${badges.join(" | ") || "(none)"}`);
    console.log(`  the world answered: ${answered ? "yes" : "no"}`);
    console.log(`  lane changes with no key pressed: ${stolen} (during a storm: ${stolenDuringStorm}) | the pass is zero`);
    console.log(`  fired per run: ${evidence.map((entry) => entry.fired).join(", ")}`);
    if (bracketed) {
      console.log(`  bracket (run ${bracketed.attempt}):`);
      for (const [moment, path] of Object.entries(bracketed.frames)) {
        console.log(`    node tools/frame-report.mjs ${path} --region 0,0,1,1   (${moment})`);
      }
    } else {
      console.log(`  bracket: never completed`);
    }

    if (!kindsSeen.length) faults.push(`${world}: no hazard ever became active`);
    if (!warnings) faults.push(`${world}: no warning phase was ever seen`);
    if (!answered) faults.push(`${world}: the world never answered the hazard in the feed`);
    if (!badges.some((badge) => /incoming/i.test(badge))) faults.push(`${world}: the HUD never warned about the hazard`);
    if (!bracketed) faults.push(`${world}: no clear/peak frame pair was captured`);
    if (stolen > 0) faults.push(`${world}: ${stolen} lane change(s) with no key behind them — the game moved the runner`);

    if (WORLDS.length > 1) {
      await clickAt(".quiet-button");
      await waitFor(`document.documentElement.dataset.surface === "menu" && Boolean(document.querySelector(".world-card"))`);
      await sleep(700);
    }
  }

  console.log(`\nconsole:`);
  console.log(logs.slice(-15).join("\n") || "  (nothing matching)");
  console.log(`\nverdict: ${faults.length ? faults.join("; ") : "no faults"}`);
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
