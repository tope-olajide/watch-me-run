// Does a link dropped *during* a run come back generating?
//
// Recreates the reported failure — a mid-run disconnect that leaves the run over the local backdrop — and
// then watches the app put itself back together: the status transitions, the arming pass's own trace
// entries, and, the only honest evidence that frames are really being produced again, how much the
// world's pixels move once it has recovered.
//
// The drop is forced through `window.__orbisDrop`, which the world layer publishes in development.
// Nothing else works: `Network.emulateNetworkConditions({offline:true})` was tried first and does not
// cut an established WebRTC media path — the status sat at `ready`/`streaming` for the full twenty
// seconds while the world went on producing frames, and the chunk counter climbed from 1 to 7.
//
// `node tools/drop-probe.mjs [app-url]` (a dev server with the token plugin, e.g. http://[::1]:5199/).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_URL = process.argv[2] ?? "http://[::1]:5199/";
const PORT = 9334;
const DROP_WAIT_MS = Number(process.env.DROP_WAIT_MS ?? 20_000);
const LANDSCAPE = process.env.LANDSCAPE === "1";
const RECOVER_MS = Number(process.env.RECOVER_MS ?? 150_000);
const RUN_WAIT_MS = Number(process.env.RUN_WAIT_MS ?? 150_000);

const profile = mkdtempSync(join(tmpdir(), "watchme-drop-"));

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

try {
  await devtools("/json/version");
  const targets = await devtools("/json/list");
  const blank = targets.find((target) => target.type === "page");
  const browserSocket = cdpSocket(blank.webSocketDebuggerUrl);
  await browserSocket.ready;
  const { targetId } = await browserSocket.send("Target.createTarget", { url: APP_URL });
  await sleep(1200);

  const pages = await devtools("/json/list");
  const page =
    pages.find((target) => target.id === targetId) ?? pages.find((t) => t.url.startsWith("http"));
  const pageSocket = cdpSocket(page.webSocketDebuggerUrl);
  await pageSocket.ready;

  pageSocket.on((message) => {
    if (message.method === "Runtime.consoleAPICalled") {
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(" ");
      if (/orbis|world|link|session/i.test(text)) logs.push(`[${stamp()}] ${text}`.slice(0, 300));
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      logs.push(
        `[${stamp()}] exception ${details.exception?.description ?? details.text}`.slice(0, 400),
      );
    }
  });

  await pageSocket.send("Page.enable");
  await pageSocket.send("Runtime.enable");
  await pageSocket.send("Network.enable");

  const evaluate = async (expression) => {
    const result = await pageSocket.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };

  /**
   * The world layer's own snapshot, plus the two facts the snapshot cannot carry: whether a video
   * element exists at all (a disconnected link unmounts it) and how far its pixels move in 1.5 s.
   */
  const worldState = `(() => {
    const w = window.__orbisWorld?.();
    if (!w) return null;
    const video = document.querySelector(".world-layer video");
    return {
      status: w.status, videoState: w.videoState, runActive: w.runActive,
      world: w.world, started: w.session?.started, running: w.session?.running,
      chunk: w.session?.chunk, paused: w.session?.paused,
      pinning: w.pinning, hasImage: w.session?.hasImage,
      landscape: w.landscape ? w.landscape.label : null,
      video: video ? { readyState: video.readyState, w: video.videoWidth } : null,
    };
  })()`;

  /** Mean per-channel luma change over 1.5 s, straight off the <video>: pixels, not a clock. */
  const frameDelta = `(async () => {
    const video = document.querySelector(".world-layer video");
    if (!video || video.readyState < 2 || !video.videoWidth) return null;
    const W = 32, H = 18;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const grab = () => { context.drawImage(video, 0, 0, W, H); return context.getImageData(0, 0, W, H).data; };
    const before = grab();
    await new Promise((done) => setTimeout(done, 1500));
    const after = grab();
    let sum = 0;
    for (let i = 0; i < before.length; i += 4) {
      sum += Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) + Math.abs(before[i + 2] - after[i + 2]);
    }
    return Math.round((sum / (before.length / 4) / 3) * 10) / 10;
  })()`;

  const traceTail = `JSON.stringify((window.__orbisTrace ?? []).slice(-60).map((e) => e.what + " :: " + (e.detail ?? "")))`;

  const state = () => evaluate(worldState);
  const line = (label, value) => console.log(`${stamp()} ${label} ${JSON.stringify(value)}`);


  // 1. Into a run.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await evaluate(`Boolean(document.querySelector(".start-button"))`)) break;
    await sleep(500);
  }

  // Each world has its own patterns and its own session conditions, so the recovery is worth running
  // in more than the one it was first seen in: `WORLD=city node tools/drop-probe.mjs`.
  const wantedWorld = process.env.WORLD;
  if (wantedWorld) {
    const clicked = await evaluate(`(() => {
      const card = document.querySelector(".world-card.world-${wantedWorld}");
      if (!card) return false;
      card.click();
      return true;
    })()`);
    await sleep(700);
    console.log(
      `${stamp()} world: ${wantedWorld} -> ${await evaluate(`JSON.stringify({
        selected: document.querySelector(".world-card.selected .world-copy strong")?.textContent ?? null,
        local: document.querySelector(".world-local")?.dataset.world ?? null,
      })`)}`,
    );
    if (!clicked) process.exitCode = 1;
  }

  // A pinned landscape puts two more things through the recovery than a generated one: the session
  // comes back with no starting image at all, so the arm pass has to upload the file again and pin it,
  // and `startWorld` raises `pinning` for the arm to clear. What this run is for is checking that the
  // world comes back *the same landscape* — and that `pinning` ends up false, because a pin flag left
  // standing is a run's loading screen that never gets past "Pinning your landscape".
  if (LANDSCAPE) {
    const built = await evaluate(`(async () => {
      const width = 900, height = 500, horizon = 0.72;
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d");
      const sky = context.createLinearGradient(0, 0, 0, height * horizon);
      sky.addColorStop(0, "#ff9d4d"); sky.addColorStop(1, "#ffe9b0");
      context.fillStyle = sky; context.fillRect(0, 0, width, height * horizon);
      const ground = context.createLinearGradient(0, height * horizon, 0, height);
      ground.addColorStop(0, "#6b3a1e"); ground.addColorStop(1, "#241209");
      context.fillStyle = ground; context.fillRect(0, height * horizon, width, height - height * horizon);
      const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], "probe-landscape.png", { type: "image/png" }));
      const input = document.querySelector(".landscape-input");
      if (!input) return "no upload control";
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return "handed the upload control a " + width + "x" + height + " picture";
    })()`);
    console.log(`${stamp()} landscape upload: ${built}`);
    await sleep(3000);
    console.log(
      `${stamp()} menu after upload: ${await evaluate(
        `document.querySelector(".start-button")?.textContent?.replace(/\\s+/g, " ").trim()`,
      )}`,
    );
  }

  console.log(`${stamp()} menu is up; clicking Start`);
  await evaluate(`document.querySelector(".start-button").click()`);

  let live = null;
  const runDeadline = Date.now() + RUN_WAIT_MS;
  while (Date.now() < runDeadline) {
    const now = await state();
    if (now && now.runActive && now.status === "ready" && now.started && now.video?.readyState >= 2) {
      live = now;
      break;
    }
    await sleep(2000);
  }
  if (!live) {
    console.log("FAIL: the run never reached a live, generating world");
    line("last state", await state());
    console.log(logs.slice(-25).join("\n"));
    process.exit(1);
  }
  line("run is live", live);
  if (LANDSCAPE) {
    console.log(
      `         landscape before the drop: ${live.landscape ?? "none"} / hasImage=${live.hasImage} / pinning=${live.pinning}`,
    );
  }
  const before = await evaluate(frameDelta);
  line("frame delta before the drop", before);

  // 2. Drop the link under the live session.
  console.log(`${stamp()} releasing the link under the run`);
  await evaluate(`window.__orbisDrop?.()`);

  const transitions = [];
  const cutDeadline = Date.now() + DROP_WAIT_MS;
  while (Date.now() < cutDeadline) {
    const now = await state();
    const key = `${now?.status}/${now?.videoState}/${Boolean(now?.video)}`;
    if (!transitions.length || transitions[transitions.length - 1].key !== key) {
      transitions.push({ key, at: stamp(), runActive: now?.runActive, started: now?.started });
      line("transition", transitions[transitions.length - 1]);
    }
    if (now && now.status !== "ready" && now.status !== "connecting") break;
    await sleep(1000);
  }
  const cut = transitions.some((entry) => !entry.key.startsWith("ready/"));

  let recovered = null;
  const recoverDeadline = Date.now() + RECOVER_MS;
  let lastKey = "";
  while (Date.now() < recoverDeadline) {
    const now = await state();
    const key = `${now?.status}/${now?.videoState}/${Boolean(now?.video)}/${now?.started}`;
    if (key !== lastKey) {
      lastKey = key;
      line("state", { ...now, at: stamp() });
    }
    if (now && now.status === "ready" && now.started && now.video?.readyState >= 2) {
      recovered = now;
      break;
    }
    await sleep(2000);
  }

  console.log("\n===== verdict =====");
  console.log(`dropped mid-run:              ${cut ? "yes" : "NO — offline emulation did not cut the link"}`);
  console.log(`recovered to a started session: ${recovered ? "yes" : "no"}`);
  if (recovered) {
    line("recovered state", recovered);
    line("frame delta after recovery", await evaluate(frameDelta));
    if (LANDSCAPE) {
      console.log(`same landscape:               ${recovered.landscape === live.landscape ? "yes" : "NO — " + live.landscape + " -> " + recovered.landscape}`);
      console.log(`image pinned again:           ${recovered.hasImage ? "yes" : "no"}`);
      console.log(`pinning cleared after recovery: ${recovered.pinning === false ? "yes" : "NO — still " + recovered.pinning}`);

      // The loader of the *next* run reads `pinning`: a flag left standing would have it saying
      // "Pinning your landscape" with the world already pinned, and waiting out its fallback.
      console.log(`${stamp()} exiting the run`);
      await evaluate(`document.querySelector(".quiet-button")?.click()`);
      let after = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        after = await state();
        if (after && !after.runActive) break;
        await sleep(1000);
      }
      line("after Exit", after);
      console.log(`pinning after Exit:           ${after?.pinning === false ? "cleared" : "NO — still " + after?.pinning}`);
    }
  }
  console.log("\narming trace:");
  const trace = JSON.parse(await evaluate(traceTail));
  for (const entry of trace.filter((e) => /arm|start|connect|release|resolution/.test(e))) {
    console.log(`  ${entry}`);
  }
  console.log("\nconsole:");
  console.log(logs.slice(-30).join("\n"));

  // End the session the way the app does and wait for the release to land, rather than killing Chrome
  // over the top of it. `pagehide` starts an async release — a token, a `disconnect`, a server-side
  // session end — and the account allows one session at a time, so an orphan left here is the next
  // probe run failing to find a world for a minute or two.
  await evaluate(`window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }))`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const released = JSON.parse(
      (await evaluate(`(() => {
        const entries = (window.__orbisTrace ?? []).filter((entry) => entry.what === "release");
        return JSON.stringify({
          status: window.__orbisWorld?.()?.status ?? null,
          last: entries.length ? entries[entries.length - 1].detail : null,
        });
      })()`)) ?? "{}",
    );
    if (/ok \(attempt/.test(released.last ?? "") || attempt % 10 === 9) {
      console.log(`${stamp()} release: ${JSON.stringify(released)}`);
    }
    if (released.status === "disconnected" && /ok \(attempt/.test(released.last ?? "")) break;
    await sleep(1000);
  }

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
