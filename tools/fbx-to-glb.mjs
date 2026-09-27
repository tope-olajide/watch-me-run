// Build step for the runner assets: drives `tools/fbx-to-glb.html` in headless Chrome and writes
// `models/characters/<runner>.glb`.
//
// The FBX files in `models/` are the source of truth — each character carries 4096² textures and a
// vertex per face corner, which is why the three of them weigh 108 MB. This converts them to one GLB
// per runner with textures cut to 1024 (colour) and 512 (data) and the duplicate vertices welded,
// which lands around 7 MB total. The conversion runs in the browser because that is where three's
// FBXLoader can decode the embedded textures and GLTFExporter can re-encode them.
//
// Usage (with the dev server already running, since the page imports three through Vite):
//
//   node tools/fbx-to-glb.mjs                      # http://localhost:5173, writes models/characters
//   node tools/fbx-to-glb.mjs http://localhost:5199/ ./models/characters
//
// Re-run it whenever the FBX sources in `models/` change.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE_URL = (process.argv[2] ?? "http://localhost:5173/").replace(/\/$/, "");
const OUT_DIR = process.argv[3] ?? "models/characters";
const PAGE_URL = `${BASE_URL}/tools/fbx-to-glb.html`;
const PORT = Number(process.env.CDP_PORT ?? 9343);

const profile = mkdtempSync(join(tmpdir(), "watchme-glb-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-unsafe-swiftshader",
    "--js-flags=--max-old-space-size=8192",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function devtools(path) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}${path}`);
      if (response.ok) return response.json();
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`Chrome's DevTools endpoint never came up on ${PORT}`);
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
    socket.addEventListener("error", reject);
  });

  return {
    ready,
    send(method, params = {}) {
      id += 1;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(listener) {
      listeners.push(listener);
    },
  };
}

let pageFailed = false;

try {
  await devtools("/json/version");
  const targets = await devtools("/json/list");
  const blank = targets.find((target) => target.type === "page");
  const browserSocket = cdpSocket(blank.webSocketDebuggerUrl);
  await browserSocket.ready;
  const { targetId } = await browserSocket.send("Target.createTarget", { url: `${PAGE_URL}?mode=export` });
  await sleep(1500);

  const pages = await devtools("/json/list");
  const page = pages.find((target) => target.id === targetId) ?? pages.find((target) => target.url.startsWith("http"));
  const pageSocket = cdpSocket(page.webSocketDebuggerUrl);
  await pageSocket.ready;

  pageSocket.on((message) => {
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      console.error(`page threw: ${(details.exception?.description ?? details.text).slice(0, 400)}`);
      pageFailed = true;
    }
    if (message.method === "Runtime.consoleAPICalled") {
      const text = (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
      if (/^step /.test(text)) console.log(text.replace(/@\d+ms$/, ""));
      else if (/error/i.test(message.params.type)) console.error(text.slice(0, 300));
    }
    if (message.method === "Log.entryAdded") {
      const entry = message.params.entry;
      if (entry.level === "error" && !entry.url?.endsWith("favicon.ico")) {
        console.error(`[error] ${entry.text} ${entry.url ?? ""}`.slice(0, 300));
      }
    }
  });

  await pageSocket.send("Runtime.enable");
  await pageSocket.send("Log.enable");

  const evaluate = async (expression) => {
    const result = await pageSocket.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      pageFailed = true;
      throw new Error(result.exceptionDetails.exception?.description?.slice(0, 400) ?? "evaluate failed");
    }
    return result.result?.value;
  };

  let report = null;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (pageFailed) throw new Error("the conversion page threw before finishing");
    if (await evaluate("Boolean(window.__done)")) {
      report = await evaluate("window.__report");
      break;
    }
    await sleep(1000);
  }
  if (!report) throw new Error("the conversion never finished (600 s)");

  const shrinkLog = JSON.parse((await evaluate("window.__shrinkLog")) ?? "[]");
  const entries = JSON.parse(report);
  const chunks = JSON.parse(
    (await evaluate(`JSON.stringify(Object.fromEntries(Object.entries(window.__glb ?? {}).map(([name, parts]) => [name, parts.length])))`)) ?? "{}",
  );

  if (Object.keys(chunks).length === 0) throw new Error("the page produced no files");

  mkdirSync(OUT_DIR, { recursive: true });
  let total = 0;
  for (const [name, count] of Object.entries(chunks)) {
    const parts = [];
    for (let index = 0; index < count; index += 1) {
      parts.push(await evaluate(`window.__glb[${JSON.stringify(name)}][${index}]`));
    }
    const buffer = Buffer.from(parts.join(""), "base64");
    writeFileSync(join(OUT_DIR, `${name}.glb`), buffer);
    total += buffer.length;
    console.log(`${name}.glb ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
  }

  console.log("");
  console.log(`textures: ${shrinkLog.length} downscaled`);
  for (const line of shrinkLog) console.log(`  ${line}`);
  console.log(`written: ${(total / 1024 / 1024).toFixed(2)} MB total to ${OUT_DIR}`);
} finally {
  chrome.kill();
}
