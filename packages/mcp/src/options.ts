import { homedir } from "node:os";
import { z } from "zod";
import type { ActorSchema, StorageKind } from "@wayblink/using-kanban-core";
import {
  resolveOwnerName,
  resolveTransport,
  type UkbConfig,
} from "@wayblink/using-kanban-config";

export const McpOptionsSchema = z.object({
  /** Board directory — the store lives at `<dir>/.ukb/`. */
  dir: z.string().optional(),
  storage: z.enum(["sqlite", "jsonl", "memory", "postgres"]).optional(),
  /** Actor name this server acts as (what `mine` and `claim` resolve to). */
  agent: z.string().min(1).optional(),
  agentType: z.enum(["human", "agent"]).optional(),
  /** Remote board server; when set, the local store is not opened. */
  server: z.string().min(1).optional(),
  /** Bearer token for that server. */
  token: z.string().min(1).optional(),
  /** Postgres DSN for `storage: "postgres"` (or UKB_PG_URL / DATABASE_URL). */
  pgUrl: z.string().min(1).optional(),
  /** Turn off the per-card creator/assignee guard (personal board). */
  openAccess: z.boolean().optional(),
  /** The single auth switch; false also implies openAccess. */
  auth: z.boolean().optional(),
});
export type McpOptions = z.input<typeof McpOptionsSchema>;

export interface ResolvedMcpOptions {
  dir: string;
  storage: StorageKind;
  actor: z.infer<typeof ActorSchema>;
  /** The machine's human name (`config.owner`), used for the permission guard. */
  owner: string;
  /** True when no agent name was supplied and a generic default was used. */
  usedDefaultAgent: boolean;
  /** Remote origin, or null for the local store. */
  server: string | null;
  /** Token for that origin, when one was resolved. */
  token: string | null;
  /** Postgres DSN for the local `storage: postgres` mode. */
  postgresUrl: string | undefined;
  /** Disable the per-card permission guard (personal board). */
  openAccess: boolean;
  /** The one authentication switch, when explicitly configured. */
  auth: boolean | undefined;
}

const DEFAULT_AGENT_NAME = "agent";

/**
 * Resolution order: CLI flags → environment → the shared config file → a
 * default.
 *
 * `--agent claude-code` (or `UKB_AGENT=claude-code`) is what `ukb init --for`
 * writes into each framework's MCP config, so cards are attributed to the
 * right agent; `agent` in `~/.config/ukb/config.json` covers the frameworks
 * nobody wired up. The owner comes from the same file, so an MCP server and a
 * browser on this machine agree on who the human is.
 */
export function resolveMcpOptions(
  argv: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  config: UkbConfig = {},
): ResolvedMcpOptions {
  const parsed = McpOptionsSchema.parse(parseArgv(argv));

  const agent =
    parsed.agent ?? env.UKB_AGENT ?? config.agent ?? DEFAULT_AGENT_NAME;
  // Centralised store: one board per machine, projects separated by the
  // `project` field on cards rather than by directory.
  const dir = parsed.dir ?? env.UKB_DIR ?? homedir();
  const storage = (parsed.storage ??
    env.UKB_STORAGE ??
    "sqlite") as StorageKind;
  const agentType = (parsed.agentType ??
    (env.UKB_AGENT_TYPE === "human" ? "human" : "agent")) as "human" | "agent";

  const transport = resolveTransport({
    ...(parsed.server === undefined ? {} : { server: parsed.server }),
    ...(parsed.token === undefined ? {} : { token: parsed.token }),
    env,
    config,
  });

  return {
    dir,
    storage,
    actor: { type: agentType, name: agent },
    owner: resolveOwnerName({ env, config }),
    server: transport.server,
    token: transport.token,
    postgresUrl:
      parsed.pgUrl ?? env.UKB_PG_URL ?? env.DATABASE_URL ?? undefined,
    auth:
      parsed.auth ??
      (env.UKB_AUTH === undefined
        ? config.auth
        : /^(on|1|true|yes)$/iu.test(env.UKB_AUTH)),
    openAccess:
      (parsed.auth ??
        (env.UKB_AUTH === undefined
          ? config.auth
          : /^(on|1|true|yes)$/iu.test(env.UKB_AUTH))) === false ||
      parsed.openAccess === true ||
      (env.UKB_OPEN_ACCESS !== undefined
        ? /^(1|true|yes)$/iu.test(env.UKB_OPEN_ACCESS)
        : config.openAccess === true),
    usedDefaultAgent:
      parsed.agent === undefined &&
      env.UKB_AGENT === undefined &&
      config.agent === undefined,
  };
}

function parseArgv(argv: readonly string[]): McpOptions {
  const options: Record<string, unknown> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    // Support both `--flag value` and `--flag=value`.
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1);
    const next = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${name} needs a value`);
      index += 1;
      return value;
    };
    switch (name) {
      case "--dir":
        options.dir = next();
        break;
      case "--storage":
        options.storage = next();
        break;
      case "--agent":
        options.agent = next();
        break;
      case "--agent-type":
        options.agentType = next();
        break;
      case "--server":
        options.server = next();
        break;
      case "--token":
        options.token = next();
        break;
      case "--pg-url":
        options.pgUrl = next();
        break;
      case "--open-access":
        options.openAccess = true;
        break;
      case "--auth": {
        const value = next().trim().toLowerCase();
        options.auth = ["on", "1", "true", "yes"].includes(value);
        break;
      }
      case "--help":
      case "-h":
        throw new Error(
          [
            "ukb-mcp — MCP stdio server for using-kanban",
            "",
            "  --dir <path>       board directory (store lives at <dir>/.ukb/)",
            "  --storage <kind>   sqlite (default) | jsonl | memory",
            "  --agent <name>     actor name for this server (e.g. claude-code)",
            "  --agent-type <t>   agent (default) | human",
            "",
            "Env equivalents: UKB_DIR, UKB_STORAGE, UKB_AGENT, UKB_AGENT_TYPE",
          ].join("\n"),
        );
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options as McpOptions;
}
