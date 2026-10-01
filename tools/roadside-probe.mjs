// What is beside the road, and how much of the picture it is.
//
// The roadside is scenery in the 3D layer with nothing in the DOM to point at, so a run has two
// separate questions and the app answers both: `window.__roadside()` reports what the layout put
// there (pieces per kind, panels, the travel the scroll has reached, the height of the ground under
// the near row, and whether the panels are wearing the live world or the fallback art), and
// `window.__roadsideVisible(false)` hides the whole group so the same instant of a run can be captured
// with and without it.
//
// The second one exists because the first one is not enough. A count of instances proves the pieces
// exist and are mounted; it says nothing about whether any of them is in the picture — and in a dark
// world, where the scenery and the ground behind it are both nearly black, a frame that is fifteen luma
// darker and a frame with nothing in it look the same in a photograph. Hiding the group and
// differencing settles it. The captures are taken with → without → with, about 200 ms apart, because
// the generated world is a live video layer that keeps changing between captures: a contribution shows
// up whichever way time runs between them, whereas drift shows up as opposite signs. A flat
// with/without pair cannot tell the two apart, and reading the numbers as if it could is how "the
// roadside is 15 luma" would be reported when the world had simply brightened.
//
//   node tools/roadside-probe.mjs [app-url] [out-dir]
//   WORLD=city node tools/roadside-probe.mjs            # one world instead of all three
//
// Writes `<out>/roadside-<world>-a.png` and `-b.png` (a second apart, for the scroll) and
// `<out>/full-<world>-with-1.png`, `-without.png`, `-with-2.png` (for the contribution), then prints
// the `frame-report.mjs` commands that turn those into numbers:
//
//   node tools/frame-report.mjs --activity roadside-desert-a.png roadside-desert-b.png
//   node tools/frame-report.mjs full-city-with-1.png --region 0,0,1,1
//
// A dev server with the token plugin (`npm run dev`), because the readouts are development-only.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_URL = process.argv[2] ?? "http://[::1]:5199/";
const OUT = process.argv[3] ?? process.env.OUT ?? tmpdir();
const WORLDS = (process.env.WORLD ?? "desert,city,forest").split(",");
const PORT = Number(process.env.CDP_PORT ?? 9341);
/** How long to wait for a world to be armed, streaming and painting before calling it not live. */
const LIVE_WAIT_MS = Number(process.env.LIVE_WAIT_MS ?? 90_000);
/** Metres of travel to let the run reach before measuring: the scroll is the thing being judged. */
const SETTLE_METRES = Number(process.env.SETTLE_METRES ?? 8);

const profile = mkdtempSync(join(tmpdir(), "watchme-roadside-"));

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
      // A broken instanced mesh — an attribute the material declares and the geometry does not have —
      // shows up here as a shader or program error, and that is the one failure the readouts cannot see.
      if (/three|shader|program|webgl|instance|geometry|nan|dispose/i.test(text)) {
        logs.push(`[${stamp()}] ${text}`.slice(0, 300));
      }
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      const text = details.exception?.description ?? details.text;
      logs.push(`[${stamp()}] exception ${text}`.slice(0, 400));
      faults.push(`exception: ${text}`.slice(0, 200));
    }
  });

  await pageSocket.send("Page.enable");
  await pageSocket.send("Runtime.enable");
  await pageSocket.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const evaluate = async (expression) => {
    const result = await pageSocket.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };

  const shot = async (name, clip) => {
    const { data } = await pageSocket.send("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip } : {}),
    });
    const path = join(OUT, name);
    writeFileSync(path, Buffer.from(data, "base64"));
    return path;
  };

  const json = async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`));

  const worldState = `(() => {
    const w = window.__orbisWorld?.();
    const video = document.querySelector(".world-layer video");
    return {
      surface: document.documentElement.dataset.surface ?? null,
      status: w?.status ?? null,
      videoState: w?.videoState ?? null,
      run: Boolean(w?.runActive),
      started: Boolean(w?.session?.started),
      video: video ? video.readyState : null,
    };
  })()`;

  // The menu, and the world layer mounted: the bus reports its pre-mount defaults (`status: "idle"`,
  // no `.world-layer`) until it is, and reading those looks exactly like a broken menu.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const mounted = await evaluate(
      `Boolean(document.querySelector(".world-layer") && document.querySelector(".start-button"))`,
    );
    if (mounted) break;
    await sleep(500);
  }

  for (const world of WORLDS) {
    console.log(`\n===== ${world} =====`);
    if (WORLDS.length > 1 || process.env.PICK_WORLD === "1") {
      const picked = await evaluate(`(() => {
        const card = document.querySelector(".world-card.world-${world}");
        if (!card) return false;
        card.click();
        return true;
      })()`);
      if (!picked) {
        faults.push(`${world}: no world card`);
        console.log(`${stamp()} no world card for ${world}`);
        continue;
      }
      await sleep(600);
    }

    await evaluate(`document.querySelector(".start-button").click()`);

    let live = false;
    const deadline = Date.now() + LIVE_WAIT_MS;
    while (Date.now() < deadline) {
      const state = await json(worldState);
      // A world that never streams still opens the run over the local backdrop, so the run surface coming
      // up is not the test; the session started and the video painting is.
      if (state.surface === "run" && state.run && state.started && state.video >= 2) {
        live = true;
        break;
      }
      if (state.surface === "run" && state.run && Date.now() > deadline - LIVE_WAIT_MS / 3) break;
      await sleep(1000);
    }
    console.log(`${stamp()} run: ${JSON.stringify(await json(worldState))} live=${live}`);

    // Let it travel: the roadside only reads as scenery once the scroll is under way.
    const first = await json(`window.__roadside?.() ?? null`);
    let settled = first;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(500);
      settled = await json(`window.__roadside?.() ?? null`);
      if (first && settled && settled.travel - first.travel >= SETTLE_METRES) break;
    }
    console.log(`${stamp()} roadside: ${JSON.stringify(settled)}`);
    if (!settled) faults.push(`${world}: window.__roadside() never published`);
    else if (settled.pieces === 0) faults.push(`${world}: no pieces beside the road`);

    // "Context Lost" at run entry is the menu's character-preview canvas being disposed, not this one;
    // read the run canvas to be sure, because a lost context here would make every capture a lie.
    const context = await evaluate(`(() => {
      const canvas = document.querySelector(".game-stage canvas") ?? document.querySelector("canvas");
      if (!canvas) return "no canvas";
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      return gl ? (gl.isContextLost() ? "LOST" : "alive") : "no context";
    })()`);
    console.log(`${stamp()} run canvas: ${context}`);
    if (context === "LOST") faults.push(`${world}: the run canvas lost its WebGL context`);

    const a = await shot(`roadside-${world}-a.png`);
    const withOne = await shot(`full-${world}-with-1.png`);
    await evaluate(`window.__roadsideVisible?.(false)`);
    await sleep(200);
    const without = await shot(`full-${world}-without.png`);
    const restored = await evaluate(`Boolean(window.__roadsideVisible?.(true))`);
    await sleep(200);
    const withTwo = await shot(`full-${world}-with-2.png`);
    await sleep(1000);
    const b = await shot(`roadside-${world}-b.png`);
    console.log(`${stamp()} frames: ${a} , ${b}`);
    console.log(`${stamp()} contribution frames: ${withOne} , ${without} , ${withTwo} (restored: ${restored})`);
    if (!restored) faults.push(`${world}: the roadside did not come back after being hidden`);

    // Back to the menu for the next world. `runActive` clears as soon as the run ends, but the menu
    // that holds the world cards is a phase after that, so wait for it rather than for the run.
    if (WORLDS.length > 1) {
      await evaluate(`document.querySelector(".quiet-button")?.click()`);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const ready = await evaluate(`(() => (
          document.documentElement.dataset.surface === "menu" &&
          Boolean(document.querySelector(".world-card"))
        ))()`);
        if (ready) break;
        await sleep(500);
      }
      await sleep(800);
    }
  }

  console.log("\nconsole:");
  console.log(logs.slice(-25).join("\n") || "  (nothing matching)");

  console.log("\nfor the numbers:");
  for (const world of WORLDS) {
    console.log(`  node tools/frame-report.mjs ${join(OUT, `full-${world}-with-1.png`)} --region 0,0,1,1`);
    console.log(`  node tools/frame-report.mjs ${join(OUT, `full-${world}-without.png`)} --region 0,0,1,1`);
    console.log(`  node tools/frame-report.mjs ${join(OUT, `full-${world}-with-2.png`)} --region 0,0,1,1`);
    console.log(`  node tools/frame-report.mjs --activity ${join(OUT, `roadside-${world}-a.png`)} ${join(OUT, `roadside-${world}-b.png`)}`);
  }

  // End the session the way the app does and wait for the release to land, rather than killing Chrome
  // over the top of it: `pagehide` starts an async release, and the account allows one session at a
  // time, so an orphan left here is the next probe's run failing to find a world for a minute or two.
  await evaluate(`window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }))`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const released = await json(`(() => {
      const entries = (window.__orbisTrace ?? []).filter((entry) => entry.what === "release");
      return {
        status: window.__orbisWorld?.()?.status ?? null,
        last: entries.length ? entries[entries.length - 1].detail : null,
      };
    })()`);
    if (released.status === "disconnected" && /ok \(attempt/.test(released.last ?? "")) {
      console.log(`\n${stamp()} release: ${JSON.stringify(released)}`);
      break;
    }
    await sleep(1000);
  }

  console.log(`verdict: ${faults.length ? faults.join("; ") : "no faults"}`);
  if (faults.length) process.exitCode = 1;
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
