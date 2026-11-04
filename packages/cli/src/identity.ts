import type { Actor } from "@wayblink/using-kanban-core";
import {
  resolveOwnerName,
  type UkbConfig,
} from "@wayblink/using-kanban-config";
import { flagString } from "./argv.js";

/**
 * Who this command runs as.
 *
 * Precedence: `--agent` → `UKB_AGENT` → (for an agent) `agent` in the config
 * file → the machine's owner. The owner is the CLI's human identity, so a
 * terminal and a browser on one machine agree on who they are — the loose end
 * that used to make one person appear as `$USER` in one place and as something
 * else in another.
 */
export function resolveActor(
  flags: Record<string, string | true>,
  env: NodeJS.ProcessEnv,
  config: UkbConfig = {},
): Actor {
  const type = flagString(flags, "agent-type") ?? env.UKB_AGENT_TYPE ?? "human";
  if (type !== "human" && type !== "agent") {
    throw new Error(`--agent-type expects human | agent (got "${type}")`);
  }

  const name =
    flagString(flags, "agent") ??
    env.UKB_AGENT ??
    (type === "agent" ? config.agent : undefined) ??
    resolveOwnerName({ env, config });

  return { type, name };
}

/** The machine's human name, resolved the same way in every CLI verb. */
export function resolveOwner(
  env: NodeJS.ProcessEnv,
  config: UkbConfig = {},
): string {
  return resolveOwnerName({ env, config });
}
