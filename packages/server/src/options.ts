import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { ActorSchema, type StorageKind } from "@wayblink/using-kanban-core";
import { machineName } from "@wayblink/using-kanban-config";

export const DEFAULT_HOST = "127.0.0.1";

export const ServerOptionsSchema = z.object({
  /** Board directory — the store lives at `<dir>/.ukb/`. */
  // One centralised board; projects are separated by the `project` field.
  dir: z.string().default(homedir()),
  storage: z.enum(["sqlite", "jsonl", "memory"]).default("sqlite"),
  /** Bind address. Anything other than loopback is opt-in. */
  host: z.string().default(DEFAULT_HOST),
  /** 0 = let the OS pick a free port. */
  port: z.number().int().min(0).max(65535).default(0),
  /** Bearer token for mutations. Generated when omitted. */
  token: z.string().min(1).optional(),
  /**
   * The machine's human name (`config.owner`) — the permission escape hatch,
   * and the default actor of the Web UI. Defaults to the machine's name.
   */
  owner: z.string().min(1).optional(),
  /** Default actor when a request carries no identity. Defaults to the owner. */
  actor: ActorSchema.optional(),
  /** Directory of static assets to serve at `/` (the default Web UI). */
  uiDir: z.string().optional(),
  /**
   * Directories a card note's document link may point into. The store
   * directory and the server's working directory are always allowed; these
   * extend that (e.g. the repo the cards are about).
   */
  docRoots: z.array(z.string()).default([]),
  /** Value for `Access-Control-Allow-Origin`; `*` allows embedding from anywhere. */
  corsOrigin: z.string().default("*"),
  /** How often the SSE broker polls the event log. */
  ssePollMs: z.number().int().positive().default(250),
});
export type ServerOptions = z.input<typeof ServerOptionsSchema>;

export interface ResolvedServerOptions {
  dir: string;
  storage: StorageKind;
  host: string;
  port: number;
  token: string;
  owner: string;
  actor: z.infer<typeof ActorSchema>;
  uiDir?: string | undefined;
  corsOrigin: string;
  ssePollMs: number;
  docRoots: string[];
}

export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Loopback only — `0.0.0.0`/`::` bind every interface and must NOT count. */
export function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

/** Applies defaults, generates a token when none was given. */
export function resolveServerOptions(
  options: ServerOptions = {},
): ResolvedServerOptions {
  const parsed = ServerOptionsSchema.parse(options);
  // One name for the person at this machine: the owner is the Web UI's default
  // actor and the one identity the permission guard always lets through.
  const owner = parsed.owner ?? machineName();
  return {
    ...parsed,
    owner,
    actor: parsed.actor ?? { type: "human", name: owner },
    token: parsed.token ?? generateToken(),
    docRoots: parsed.docRoots.map((root) => resolve(root)),
  };
}
