// Does a run leave anything behind, and does the next run have to race it?
//
//   node tools/meta-probe.mjs [app-url]
//   WORLD=city node tools/meta-probe.mjs
//
// The meta layer makes four claims, and the interesting one is that they are *the same data*: a run
// banks its tokens, writes down its line, files its best, and the next run races the line. So this
// probe plays two runs in one world and reads the claims back out of the stores and the live readout:
//
//   - the bank: `watchme-run:bank` grows by exactly the run's tokens, and the card says what it paid;
//   - the line: `watchme-run:records[world].line` is a flat list of `distance, lane, score, time`
//     quads, every 20 m, strictly increasing in distance and in time, ending where the run ended —
//     which is the only shape a ghost can be read from;
//   - the ghost: on the second run, `window.__runfield().ghost` names the lane the stored line held at
//     the metre the run is at, and the HUD's race number equals the readout's own `ahead`;
//   - the deal purchase: with a seeded balance, unlocking costs exactly the price, writes the deal to
//     `watchme-run:deals`, and refuses a deal the balance cannot pay for.
//
// A dev server (`npm run dev`), because the readout is development-only. Run 1 is played *into* the
// traffic on purpose: a run files its record when it ends, so the probe needs it to end.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_URL = process.argv[2] ?? "http://[::1]:5199/";
const PORT = Number(process.env.CDP_PORT ?? 9347);
const WORLD = process.env.WORLD ?? "forest";
/** What the second run is played to, in metres: far enough past a short first run to race the line. */
const CHASE_METRES = Number(process.env.CHASE_METRES ?? 320);
/** The seeded balance for the purchase half. The `close` deal costs 500, `glass` 1200. */
const SEED_BANK = Number(process.env.SEED_BANK ?? 500);

const profile = mkdtempSync(join(tmpdir(), "watchme-meta-"));
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
      /* the port is not up yet */
    }
    await sleep(500);
  }
  throw new Error(`devtools ${path} never answered`);
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
  };
}

/**
 * The feed, read from the DOM as it renders.
 *
 * The subtree walk matters here for the same reason it does in the contract probe: the card re-renders
 * whole on a run restart, so an entry that arrives in that commit comes in as a child of an inserted
 * list rather than as an inserted `<li>`, and a node-only reader never sees it.
 */
const RECORDER = `(() => {
  window.__metaProbe = window.__metaProbe ?? { feed: [] };
  window.__metaProbe.feed = [];
  // Installed once per page, however many runs the probe plays: a second observer would push every
  // answer into the same array again, and the probe would report each of them twice.
  if (window.__metaProbe.installed) return true;
  window.__metaProbe.installed = true;
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        const items = node.tagName === "LI" ? [node] : [...node.querySelectorAll("li")];
        for (const item of items) {
          const line = item.querySelector("b")?.textContent ?? "";
          if (!line) continue;
          window.__metaProbe.feed.push({
            line,
            detail: item.querySelector("span")?.textContent ?? "",
            at: Math.round(performance.now()),
          });
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  return true;
})()`;

const SAMPLE = `(() => {
  const field = window.__runfield?.() ?? null;
  if (!field) return null;
  return {
    distance: field.distance,
    score: field.score,
    tokens: field.tokens,
    lane: field.lane,
    damage: field.damage,
    ghost: field.ghost ?? null,
    ghostMark: field.ghostMark ?? null,
    line: field.line ?? 0,
    over: Boolean(document.querySelector(".run-over")),
    card: document.querySelector(".run-over") ? {
      bank: document.querySelector(".run-over-bank span")?.textContent ?? null,
      best: document.querySelector(".run-over-record")?.textContent ?? null,
    } : null,
    hudGhost: document.querySelector(".hud-ghost b")?.textContent ?? null,
  };
})()`;

const STORE = (key) => `window.localStorage.getItem(${JSON.stringify(key)})`;

const logs = [];
const faults = [];
const notes = [];
const checks = [];
function check(ok, label, detail) {
  checks.push({ ok, label, detail });
  if (!ok) faults.push(`${label}${detail ? `: ${detail}` : ""}`);
  console.log(`  ${ok ? "ok  " : "FAULT"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const profileDir = profile;
/**
 * The temporary profile is the OS's to delete.
 *
 * Chrome holds the directory open for a moment after it is killed, so a `rmSync` here can fail with
 * EPERM — and a probe that has already printed its verdict must not turn into a crash because a temp
 * folder outlived it.
 */
function cleanup() {
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* the OS will take it */
  }
}
try {
  await devtools("/json/version");
  const targets = await devtools("/json/list");
  const blank = targets.find((target) => target.type === "page");
  const browserSocket = cdpSocket(blank.webSocketDebuggerUrl);
  await browserSocket.ready;
  const { targetId } = await browserSocket.send("Target.createTarget", { url: APP_URL });
  await sleep(1800);

  const pages = await devtools("/json/list");
  const page = pages.find((target) => target.id === targetId) ?? pages.find((target) => target.type === "page");
  const pageSocket = cdpSocket(page.webSocketDebuggerUrl);
  await pageSocket.ready;
  await pageSocket.send("Runtime.enable");
  pageSocket.on((message) => {
    if (message.method === "Runtime.consoleAPICalled") {
      const text = (message.params.args ?? [])
        .map((arg) => (arg.value === undefined ? arg.description ?? arg.type : String(arg.value)))
        .join(" ");
      if (/error|exception|three\b|webgl/i.test(text)) logs.push(`[${stamp()}] ${text.slice(0, 200)}`);
    }
    if (message.method === "Runtime.exceptionThrown") {
      logs.push(`[${stamp()}] exception ${message.params.exceptionDetails?.text ?? ""}`.slice(0, 300));
    }
  });

  const evaluate = async (expression) => {
    try {
      const result = await pageSocket.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    } catch (cause) {
      // The expression travels with the failure: "a CDP call failed" is not a bug report, and an
      // expression that returns a live object is a mistake this probe has already made once.
      throw new Error(`${cause?.message ?? cause} — evaluating: ${String(expression).slice(0, 120)}`);
    }
  };
  /**
   * A side effect, with a primitive for an answer.
   *
   * Every click and every write goes through here rather than through `evaluate` directly: a call whose
   * completion value is a live DOM object makes CDP try to serialise a page it cannot copy, and the
   * probe dies with "Object reference chain is too long" instead of doing anything useful.
   */
  const run = async (statement) => evaluate(`(() => { ${statement}; return true; })()`);
  const json = async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`));

  const keyCodes = { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40 };
  const press = async (key) => {
    const code = keyCodes[key];
    await pageSocket.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, code: key, key });
    await pageSocket.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, code: key, key });
  };
  const clickAt = async (selector) => {
    // Centred first: the menu is taller than the window, and the deals row sits below the fold, so a
    // click computed from the element's own rect would land outside the viewport and miss entirely.
    await run(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`);
    await sleep(150);
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
  const waitFor = async (expression, attempts = 100, every = 400) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await evaluate(expression)) return true;
      await sleep(every);
    }
    return false;
  };

  // A clean slate: the four stores this probe exists to watch, and nothing else — the world choice and
  // the sound settings are not part of the claims.
  await waitFor(`Boolean(document.querySelector(".world-card") && document.querySelector(".start-button"))`, 150);
  await evaluate(`(() => {
    for (const key of ["watchme-run:records", "watchme-run:bank", "watchme-run:deals", "watchme-run:contract"]) {
      window.localStorage.removeItem(key);
    }
    return true;
  })()`);
  await run(`window.location.reload()`);
  await waitFor(`Boolean(document.querySelector(".world-card") && document.querySelector(".start-button"))`, 150);

  /* ---- what the menu says before anything has been run ----------------------------------------- */
  console.log(`${stamp()} ${WORLD}: the menu, with no history`);
  const menu = await json(`(() => ({
    deals: [...document.querySelectorAll(".menu-deal")].map((el) => ({
      id: el.dataset.deal,
      locked: el.dataset.locked === "true",
      terms: el.querySelector(".menu-deal-pick small")?.textContent ?? "",
      unlock: el.querySelector(".menu-deal-unlock") ? {
        text: el.querySelector(".menu-deal-unlock").textContent.trim(),
        disabled: el.querySelector(".menu-deal-unlock").disabled,
      } : null,
    })),
    label: document.querySelector(".menu-deals-label")?.textContent?.replace(/\\s+/g, " ") ?? null,
  }))()`);
  console.log(`  ${JSON.stringify(menu)}`);
  check(menu.deals.length === 4, "the menu offers four deals", `${menu.deals.length} found`);
  check(menu.deals.find((deal) => deal.id === "standard")?.locked === false, "standard is open from the start");
  const lockedBefore = menu.deals.filter((deal) => deal.locked).map((deal) => deal.id);
  check(lockedBefore.length === 3, "the other three are locked", lockedBefore.join(", "));
  check(menu.deals.every((deal) => !deal.locked || deal.unlock), "every locked deal carries a price");
  check(
    menu.deals.filter((deal) => deal.locked).every((deal) => deal.unlock.disabled),
    "nothing is affordable at a bank of zero",
    menu.deals.filter((deal) => deal.locked).map((deal) => `${deal.id}:${deal.unlock.disabled}`).join(", "),
  );
  check(/0\s+tokens banked/.test(menu.label ?? ""), "the bank reads zero", menu.label ?? "no label");

  /* ---- run 1: played into the traffic, because a record is filed when a run ends ---------------- */
  const pickWorldAndStart = async () => {
    const picked = await evaluate(`(() => {
      const el = document.querySelector(".world-card.world-${WORLD}");
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!picked) throw new Error(`${WORLD}: no world card in the menu`);
    await sleep(700);
    await run(`document.querySelector(".start-button")?.click()`);
    return waitFor(`document.documentElement.dataset.surface === "run" && Boolean(window.__runfield)`, 200);
  };

  console.log(`${stamp()} ${WORLD}: run 1 — no best yet, played straight into the traffic`);
  if (!(await pickWorldAndStart())) throw new Error("the first run never came up");
  await evaluate(RECORDER);
  const ghostOnFirst = await json(`(() => ({ hud: Boolean(document.querySelector(".hud-ghost")), ghost: (window.__runfield?.() ?? {}).ghost ?? null }))()`);
  check(ghostOnFirst.hud === false && ghostOnFirst.ghost === null, "the first run has no ghost to race");

  let first = null;
  const firstDeadline = Date.now() + 300_000;
  while (Date.now() < firstDeadline) {
    const sample = await json(SAMPLE);
    if (!sample) {
      await sleep(250);
      continue;
    }
    first = sample;
    if (sample.over) break;
    // No steering at all: the run takes its own hits, which is the point — under the standard deal it
    // needs three, and the card only comes up when it has them.
    await sleep(160);
  }
  if (!first?.over) throw new Error("the first run never ended");
  const firstLine = await json(`(() => {
    const state = window.__runfield();
    return { distance: state.distance, tokens: state.tokens, score: state.score, line: state.line };
  })()`);
  console.log(
    `${stamp()} run 1 filed: ${firstLine.distance} m, ${firstLine.tokens} tokens, ${firstLine.score} points, ` +
      `${firstLine.line} line samples`,
  );
  console.log(`  card: ${JSON.stringify(first.card)}`);

  const banked = Number(await evaluate(STORE("watchme-run:bank")));
  check(banked === firstLine.tokens, "the run banked exactly its tokens", `bank ${banked} · run ${firstLine.tokens}`);
  check(
    /BANK \+\d+/.test(first.card?.bank ?? "") && Number((first.card?.bank ?? "").replace(/[^0-9]/g, "")) === firstLine.tokens,
    "the card says what the run paid in",
    first.card?.bank ?? "no bank line",
  );

  const stored = await json(`(() => JSON.parse(${STORE("watchme-run:records")} ?? "{}")[${JSON.stringify(WORLD)}] ?? null)()`);
  const line = stored?.line ?? [];
  check(Boolean(stored), "the run filed a record for its world");
  check(line.length >= 8 && line.length % 4 === 0, "the line is a whole number of quads", `${line.length} numbers`);
  let shape = true;
  let laneOk = true;
  let timeOk = true;
  let worstDistance = 0;
  for (let at = 4; at < line.length; at += 4) {
    if (!(line[at] > line[at - 4])) shape = false;
    if (![0, 1, 2].includes(line[at + 1])) laneOk = false;
    if (!(line[at + 3] > line[at - 1])) timeOk = false;
  }
  const samples = line.length / 4;
  check(shape, "every sample is further along than the one before it");
  check(laneOk, "every sample names a real lane");
  check(timeOk, "every sample is later than the one before it");
  // Every 20 m, and the last one at the end: a line that stopped short of the record would put the
  // ghost behind the number it is named after.
  // Every gap but the last: the final sample is forced at the moment the run died, so it is the one
  // sample allowed to be closer than `LINE_METRES` — that is where the run stopped.
  const spacing = line
    .filter((_, index) => index % 4 === 0)
    .map((value, index, all) => (index ? value - all[index - 1] : 0))
    .slice(2, -1);
  const expected = Math.floor(firstLine.distance / 20);
  worstDistance = Math.abs((stored?.distance ?? 0) - (line[line.length - 4] ?? 0));
  check(
    Math.abs(samples - expected) <= 2,
    "the line is sampled every 20 m",
    `${samples} samples for ${firstLine.distance} m (expected ~${expected})`,
  );
  check(worstDistance <= 2, "the line ends where the run ended", `${worstDistance} m short`);
  check(spacing.every((gap) => Math.abs(gap - 20) <= 1), "the samples are evenly spaced", spacing.slice(0, 6).join(", "));

  /* ---- the purchase: with a balance, unlocking costs exactly the price -------------------------- */
  console.log(`${stamp()} the bank and the deals, with a seeded balance of ${SEED_BANK}`);
  await run(`window.localStorage.setItem("watchme-run:bank", ${JSON.stringify(String(SEED_BANK))})`);
  await run(`document.querySelector(".quiet-button")?.click()`);
  if (!(await waitFor(`Boolean(document.querySelector(".start-button") && document.querySelector(".menu-deal"))`, 150))) {
    throw new Error("never made it back to the menu");
  }
  const menu2 = await json(`(() => ({
    label: document.querySelector(".menu-deals-label")?.textContent?.replace(/\\s+/g, " ") ?? null,
    deals: [...document.querySelectorAll(".menu-deal")].map((el) => ({
      id: el.dataset.deal,
      locked: el.dataset.locked === "true",
      unlock: el.querySelector(".menu-deal-unlock") ? el.querySelector(".menu-deal-unlock").disabled : null,
    })),
  }))()`);
  console.log(`  ${JSON.stringify(menu2)}`);
  check(/500\s+tokens banked/.test(menu2.label ?? ""), "the menu reads the balance", menu2.label ?? "no label");
  const glass = menu2.deals.find((deal) => deal.id === "glass");
  const close = menu2.deals.find((deal) => deal.id === "close");
  check(glass?.locked === true && glass.unlock === true, "a deal past the balance stays shut", `glass unlock disabled: ${glass?.unlock}`);
  check(close?.locked === true && close.unlock === false, "a deal the balance covers can be paid for", `close unlock disabled: ${close?.unlock}`);

  await clickAt('.menu-deal[data-deal="close"] .menu-deal-unlock');
  await sleep(600);
  const bought = await json(`(() => ({
    bank: window.localStorage.getItem("watchme-run:bank"),
    deals: JSON.parse(window.localStorage.getItem("watchme-run:deals") ?? "[]"),
    locked: document.querySelector('.menu-deal[data-deal="close"]')?.dataset.locked,
    selected: document.querySelector('.menu-deal[data-deal="close"] .menu-deal-pick')?.dataset.selected,
    note: document.querySelector(".menu-note")?.textContent ?? null,
  }))()`);
  console.log(`  ${JSON.stringify(bought)}`);
  check(bought.bank === String(SEED_BANK - 500), "the price was taken from the bank", `bank ${bought.bank}`);
  check((bought.deals ?? []).includes("close"), "the deal was remembered", JSON.stringify(bought.deals));
  check(bought.locked === "false", "the chip is open now", `data-locked ${bought.locked}`);
  check(bought.selected === "true", "buying a deal takes it", `data-selected ${bought.selected}`);

  /* ---- run 2: the ghost, and the race ---------------------------------------------------------- */
  console.log(`${stamp()} ${WORLD}: run 2 — racing the line run 1 left`);
  if (!(await pickWorldAndStart())) throw new Error("the second run never came up");
  await evaluate(RECORDER);
  const storedLine = line;
  /** The lane the stored line held at a distance, read here rather than assumed: the ghost is a claim. */
  const laneAt = (distance) => {
    let lane = null;
    for (let at = 0; at < storedLine.length; at += 4) {
      if (storedLine[at] > distance) break;
      lane = storedLine[at + 1];
    }
    return lane;
  };

  const ghostSamples = [];
  const lineSamples = [];
  let second = null;
  let lastLaneChange = 0;
  let myLane = 1;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const sample = await json(SAMPLE);
    if (!sample) {
      await sleep(250);
      continue;
    }
    second = sample;
    ghostSamples.push({ distance: sample.distance, ghost: sample.ghost, mark: sample.ghostMark, hud: sample.hudGhost });
    lineSamples.push(sample.line);
    if (sample.over || sample.distance >= CHASE_METRES) break;

    // A dodging autopilot: the ghost race needs a run that survives, or there is nothing to compare.
    const field = await json(`(() => {
      const state = window.__runfield?.() ?? null;
      return state ? { obstacles: state.obstacles, lane: state.lane } : null;
    })()`);
    if (field) {
      myLane = field.lane;
      const ahead = (field.obstacles ?? []).filter((obstacle) => obstacle.z < 3 && obstacle.z > 3 - 24);
      const inLane = ahead.filter((obstacle) => obstacle.lane === myLane).sort((a, b) => b.z - a.z)[0];
      const clear = [0, 1, 2]
        .filter((other) => other !== myLane && !ahead.some((obstacle) => obstacle.lane === other))
        .sort((a, b) => Math.abs(a - myLane) - Math.abs(b - myLane));
      if (inLane && inLane.z > 3 - 20 && clear.length && Date.now() - lastLaneChange > 260) {
        await press(clear[0] > myLane ? "ArrowRight" : "ArrowLeft");
        myLane = clear[0];
        lastLaneChange = Date.now();
      } else if (inLane && inLane.z > 3 - 13) {
        await press(inLane.kind === "gate" ? "ArrowDown" : "ArrowUp");
      }
    }
    await sleep(150);
  }
  if (!second) throw new Error("the second run never produced a sample");

  const withGhost = ghostSamples.filter((entry) => entry.ghost);
  console.log(
    `${stamp()} run 2: ${second.distance} m, ${withGhost.length} ghost samples, ` +
      `line ${lineSamples[0]} → ${lineSamples[lineSamples.length - 1]} samples`,
  );
  check(withGhost.length > 0, "the second run is shown the best line", `${withGhost.length} samples`);
  check(
    lineSamples[lineSamples.length - 1] > lineSamples[0],
    "the run writes its own line as it goes",
    `${lineSamples[0]} → ${lineSamples[lineSamples.length - 1]}`,
  );

  // The lane: the ghost mark stands where the best line was, at the metre this run is at. Sampled a
  // sample behind the distance to allow for the readout being a frame behind the frame it reports.
  const laneChecks = withGhost
    .map((entry) => {
      const expected = laneAt(entry.distance - 5);
      return expected === null ? null : { expected, found: entry.ghost.lane, distance: entry.distance };
    })
    .filter(Boolean);
  const laneWrong = laneChecks.filter((entry) => entry.expected !== entry.found);
  console.log(
    `  ghost lane: ${laneChecks.length} checks, ${laneWrong.length} off` +
      (laneWrong.length ? ` — e.g. at ${laneWrong[0].distance} m expected lane ${laneWrong[0].expected}, read ${laneWrong[0].found}` : ""),
  );
  check(laneWrong.length === 0, "the ghost stands in the lane the best line held");

  // The mesh, not the number: a marker that is never added to the scene, or one standing in the wrong
  // lane, would leave every readout above perfectly correct and the road telling the player a line that
  // is not theirs.
  const markChecks = withGhost.filter((entry) => entry.mark);
  const markWrong = markChecks.filter((entry) => !entry.mark.on || entry.mark.lane !== entry.ghost.lane);
  console.log(
    `  the mark on the road: ${markChecks.length} reads, ${markWrong.length} wrong` +
      (markWrong.length
        ? ` — e.g. at ${markWrong[0].distance} m the line says lane ${markWrong[0].ghost.lane}, the mark stands in ${markWrong[0].mark.lane}`
        : `, last standing in lane ${markChecks[markChecks.length - 1]?.mark.lane}`),
  );
  check(markChecks.length > 0, "the ghost is drawn on the road");
  check(markWrong.length === 0, "the mark stands in the lane the ghost is in");

  const hudChecks = withGhost.filter((entry) => entry.hud);
  // The HUD is refreshed five times a second and the readout is the frame's own number, so the two are
  // allowed a metre or two of daylight: at 14 m/s a run gains a metre between HUD renders, and a check
  // that demanded the same number at the same instant would be testing the throttling, not the ghost.
  const hudWrong = hudChecks.filter(
    (entry) => Math.abs(Number(String(entry.hud).replace(/[^0-9]/g, "")) - Math.abs(entry.ghost.ahead)) > 3,
  );
  console.log(
    `  the race: ${hudChecks.length} HUD reads, ${hudWrong.length} off` +
      (hudWrong.length ? ` — e.g. HUD ${hudWrong[0].hud} against ${round(hudWrong[0].ghost.ahead)} m` : `, last ${hudChecks[hudChecks.length - 1]?.hud ?? "none"}`),
  );
  check(hudChecks.length > 0, "the HUD carries the race");
  check(hudWrong.length === 0, "the HUD's number is the readout's own gap", "within three metres of it");
  const aheadAt = withGhost.filter((entry) => entry.ghost.ahead >= 0).length;
  console.log(`  ahead in ${aheadAt} of ${withGhost.length} samples of the line run 1 left`);

  const feed = await json(`window.__metaProbe?.feed ?? []`);
  const beat = feed.filter((entry) => /BEST LINE BEATEN/.test(entry.line));
  console.log(`  answers: ${feed.map((entry) => entry.line).join(" | ") || "(none)"}`);
  if (beat.length) {
    check(true, "the world answered the best line being beaten", `${beat[0].line} — ${beat[0].detail}`);
  } else {
    notes.push("the second run never got ahead of the first, so the world's answer to it went untested");
  }

  console.log(`\nconsole:`);
  console.log(logs.join("\n") || "  (nothing matching)");
  console.log(`\nnotes: ${notes.join("; ") || "(none)"}`);
  console.log(`verdict: ${faults.length ? faults.join("; ") : "no faults"}`);
  if (faults.length) process.exitCode = 1;

  await run(`window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }))`);
  await sleep(300);
  await browserSocket.send("Target.closeTarget", { targetId });
  browserSocket.close?.();
  pageSocket.close?.();
  chrome.kill();
  cleanup();
} catch (cause) {
  console.error(`${stamp()} the probe could not finish: ${cause?.message ?? cause}`);
  console.error(`console:\n${logs.join("\n")}`);
  chrome.kill();
  cleanup();
  process.exitCode = 1;
}
