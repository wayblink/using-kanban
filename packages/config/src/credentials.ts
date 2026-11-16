/**
 * Where the token for a remote board lives.
 *
 * Kept out of `config.json` on purpose: that file is shared with the Pi panel
 * and is meant to be copyable between machines. A credential is per machine and
 * per server, written 0600, and never printed back.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { resolveConfigPath } from "./index.js";

export const CREDENTIALS_FILE_NAME = "credentials.json";

interface StoredServer {
  readonly token: string;
  readonly addedAt?: string;
}

export interface CredentialsDocument {
  readonly version: 1;
  readonly servers: Readonly<Record<string, StoredServer>>;
}

const EMPTY: CredentialsDocument = { version: 1, servers: {} };

/** `~/.config/ukb/credentials.json`, beside the config file. */
export function resolveCredentialsPath(env: NodeJS.ProcessEnv): string {
  return `${dirname(resolveConfigPath(env))}/${CREDENTIALS_FILE_NAME}`;
}

/** Canonical key for a server: no trailing slash, http(s) only. */
export function normalizeServerUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/u, "");
  if (!/^https?:\/\/[^/]+/u.test(value)) {
    throw new Error(`server must be an http(s) URL, got "${raw}"`);
  }
  return value;
}

export function readCredentials(
  env: NodeJS.ProcessEnv = process.env,
): CredentialsDocument {
  const path = resolveCredentialsPath(env);
  if (!existsSync(path)) return EMPTY;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      servers?: unknown;
    };
    if (
      parsed.version !== 1 ||
      typeof parsed.servers !== "object" ||
      parsed.servers === null ||
      Array.isArray(parsed.servers)
    ) {
      return EMPTY;
    }
    return {
      version: 1,
      servers: parsed.servers as Record<string, StoredServer>,
    };
  } catch {
    return EMPTY;
  }
}

/** The stored token for one server, or null. */
export function credentialFor(
  env: NodeJS.ProcessEnv,
  server: string,
): string | null {
  let key: string;
  try {
    key = normalizeServerUrl(server);
  } catch {
    return null;
  }
  const token = readCredentials(env).servers[key]?.token;
  return typeof token === "string" && token !== "" ? token : null;
}

/** Stores (or replaces) the token for a server. */
export function saveCredential(
  env: NodeJS.ProcessEnv,
  server: string,
  token: string,
  now = new Date(),
): string {
  const key = normalizeServerUrl(server);
  const trimmed = token.trim();
  if (trimmed === "") throw new Error("token must not be empty");
  const path = resolveCredentialsPath(env);
  const current = readCredentials(env);
  const document: CredentialsDocument = {
    version: 1,
    servers: {
      ...current.servers,
      [key]: { token: trimmed, addedAt: now.toISOString() },
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return path;
}

/** Removes the token for a server; returns whether one was there. */
export function removeCredential(
  env: NodeJS.ProcessEnv,
  server: string,
): boolean {
  const key = normalizeServerUrl(server);
  const current = readCredentials(env);
  if (current.servers[key] === undefined) return false;
  const servers = { ...current.servers };
  delete servers[key];
  const path = resolveCredentialsPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ version: 1, servers }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return true;
}

export interface TransportSources {
  /** CLI/MCP flags. */
  readonly server?: string | undefined;
  readonly token?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly config?: { readonly server?: string | undefined } | undefined;
}

export interface ResolvedTransport {
  /** Canonical remote origin, or null for the local store. */
  readonly server: string | null;
  readonly token: string | null;
}

/**
 * Flag → environment → config file decides *where*; flag → environment → the
 * credentials file decides *what proves it*. A remote URL without a token is
 * still a remote URL — the server's 401 turns into advice to run `ukb login`.
 */
export function resolveTransport(
  sources: TransportSources = {},
): ResolvedTransport {
  const env = sources.env ?? process.env;
  const configured =
    sources.server ?? env.UKB_SERVER ?? sources.config?.server ?? null;
  const server =
    configured === null || configured.trim() === ""
      ? null
      : normalizeServerUrl(configured);
  if (server === null) return { server: null, token: null };

  const token =
    sources.token ?? env.UKB_TOKEN ?? credentialFor(env, server) ?? null;
  return { server, token: token?.trim() || null };
}
