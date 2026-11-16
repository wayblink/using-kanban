import type { IncomingMessage } from "node:http";
import {
  ActorSchema,
  type AccountIdentity,
  type AccountStore,
  type Actor,
  type EventSource,
} from "@wayblink/using-kanban-core";
import { HttpError } from "./http.js";
import { isLoopbackHost, type ResolvedServerOptions } from "./options.js";

export interface AuthSuccess {
  readonly ok: true;
  /** Who the credential belongs to; null for the machine token / anonymous loopback. */
  readonly identity: AccountIdentity | null;
}

export interface AuthFailure {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** Send `WWW-Authenticate: Basic` so a browser shows its sign-in prompt. */
  readonly challenge: boolean;
}

export type AuthResult = AuthSuccess | AuthFailure;

function failure(
  status: number,
  code: string,
  message: string,
  challenge: boolean,
): AuthFailure {
  return { ok: false, status, code, message, challenge };
}

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;
const BLOCK_MS = 60_000;

interface Attempt {
  count: number;
  since: number;
  until: number;
}

/**
 * Coarse sign-in throttle, per client address.
 *
 * Basic auth is checked on every request, so an attacker gets as many guesses
 * as the server has CPU: this keeps a brute-force pass from being cheap. One
 * minute of lockout after ten failures is deliberately blunt — a shared board
 * is not worth a per-account lockout policy yet.
 */
export class LoginThrottle {
  private readonly attempts = new Map<string, Attempt>();

  blocked(clientIp: string, now = Date.now()): boolean {
    const attempt = this.attempts.get(clientIp);
    if (attempt === undefined) return false;
    if (attempt.until > now) return true;
    if (now - attempt.since > FAILURE_WINDOW_MS) {
      this.attempts.delete(clientIp);
      return false;
    }
    return false;
  }

  failed(clientIp: string, now = Date.now()): void {
    const attempt = this.attempts.get(clientIp);
    if (attempt === undefined || now - attempt.since > FAILURE_WINDOW_MS) {
      this.attempts.set(clientIp, { count: 1, since: now, until: 0 });
      return;
    }
    attempt.count += 1;
    if (attempt.count >= MAX_FAILURES) {
      attempt.count = 0;
      attempt.since = now;
      attempt.until = now + BLOCK_MS;
    }
  }

  succeeded(clientIp: string): void {
    this.attempts.delete(clientIp);
  }
}

/**
 * Decides whether a request may proceed, and as whom.
 *
 * Two modes:
 * - **Accounts configured** (the shared-server case): every request needs either
 *   HTTP Basic credentials or a machine token. The loopback exemption is gone on
 *   purpose — behind a reverse proxy every request looks local.
 * - **No accounts**: the original single-machine rules. Reads are free on
 *   loopback (or anywhere when `--allow-anonymous` explicitly marks the network
 *   trusted), mutations need the generated token, and a non-loopback bind is
 *   refused at startup unless that flag is set (see `assertBindPolicy`). The
 *   flag relaxes the bind and anonymous reads, never the write credential.
 */
export async function authorizeRequest(
  req: IncomingMessage,
  url: URL,
  options: ResolvedServerOptions,
  accounts: AccountStore,
  isMutation: boolean,
  clientIp: string,
  throttle: LoginThrottle,
): Promise<AuthResult> {
  const configured = accounts.hasUsers();

  if (configured) {
    const presented = extractToken(req, url);
    if (presented !== null) {
      if (presented === options.token) return { ok: true, identity: null };
      const identity = accounts.verifyToken(presented);
      if (identity !== null) return { ok: true, identity };
      return failure(
        401,
        "unauthorized",
        "a valid machine token is required (ukb user token add <name>)",
        false,
      );
    }

    if (throttle.blocked(clientIp)) {
      return failure(
        429,
        "too_many_attempts",
        "too many failed sign-ins; try again in a minute",
        false,
      );
    }

    const basic = parseBasic(req);
    if (basic !== null) {
      const identity = await accounts.verifyPassword(
        basic.name,
        basic.password,
      );
      if (identity !== null) {
        throttle.succeeded(clientIp);
        return { ok: true, identity };
      }
      throttle.failed(clientIp);
      return failure(401, "unauthorized", "invalid username or password", true);
    }

    return failure(
      401,
      "unauthorized",
      "accounts are enabled: send HTTP Basic credentials or a machine token",
      true,
    );
  }

  const token = extractToken(req, url);
  if (token !== null && token === options.token)
    return { ok: true, identity: null };
  if (isMutation) {
    return failure(
      401,
      "unauthorized",
      "a valid token is required for mutations (Authorization: Bearer <token> or ?token=)",
      false,
    );
  }
  // The loopback exemption assumes the machine is the boundary. A non-loopback
  // bind drops that assumption, so reads are only open when the operator said
  // the network is trusted; writes always keep the token requirement above.
  if (isLoopbackHost(options.host) || options.allowAnonymous) {
    return { ok: true, identity: null };
  }
  return failure(
    401,
    "unauthorized",
    "a valid token is required when the server is not bound to loopback",
    false,
  );
}

/** Bearer header first, then the `?token=` form EventSource needs. */
export function extractToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  return url.searchParams.get("token");
}

/** `Authorization: Basic base64(name:password)`, or null. */
export function parseBasic(
  req: IncomingMessage,
): { name: string; password: string } | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(
      header.slice("Basic ".length).trim(),
      "base64",
    ).toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0) return null;
  return { name: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
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
