import type { Actor } from "@using-kanban/core";
import { flagString } from "./argv.js";

/** Flags win, then env, then the OS user. */
export function resolveActor(
  flags: Record<string, string | true>,
  env: NodeJS.ProcessEnv,
): Actor {
  const name = flagString(flags, "agent") ?? env.UKB_AGENT ?? defaultName(env);
  const type = flagString(flags, "agent-type") ?? env.UKB_AGENT_TYPE ?? "human";
  if (type !== "human" && type !== "agent") {
    throw new Error(`--agent-type expects human | agent (got "${type}")`);
  }
  return { type, name };
}

function defaultName(env: NodeJS.ProcessEnv): string {
  return env.USER ?? env.USERNAME ?? env.LOGNAME ?? "someone";
}
