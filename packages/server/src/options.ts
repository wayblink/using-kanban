import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  ACCOUNTS_FILE_NAME,
  ActorSchema,
  type StorageKind,
} from "@wayblink/using-kanban-core";
import { machineName } from "@wayblink/using-kanban-config";

export const DEFAULT_HOST = "127.0.0.1";

export const ServerOptionsSchema = z.object({
  /** Board directory — the store lives at `<dir>/.ukb/`. */
  // One centralised board; projects are separated by the `project` field.
  dir: z.string().default(homedir()),
  storage: z.enum(["sqlite", "jsonl", "memory", "postgres"]).default("sqlite"),
  /** Bind address. Anything other than loopback is opt-in. */
  host: z.string().default(DEFAULT_HOST),
  /** 0 = let the OS pick a free port. */
  port: z.number().int().min(0).max(65535).default(0),
  /** Bearer token for mutations. Generated when omitted. */
  token: z.string().min(1).optional(),
  /** Connection URL for `storage: "postgres"`. */
  postgresUrl: z.string().min(1).optional(),
  /**
   * Allow binding beyond loopback without any account. Off by default: a board
   * that leaves the machine must say who may read it. `--allow-anonymous` is the
   * explicit escape hatch for a trusted LAN: reads are open to whoever reaches
   * the port, mutations still need the token.
   */
  allowAnonymous: z.boolean().default(false),
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
  /** Expose POST /api/import/events (admin-only migration endpoint). */
  allowImport: z.boolean().default(false),
});
export type ServerOptions = z.input<typeof ServerOptionsSchema>;

export interface ResolvedServerOptions {
  dir: string;
  storage: StorageKind;
  host: string;
  port: number;
  token: string;
  /** Where the account file lives (`<dir>/.ukb/accounts.json`). */
  accountsPath: string;
  /** Postgres DSN, present only for `storage: postgres`. */
  postgresUrl?: string | undefined;
  allowAnonymous: boolean;
  owner: string;
  actor: z.infer<typeof ActorSchema>;
  uiDir?: string | undefined;
  corsOrigin: string;
  ssePollMs: number;
  docRoots: string[];
  allowImport: boolean;
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

/**
 * A configuration the server cannot start with — a setup step, not a crash.
 *
 * Carried as an `exitCode` the CLI and `ukb-server` honor, so a supervisor can
 * tell "needs an account" (EX_CONFIG, 78) from "the process broke" (1). The
 * property is read structurally rather than by `instanceof`: the CLI imports
 * the server lazily, and a bundled CLI may hold a different copy of this class.
 */
export class ServerConfigError extends Error {
  readonly exitCode = 78;

  constructor(message: string) {
    super(message);
    this.name = "ServerConfigError";
  }
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
    accountsPath: join(parsed.dir, ".ukb", ACCOUNTS_FILE_NAME),
    docRoots: parsed.docRoots.map((root) => resolve(root)),
  };
}

/**
 * The one policy that keeps a personal board from becoming a public one:
 * binding beyond loopback needs an account (or an explicit opt-in).
 *
 * Refusing here, at startup, means the failure is a sentence in the operator's
 * terminal — not a silent exposure discovered later. The sentence has to be
 * actionable from where the operator stands (a laptop or a container), so it
 * names the resolved board directory and both ways to create the first account.
 */
export function assertBindPolicy(
  options: Pick<
    ResolvedServerOptions,
    "host" | "dir" | "accountsPath" | "allowAnonymous"
  >,
  hasAccounts: boolean,
): void {
  if (isLoopbackHost(options.host) || options.allowAnonymous || hasAccounts) {
    return;
  }
  throw new ServerConfigError(
    [
      `refusing to bind ${options.host} without accounts`,
      "",
      `  board      ${options.dir}`,
      `  accounts   ${options.accountsPath} (no users yet)`,
      `  create     ukb user add <name> --dir ${options.dir}`,
      "  container  docker compose run --rm -T ukb ukb user add <name> --password-stdin",
      "  trusted LAN without accounts: --allow-anonymous (reads open, writes still need the token)",
      "",
      "This is a setup step, not a server error: create the account, then restart.",
    ].join("\n"),
  );
}
