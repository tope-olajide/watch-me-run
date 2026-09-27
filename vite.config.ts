import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { mintSessionToken } from "./server/reactor-token";

const wasmMimePlugin: Plugin = {
  name: "watchme-run-wasm-mime",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.includes(".wasm")) {
        response.setHeader("Content-Type", "application/wasm");
      }
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.includes(".wasm")) {
        response.setHeader("Content-Type", "application/wasm");
      }
      next();
    });
  },
};

/**
 * Serves `/api/reactor/token` from the Vite dev and preview servers by reusing the same
 * minting code as the Netlify function. Without this, live Orbis only works under
 * `npm run dev:netlify`, which is an easy way to lose an afternoon wondering why the
 * world never appears.
 */
function reactorTokenPlugin(apiKey: string | undefined): Plugin {
  const handle: Connect.NextHandleFunction = (request, response) => {
    const send = (status: number, body: unknown) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "private, no-store");
      response.end(JSON.stringify(body));
    };

    void (async () => {
      if (request.method !== "POST") return send(405, { error: "Method not allowed" });
      if (!apiKey) return send(503, { error: "REACTOR_API_KEY is not set in .env" });

      try {
        const { status, body } = await mintSessionToken(apiKey);
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.setHeader("cache-control", "private, no-store");
        response.end(body);
      } catch (cause) {
        send(502, { error: cause instanceof Error ? cause.message : "Reactor token request failed" });
      }
    })();
  };

  return {
    name: "watchme-run-reactor-token",
    configureServer(server) {
      server.middlewares.use("/api/reactor/token", handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/reactor/token", handle);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiKey = env.REACTOR_API_KEY ?? process.env.REACTOR_API_KEY;

  return {
    plugins: [react(), wasmMimePlugin, reactorTokenPlugin(apiKey)],
    optimizeDeps: {
      // The Reactor SDK loads its wasm glue through a vite-ignored dynamic import, so the
      // browser resolves "./wasm/reactor_wasm.js" at runtime against the module's own URL.
      // Pre-bundling relocates the module into node_modules/.vite/deps, where ./wasm does
      // not exist and the dev server answers with index.html, which makes wasm init fail
      // and Orbis stay in fallback. Serving both packages from their real paths keeps the
      // glue next to reactor_wasm_bg.wasm.
      exclude: ["@reactor-team/js-sdk", "@reactor-models/visko-orbis-stable"],
      // Excluding a package means its own roots are never scanned, so its CommonJS
      // dependencies have to be pre-bundled by hand — otherwise the browser gets raw
      // CJS files and named imports such as `AwaitQueue` fail to resolve.
      include: ["awaitqueue", "hls.js", "mp4box"],
    },
  };
});
