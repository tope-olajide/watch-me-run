import type { Config } from "@netlify/functions";
import { mintSessionToken } from "../../server/reactor-token";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });

export default async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const apiKey = process.env.REACTOR_API_KEY;
  if (!apiKey) return json({ error: "REACTOR_API_KEY is not configured" }, 503);

  try {
    const { status, body } = await mintSessionToken(apiKey);
    return new Response(body, {
      status,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Reactor token request failed";
    return json({ error: message }, 502);
  }
};

export const config: Config = {
  path: "/api/reactor/token",
};
