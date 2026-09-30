// Cooks the roadside props out of the downloaded asset packs and into `models/<pack>/props.glb`.
//
// The packs in `models/trees`, `models/rocks` and `models/city` are whole scenes bought as scenes —
// tens of megabytes of 2048² textures, meshes scattered down a hierarchy, and materials using
// extensions three will not all honour. `tools/cook-props.html` does the work (picking objects,
// baking their transforms, normalising them to a metre tall, shrinking every texture), because
// texture decoding needs a browser; this drives that page and writes the files.
//
// Usage (with the dev server already running, since the page imports three through Vite):
//
//   node tools/cook-props.mjs                      # http://localhost:5173, every pack
//   node tools/cook-props.mjs http://localhost:5199/ trees
//   MODE=report node tools/cook-props.mjs          # report without writing anything
//
// Re-run it whenever the packs in `models/` are replaced.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE_URL = (process.argv[2] ?? "http://localhost:5173/").replace(/\/$/, "");
const ONLY = process.argv[3] ?? process.env.PACK;
const MODE = process.env.MODE ?? "export";
const PACKS = ONLY ? ONLY.split(",") : ["trees", "rocks", "city"];
const PORT = Number(process.env.CDP_PORT ?? 9345);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const profile = mkdtempSync(join(tmpdir(), "watchme-cook-"));
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

  for (const pack of PACKS) {
    console.log(`\n===== ${pack} =====`);
    const targets = await devtools("/json/list");
    const blank = targets.find((target) => target.type === "page");
    const browserSocket = cdpSocket(blank.webSocketDebuggerUrl);
    await browserSocket.ready;
    const { targetId } = await browserSocket.send("Target.createTarget", {
      url: `${BASE_URL}/tools/cook-props.html?pack=${pack}&mode=${MODE}`,
    });
    await sleep(1500);

    const pages = await devtools("/json/list");
    const page =
      pages.find((target) => target.id === targetId) ?? pages.find((target) => target.url.includes("cook-props"));
    const pageSocket = cdpSocket(page.webSocketDebuggerUrl);
    await pageSocket.ready;

    pageSocket.on((message) => {
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        console.error(`page threw: ${(details.exception?.description ?? details.text).slice(0, 500)}`);
        pageFailed = true;
      }
      if (message.method === "Runtime.consoleAPICalled") {
        const text = (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
        if (/^(step |chosen )/.test(text)) console.log(`  ${text.replace(/@\d+ms$/, "")}`);
        else if (/error/i.test(message.params.type)) console.error(`  ${text.slice(0, 300)}`);
      }
      if (message.method === "Log.entryAdded") {
        const entry = message.params.entry;
        if (entry.level === "error" && !entry.url?.endsWith("favicon.ico")) {
          console.error(`  [error] ${entry.text} ${entry.url ?? ""}`.slice(0, 300));
        }
      }
    });

    await pageSocket.send("Runtime.enable");
    await pageSocket.send("Log.enable");

    const evaluate = async (expression) => {
      const result = await pageSocket.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        pageFailed = true;
        throw new Error(result.exceptionDetails.exception?.description?.slice(0, 500) ?? "evaluate failed");
      }
      return result.result?.value;
    };

    let report = null;
    for (let attempt = 0; attempt < 900; attempt += 1) {
      if (pageFailed) throw new Error(`the ${pack} page threw before finishing`);
      if (await evaluate("Boolean(window.__done)")) {
        report = await evaluate("window.__report");
        break;
      }
      await sleep(1000);
    }
    if (!report) throw new Error(`the ${pack} cook never finished (900 s)`);

    const parsed = JSON.parse(report);
    console.log(`  cooked ${parsed.objects.length} props, ${parsed.textures} textures shrunk`);
    for (const object of parsed.objects) {
      console.log(
        `    ${object.name.padEnd(22)} from ${object.source.padEnd(24)} ${object.metres.padStart(6)} m tall  ` +
          `tris ${String(object.triangles).padStart(6)}  parts ${object.parts}  footprint ${object.box[0]}x${object.box[2]} m`,
      );
    }

    if (MODE !== "export") continue;

    const chunks = JSON.parse(
      (await evaluate(
        `JSON.stringify(Object.fromEntries(Object.entries(window.__glb ?? {}).map(([name, parts]) => [name, parts.length])))`,
      )) ?? "{}",
    );
    if (Object.keys(chunks).length === 0) throw new Error(`the ${pack} page produced no files`);

    for (const [name, count] of Object.entries(chunks)) {
      const parts = [];
      for (let index = 0; index < count; index += 1) {
        parts.push(await evaluate(`window.__glb[${JSON.stringify(name)}][${index}]`));
      }
      const buffer = Buffer.from(parts.join(""), "base64");
      const path = join("models", pack, "props.glb");
      writeFileSync(path, buffer);
      console.log(`  wrote ${path} ${(buffer.length / 1024).toFixed(0)} KB`);
    }

    await browserSocket.send("Target.closeTarget", { targetId: page.id });
  }
} finally {
  chrome.kill();
}
