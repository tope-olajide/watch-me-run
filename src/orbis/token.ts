/**
 * Browser-side Reactor token fetching.
 *
 * Kept free of any Reactor SDK import so the menu can check the world engine (and pre-warm a
 * token) without pulling the WebRTC runtime into the first bundle.
 */

const TOKEN_ENDPOINT = "/api/reactor/token";

type TokenCache = { jwt: string; expiresAt: number } | null;
let cache: TokenCache = null;
let inflight: Promise<string> | null = null;

export async function getReactorToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cache && cache.expiresAt - 60 > now) return cache.jwt;
  if (inflight) return inflight;

  inflight = fetch(TOKEN_ENDPOINT, { method: "POST", cache: "no-store" })
    .then(async (response) => {
      const body = (await response.json()) as { jwt?: string; expires_at?: number; error?: string };
      if (!response.ok || !body.jwt) {
        throw new Error(body.error ?? `Reactor token request failed (${response.status})`);
      }
      cache = { jwt: body.jwt, expiresAt: body.expires_at ?? now + 3600 };
      return body.jwt;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/**
 * A session-scoped token can only act on the sessions it created, so a cached token must live
 * as long as its connection. A new connection attempt mints a fresh one instead.
 */
export function resetReactorToken() {
  cache = null;
  inflight = null;
}

