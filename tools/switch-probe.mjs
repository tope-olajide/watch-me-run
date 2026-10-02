// Temporary diagnostic probe: does the generated world follow a world switch?
//
// The case the player reported: play one world, come back to the menu, pick another, and the
// generated picture stays in the old world. The menu is local, so the switch is made on a *warm*
// session — the one the previous run left behind inside its grace window — and the world layer is
// supposed to re-prompt that same session into the new world. This probe drives exactly that path and
// reads the two places the answer lives: the page's own prompt journal (was the new world asked for?)
// and the picture itself (did it arrive?).
//
// The picture is classified by its own pixels rather than by what the app says about itself: forest
// frames lead green, desert frames lead red, and a frame sampled off the <video> is the model's
// output and nothing else. `WORLD_A` / `WORLD_B` pick the two worlds (default forest → desert).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_URL = process.argv[2] ?? "http://localhost:8888/";
const PORT = Number(process.env.PROBE_PORT ?? 9334);
const SHOT_PATH = process.argv[3];
const WORLD_A = process.env.WORLD_A ?? "forest";
const WORLD_B = process.env.WORLD_B ?? "desert";
const LABEL = { desert: "The Dunes", city: "Neon Pursuit", forest: "The Forest" };
/** How long a cold session may take before the wait is reported as a timeout. */
const LOAD_BUDGET_MS = 70_000;
/** How long the switched world is given to morph before a "still the old world" verdict. */
const MORPH_BUDGET_MS = Number(process.env.MORPH_MS ?? 20_000);

const profile = mkdtempSync(join(tmpdir(), "watchme-switch-"));
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

  const logs = [];
  pageSocket.on((message) => {
    if (message.method === "Runtime.consoleAPICalled") {
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(" ");
      logs.push(`[${message.params.type}] ${text}`.slice(0, 300));
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      logs.push(`[exception] ${details.exception?.description ?? details.text}`.slice(0, 500));
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
    return result.result?.value;
  };

  /** What the world bus says, in development: the session and the world it has been armed for. */
  const worldState = `(() => {
    const w = window.__orbisWorld?.();
    if (!w) return "no world bus";
    return JSON.stringify({
      status: w.status, video: w.videoState, error: w.error ?? null,
      runActive: w.runActive, pinning: w.pinning, world: w.world,
      sessionId: w.sessionId ?? null,
      session: { started: w.session.started, paused: w.session.paused, chunk: w.session.chunk },
    });
  })()`;

  /**
   * The generated frame, as three numbers the picture can be classified by.
   *
   * Sampled straight off the <video>, so no CSS transform, no lane parallax and no interface is in
   * the measurement — this is the model's own output. `greenLead` is green above the stronger of red
   * and blue (a forest's signature), `warmLead` is red above blue (a desert's).
   */
  const frameSign = `(() => {
    const video = document.querySelector(".world-layer video");
    if (!video || video.readyState < 2 || !video.videoWidth) return "no frames";
    const W = 48, H = 27;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(video, 0, 0, W, H);
    const { data } = context.getImageData(0, 0, W, H);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
    }
    r /= n; g /= n; b /= n;
    return JSON.stringify({
      r: Math.round(r), g: Math.round(g), b: Math.round(b),
      greenLead: Math.round(g - Math.max(r, b)),
      warmLead: Math.round(r - b),
    });
  })()`;

  const readPrompts = async () => JSON.parse(await evaluate("JSON.stringify(window.__orbisPrompts ?? [])"));
  /** The frame signature, tolerating a video that has no frames yet (no run, or a reconnect). */
  const sampleFrame = async () => {
    const raw = await evaluate(frameSign);
    if (typeof raw !== "string" || !raw.startsWith("{")) return { error: String(raw) };
    return JSON.parse(raw);
  };
  const promptLine = (entry) =>
    `${entry.reason}:${entry.environment}` +
    `${entry.track === "audio" ? "/audio" : ""}` +
    `${entry.dropped ? ` DROPPED(${entry.dropped})` : entry.error ? ` ERROR(${String(entry.error).slice(0, 40)})` : entry.ok ? " ok" : " awaiting"}`;

  /** The world a prompt paragraph names, from the words only that world's opening contains. */
  const worldOfPrompt = (text = "") => {
    if (text.includes("moss-covered forest")) return "forest";
    if (text.includes("neon city")) return "city";
    if (text.includes("ancient desert")) return "desert";
    return null;
  };

  /**
   * Start the selected world and wait for the *run* to be on screen — not for the bus to say the
   * session is streaming, which a warm session says before the world it holds has changed at all.
   * What the player waits for is the loader, so the loader is what this follows: its stage, its line,
   * and the surface the app says is on screen.
   */
  const startRun = async (worldId) => {
    await evaluate(`document.querySelector(".world-card.world-${worldId}")?.click()`);
    await sleep(300);
    const card = await evaluate(`document.querySelector(".world-card.selected .world-copy strong")?.textContent ?? null`);
    const before = await evaluate(worldState);
    const beforeSession = JSON.parse(before)?.sessionId ?? null;
    const at = Date.now();
    await evaluate(`document.querySelector(".start-button")?.click()`);

    const loaderReport = `(() => {
      const loader = document.querySelector(".world-loader");
      return JSON.stringify({
        surface: document.documentElement.dataset.surface ?? null,
        stage: loader?.dataset.stage ?? null,
        line: loader?.querySelector(".loader-line")?.textContent ?? null,
      });
    })()`;

    let state = JSON.parse(await evaluate(worldState));
    let runAt = null;
    const seen = [];
    while (Date.now() - at < LOAD_BUDGET_MS) {
      const report = JSON.parse(await evaluate(loaderReport));
      const step = `${report.stage}|${report.line}`;
      if (report.stage !== null && seen[seen.length - 1] !== step) {
        seen.push(step);
        console.log(`[${worldId}] loader stage ${report.stage}: ${report.line} (t+${((Date.now() - at) / 1000).toFixed(1)}s)`);
      }
      if (report.surface === "run") {
        runAt = Date.now();
        break;
      }
      await sleep(300);
    }
    state = JSON.parse(await evaluate(worldState));
    console.log(
      `\n[${worldId}] selected "${card}" — session ${beforeSession ?? "none"} → ${state?.sessionId ?? "none"}` +
        `${beforeSession && state?.sessionId === beforeSession ? " (reused: warm)" : " (new session)"}`,
    );
    console.log(
      `[${worldId}] run on screen after ${runAt ? `${((runAt - at) / 1000).toFixed(1)}s` : "NEVER within the budget"}` +
        `; status ${state?.status}/${state?.video}; world ${state?.world}; ${state?.error ? `error: ${state.error}` : "no error"}`,
    );
    return { at, sessionId: state?.sessionId ?? null, runAt };
  };

  /** Everything the run left behind: the picture and the prompts that steered it. */
  const inspect = async (tag, since) => {
    const sign = await sampleFrame();
    const sincePrompts = (await readPrompts()).filter((entry) => entry.at >= since).map(promptLine);
    console.log(`[${tag}] picture r/g/b ${sign.r}/${sign.g}/${sign.b} (green ${sign.greenLead}, warm ${sign.warmLead})`);
    console.log(`[${tag}] prompts: ${sincePrompts.slice(-8).join(", ") || "none"}`);
    return sign;
  };

  /** Leave the run and wait for the menu's Start button to be back. */
  const exitRun = async () => {
    await evaluate(`document.querySelector(".run-header .quiet-button")?.click()`);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await evaluate(`Boolean(document.querySelector(".start-button"))`)) break;
      await sleep(200);
    }
    await sleep(600);
  };

  // The menu, with nothing asked of Orbis: the switch below is a switch made on a run's session.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await evaluate(`Boolean(document.querySelector(".start-button"))`)) break;
    await sleep(500);
  }
  console.log(`menu: ${await evaluate(worldState)}`);

  // Run A: the world the player leaves behind.
  const a = await startRun(WORLD_A);
  await sleep(6000);
  const signA = await inspect(`${WORLD_A} run`, a.at);
  if (SHOT_PATH) {
    const shot = await pageSocket.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(SHOT_PATH.replace(/\.png$/, `.${WORLD_A}.png`), Buffer.from(shot.data, "base64"));
  }
  await exitRun();

  // Run B: the world the player chooses next, on the session run A left warm.
  const b = await startRun(WORLD_B);
  const morphStart = Date.now();
  const samples = [];
  while (Date.now() - morphStart < MORPH_BUDGET_MS) {
    const sign = await sampleFrame();
    samples.push({ at: ((Date.now() - morphStart) / 1000).toFixed(1), ...sign });
    // The opening seconds are sampled finely on purpose: the switch is judged by what the first
    // frames of the run look like, and a coarse sample cannot tell a black fade-in from the old world.
    await sleep(samples.length <= 6 ? 1500 : 5000);
  }
  console.log(`\n[${WORLD_B}] picture after the switch (t+2s..):`);
  for (const sample of samples) {
    console.log(`  t+${sample.at}s r/g/b ${sample.r}/${sample.g}/${sample.b} (green ${sample.greenLead}, warm ${sample.warmLead})`);
  }
  if (SHOT_PATH) {
    const shot = await pageSocket.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(SHOT_PATH.replace(/\.png$/, `.${WORLD_B}.png`), Buffer.from(shot.data, "base64"));
  }
  const promptsB = (await readPrompts()).filter((entry) => entry.at >= b.at);
  console.log(`[${WORLD_B}] prompts after the switch (${promptsB.length}):`);
  for (const entry of promptsB) {
    console.log(`  ${promptLine(entry)} → named world ${worldOfPrompt(entry.prompt) ?? "?"} — ${entry.prompt.slice(0, 90)}...`);
  }

  const worldBAsked = promptsB.some((entry) => worldOfPrompt(entry.prompt) === WORLD_B);
  const pictureB = samples[samples.length - 1] ?? {};
  const distanceFromA = (sample) =>
    Math.abs(sample.r - signA.r) + Math.abs(sample.g - signA.g) + Math.abs(sample.b - signA.b);
  const leftA = distanceFromA(pictureB);
  /** Each world's look, from the frames measured in this run: a dusk desert is strongly warm, an
   *  old forest is cool grey-green. A `?` world is only checked for having left the other one. */
  const LOOKS = {
    desert: (sample) => sample.warmLead >= 40,
    forest: (sample) => sample.greenLead <= -3 && sample.warmLead <= -6,
    city: (sample) => sample.b >= sample.r && sample.b >= sample.g,
  };
  const readsB = (LOOKS[WORLD_B] ?? (() => true))(pictureB);

  console.log("\n=== VERDICT ===");
  console.log(
    `left behind: ${LABEL[WORLD_A]} r/g/b ${signA.r}/${signA.g}/${signA.b}` +
      ` (green ${signA.greenLead}, warm ${signA.warmLead})`,
  );
  console.log(`asked for ${LABEL[WORLD_B]} after the switch: ${worldBAsked ? "yes" : "NO"}`);
  console.log(
    `picture left ${LABEL[WORLD_A]}'s colours by t+${pictureB.at ?? "?"}s: ` +
      `${leftA > 30 ? "yes" : "NO"} (distance ${leftA})`,
  );
  console.log(
    `picture reads as ${LABEL[WORLD_B]}: ${readsB ? "yes" : "NO"}` +
      ` (r/g/b ${pictureB.r}/${pictureB.g}/${pictureB.b}, green ${pictureB.greenLead}, warm ${pictureB.warmLead})`,
  );
  if (WORLD_A === WORLD_B) {
    // The same world again: the claim is the opposite one — nothing was rebuilt and the picture never
    // left it, which is what the warm session is for.
    if (leftA > 30) {
      console.log(`!! a same-world restart changed the picture by ${leftA}`);
      process.exitCode = 1;
    }
  } else if (!worldBAsked || leftA <= 30 || !readsB) {
    console.log("!! the world did not follow the switch");
    process.exitCode = 1;
  }

  // The world layer's own trace: the rebuild's cost and the pause reconciler's answers, read from the
  // page's array rather than from console lines that lag the send.
  console.log("\n=== TRACE ===");
  console.log(
    await evaluate(`(() => {
      const entries = window.__orbisTrace ?? [];
      const counts = {};
      for (const entry of entries) counts[entry.what] = (counts[entry.what] ?? 0) + 1;
      return JSON.stringify({ counts, rebuilds: entries.filter((entry) => entry.what === "rebuild"), tail: entries.slice(-6) });
    })()`),
  );

  console.log("\n=== CONSOLE ===");
  console.log(logs.slice(-40).join("\n") || "(none)");

  // Release the session the way the app does, and wait for the app's own record of it.
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
      console.log(`release: ${JSON.stringify(released)}`);
    }
    if (released.status === "disconnected" && /ok \(attempt/.test(released.last ?? "")) break;
    await sleep(1000);
  }

  await browserSocket.send("Target.closeTarget", { targetId: page.id });
  await sleep(500);
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
