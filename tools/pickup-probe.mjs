// Does the run actually hand out pickups, and do the three verbs do what they say?
//
//   node tools/pickup-probe.mjs [app-url]
//   WORLD=forest node tools/pickup-probe.mjs
//
// Plays a real run with an autopilot that dodges what is in the way and steers towards whichever
// pickup is next (keys go in as real CDP key events, because a synthetic one is not a user gesture and
// this app listens on `keydown`). Evidence is collected from three places and *accumulated across
// restarts*, because one run cannot be relied on to live long enough to meet three pickups:
//   - the simulation's own field readout (`window.__runfield()`), sampled every 120 ms: which pickups
//     it reports (with the distance met), whether a magnet has bent a coin off its lane, and the state
//     of the shield / magnet / doubled clocks behind them;
//   - the HUD's DOM: the `.hud-pickup` chips and their countdown text;
//   - the director feed and the `+N` token readout, watched with MutationObservers, since both are
//     events rather than states.
// When a shield is up the autopilot stops dodging and walks into the next obstacle on purpose: the
// shield is the one pickup whose whole job happens on somebody else's play.
//
// A dev server (`npm run dev`), because the readout behind it is development-only. Exits non-zero if a
// pickup never arrived, the cadence drifted past 130–205 m (median), a kind never appeared, a pickup
// went unanswered in the feed, a shield was spent without a `SHIELD SPENT` line *and* a spent callout
// on screen, the frame flashed the damage red for the hit a shield absorbed, the magnet never bent a
// coin, a token was paid off the curve, or the HUD never showed a chip. The numbers it prints are the
// ones quoted in the README.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_URL = process.argv[2] ?? "http://[::1]:5199/";
const PORT = Number(process.env.CDP_PORT ?? 9342);
const WORLD = process.env.WORLD ?? "desert";
const DEADLINE_MS = Number(process.env.DEADLINE_MS ?? 420_000);
const LANES = [-2.4, 0, 2.4];

const profile = mkdtempSync(join(tmpdir(), "watchme-powerup-"));
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

const logs = [];
const faults = [];
const notes = [];

/**
 * Installed once. The arrays are *not* reset on a restart: one run is not long enough to meet three
 * pickups, and evidence that disappears when the run does is evidence nobody can check.
 */
const RECORDER = `(() => {
  if (window.__probe) return true;
  window.__probe = { tokens: [], feed: [] };
  const tokenObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || !node.classList?.contains("token-gain")) continue;
        const field = window.__runfield?.() ?? {};
        window.__probe.tokens.push({
          run: window.__probeRun ?? 0,
          value: Number(String(node.textContent).replace(/[^0-9.]/g, "")),
          distance: field.distance ?? null,
          magnet: field.magnet ?? 0,
          double: field.doubleTokens ?? 0,
          tokenValue: field.tokenValue ?? null,
        });
      }
    }
  });
  tokenObserver.observe(document.body, { childList: true, subtree: true });
  const feedObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || node.tagName !== "LI") continue;
        const field = window.__runfield?.() ?? {};
        window.__probe.feed.push({
          run: window.__probeRun ?? 0,
          line: node.querySelector("b")?.textContent ?? "",
          detail: node.querySelector("span")?.textContent ?? "",
          distance: field.distance ?? null,
          damage: field.damage ?? null,
        });
      }
    }
  });
  feedObserver.observe(document.body, { childList: true, subtree: true });
  return true;
})()`;

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

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await evaluate(`Boolean(document.querySelector(".world-card") && document.querySelector(".start-button"))`)) break;
    await sleep(500);
  }

  const card = await evaluate(`(() => {
    const el = document.querySelector(".world-card.world-${WORLD}");
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!card) faults.push(`${WORLD}: no world card`);
  await sleep(600);
  await evaluate(`document.querySelector(".start-button").click()`);

  let up = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await evaluate(`document.documentElement.dataset.surface === "run" && Boolean(window.__runfield)`)) {
      up = true;
      break;
    }
    await sleep(500);
  }
  if (!up) throw new Error("the run never came up");
  console.log(`${stamp()} ${WORLD} run up`);
  await evaluate(RECORDER);

  const spawns = [];
  const seenIds = new Set();
  let run = 0;
  await evaluate(`window.__probeRun = 0`);
  const chips = new Map();
  const chipTracks = new Map();
  const pulls = [];
  let myLane = 1;
  let shieldUpDamage = null;
  let shieldSpentAt = null;
  /** The spent callout as the DOM showed it: read at the moment the shield disappears. */
  let spentCallout = null;
  const spentSamples = [];
  let lastProgress = 0;
  let restarts = 0;
  const deadline = Date.now() + DEADLINE_MS;

  /**
   * A new run has genuinely begun. The ids restart from 1 in a remount, so the id set is cleared
   * only once the simulation is observed to have started over — clearing it on the click instead is
   * what made the first version of this probe report four pickups in five metres: it was reading two
   * runs into one list.
   */
  const beginRun = () => {
    run += 1;
    seenIds.clear();
    myLane = 1;
    shieldUpDamage = null;
  };

  while (Date.now() < deadline) {
    const field = await json(`window.__runfield?.() ?? null`);
    if (!field) {
      await sleep(250);
      continue;
    }

    for (const pickup of field.powerups) {
      if (seenIds.has(pickup.id)) continue;
      seenIds.add(pickup.id);
      spawns.push({ run, id: pickup.id, kind: pickup.kind, lane: pickup.lane, distance: field.distance });
    }

    const hud = await json(`(() => {
      const out = { chips: {} };
      for (const el of document.querySelectorAll(".hud-pickup")) out.chips[el.dataset.kind] = el.textContent.trim().replace(/\\s+/g, " ");
      out.card = Boolean(document.querySelector(".run-over-card"));
      return out;
    })()`);
    for (const [kind, text] of Object.entries(hud.chips)) {
      chips.set(kind, (chips.get(kind) ?? 0) + 1);
      const track = chipTracks.get(kind) ?? [];
      if (track[track.length - 1] !== text) track.push(text);
      chipTracks.set(kind, track);
    }

    if (field.shield && shieldUpDamage === null) shieldUpDamage = field.damage;
    if (!field.shield && shieldUpDamage !== null && shieldSpentAt === null) {
      shieldSpentAt = { damage: field.damage, was: shieldUpDamage, distance: field.distance };
      // A spent shield is the one event the HUD can only show by a chip *vanishing*, which is also
      // what a timer running out looks like — so it has to be said out loud, and that callout is what
      // this reads. The frame's other half is the flash: a hit the shield absorbed must pulse the
      // shield's own cyan (`--absorb`) and never the damage red (`--hit`). The callout lives for
      // 1.6 s and the frame value decays from 1 in about 0.7 s, so a short poll catches both.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const sample = await json(`(() => {
          const root = getComputedStyle(document.documentElement);
          const el = document.querySelector(".run-callout");
          if (!el) return null;
          const style = getComputedStyle(el);
          return {
            line: el.querySelector("b")?.textContent ?? null,
            detail: el.querySelector("small")?.textContent ?? null,
            kind: el.dataset.kind ?? null,
            opacity: Number(style.opacity),
            absorb: Number(root.getPropertyValue("--absorb")) || 0,
            hit: Number(root.getPropertyValue("--hit")) || 0,
          };
        })()`);
        if (sample) {
          spentSamples.push(sample);
          if (!spentCallout) spentCallout = sample;
        }
        // Read until both halves have been seen at strength: the callout animates in from opacity 0
        // over its first ~130 ms, so the sample that catches its first frame is not the one to judge
        // it by, and the frame's pulse is read from the root at the same moment.
        const visible = spentSamples.some((item) => item.opacity > 0.5);
        const pulsed = spentSamples.some((item) => item.absorb > 0);
        if (visible && pulsed) break;
        await sleep(100);
      }
    }

    for (const coin of field.coins ?? []) {
      if (field.magnet > 0 && coin.lane !== myLane && Math.abs(coin.x) > 0.4) {
        pulls.push({ lane: coin.lane, x: coin.x, z: coin.z, magnet: field.magnet, myLane, distance: field.distance });
      }
    }

    if (hud.card) {
      restarts += 1;
      notes.push(`run ${run} over at ${field.distance} m (damage ${field.damage})`);
      if (restarts > 8) break;
      const endedAt = field.distance;
      await clickAt(".run-again");
      let restarted = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await sleep(300);
        const after = await json(`window.__runfield?.() ?? null`);
        if (after && after.distance < endedAt / 2) {
          restarted = true;
          break;
        }
      }
      if (!restarted) {
        faults.push("the run ended and RUN AGAIN did not start another one");
        break;
      }
      await evaluate(`window.__probeRun = ${run + 1}`);
      beginRun();
      notes.push(`run ${run} started`);
      continue;
    }

    // The autopilot. A shield makes it walk into things on purpose; otherwise it dodges what is in its
    // lane and steers towards the next pickup.
    const obstacles = (field.obstacles ?? []).filter((obstacle) => obstacle.z < 3 && obstacle.z > 3 - 30);
    const inLane = obstacles.filter((obstacle) => obstacle.lane === myLane).sort((a, b) => b.z - a.z)[0];
    const target = (field.powerups ?? []).filter((pickup) => !pickup.collected).sort((a, b) => b.z - a.z)[0];
    let action = null;
    let wanted = myLane;

    if (inLane && shieldUpDamage !== null) {
      // Shielded: hold the lane and let it arrive.
      action = "hold";
    } else if (inLane && inLane.z > 3 - 12) {
      // Too close to step aside: the verb that clears it.
      action = inLane.kind === "gate" ? "slide" : "jump";
    } else if (inLane) {
      const clear = [0, 1, 2].filter((lane) => lane !== myLane && !obstacles.some((o) => o.lane === lane && o.z > 3 - 22));
      wanted = clear.length ? clear.sort((a, b) => Math.abs(a - myLane) - Math.abs(b - myLane))[0] : myLane;
      action = "move";
    } else if (target && target.z > 3 - 60) {
      wanted = target.lane;
      action = "move";
    }

    if (action === "jump") await press("ArrowUp");
    else if (action === "slide") await press("ArrowDown");
    else if (action === "move" && wanted !== myLane) {
      await press(wanted > myLane ? "ArrowRight" : "ArrowLeft");
      myLane += wanted > myLane ? 1 : -1;
      await sleep(80);
    }

    if (Date.now() - lastProgress > 20_000) {
      lastProgress = Date.now();
      console.log(
        `${stamp()} d=${field.distance}m dmg=${field.damage} shield=${field.shield} magnet=${field.magnet} x2=${field.doubleTokens} chips=${JSON.stringify(hud.chips)}`,
      );
    }
    await sleep(120);
  }

  const recorded = await json(`window.__probe ?? { tokens: [], feed: [] }`);

  const ordered = [...spawns].sort((a, b) => a.run - b.run || a.distance - b.distance);
  const kinds = [...new Set(ordered.map((spawn) => spawn.kind))];

  console.log(`\npickups met (${ordered.length}):`);
  for (const spawn of ordered) console.log(`  run ${spawn.run}  ${spawn.distance} m  ${spawn.kind} in lane ${spawn.lane} (id ${spawn.id})`);

  // Gaps are measured inside a run: the ids restart with the simulation, and a list that spans two
  // runs sorts two different pickups next to each other.
  const gaps = [];
  for (const spawn of ordered) {
    const previous = [...ordered].reverse().find((item) => item.run === spawn.run && item.distance < spawn.distance);
    if (previous) gaps.push({ run: spawn.run, gap: spawn.distance - previous.distance });
  }
  console.log(`gaps inside a run: ${gaps.map((item) => item.gap).join(", ") || "(none)"}`);
  console.log(`kinds: ${kinds.join(", ") || "(none)"}`);

  console.log(`\nfeed (${recorded.feed.length} entries) — the pickup ones:`);
  for (const entry of recorded.feed.filter((item) => /SHIELD|MAGNET|DOUBLE|PICKUP/.test(item.line))) {
    console.log(`  ${entry.distance} m  ${entry.line} — ${entry.detail} (damage ${entry.damage})`);
  }
  console.log(`  (all lines seen: ${[...new Set(recorded.feed.map((item) => item.line))].join(" | ")})`);

  const doubled = recorded.tokens.filter((token) => token.double > 0);
  const plain = recorded.tokens.filter((token) => token.double === 0);
  /** What the token *should* have paid: the curve's own value at that distance, doubled if doubled. */
  const expectedFor = (token) => (token.tokenValue === null ? null : round(token.tokenValue * (token.double > 0 ? 2 : 1)));
  const offFor = (token) => (expectedFor(token) === null ? null : round(token.value - expectedFor(token)));
  const doubledOff = doubled.map(offFor).filter((value) => value !== null);
  const plainOff = plain.map(offFor).filter((value) => value !== null);
  console.log(`\ntokens: ${recorded.tokens.length} (${doubled.length} doubled, ${plain.length} plain)`);
  console.log(`  doubled: ${doubled.slice(0, 8).map((token) => `+${token.value}@${token.distance}m (worth ${expectedFor(token)})`).join(" ") || "(none)"}`);
  console.log(`  plain:   ${plain.slice(0, 8).map((token) => `+${token.value}@${token.distance}m (worth ${expectedFor(token)})`).join(" ") || "(none)"}`);
  console.log(
    `  worst difference from the curve: doubled ${doubledOff.length ? Math.max(...doubledOff.map(Math.abs)) : "(unmeasured)"}, plain ${plainOff.length ? Math.max(...plainOff.map(Math.abs)) : "(unmeasured)"}`,
  );
  console.log(`  doubled off-curve by more than 1.5: ${doubledOff.filter((value) => Math.abs(value) > 1.5).length}`);
  console.log(`  plain off-curve by more than 1.5: ${plainOff.filter((value) => Math.abs(value) > 1.5).length}`);

  console.log(`\nmagnet pulls (${pulls.length}):`);
  for (const pull of pulls.slice(0, 10)) {
    console.log(`  coin lane ${pull.lane} offset ${pull.x} at ${pull.z} m; run in lane ${pull.myLane}, magnet ${pull.magnet}s left`);
  }

  console.log(`\nHUD chips: ${[...chips].map(([kind, count]) => `${kind} ×${count}`).join(", ") || "(none)"}`);
  for (const [kind, track] of chipTracks) console.log(`  ${kind}: ${track.join(" → ")}`);

  console.log(`\nshield: ${shieldSpentAt ? `up at damage ${shieldSpentAt.was}, gone at ${shieldSpentAt.distance} m with damage ${shieldSpentAt.damage}` : "never seen"}`);
  console.log(
    `spent callout: ${
      spentCallout
        ? `${spentCallout.line} — ${spentCallout.detail} [${spentCallout.kind}] · ${spentSamples.length} sample${spentSamples.length === 1 ? "" : "s"}, opacity up to ${Math.max(...spentSamples.map((sample) => sample.opacity)).toFixed(2)}, frame absorb up to ${Math.max(...spentSamples.map((sample) => sample.absorb)).toFixed(2)}, hit up to ${Math.max(...spentSamples.map((sample) => sample.hit)).toFixed(2)}`
        : "never seen"
    }`,
  );
  console.log(`\nnotes:`);
  for (const note of notes) console.log(`  ${note}`);

  /* ---- verdict ---- */
  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const inRunGaps = gaps.map((item) => item.gap).filter((value) => value > 30);
  const gap = median(inRunGaps);
  if (ordered.length < 4) faults.push(`only ${ordered.length} pickups were met`);
  if (gap !== null && (gap < 130 || gap > 205)) faults.push(`pickup cadence looks like ${gap} m, not ~165`);
  if (kinds.length < 3) faults.push(`only these pickup kinds appeared: ${kinds.join(", ") || "none"}`);
  const pickupLines = recorded.feed.filter((item) => /SHIELD|MAGNET|DOUBLE/.test(item.line));
  if (!pickupLines.some((item) => /UP|PULL|×2/.test(item.line))) faults.push("no pickup was answered in the feed");
  if (!shieldSpentAt) faults.push("a shield was never spent");
  else {
    if (shieldSpentAt.damage !== shieldSpentAt.was) faults.push("the shield was gone but the damage had moved: it did not absorb the hit");
    if (!recorded.feed.some((item) => /SPENT/.test(item.line))) faults.push("the shield was spent without a SPENT line in the feed");
    // The callout, not the feed: the feed is a corner card the run screen hides on purpose, so a
    // spend that is only answered there is a spend the player never saw.
    if (!spentCallout) faults.push("the shield was spent without a spent callout on screen");
    else {
      if (spentCallout.line !== "SHIELD SPENT") faults.push(`the spent callout read ${JSON.stringify(spentCallout.line)}`);
      if (spentCallout.kind !== "shield") faults.push(`the spent callout was drawn for ${JSON.stringify(spentCallout.kind)}`);
      if (!(Math.max(...spentSamples.map((sample) => sample.opacity)) > 0.1)) {
        faults.push(`the spent callout was mounted but never visible (opacity ${Math.max(...spentSamples.map((sample) => sample.opacity))})`);
      }
    }
    if (!spentSamples.some((sample) => sample.absorb > 0)) {
      faults.push("the frame never pulsed in the shield's colour for a spent shield");
    }
    // A *residual* red is not this spend's doing: a real hit taken before the shield was collected can
    // still be decaying when the shield is spent. What must not happen is the frame flashing the
    // damage red *for this impact*, so the check is a strong flash rather than any value at all.
    const red = spentSamples.find((sample) => sample.hit > 0.5);
    if (red) faults.push(`the frame flashed the damage red for a hit the shield absorbed (--hit ${red.hit})`);
  }
  if (pulls.length < 2) faults.push(`the magnet barely bent a coin (${pulls.length} samples)`);
  const offDouble = doubled.map(offFor).filter((value) => value !== null && Math.abs(value) > 1.5);
  const offPlain = plain.map(offFor).filter((value) => value !== null && Math.abs(value) > 1.5);
  if (doubled.length < 3) faults.push(`only ${doubled.length} tokens were paid while DOUBLE was up`);
  else if (offDouble.length) faults.push(`${offDouble.length} doubled tokens did not pay twice the curve's value`);
  if (plain.length < 3) faults.push(`only ${plain.length} plain tokens were paid`);
  else if (offPlain.length) faults.push(`${offPlain.length} plain tokens did not pay the curve's value`);
  if (chips.size === 0) faults.push("the HUD never showed a pickup");

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
