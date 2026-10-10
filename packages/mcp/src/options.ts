import { homedir } from "node:os";
import { z } from "zod";
import type { ActorSchema, StorageKind } from "@wayblink/using-kanban-core";

export const McpOptionsSchema = z.object({
  /** Board directory — the store lives at `<dir>/.ukb/`. */
  dir: z.string().optional(),
  storage: z.enum(["sqlite", "jsonl", "memory"]).optional(),
  /** Actor name this server acts as (what `mine` and `claim` resolve to). */
  agent: z.string().min(1).optional(),
  agentType: z.enum(["human", "agent"]).optional(),
});
export type McpOptions = z.input<typeof McpOptionsSchema>;

export interface ResolvedMcpOptions {
  dir: string;
  storage: StorageKind;
  actor: z.infer<typeof ActorSchema>;
  /** True when no agent name was supplied and a generic default was used. */
  usedDefaultAgent: boolean;
}

const DEFAULT_AGENT_NAME = "agent";

/**
 * Resolution order: CLI flags → environment → defaults.
 *
 * `--agent claude-code` (or `UKB_AGENT=claude-code`) is what `ukb init --for`
 * writes into each framework's MCP config, so cards are attributed to the
 * right agent.
 */
export function resolveMcpOptions(
  argv: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMcpOptions {
  const parsed = McpOptionsSchema.parse(parseArgv(argv));

  const agent = parsed.agent ?? env.UKB_AGENT ?? DEFAULT_AGENT_NAME;
  // Centralised store: one board per machine, projects separated by the
  // `project` field on cards rather than by directory.
  const dir = parsed.dir ?? env.UKB_DIR ?? homedir();
  const storage = (parsed.storage ??
    env.UKB_STORAGE ??
    "sqlite") as StorageKind;
  const agentType = (parsed.agentType ??
    (env.UKB_AGENT_TYPE === "human" ? "human" : "agent")) as "human" | "agent";

  return {
    dir,
    storage,
    actor: { type: agentType, name: agent },
    usedDefaultAgent: parsed.agent === undefined && env.UKB_AGENT === undefined,
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
