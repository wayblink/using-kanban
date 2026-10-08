import type { IncomingMessage } from "node:http";
import { ActorSchema, type Actor, type EventSource } from "@using-kanban/core";
import { HttpError } from "./http.js";
import { isLoopbackHost, type ResolvedServerOptions } from "./options.js";

export type AuthResult =
  { ok: true } | { ok: false; status: number; code: string; message: string };

/**
 * Token rules:
 * - mutations always need the token (browsers can pass it as `?token=` for SSE)
 * - reads are free on loopback, need the token otherwise
 */
export function authorizeRequest(
  req: IncomingMessage,
  url: URL,
  options: ResolvedServerOptions,
  isMutation: boolean,
): AuthResult {
  const token = extractToken(req, url);
  if (token === options.token) return { ok: true };

  if (isMutation) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message:
        "a valid token is required for mutations (Authorization: Bearer <token> or ?token=)",
    };
  }
  if (isLoopbackHost(options.host)) return { ok: true };
  return {
    ok: false,
    status: 401,
    code: "unauthorized",
    message:
      "a valid token is required when the server is not bound to loopback",
  };
}

export function extractToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  return url.searchParams.get("token");
}

/**
 * Resolves the acting identity: explicit headers win, then query params, then
 * the configured default actor.
 */
export function resolveActor(
  req: IncomingMessage,
  url: URL,
  fallback: Actor,
): Actor {
  const name =
    headerValue(req, "x-actor-name") ??
    url.searchParams.get("actor") ??
    fallback.name;
  const type =
    headerValue(req, "x-actor-type") ??
    url.searchParams.get("actor-type") ??
    fallback.type;

  const parsed = ActorSchema.safeParse({
    name: String(name),
    type: String(type),
  });
  if (!parsed.success) {
    throw new HttpError(
      400,
      "invalid_actor",
      "actor must have a non-empty name and type human|agent",
    );
  }
  return parsed.data;
}

/** Optional `X-Source` override so UIs can mark their events as `web`. */
export function resolveSource(
  req: IncomingMessage,
  fallback: EventSource = "api",
): EventSource {
  const value = headerValue(req, "x-source");
  if (
    value === "cli" ||
    value === "mcp" ||
    value === "api" ||
    value === "web" ||
    value === "system"
  ) {
    return value;
  }
  return fallback;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
