// Temporary diagnostic probe: launches headless Chrome, drives the WatchMe Run
// menu, and reports what the Orbis/Reactor layer is actually doing.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_URL = process.argv[2] ?? "http://localhost:8888/";
const PORT = 9333;
const RUN_SECONDS = Number(process.argv[3] ?? 50);
const SHOT_PATH = process.argv[4];

const profile = mkdtempSync(join(tmpdir(), "watchme-probe-"));
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

const events = [];
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
  const page = pages.find((target) => target.id === targetId) ?? pages.find((t) => t.url.startsWith("http"));
  const pageSocket = cdpSocket(page.webSocketDebuggerUrl);
  await pageSocket.ready;

  const tokenRequests = new Map();

  pageSocket.on((message) => {
    if (message.method === "Network.requestWillBeSent") {
      const { url, method } = message.params.request;
      if (url.includes("/api/reactor/token")) {
        tokenRequests.set(message.params.requestId, `${method} ${url}`);
      }
    }
    if (message.method === "Network.loadingFinished" && tokenRequests.has(message.params.requestId)) {
      const requestId = message.params.requestId;
      void pageSocket
        .send("Network.getResponseBody", { requestId })
        .then((result) => {
          events.push(`token body: ${String(result.body).slice(0, 240)}`);
        })
        .catch((error) => events.push(`token body unavailable: ${error.message}`));
    }
    if (message.method === "Runtime.consoleAPICalled") {
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(" ");
      logs.push(`[${message.params.type}] ${text}`.slice(0, 400));
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      logs.push(`[exception] ${details.exception?.description ?? details.text}`.slice(0, 600));
    }
    if (message.method === "Log.entryAdded") {
      const entry = message.params.entry;
      if (entry.level === "error" || entry.level === "warning") {
        logs.push(`[${entry.level}] ${entry.text} ${entry.url ?? ""}`.slice(0, 400));
      }
    }
    if (message.method === "Network.responseReceived") {
      const { url, status, mimeType } = message.params.response;
      if (url.includes("/api/reactor/token")) events.push(`token -> ${status}`);
      if (url.includes(".wasm")) events.push(`wasm ${status} ${mimeType} ${url.split("/").pop()}`);
      if (url.includes("api.reactor.inc")) events.push(`reactor ${status} ${url.replace(/\?.*/, "")}`);
    }
    if (message.method === "Network.loadingFailed") {
      events.push(`failed ${message.params.errorText}`);
    }
    if (message.method === "Network.webSocketFrameError") {
      events.push(`ws error ${message.params.errorMessage}`);
    }
  });

  await pageSocket.send("Page.enable");
  await pageSocket.send("Runtime.enable");
  await pageSocket.send("Log.enable");
  await pageSocket.send("Network.enable");

  const evaluate = async (expression) => {
    const result = await pageSocket.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.result?.value;
  };

  const menuReport = `(() => {
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return Math.round(r.width) + "x" + Math.round(r.height) + "@" + Math.round(r.top) + "," + Math.round(r.left);
    };
    return JSON.stringify({
      viewport: window.innerWidth + "x" + window.innerHeight,
      title: (document.querySelector(".menu-title")?.textContent || "").replace(/\\s+/g, " ").trim(),
      engine: document.querySelector(".engine-chip")?.textContent?.trim(),
      worlds: document.querySelectorAll(".world-card").length,
      selectedWorld: document.querySelector(".world-card.selected .world-copy strong")?.textContent,
      runners: document.querySelectorAll(".rail-card").length,
      stage: box(".stage-frame"),
      stageCanvas: Boolean(document.querySelector(".stage-frame canvas")),
      intro: box(".menu-intro"),
      worldsBox: box(".menu-worlds"),
      cta: box(".start-button"),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      overflowY: document.documentElement.scrollHeight > window.innerHeight + 2,
      leftovers: document.querySelectorAll(".character-modal, .selection-screen").length,
    });
  })()`;

  const setViewport = (width, height, mobile = false) =>
    pageSocket.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });

  // Wait for the menu, then check its layout at both breakpoints before starting a run.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const hasButton = await evaluate(`Boolean(document.querySelector(".start-button"))`);
    if (hasButton) break;
    await sleep(500);
  }

  // `MOBILE=1 node tools/orbis-probe.mjs ...` keeps the phone viewport for the whole session, so the
  // run itself is measured at the phone breakpoint rather than only the menu. The breakpoint is the
  // one part of "mobile" that is not a single size: `VIEWPORT=360x640` runs a narrower phone, which is
  // where a row of HUD cells that fits a large phone stops fitting.
  const mobileRun = process.env.MOBILE === "1";
  const [phoneWidth, phoneHeight] = (process.env.VIEWPORT ?? "430x900")
    .split("x")
    .map((value) => Number(value));

  await setViewport(1280, 800);
  await sleep(900);
  console.log("menu (desktop):", await evaluate(menuReport));
  await setViewport(phoneWidth, phoneHeight, true);
  await sleep(900);
  console.log("menu (mobile): ", await evaluate(menuReport));
  await setViewport(mobileRun ? phoneWidth : 1280, mobileRun ? phoneHeight : 800, mobileRun);
  await sleep(500);
  if (mobileRun) {
    console.log(`viewport: running the whole session at the phone breakpoint (${phoneWidth}x${phoneHeight})`);
  }
  console.log("start button:", await evaluate(`document.querySelector(".start-button")?.textContent`));

  // The headline check for this build: the homepage should generate and show a moving world on
  // its own, before any run starts.
  const menuWorld = `(() => {
    const layer = document.querySelector(".world-layer");
    const local = document.querySelector(".world-local");
    const video = layer?.querySelector("video");
    return JSON.stringify({
      tone: document.querySelector(".menu")?.dataset.worldTone,
      chip: document.querySelector(".engine-chip")?.textContent?.trim(),
      status: layer?.dataset.status,
      videoState: layer?.dataset.video,
      localWorld: local?.dataset.world,
      layerOpacity: layer ? getComputedStyle(layer).opacity : null,
      liveBadge: Boolean(document.querySelector(".stage-live")),
      liveCard: document.querySelector(".world-hazards i.is-live")?.textContent ?? null,
      video: video ? {
        readyState: video.readyState,
        width: video.videoWidth,
        height: video.videoHeight,
        currentTime: Math.round(video.currentTime * 10) / 10,
        paused: video.paused,
        muted: video.muted,
      } : null,
    });
  })()`;
  const parseMenu = (raw) => JSON.parse(raw);

  /**
   * What the world layer says about itself, in development. The session snapshot — what Orbis reports
   * about the running session, what landscape is pinned, whether generation is paused — exists in no
   * readable form in the DOM, and scraping it out of console lines would be reading a lagging copy.
   * `window.__orbisWorld` publishes the value itself (see src/orbis/world-bus.ts).
   */
  const worldState = `(() => {
    const w = window.__orbisWorld?.();
    if (!w) return "no world bus";
    return JSON.stringify({
      status: w.status, video: w.videoState, error: w.error ?? null,
      runActive: w.runActive, pauseRequested: w.pauseRequested, pinning: w.pinning,
      world: w.world, session: w.session,
      landscape: w.landscape ? { label: w.landscape.label, sourceHorizon: w.landscape.sourceHorizon,
        placed: w.landscape.placed, seed: w.landscape.seed } : null,
    });
  })()`;

  const videoClock = `(() => {
    const video = document.querySelector(".world-layer video");
    return video ? Math.round(video.currentTime * 100) / 100 : null;
  })()`;

  /**
   * How much the generated picture actually changed over 2.5 s, as a mean per-channel luma delta.
   *
   * `video.currentTime` is not evidence of anything: a live WebRTC track keeps its media element's
   * clock advancing in real time whether or not frames are arriving, so a paused world reads exactly
   * like a running one. The pixels are the evidence — sampled straight off the <video>, so no CSS
   * transform, lane parallax or idle breath is in the measurement.
   */
  const frameDelta = `(async () => {
    const video = document.querySelector(".world-layer video");
    if (!video || video.readyState < 2 || !video.videoWidth) return null;
    const W = 32, H = 18;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const grab = () => { context.drawImage(video, 0, 0, W, H); return context.getImageData(0, 0, W, H).data; };
    const before = grab();
    await new Promise((done) => setTimeout(done, 2500));
    const after = grab();
    let sum = 0;
    for (let i = 0; i < before.length; i += 4) {
      sum += Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) + Math.abs(before[i + 2] - after[i + 2]);
    }
    return Math.round((sum / (before.length / 4) / 3) * 10) / 10;
  })()`;

  /**
   * The sound channel, from the model's own report.
   *
   * Whether the generated audio is *audible* is not something a headless probe can claim, and the
   * metrics that look like they could lie: `webkitAudioDecodedByteCount` stays 0 for a MediaStream-
   * backed element even while its audio track is live, and an AudioContext cannot be resumed without a
   * real user gesture. What can be checked is that the session says it is generating sound at all and
   * that the caption conditioning it is this world's — read from the `state` snapshot.
   */
  const audioReport = `(() => {
    const session = window.__orbisWorld?.()?.session;
    return session ? JSON.stringify({ enabled: session.audioEnabled, caption: session.audioPrompt }) : null;
  })()`;

  /**
   * The prepared landscape card, measured independently of the app.
   *
   * The picture is uploaded with its horizon deliberately low in the frame — the case that would have
   * the player running in the sky — and the probe then scans the *prepared* frame with its own row
   * brightness code rather than the app's, so the number printed here is not the app agreeing with
   * itself. The expected result is the game's line: 0.44.
   */
  const landscapeCard = `(async () => {
    const card = document.querySelector(".landscape-card");
    if (!card) return JSON.stringify({ error: "no prepared landscape" });
    const image = card.querySelector(".landscape-shot");
    const bitmap = await createImageBitmap(await (await fetch(image.src)).blob());
    const W = 48, H = 48;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0, W, H);
    const { data } = context.getImageData(0, 0, W, H);
    const rows = [];
    for (let row = 0; row < H; row += 1) {
      let sum = 0;
      for (let column = 0; column < W; column += 1) {
        const index = (row * W + column) * 4;
        sum += 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
      }
      rows.push(sum / W);
    }
    let step = 0, at = -1;
    for (let row = 1; row < H - 1; row += 1) {
      const drop = rows[row] - rows[row + 1];
      if (drop > step) { step = drop; at = row; }
    }
    return JSON.stringify({ ...card.dataset, preparedHorizon: (at + 1) / H, preparedStep: Math.round(step),
      preview: image.naturalWidth + "x" + image.naturalHeight });
  })()`;

  // Each world has its own speed ramp, so a pace check needs a run in the world being checked:
  // `WORLD=city node tools/orbis-probe.mjs ...` selects the card before the run starts.
  const wantedWorld = process.env.WORLD;
  if (wantedWorld) {
    const picked = await evaluate(`(() => {
      const card = document.querySelector(".world-card.world-${wantedWorld}");
      if (!card) return "missing";
      card.click();
      return document.querySelector(".start-button")?.textContent?.replace(/\\s+/g, " ").trim() ?? "";
    })()`);
    console.log(`world selected: ${wantedWorld} -> ${picked}`);
  }

  const worldWaitStart = Date.now();
  let menuLive = null;
  for (let attempt = 0; attempt < 260; attempt += 1) {
    const state = parseMenu(await evaluate(menuWorld));
    if (attempt % 10 === 0) {
      console.log(`menu world t+${Math.round((Date.now() - worldWaitStart) / 1000)}s: ${JSON.stringify(state)}`);
    }
    if (state.videoState === "streaming" && state.video?.readyState >= 2) {
      menuLive = state;
      break;
    }
    await sleep(1000);
  }
  console.log(
    `menu world live after: ${Math.round((Date.now() - worldWaitStart) / 1000)}s`,
    menuLive ? JSON.stringify(menuLive) : "NOT LIVE",
  );

  // "Moving" has to mean the video clock advances, not that a frame exists.
  const menuClock = async () => parseMenu(await evaluate(menuWorld)).video?.currentTime ?? null;
  const clockA = await menuClock();
  await sleep(4000);
  const clockB = await menuClock();
  console.log(`menu world motion: video clock ${clockA}s -> ${clockB}s over 4s of wall clock`);
  console.log(`menu world state:  ${await evaluate(worldState)}`);

  // `LANDSCAPE=1` builds a picture in the page and hands it to the real upload control, which is the
  // whole feature end to end: the file is prepared, measured, cropped, uploaded, pinned as the
  // session's starting frame and the world is rebuilt around it. The picture is made with its
  // horizon at `LANDSCAPE_HORIZON` (0.72 by default) — deliberately far below the game's line, which
  // is exactly what makes a player run in the sky if it reaches the model unaltered.
  if (process.env.LANDSCAPE === "1") {
    const horizon = Number(process.env.LANDSCAPE_HORIZON ?? 0.72);
    const built = await evaluate(`(async () => {
      const width = 900, height = 500;
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d");
      const sky = context.createLinearGradient(0, 0, 0, height * ${horizon});
      sky.addColorStop(0, "#ff9d4d"); sky.addColorStop(1, "#ffe9b0");
      context.fillStyle = sky; context.fillRect(0, 0, width, height * ${horizon});
      const ground = context.createLinearGradient(0, height * ${horizon}, 0, height);
      ground.addColorStop(0, "#6b3a1e"); ground.addColorStop(1, "#241209");
      context.fillStyle = ground; context.fillRect(0, height * ${horizon}, width, height - height * ${horizon});
      const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
      const file = new File([blob], "probe-landscape.png", { type: "image/png" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.querySelector(".landscape-input");
      if (!input) return "no upload control";
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return "uploaded a " + width + "x" + height + " picture, horizon at " + ${horizon};
    })()`);
    console.log(`landscape upload:  ${built}`);
    await sleep(2500);
    // The menu holds the run while the picture is pinned — pinning is a rebuild (reset, image,
    // start), and one landing under a run would be a hard cut through the dive. So this waits for the
    // control to come back rather than assuming a delay, and reports how long that took.
    const readButton = `(() => {
      const button = document.querySelector(".start-button");
      return JSON.stringify({ label: button?.textContent ?? null, disabled: button?.disabled ?? null,
        pinning: button?.dataset.pinning ?? null });
    })()`;
    const pinWait = Date.now();
    let button = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      button = JSON.parse((await evaluate(readButton)) ?? "null");
      if (attempt % 5 === 0 || !button?.disabled) {
        console.log(`  pin wait +${Math.round((Date.now() - pinWait) / 1000)}s: ${JSON.stringify(button)}`);
      }
      if (!button?.disabled) break;
      await sleep(1000);
    }
    console.log(`landscape card:    ${await evaluate(landscapeCard)}`);
    console.log(`landscape pinned:  ${await evaluate(worldState)}`);

    // The upload control is new interface, and a phone is where new interface breaks — a preview, a
    // name, a clear button and a hint in a column that is already narrow. The session is up by now, so
    // this costs a viewport rather than a second session, and the line above it carries the delivery
    // resolution the viewport asked for.
    await setViewport(phoneWidth, phoneHeight, true);
    await sleep(900);
    console.log(`menu with a landscape (${phoneWidth}x${phoneHeight}):`, await evaluate(menuReport));
    await setViewport(mobileRun ? phoneWidth : 1280, mobileRun ? phoneHeight : 800, mobileRun);
    await sleep(600);
  }

  if (SHOT_PATH) {
    const menuShot = await pageSocket.send("Page.captureScreenshot", { format: "png" });
    const menuPath = SHOT_PATH.replace(/\.png$/, ".menu.png");
    writeFileSync(menuPath, Buffer.from(menuShot.data, "base64"));
    await evaluate(`document.querySelector(".world-layer").style.visibility = "hidden"`);
    await sleep(400);
    const menuOffline = await pageSocket.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${menuPath}.offline.png`, Buffer.from(menuOffline.data, "base64"));
    await evaluate(`document.querySelector(".world-layer").style.visibility = "visible"`);
    console.log(`menu frames: ${menuPath}, ${menuPath}.offline.png`);

    // Why the world can be live in the DOM yet invisible on screen: find what paints over it.
    const clipShot = async (file, clip) => {
      const shot = await pageSocket.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
      writeFileSync(file, Buffer.from(shot.data, "base64"));
    };
    const corner = { x: 940, y: 0, width: 340, height: 200 };
    await clipShot(`${menuPath}.corner.png`, corner);
    await evaluate(`document.querySelector(".world-layer").style.visibility = "hidden"`);
    await sleep(300);
    await clipShot(`${menuPath}.corner.off.png`, corner);
    await evaluate(`document.querySelector(".world-layer").style.visibility = "visible"`);

    const menuStack = `(() => {
      const info = (label, el) => {
        if (!el) return label + ": missing";
        const style = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return label + ": " + [
          Math.round(r.left) + "x" + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height),
          "z=" + style.zIndex,
          "op=" + style.opacity,
          "bg=" + style.backgroundColor,
          "vis=" + style.visibility,
          "transform=" + style.transform,
        ].join(" ");
      };
      const covering = [...document.querySelectorAll("body *")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width >= window.innerWidth - 2 && r.height >= window.innerHeight - 2;
      }).map((el) => (el.className || el.tagName) + " z=" + getComputedStyle(el).zIndex + " bg=" + getComputedStyle(el).backgroundColor + " op=" + getComputedStyle(el).opacity + " filter=" + getComputedStyle(el).filter);
      const video = document.querySelector(".world-layer video");
      const ancestors = [];
      for (let el = video; el && el !== document.body; el = el.parentElement) {
        const style = getComputedStyle(el);
        ancestors.push(
          (el.className || el.tagName) + " [" + el.clientWidth + "x" + el.clientHeight + "]" +
          " display=" + style.display + " pos=" + style.position +
          " h=" + style.height + " w=" + style.width + " flex=" + style.flex +
          " inline=" + (el.getAttribute("style") ?? "-"),
        );
      }
      return JSON.stringify({
        layer: info("layer", document.querySelector(".world-layer")),
        video: info("video", video),
        videoBox: video ? { offsetHeight: video.offsetHeight, clientHeight: video.clientHeight, cssHeight: getComputedStyle(video).height, inline: video.getAttribute("style") } : null,
        ancestors,
        local: info("local", document.querySelector(".world-local")),
        shell: info("shell", document.querySelector(".app-shell")),
        scrim: info("scrim", document.querySelector(".menu-scrim")),
        backdrop: info("backdrop", document.querySelector(".menu-backdrop")),
        body: info("body", document.body),
        covering,
      });
    })()`;
    console.log("menu stacking:", await evaluate(menuStack));
  }

  // The dive from the menu into the run: the interface should leave while the already-live world
  // pushes in, and the world's name should pass through frame on the way.
  const enterState = `(() => {
    const html = document.documentElement;
    const veil = document.querySelector(".enter-veil");
    const menuLayout = document.querySelector(".menu-layout");
    const menuBackdrop = document.querySelector(".menu-backdrop");
    const worldFrame = document.querySelector(".world-video") ?? document.querySelector(".world-local");
    const runShell = document.querySelector('.app-shell[class*="environment-"]');
    const weather = document.querySelector(".enter-weather");
    return JSON.stringify({
      entering: html.dataset.entering ?? null,
      veil: Boolean(veil),
      card: document.querySelector(".enter-card strong")?.textContent ?? null,
      sub: document.querySelector(".enter-card .enter-sub")?.textContent?.trim() ?? null,
      // The world's own beat: which weather the dive paints, the line it holds, the readout under it.
      weather: veil?.dataset.weather ?? null,
      weatherOpacity: weather ? getComputedStyle(weather).opacity : null,
      line: document.querySelector(".enter-card .enter-line")?.textContent ?? null,
      lineOpacity: (() => {
        const el = document.querySelector(".enter-card .enter-line");
        return el ? getComputedStyle(el).opacity : null;
      })(),
      ambience: document.querySelector(".enter-card .enter-ambience")?.textContent ?? null,
      menuOpacity: menuLayout ? getComputedStyle(menuLayout).opacity : null,
      menuBlur: menuLayout ? getComputedStyle(menuLayout).filter : null,
      scrimOpacity: menuBackdrop ? getComputedStyle(menuBackdrop).opacity : null,
      worldTransform: worldFrame ? getComputedStyle(worldFrame).transform : null,
      worldFilter: worldFrame ? getComputedStyle(worldFrame).filter : null,
      runShell: Boolean(runShell),
      // Whether the dive could reach the model at all: a launch prompt can only arrive on a ready
      // session, so an unreachable link must not be reported as a missing intro.
      status: document.querySelector(".world-layer")?.dataset.status ?? null,
      video: document.querySelector(".world-layer")?.dataset.video ?? null,
    });
  })()`;

  await evaluate(`document.querySelector(".start-button").click()`);

  // Screenshots take real time, so the clock is measured rather than assumed: a sample labelled
  // t+700ms is taken 700ms after the click, whatever the capture in between cost. Capturing a frame
  // mid-dive costs 1-3 s each in software-rendered headless Chrome, which distorts the very timing
  // it is meant to show, so the dive frames are opt-in: DIVE_FRAMES=1.
  const diveFrames = process.env.DIVE_FRAMES === "1" && SHOT_PATH ? SHOT_PATH.replace(/\.png$/, ".dive") : null;
  const diveStart = Date.now();
  for (const [index, at] of [320, 700, 1050, 1500].entries()) {
    const wait = at - (Date.now() - diveStart);
    if (wait > 0) await sleep(wait);
    console.log(`transition t+${Date.now() - diveStart}ms: ${await evaluate(enterState)}`);
    if (diveFrames && index < 3) {
      const shot = await pageSocket.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${diveFrames}-${index + 1}.png`, Buffer.from(shot.data, "base64"));
    }
  }
  console.log(`after the dive:    ${await evaluate(enterState)}`);
  if (diveFrames) console.log(`dive frames: ${diveFrames}-1.png .. -3.png`);

  // The launch: a run opens faster than it cruises, then settles into the normal speed ramp.
  const launchState = `(() => {
    const hud = document.querySelector(".run-hud")?.textContent ?? "";
    return JSON.stringify({
      hud: hud.replace(/\\s+/g, " "),
      runSpeed: getComputedStyle(document.documentElement).getPropertyValue("--run-speed").trim(),
      roadGrade: getComputedStyle(document.documentElement).getPropertyValue("--road-grade").trim(),
    });
  })()`;
  console.log(`just after the swap: ${await evaluate(launchState)}`);
  await sleep(900);
  console.log(`launch +0.9s:        ${await evaluate(launchState)}`);
  await sleep(1500);
  console.log(`cruise +2.4s:        ${await evaluate(launchState)}`);
  // A run that never started must not read as a clean probe: every measurement after this point
  // describes nothing at all — a menu with no world, a pause nobody asked for — and that is exactly
  // how a blocked start button hid itself the first time this ran.
  if (!(await evaluate(`Boolean(document.querySelector(".run-hud"))`))) {
    console.log("!! the run never started — every run measurement below describes the menu");
    process.exitCode = 1;
  }

  const snapshot = `(() => {
    const chip = document.querySelector(".orbis-preview");
    const wrap = document.querySelector(".world-layer");
    const video = wrap?.querySelector("video");
    const layers = [...document.querySelectorAll(".app-shell *")]
      .filter((el) => {
        const style = getComputedStyle(el);
        return style.position === "absolute" && el.clientWidth > 400;
      })
      .map((el) => el.className + " z=" + getComputedStyle(el).zIndex + " op=" + getComputedStyle(el).opacity + " size=" + el.clientWidth + "x" + el.clientHeight);
    return JSON.stringify({
      chip: chip?.textContent?.trim(),
      hud: document.querySelector(".run-hud")?.textContent?.trim(),
      runSpeed: getComputedStyle(document.documentElement).getPropertyValue("--run-speed").trim(),
      hit: getComputedStyle(document.documentElement).getPropertyValue("--hit").trim(),
      grading: {
        worldLuma: getComputedStyle(document.documentElement).getPropertyValue("--world-luma").trim(),
        tone: getComputedStyle(document.documentElement).getPropertyValue("--world-tone").trim(),
        road: getComputedStyle(document.documentElement).getPropertyValue("--road-grade").trim(),
        source: getComputedStyle(document.documentElement).getPropertyValue("--road-grade-source").trim(),
      },
      worldX: getComputedStyle(document.documentElement).getPropertyValue("--world-x").trim(),
      // The vertical lock: where the generated horizon was measured (source fraction, 0 = top of
      // the video frame) and how far the video was shifted to put it on the game's line (shift,
      // % of viewport height, positive = the video content moved down).
      alignment: {
        source: getComputedStyle(document.documentElement).getPropertyValue("--world-horizon").trim(),
        window: getComputedStyle(document.documentElement).getPropertyValue("--world-horizon-window").trim(),
        shift: getComputedStyle(document.documentElement).getPropertyValue("--world-y").trim(),
        target: getComputedStyle(document.documentElement).getPropertyValue("--game-horizon").trim(),
        samples: getComputedStyle(document.documentElement).getPropertyValue("--world-horizon-samples").trim(),
        // How clear the skyline was: the winning step's size and its margin over the runner-up. Small
        // numbers mean the lock read a skyline out of texture, which is what the gates refuse.
        step: getComputedStyle(document.documentElement).getPropertyValue("--world-align-step").trim(),
        contrast: getComputedStyle(document.documentElement).getPropertyValue("--world-align-contrast").trim(),
      },
      videoTransform: wrap ? getComputedStyle(wrap).transform : null,
      chipData: chip ? { ...chip.dataset } : null,
      videoData: wrap ? { ...wrap.dataset } : null,
      hasVideoWrapper: Boolean(wrap),
      hasVideo: Boolean(video),
      video: video ? {
        readyState: video.readyState,
        width: video.videoWidth,
        height: video.videoHeight,
        paused: video.paused,
        currentTime: Math.round(video.currentTime * 10) / 10,
        srcObject: video.srcObject?.getTracks?.().map((t) => t.kind + ":" + t.readyState) ?? null,
        muted: video.muted,
        style: video.getAttribute("style"),
        // The vertical lock's actual output: the overscan and the shift, as the browser composited
        // them. Reading the <video> element rather than the wrapper is the point — that transform is
        // what moves the generated horizon.
        transform: getComputedStyle(video).transform,
      } : null,
      worldLayer: (() => {
        const el = document.querySelector(".world-layer");
        return el
          ? getComputedStyle(el).opacity + " z=" + getComputedStyle(el).zIndex + " video=" + el.dataset.video
          : null;
      })(),
      bigLayers: layers.slice(0, 10),
    });
  })()`;

  // What the run looks like where it is being played: the HUD and the world chip are absolutely
  // positioned, so on a phone they are the things that can collide or run off-screen.
  const runLayout = `(() => {
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return Math.round(r.width) + "x" + Math.round(r.height) + "@" + Math.round(r.top) + "," + Math.round(r.left);
    };
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
    /**
     * Which element actually receives a click at a control's centre. Geometry says two boxes overlap;
     * only this says which one is on top, which is the difference between a dimmed panel and a control
     * that has been taken away.
     */
    const hitAt = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit ? String(hit.className || hit.tagName).split(" ")[0] : null;
    };
    const overlap = (a, b) => {
      const x = rect(a);
      const y = rect(b);
      if (!x || !y) return null;
      const w = Math.min(x.right, y.right) - Math.max(x.left, y.left);
      const h = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
      return w > 2 && h > 2 ? Math.round(w) + "x" + Math.round(h) : 0;
    };
    const canvas = document.querySelector(".game-stage canvas");
    return JSON.stringify({
      viewport: window.innerWidth + "x" + window.innerHeight,
      hud: box(".run-hud"),
      hudTokens: document.querySelector(".run-hud")?.textContent?.replace(/\\s+/g, " ") ?? null,
      tokenMultiplier: document.querySelector(".token-mult")?.textContent ?? null,
      // The reward readout: how far up this world's curve the run is, what a token pays now against
      // its ceiling, and what the token just picked up was worth.
      reward: (() => {
        const ramp = document.querySelector(".token-ramp");
        if (!ramp) return null;
        return {
          ramp: Number(ramp.dataset.ramp),
          tier: Number(ramp.dataset.tier),
          value: Number(ramp.dataset.tokenValue),
          peak: Number(ramp.dataset.peakValue),
          label: ramp.querySelector(".token-ramp-label")?.textContent ?? null,
          beat: ramp.classList.contains("is-beat"),
          lastToken: document.querySelector(".token-gain")?.textContent ?? null,
        };
      })(),
      header: box(".run-header"),
      // The header is a single flex row, so the probe can only see it as one box — which hides a title
      // and a status that have wrapped on top of each other inside it.
      headerParts: {
        exit: box(".run-header .quiet-button"),
        title: box(".run-title"),
        status: box(".run-status"),
      },
      titleOverStatus: overlap(".run-title", ".run-status"),
      exitOverTitle: overlap(".run-header .quiet-button", ".run-title"),
      chip: box(".orbis-preview"),
      stage: box(".game-stage"),
      directorCard: box(".director-card"),
      canvas: canvas ? canvas.clientWidth + "x" + canvas.clientHeight : null,
      // Any non-zero overlap between things that are positioned on top of the world.
      hudOverChip: overlap(".run-hud", ".orbis-preview"),
      hudOverCard: overlap(".run-hud", ".director-card"),
      headerOverChip: overlap(".run-header", ".orbis-preview"),
      // Every pair of overlays, not just the three that were suspected first: on a phone these all sit
      // in the same column, and any two of them can collide.
      headerOverHud: overlap(".run-header", ".run-hud"),
      headerOverCard: overlap(".run-header", ".director-card"),
      chipOverCard: overlap(".orbis-preview", ".director-card"),
      chipOverHud: overlap(".orbis-preview", ".run-hud"),
      hudOverPause: overlap(".run-hud", ".pause-overlay"),
      pauseOverlay: box(".pause-overlay"),
      // Who wins a click at each control while the pause dimming is up.
      topmost: {
        hud: hitAt(".run-hud"),
        exit: hitAt(".run-header .quiet-button"),
        retry: hitAt(".orbis-preview .quiet-button"),
      },
      offscreenRight: [".run-hud", ".orbis-preview", ".director-card", ".pause-overlay"]
        .map((sel) => ({ sel, over: rect(sel) ? Math.round(rect(sel).right - window.innerWidth) : null }))
        .filter((item) => item.over !== null && item.over > 1),
      offscreenBottom: [".run-hud", ".director-card", ".orbis-preview", ".pause-overlay"]
        .map((sel) => ({ sel, over: rect(sel) ? Math.round(rect(sel).bottom - window.innerHeight) : null }))
        .filter((item) => item.over !== null && item.over > 1),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      overflowY: document.documentElement.scrollHeight > window.innerHeight + 2,
    });
  })()`;

  // Exercise the runner with real inputs so jumps, slides, near misses, and stumbles all run.
  const pressKey = `(() => {
    const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    const key = keys[Math.floor(Math.random() * keys.length)];
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    return key;
  })()`;

  // A value-up beat lasts 1.8 s and the samples are 5 s apart, so a sample would usually miss it.
  // `BEATS=1` polls the readout between the normal samples instead, which is the only way to catch a
  // transient: it counts the beats and records the highest tier the ramp reached.
  const beatsWanted = process.env.BEATS === "1";
  const rewardOnly = `(() => {
    const ramp = document.querySelector(".token-ramp");
    if (!ramp) return null;
    return JSON.stringify({ tier: Number(ramp.dataset.tier), beat: ramp.classList.contains("is-beat"),
      label: ramp.querySelector(".token-ramp-label")?.textContent ?? null });
  })()`;
  let beatsSeen = 0;
  let topTier = 0;
  const beatLabels = new Set();

  // Bounds the prompt check below: what the run asked the model for, not what the menu did.
  const runBegan = Date.now();

  // The control for the paused measurement below: the same pixels, same window, while the world is
  // running. Without it a small paused number would be indistinguishable from a stalled video.
  const runningDelta = await evaluate(frameDelta);
  console.log(`world running: frames changed by ${runningDelta} over 2.5s`);
  console.log(`world sound:   ${await evaluate(audioReport)}`);

  // The pause overlay is the one panel that exists only when the player asks for it, drawn over a
  // canvas that fills the screen — so it is measured on request rather than never. Space is the live
  // binding, dispatched with the `code` the handler reads.
  const pressSpace = `window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }))`;
  await evaluate(pressSpace);
  await sleep(450);
  console.log(`paused layout:     ${await evaluate(runLayout)}`);

  // A pause has to reach the *model*, not just the game: the paused session stops producing chunks,
  // which is both what a frozen world should look like and the one lever that stops an open session
  // from costing anything. `pause` takes effect when the chunk already in flight finishes, so the
  // reported state is waited for rather than assumed, and the video clock is then timed — a clock
  // that keeps advancing would mean the world was still generating behind a paused game.
  let pausedSession = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    pausedSession = JSON.parse((await evaluate(worldState)) ?? "null");
    console.log(`    pause poll +${attempt}s: ${JSON.stringify(pausedSession?.session ?? null)} hidden=${await evaluate(`document.visibilityState`)}`);
    if (pausedSession?.session?.paused) break;
    await sleep(1000);
  }
  // A pause stops *generation*; the media element still has whatever the track already delivered, so
  // it plays that out and only then freezes. Measuring straight after the state flips reads a moving
  // picture and says nothing — hence the settle, and hence the running control above taken with the
  // same code and the same window.
  await sleep(5000);
  const pausedClockA = await evaluate(videoClock);
  const pausedDelta = await evaluate(frameDelta);
  const pausedClockB = await evaluate(videoClock);
  console.log(`world pause:       ${JSON.stringify(pausedSession?.session ?? null)}`);
  console.log(`world paused: frames changed by ${pausedDelta} (control, while running: ${runningDelta}) over 2.5s, 5s after the pause`);
  console.log(`world paused: media clock ${pausedClockA}s -> ${pausedClockB}s`);

  await evaluate(pressSpace);
  await sleep(1200);
  console.log(`world resume:      ${await evaluate(worldState)}`);

  for (let tick = 0; tick < Math.ceil(RUN_SECONDS / 5); tick += 1) {
    for (let press = 0; press < 4; press += 1) {
      await evaluate(pressKey);
      await sleep(900);
    }
    await sleep(1400);
    const state = await evaluate(snapshot);
    console.log(`--- t+${(tick + 1) * 5}s --- ${state}`);
    console.log(`    world: ${await evaluate(worldState)}`);
    if (!beatsWanted) continue;
    for (let poll = 0; poll < 8; poll += 1) {
      const raw = await evaluate(rewardOnly);
      if (raw) {
        const reward = JSON.parse(raw);
        topTier = Math.max(topTier, reward.tier);
        if (reward.beat) {
          beatsSeen += 1;
          if (reward.label) beatLabels.add(reward.label);
        }
      }
      await sleep(250);
    }
  }
  if (beatsWanted) {
    console.log(`value-up beats seen: ${beatsSeen}; top tier reached ${topTier}/4` +
      `${beatLabels.size ? `; labels ${[...beatLabels].join(" | ")}` : ""}`);
  }

  // Layout of the finished run, where it is being played.
  console.log(`run layout:        ${await evaluate(runLayout)}`);

  /**
   * One ask per chunk.
   *
   * Orbis reads the prompt in force when a chunk starts, so a second prompt sent inside the same
   * chunk is thrown away unread — an event the player felt, spent on nothing. The journal records the
   * chunk each ask went out in, so the check is arithmetic on the run that actually happened.
   */
  const chunkSpend = await evaluate(`(() => {
    const records = (window.__orbisPrompts ?? []).filter(
      (entry) => entry.channel === "run" && entry.track !== "audio" && entry.ok,
    );
    const byChunk = new Map();
    for (const entry of records) {
      const key = entry.chunk ?? -1;
      byChunk.set(key, (byChunk.get(key) ?? 0) + 1);
    }
    const doubled = [...byChunk.entries()].filter(([, count]) => count > 1);
    return JSON.stringify({ asks: records.length, chunks: byChunk.size,
      chunkRange: records.length ? [records[0].chunk, records[records.length - 1].chunk] : null,
      doubled: doubled.length });
  })()`);
  console.log(`run prompts:       ${chunkSpend} (one ask per chunk; "doubled" counts chunks that took two)`);
  if (JSON.parse(chunkSpend)?.doubled > 0) process.exitCode = 1;

  // What a horizon detector would actually see. Sampling the <video> straight into a canvas reads
  // the generated frames themselves, with no CSS transform, no lane parallax and no idle breath in
  // the measurement — a screenshot pair cannot do this, because it captures whatever the layer
  // transforms were doing at that instant. Two rows of output: how much each row *changed* between
  // two samples (what the lock keys on), and how bright each row is (what a step detector would key
  // on).
  const worldProfile = await evaluate(`(async () => {
    const video = document.querySelector(".world-layer video");
    if (!video || video.readyState < 2 || !video.videoWidth) return JSON.stringify({ error: "no live frames" });
    const W = 48, H = 48;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const luma = (data, i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    const sample = () => {
      context.clearRect(0, 0, W, H);
      context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, W, H);
      return context.getImageData(0, 0, W, H).data;
    };
    const a = sample();
    await new Promise((resolve) => setTimeout(resolve, 450));
    const b = sample();
    const activity = [];
    const brightness = [];
    for (let y = 0; y < H; y += 1) {
      let change = 0;
      let bright = 0;
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4;
        change += Math.abs(luma(a, i) - luma(b, i));
        bright += luma(a, i);
      }
      activity.push(change / W);
      brightness.push(bright / W);
    }
    const reference = activity.slice(-5).reduce((sum, value) => sum + value, 0) / 5;
    return JSON.stringify({
      reference: Math.round(reference * 10) / 10,
      activity: activity.map((value) => Math.round((reference ? value / reference : 0) * 100) / 100),
      brightness: brightness.map((value) => Math.round(value)),
    });
  })()`);
  const profile = JSON.parse(worldProfile);
  if (profile.error) {
    console.log(`world profile:     ${profile.error}`);
  } else {
    const glyph = (value) =>
      value < 0.05 ? "." : value < 0.12 ? ":" : value < 0.25 ? "+" : value < 0.45 ? "*" : value < 0.7 ? "#" : "@";
    console.log(`world profile:     reference (bottom-band |delta luma|) ${profile.reference}`);
    console.log(`  row   change  brightness map`);
    profile.activity.forEach((value, row) => {
      const percent = String(Math.round((row / profile.activity.length) * 100)).padStart(3);
      console.log(
        `  ${percent}%  ${value.toFixed(2).padStart(6)}  ${String(profile.brightness[row]).padStart(10)}  ${glyph(value)}`,
      );
    });
  }

  if (SHOT_PATH) {
    // Hide the HUD so the captured frame shows only the 3D layer and the generated video.
    await evaluate(`document.querySelectorAll(".run-header, .run-hud, .director-card, .orbis-preview, .orbis-sound").forEach((el) => { el.style.display = "none"; })`);
    await sleep(700);
    const shot = await pageSocket.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(SHOT_PATH, Buffer.from(shot.data, "base64"));
    console.log(`screenshot written to ${SHOT_PATH}`);

    // Companion frames: without the generated video, and with only the generated video, so a
    // diff can show how much of the world is actually visible through the 3D layer.
    await evaluate(`document.querySelector(".world-layer").style.visibility = "hidden"`);
    await sleep(400);
    const withoutVideo = await pageSocket.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${SHOT_PATH}.3d.png`, Buffer.from(withoutVideo.data, "base64"));

    // Ribbon on its own: with the local gradient hidden too, its rendered luma is measurable, which
    // is what calibrates the per-world grade.
    await evaluate(`document.querySelector(".world-local").style.visibility = "hidden"`);
    await sleep(300);
    const ribbonOnly = await pageSocket.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${SHOT_PATH}.ribbon.png`, Buffer.from(ribbonOnly.data, "base64"));
    await evaluate(`document.querySelector(".world-local").style.visibility = "visible"`);

    await evaluate(`document.querySelector(".world-layer").style.visibility = "visible"; document.querySelector(".game-stage").style.visibility = "hidden"`);
    await sleep(400);
    const videoOnly = await pageSocket.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${SHOT_PATH}.video.png`, Buffer.from(videoOnly.data, "base64"));

    // A time pair of the generated layer alone. Two frames of the same shot a fraction of a second
    // apart are the only way to check the premise the vertical lock is built on — that the sky holds
    // still while the ground scrolls — and to see where the boundary between them falls. They are
    // captured with every other layer hidden, so what moves in the diff is the world, not the road.
    await sleep(450);
    const videoLater = await pageSocket.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${SHOT_PATH}.video-b.png`, Buffer.from(videoLater.data, "base64"));
    console.log(
      `companion frames: ${SHOT_PATH}.3d.png, ${SHOT_PATH}.ribbon.png, ${SHOT_PATH}.video.png, ` +
        `${SHOT_PATH}.video-b.png (world activity pair)`,
    );
  }

  // Leaving a run mirrors entering one: the run pulls back out, the menu reassembles around the
  // world's wide shot, and the world itself keeps streaming through all of it.
  const exitState = `(() => {
    const runShell = document.querySelector('.app-shell[class*="environment-"]');
    const menu = document.querySelector(".menu");
    const layout = document.querySelector(".menu-layout");
    const wrap = document.querySelector(".world-layer");
    const video = wrap?.querySelector("video");
    return JSON.stringify({
      exiting: document.documentElement.dataset.exiting ?? null,
      runShell: runShell ? getComputedStyle(runShell).opacity + " blur=" + getComputedStyle(runShell).filter : null,
      menu: Boolean(menu),
      returning: menu?.dataset.returning ?? null,
      menuOpacity: layout ? getComputedStyle(layout).opacity : null,
      chip: (document.querySelector(".engine-chip") ?? document.querySelector(".orbis-preview"))?.textContent?.trim() ?? null,
      videoState: wrap?.dataset.video ?? null,
      videoTime: video ? Math.round(video.currentTime * 10) / 10 : null,
    });
  })()`;

  // Every prompt the app asked the model for, read from the page's own journal rather than from
  // console lines: browser log delivery lags the send, which is how a previous world's prompt used
  // to be attributed to the next world's dive. Windows are bounded by timestamp, not by index,
  // because the journal is capped and its indices shift.
  const readPrompts = async () => JSON.parse(await evaluate("JSON.stringify(window.__orbisPrompts ?? [])"));
  const promptsSince = async (since) => (await readPrompts()).filter((entry) => entry.at >= since);

  // The reward curve reaching the world: every tier crossing is a directed prompt, so the journal
  // says whether Orbis was actually asked to answer it — and whether the ask was dropped.
  const duringRun = await promptsSince(runBegan);
  console.log(
    `prompts in run:    ${duringRun.length} ` +
      `(${duringRun
        .map(
          (entry) =>
            `${entry.reason}${entry.dropped ? ` DROPPED(${entry.dropped})` : entry.ok ? "" : " unresolved"}`,
        )
        .join(", ") || "none"}); tier crossings asked for: ` +
      `${duringRun.filter((entry) => entry.prompt.includes("escalation")).length}`,
  );

  await evaluate(`document.querySelector(".run-header .quiet-button").click()`);
  const beforeExit = Date.now();
  await sleep(300);
  console.log(`exit t+300ms:      ${await evaluate(exitState)}`);
  await sleep(500);
  console.log(`exit t+800ms:      ${await evaluate(exitState)}`);
  await sleep(800);
  console.log(`back in the menu:  ${await evaluate(exitState)}`);

  // Leaving must silence the run, not just hide it. The run shell is present for the whole exit and
  // its simulation keeps running, so a queued director event used to fire over the menu's wide shot.
  const afterExit = await promptsSince(beforeExit);
  const runEventsAfterExit = afterExit.filter((entry) => entry.reason === "run-event");
  const dropCount = (list) => list.filter((entry) => entry.dropped).length;
  console.log(
    `prompts after Exit: ${afterExit.length} ` +
      `(${afterExit
        .map(
          (entry) =>
            `${entry.reason}:${entry.environment}@-${Date.now() - entry.at}ms` +
            `${entry.dropped ? ` DROPPED(${entry.dropped})` : entry.ok ? "" : " unresolved"}`,
        )
        .join(", ") || "none"}); ` +
      `run events after Exit: ${runEventsAfterExit.length} ` +
      `(dropped by the bus: ${dropCount(afterExit)})`,
  );

  // Each world's own intro: selecting a world should swap the launch prompt and the beat without
  // ever cutting the stream. Opt-in because it costs a dive and an exit per world.
  if (process.env.INTROS === "1") {
    console.log("\n=== PER-WORLD INTROS ===");
    // The phrase only that world's launch prompt contains, used to prove the right one arrived.
    const INTRO_SIGNATURE = {
      desert: "crest of a dune",
      city: "rain-slick neon avenue",
      forest: "beneath the canopy of an old-growth forest",
    };
    for (const worldId of ["desert", "city", "forest"]) {
      const before = Date.now();
      await evaluate(`document.querySelector(".world-card.world-${worldId}")?.click()`);
      await sleep(200);
      const cta = await evaluate(`document.querySelector(".start-button")?.textContent?.replace(/\\s+/g, " ").trim()`);
      await evaluate(`document.querySelector(".start-button")?.click()`);
      await sleep(380);
      const early = JSON.parse(await evaluate(enterState));
      await sleep(460);
      const settled = JSON.parse(await evaluate(enterState));
      await sleep(900);
      const after = JSON.parse(await evaluate(enterState));
      // Every prompt that went out during the dive, not just the first: a launch prompt that gets
      // overwritten by something else is exactly the bug this pass exists to catch.
      const sent = await promptsSince(before);
      const signature = INTRO_SIGNATURE[worldId];
      const launchEntry = sent.find(
        (entry) => entry.reason === "launch" && entry.prompt.includes(signature),
      );
      // A launch prompt for the world the player picked, and nothing else steering the world during
      // the dive: a run event that lands first makes the opening chunks belong to an older moment.
      const wrongWorld = sent.filter((entry) => entry.environment && entry.environment !== worldId);
      const runEvents = sent.filter((entry) => entry.reason === "run-event");
      const launchAt = launchEntry?.at ?? Infinity;
      const beforeLaunch = runEvents.filter((entry) => entry.at < launchAt);
      const dropped = sent.filter((entry) => entry.dropped);
      console.log(
        `${worldId}: cta="${cta}" card="${early.card}" sub="${early.sub}"\n` +
          `  weather=${early.weather} atmos=${early.weatherOpacity} ` +
          `line="${early.line}" (${early.lineOpacity}) ambience="${early.ambience}"\n` +
          `  t+380ms line=${early.lineOpacity} → t+840ms line=${settled.lineOpacity} → after entering=${after.entering}\n` +
          `  world link during the dive: ${early.status}/${early.video}\n` +
          `  prompts: ${sent.length}; bespoke launch ${launchEntry ? "yes" : "MISSING"}` +
          ` (${launchEntry?.ok ? "accepted" : launchEntry?.dropped ?? launchEntry?.error ?? "awaiting the next chunk boundary"})` +
          `; wrong-world ${wrongWorld.length}` +
          `; run events before the launch ${beforeLaunch.length}` +
          `; dropped ${dropped.length}\n` +
          sent
            .map(
              (entry, index) =>
                `    ${index + 1}. [${entry.reason} ${entry.environment} @-${Date.now() - entry.at}ms` +
                `${entry.dropped ? ` DROPPED(${entry.dropped})` : entry.error ? ` ERROR(${entry.error.slice(0, 40)})` : entry.ok ? " ok" : " no-ack-yet"}] ` +
                `${entry.prompt.slice(0, 110)}...`,
            )
            .join("\n"),
      );
      // Back out to the menu so the next world can be selected.
      await evaluate(`document.querySelector(".run-header .quiet-button")?.click()`);
      await sleep(1400);
    }
  }

  console.log("\n=== NETWORK/EVENTS ===");
  console.log(events.slice(-40).join("\n") || "(none)");
  // The pause reconciler's own trace: what it wanted, what it asked for, and what the model
  // answered (see the trace in src/orbis/WorldLayer.tsx). Counts plus a tail, not the whole log.
  console.log(
    "pause trace:",
    await evaluate(`(() => {
      const entries = window.__orbisTrace ?? [];
      const counts = {};
      for (const entry of entries) counts[entry.what] = (counts[entry.what] ?? 0) + 1;
      return JSON.stringify({ counts, head: entries.slice(0, 4), tail: entries.slice(-10) });
    })()`),
  );
  console.log("\n=== CONSOLE ===");
  console.log(logs.slice(-60).join("\n") || "(none)");

  // Close the page target so React unmounts and the SDK ends its Reactor session —
  // otherwise the leaked session blocks the next run (the account allows one at a time).
  await browserSocket.send("Target.closeTarget", { targetId: page.id });
  await sleep(3000);

  pageSocket.close();
  browserSocket.close();
} catch (error) {
  console.error("probe failed:", error);
} finally {
  chrome.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
