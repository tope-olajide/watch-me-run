// Are the run's terms real, or are they a label?
//
//   node tools/contract-probe.mjs [app-url]
//   WORLD=forest node tools/contract-probe.mjs
//
// The contract feature claims four things per deal — how many hits the run survives, what a token
// pays, how fast the meter fills, and whether the world brings its own weather — and every one of them
// is a number the run *already* computes. A contract that only changed the chip on the HUD would look
// identical from the outside, so this probe plays each deal and reads the run's own numbers back:
//
//   - the chip and the pips: `.hud-contract[data-contract]` names the deal, and the number of
//     `.hud-pip` elements is the hit count the deal claims (they are drawn from the same field the
//     simulation ends the run on, so a mismatch is the display drifting from the rule);
//   - the hits: Glass cannon is played *straight into the traffic* by the autopilot, so the first
//     collision must end the run — if damage ever reaches 2 under a one-hit deal, the limit was not
//     applied;
//   - the tokens: every `.token-gain` the HUD draws is compared against `window.__runfield()`'s
//     `tokenValue`, which is the world's own curve from the same function the scoring used. The ratio
//     *is* the deal's token scale (×2 while a double-token pickup is up), so a contract that only
//     claimed to pay more fails here;
//   - the weather: Fair weather is played past the first hazard window and must never produce a
//     hazard phase at all, on the badge or in the run state;
//   - the meter: the flow the run gains per near miss is bucketed by deal and compared, because
//     Close quarters claims to fill it half again as fast.
//
// A dev server (`npm run dev`), because the readout is development-only.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_URL = process.argv[2] ?? "http://[::1]:5199/";
const PORT = Number(process.env.CDP_PORT ?? 9346);
/**
 * The forest by default, and deliberately: its hazard is a change of *visibility*, so a run the probe
 * is steering itself is still the run it thinks it is. The desert's storm moves the runner without a
 * key being pressed, which would make the Fair-weather phase ambiguous.
 */
const WORLD = process.env.WORLD ?? "forest";
/** Wall-clock budget per phase. Glass ends on its own; Fair weather is the long one. */
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 120_000);
/** How long a phase must last before a missing acknowledgement is a fault rather than a short run. */
const TERMS_GRACE_MS = 6000;
/** How far a phase is allowed to run before it is called: a hit count or a hazard window, in metres. */
const RUN_METRES = Number(process.env.RUN_METRES ?? 400);

/** `ONLY=glass` plays a single deal, for iterating on one claim without a four-run wait. */
const ONLY = process.env.ONLY;
const DEALS = [
  { id: "standard", name: "Standard", hits: 3, tokenScale: 1, flowScale: 1, hazards: true, metres: 220 },
  { id: "glass", name: "Glass cannon", hits: 1, tokenScale: 1.6, flowScale: 1.2, hazards: true, metres: 400 },
  { id: "fair", name: "Fair weather", hits: 3, tokenScale: 0.9, flowScale: 0.75, hazards: false, metres: RUN_METRES },
  { id: "close", name: "Close quarters", hits: 2, tokenScale: 1.3, flowScale: 1.5, hazards: true, metres: 220 },
];

const DEALS_TO_PLAY = DEALS.filter((deal) => !ONLY || deal.id === ONLY);

const profile = mkdtempSync(join(tmpdir(), "watchme-contract-"));
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

/**
 * Everything the deal is judged by, recorded from the DOM as it happens.
 *
 * The token entries are the important ones and they are stamped *at the observer callback*, not at a
 * poll: `token-gain` is added on the same render that the score was paid on, and the readout beside it
 * is the world's own curve at that same moment, so the ratio of the two is the deal's scale with no
 * sampling error in it. The near-miss feed line is recorded the same way, which is what lets the flow
 * measurement know *when* the meter should have jumped.
 */
const RECORDER = `(() => {
  if (window.__contractProbe) {
    window.__contractProbe = { tokens: [], feed: [], hazards: [] };
    return true;
  }
  window.__contractProbe = { tokens: [], feed: [], hazards: [] };
  const reading = () => window.__runfield?.() ?? null;
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList?.contains("token-gain")) {
          const field = reading();
          window.__contractProbe.tokens.push({
            paid: Number(String(node.textContent).replace(/[^0-9.]/g, "")),
            curve: field?.tokenValue ?? null,
            distance: field?.distance ?? null,
            doubled: (field?.doubleTokens ?? 0) > 0,
            at: performance.now(),
          });
        }
        if (node.classList?.contains("hud-hazard")) {
          const field = reading();
          window.__contractProbe.hazards.push({
            name: node.textContent.trim().replace(/\\s+/g, " "),
            phase: node.dataset.phase ?? null,
            distance: field?.distance ?? null,
            at: performance.now(),
          });
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  // Entries are read from the subtree of whatever was added, not from the added node alone: the feed
  // list is replaced whole when the card re-renders (a run restart, the pause overlay leaving), and an
  // entry that arrives in that same commit comes in as a child of an inserted <ul> — measured: the
  // deal's acknowledgement landed while the card was remounting and a node-only reader never saw it.
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        const items = node.tagName === "LI" ? [node] : [...node.querySelectorAll("li")];
        for (const item of items) {
          const line = item.querySelector("b")?.textContent ?? "";
          if (!line) continue;
          window.__contractProbe.feed.push({
            line,
            detail: item.querySelector("span")?.textContent ?? "",
            at: performance.now(),
          });
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
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

  const keyCodes = { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Space: 32 };
  const press = async (key) => {
    const code = keyCodes[key];
    const params = { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, code: key === "Space" ? "Space" : key, key: key === "Space" ? " " : key };
    await pageSocket.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
    await pageSocket.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  };
  /** A real mouse event: `element.click()` is not a user gesture, and the interface is built on one. */
  const clickAt = async (selector) => {
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
  const waitFor = async (expression, attempts = 100, every = 300) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await evaluate(expression)) return true;
      await sleep(every);
    }
    return false;
  };

  /** One reading of the run, the HUD and the card, in a single round trip. */
  const SAMPLE = `(() => {
    const field = window.__runfield?.() ?? null;
    if (!field) return null;
    const chip = document.querySelector(".hud-contract");
    return {
      ...field,
      perf: performance.now(),
      chip: chip ? { id: chip.dataset.contract, text: chip.textContent.trim().replace(/\\s+/g, " "), rule: chip.title } : null,
      pips: document.querySelectorAll(".hud-pip").length,
      hazardBadge: document.querySelector(".hud-hazard")?.dataset.phase ?? null,
      over: Boolean(document.querySelector(".run-over-card")),
      paused: Boolean(document.querySelector(".pause-overlay")),
      feedTop: document.querySelector(".director-feed li b")?.textContent ?? "",
    };
  })()`;

  await waitFor(`Boolean(document.querySelector(".world-card") && document.querySelector(".start-button"))`, 150);

  // The deals are bought now (see `meta-probe.mjs`, which verifies the purchase), so a probe that plays
  // all four has to own them first: seeded here rather than earned, because earning 1200 banked tokens
  // is four long runs per deal and that is a different probe's job. The seeding is the only thing this
  // probe takes on trust; everything it measures is still read out of the run itself.
  await evaluate(`(() => {
    window.localStorage.setItem("watchme-run:deals", JSON.stringify(["standard", "close", "glass", "fair"]));
    return true;
  })()`);

  const picked = await evaluate(`(() => {
    const el = document.querySelector(".world-card.world-${WORLD}");
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!picked) throw new Error(`${WORLD}: no world card in the menu`);
  await sleep(700);
  await evaluate(`document.querySelector(".start-button").click()`);
  if (!(await waitFor(`document.documentElement.dataset.surface === "run" && Boolean(window.__runfield)`, 200))) {
    throw new Error("the run never came up");
  }
  await evaluate(RECORDER);

  const phases = [];

  /** Switches to a deal from wherever the player happens to be: a pause, or the end card. */
  const takeDeal = async (deal, from) => {
    if (from === "card") {
      if (!(await clickAt(`.run-over .contract-chip[data-contract="${deal.id}"]`))) return false;
    } else {
      await press("Space");
      if (!(await waitFor(`Boolean(document.querySelector(".pause-overlay"))`, 20, 200))) return false;
      if (!(await clickAt(`.pause-overlay .contract-chip[data-contract="${deal.id}"]`))) return false;
    }
    // The new run is the old one remounted, so the check is that the distance went back to the line and
    // the chip under it is the deal that was taken — not merely that the click registered.
    return waitFor(
      `(() => {
        const field = window.__runfield?.() ?? null;
        const chip = document.querySelector(".hud-contract");
        return Boolean(field) && chip?.dataset.contract === ${JSON.stringify(deal.id)} && field.distance < 20 &&
          !document.querySelector(".run-over-card") && !document.querySelector(".pause-overlay");
      })()`,
      40,
      200,
    );
  };

  /**
   * The autopilot.
   *
   * `reckless` is for the one-hit deal: it drives into whatever is in the lane, because the claim
   * being tested *is* the collision. Otherwise it dodges, and reaches for coins whenever the lane
   * they sit in is clear — the token check needs tokens, and a probe that only survives samples the
   * deal's token scale a handful of times a run.
   */
  const drive = async (sample, state, reckless) => {
    const field = sample;
    const ahead = (field.obstacles ?? []).filter((obstacle) => obstacle.z < 3 && obstacle.z > 3 - 32);
    const inLane = ahead.filter((obstacle) => obstacle.lane === state.lane).sort((a, b) => b.z - a.z)[0];
    const coins = (field.coins ?? []).filter((coin) => coin.z < 3 && coin.z > 3 - 26 && !ahead.some((o) => o.lane === coin.lane && Math.abs(o.z - coin.z) < 8));
    const clear = [0, 1, 2]
      .filter((lane) => !ahead.some((obstacle) => obstacle.lane === lane))
      .sort((a, b) => Math.abs(a - state.lane) - Math.abs(b - state.lane));
    const move = async (wanted) => {
      if (wanted === undefined || Date.now() - state.movedAt < 260) return;
      await press(wanted > state.lane ? "ArrowRight" : "ArrowLeft");
      state.lane = wanted;
      state.movedAt = Date.now();
      await sleep(60);
    };

    if (reckless) return;
    if (inLane && inLane.z > 3 - 11) {
      await press(inLane.kind === "gate" ? "ArrowDown" : "ArrowUp");
    } else if (inLane && inLane.z > 3 - 24) {
      await move(clear[0]);
    } else if (myLaneWantsCoin(field, coins, state) && clear.includes(coins[0].lane)) {
      await move(coins[0].lane);
    } else if (!inLane && state.lane !== 1 && !ahead.some((obstacle) => obstacle.lane === 1) && !coins.some((coin) => coin.lane === 1)) {
      await move(1);
    }
  };

  /** Does a coin ahead sit in a different lane than the runner, worth crossing for? */
  function myLaneWantsCoin(field, coins, state) {
    return coins.length > 0 && coins[0].lane !== state.lane && field.distance > 40;
  }

  for (const deal of DEALS_TO_PLAY) {
    const before = phases.length === 0 ? "pause" : phases[phases.length - 1].over ? "card" : "pause";
    const taken = await takeDeal(deal, before);
    if (!taken) {
      faults.push(`${deal.id}: the deal could not be taken from ${before}`);
      break;
    }

    const feedAt = (await json(`window.__contractProbe.feed.length`)) ?? 0;
    const tokensAt = (await json(`window.__contractProbe.tokens.length`)) ?? 0;
    const hazardsAt = (await json(`window.__contractProbe.hazards.length`)) ?? 0;

    const samples = [];
    const state = { lane: 1, movedAt: 0 };
    let over = false;
    const startedAt = Date.now();
    const deadline = startedAt + BUDGET_MS;
    const reckless = deal.hits === 1;

    while (Date.now() < deadline) {
      const sample = await json(SAMPLE);
      if (!sample) {
        await sleep(200);
        continue;
      }
      // A shove moves the lane without a key, so the autopilot has to re-read where it actually is.
      state.lane = sample.lane;
      samples.push(sample);
      if (sample.distance >= deal.metres || sample.over) {
        over = sample.over;
        break;
      }
      await drive(sample, state, reckless);
      await sleep(130);
    }

    const recorded = await json(`(() => ({
      tokens: window.__contractProbe.tokens.slice(${tokensAt}),
      feed: window.__contractProbe.feed.slice(${feedAt}),
      hazards: window.__contractProbe.hazards.slice(${hazardsAt}),
      feedFrom: ${feedAt},
      wholeFeed: window.__contractProbe.feed.length,
    }))()`);
    const last = samples[samples.length - 1] ?? {};
    phases.push({ deal, samples, recorded, over, last, lasted: Date.now() - startedAt });
    console.log(
      `${stamp()} ${deal.id}: ${samples.length} samples, ${last.distance ?? 0} m, damage ${last.damage ?? 0}` +
        `, tokens ${recorded.tokens.length}, hazards ${recorded.hazards.length}, ended ${over}`,
    );
  }

  /* ---- what each deal actually played like ---------------------------------------------------- */
  for (const phase of phases) {
    const { deal, samples, recorded, last } = phase;
    const chip = last.chip ?? samples[0]?.chip ?? null;
    const pips = last.pips ?? samples[0]?.pips ?? null;

    console.log(`\n--- ${deal.name} (${deal.id}) ---`);
    console.log(`  chip: ${chip ? `${chip.id} · "${chip.text}" · ${pips} pip${pips === 1 ? "" : "s"}` : "(none)"}`);
    if (!chip || chip.id !== deal.id) faults.push(`${deal.id}: the HUD chip did not name the deal (${chip?.id ?? "missing"})`);
    if (pips !== deal.hits) faults.push(`${deal.id}: ${pips} pips drawn for a ${deal.hits}-hit deal`);
    if (chip && !chip.text.toLowerCase().includes(`${deal.hits} hit`)) {
      faults.push(`${deal.id}: the chip does not state its hit count ("${chip.text}")`);
    }

    const tokens = recorded.tokens.filter((entry) => entry.curve);
    const ratios = tokens.map((entry) => {
      const expected = deal.tokenScale * (entry.doubled ? 2 : 1);
      return { ...entry, expected, ratio: entry.paid / entry.curve };
    });
    console.log(
      `  tokens: ${ratios.length} paid` +
        (ratios.length
          ? ` — ${ratios
              .slice(0, 6)
              .map((entry) => `${entry.paid}/${entry.curve}${entry.doubled ? " (×2 up)" : ""} = ${round(entry.ratio)}`)
              .join(", ")}${ratios.length > 6 ? ", …" : ""}`
          : ""),
    );
    const wrong = ratios.filter((entry) => Math.abs(entry.ratio - entry.expected) / entry.expected > 0.15);
    if (wrong.length) {
      faults.push(
        `${deal.id}: ${wrong.length}/${ratios.length} tokens paid off the scale (expected ×${deal.tokenScale}${wrong[0].doubled ? ", doubled" : ""}): ` +
          wrong.slice(0, 3).map((entry) => `${entry.paid} for a ${entry.curve} token`).join(", "),
      );
    } else if (ratios.length < 3) {
      notes.push(`${deal.id}: only ${ratios.length} tokens were collected, so the token scale is weakly measured`);
    }

    const damage = Math.max(...samples.map((sample) => sample.damage), 0);
    console.log(`  hits taken: ${damage} of ${deal.hits} allowed, run ended: ${phase.over}`);
    if (damage > deal.hits) faults.push(`${deal.id}: the run took ${damage} hits under a ${deal.hits}-hit deal`);
    if (deal.hits === 1) {
      if (damage < 1) notes.push("glass cannon: no collision landed, so the one-hit limit went untested");
      else if (!phase.over) faults.push("glass cannon: a hit landed and the run carried on");
      else if (damage !== 1) faults.push(`glass cannon: the run ended after ${damage} hits`);
      const spent = recorded.feed.filter((entry) => /SHIELD SPENT/.test(entry.line));
      if (spent.length) console.log(`  shields that took the hit first: ${spent.length}`);
    }
    if (phase.over && damage === 0) faults.push(`${deal.id}: the run ended without taking a hit`);

    const phasesSeen = new Set(samples.map((sample) => sample.hazard?.phase).filter(Boolean));
    // A count of hazards announced this run, not a distance: under Fair weather it must stay at zero.
    const fired = Math.max(...samples.map((sample) => sample.hazardFired ?? 0), 0);
    console.log(
      `  weather: phases ${[...phasesSeen].join("/") || "(none)"}, badges ${recorded.hazards.length}, fired ${fired}`,
    );
    if (!deal.hazards) {
      if (recorded.hazards.length) faults.push(`fair weather: the badge announced ${recorded.hazards[0].name}`);
      if (fired > 0) faults.push(`fair weather: ${fired} hazard${fired === 1 ? "" : "s"} fired`);
      if ([...phasesSeen].some((entry) => entry !== "calm")) {
        faults.push(`fair weather: the run state reached ${[...phasesSeen].join("/")}`);
      }
      if ((last.distance ?? 0) < 300) {
        notes.push(`fair weather: the run only reached ${last.distance ?? 0} m, short of the first hazard window`);
      }
    }

    const terms = recorded.feed.filter((entry) => /^TERMS · /.test(entry.line));
    console.log(`  feed: ${terms.map((entry) => `${entry.line} — ${entry.detail}`).join(" | ") || "(no TERMS line)"}`);
    if (!terms.length) {
      // The deal is asked for once the dive is over, so a run that was over in seconds — a one-hit
      // deal played straight into the traffic — is not evidence that the deal goes unannounced. The
      // chip names it on the HUD from the first frame either way; only a run that lasted long enough
      // to spend the ask and still never heard it is a fault.
      if (phase.lasted >= TERMS_GRACE_MS) faults.push(`${deal.id}: the deal was never acknowledged in the feed`);
      else notes.push(`${deal.id}: over after ${(phase.lasted / 1000).toFixed(1)} s, before an announcement could be spent`);
    }
    // Every answer the world gave, newest first: the evidence that the deal is wired into the same
    // channel as the rest of the run, not only into the numbers.
    console.log(
      `  answers: ${recorded.feed.length} of ${recorded.wholeFeed} captured since ${recorded.feedFrom} — ` +
        `${recorded.feed.map((entry) => entry.line).join(" | ") || "(none)"}`,
    );

    /* The meter's own gains, which is the cleanest evidence in the run: only two things add to flow —
       a near miss (`0.15 × flowScale`) and a threaded gap (`0.34 × flowScale`) — and nothing else does.
       So every upward step in the flow value between two samples *is* one of those, at the deal's own
       scale, and the median step separates the deals by the ratio they claim. Steps taken from a meter
       already past 0.7 are dropped: a gain that would have landed above the cap is truncated, and a
       truncated step is not the gain the deal pays. Decay inside an interval is 0.03 × 0.26 s at most,
       which is inside the rounding. */
    const jumps = [];
    const nearMissJumps = [];
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const now = samples[index];
      if (previous.flow > 0.7) continue;
      const gain = round(now.flow - previous.flow);
      if (gain <= 0.01) continue;
      jumps.push(gain);
      if (/^NEAR MISS/.test(now.feedTop) && now.feedTop !== previous.feedTop) nearMissJumps.push(gain);
    }
    jumps.sort((a, b) => a - b);
    const median = jumps.length ? jumps[Math.floor(jumps.length / 2)] : null;
    const bands = [...new Set(jumps.map((gain) => round(gain)))].sort((a, b) => a - b);
    console.log(
      `  meter steps: ${jumps.length} measured${median === null ? "" : `, median ${round(median)}`}` +
        `${bands.length ? ` — values ${bands.join(", ")}` : ""}` +
        `${nearMissJumps.length ? ` (${nearMissJumps.length} struck while a near miss was the newest line)` : ""}`,
    );
    phase.jumps = jumps;
    phase.medianJump = median;
    phase.terms = terms;
  }

  const withTerms = phases.filter((phase) => phase.terms.length > 0);
  if (phases.some((phase) => phase.terms.length > 0) === false) {
    notes.push("no deal was acknowledged in the feed in this run of the probe");
  } else if (withTerms.length < Math.ceil(phases.length / 2)) {
    notes.push(`only ${withTerms.length}/${phases.length} deals were acknowledged in the feed`);
  }

  const standard = phases.find((phase) => phase.deal.id === "standard");
  const close = phases.find((phase) => phase.deal.id === "close");
  if (!standard || !close) notes.push("the flow scale was not compared: both standard and close quarters have to be played");
  if (standard?.medianJump && close?.medianJump && standard.jumps.length >= 6 && close.jumps.length >= 6) {
    console.log(
      `\nflow per near miss: standard ${round(standard.medianJump)} (${standard.jumps.length}) against close quarters ${round(close.medianJump)} (${close.jumps.length}) — the claim is ×1.5`,
    );
    if (close.medianJump <= standard.medianJump * 1.15) {
      faults.push(
        `close quarters filled the meter at ${round(close.medianJump / standard.medianJump)}× standard, and the deal claims 1.5×`,
      );
    }
  } else {
    notes.push("too few near misses were measured to compare the flow scale between deals");
  }

  console.log(`\nconsole:`);
  // Every matching line, not a tail: a director that drops an ask three times in a row says so
  // in a burst, and the lines that explain a missing announcement are the oldest ones.
  console.log(logs.join("\n") || "  (nothing matching)");
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
