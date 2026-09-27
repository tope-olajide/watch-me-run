/**
 * Server-only Reactor token minting.
 *
 * `REACTOR_API_KEY` must never reach the browser, so both the Netlify function and the
 * Vite dev/preview middleware mint session-scoped JWTs through this one implementation.
 */

const MODEL_NAME = "reactor/visko-orbis-stable";

const TOKEN_LIFETIME_SECONDS = 3600;

/**
 * Keep the per-session cap modest: if a browser dies mid-run, the orphaned session
 * frees up quickly instead of blocking the account's single concurrent-session slot.
 */
const MAX_SESSION_DURATION_SECONDS = 1200;

/** How many sessions one token may create. Retries reuse the slot, so this stays small. */
const MAX_SESSIONS = 3;

export type MintResult = { status: number; body: string };

export async function mintSessionToken(apiKey: string): Promise<MintResult> {
  const response = await fetch("https://api.reactor.inc/tokens", {
    method: "POST",
    headers: {
      "Reactor-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: TOKEN_LIFETIME_SECONDS,
      authorization_details: [
        {
          type: "session",
          resources: { models: { match: [MODEL_NAME] } },
          constraints: {
            max_sessions: MAX_SESSIONS,
            max_session_duration_seconds: MAX_SESSION_DURATION_SECONDS,
          },
        },
      ],
    }),
  });

  return { status: response.status, body: await response.text() };
}

export { MODEL_NAME };
