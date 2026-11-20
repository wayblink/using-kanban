/**
 * config.js — the parts of `~/.config/ukb/config.json` the bundle reads itself.
 *
 * The bundle never reimplements the CLI, so the file it reads here is only the
 * context a browser half cannot get on its own: who the board belongs to (the
 * panel's "Mine" filter) and whether the CLI is pointed at a remote board (the
 * Full board button then opens that server instead of starting a local one).
 * Everything that changes the board stays a CLI call.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `<XDG_CONFIG_HOME or ~/.config>/ukb/config.json` — the same file the CLI,
 * the MCP server, `ukb web` and the Pi panel read.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function ukbConfigPath(env = process.env) {
  const base =
    env.XDG_CONFIG_HOME?.trim() ||
    join(env.HOME?.trim() || homedir(), ".config");
  return join(base, "ukb", "config.json");
}

/**
 * The parsed config, or `{}` when the file is missing or unreadable. A broken
 * config must not break the panel: the CLI reports its own problems with it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ owner?: string, server?: string } & Record<string, unknown>}
 */
export function readUkbConfig(env = process.env) {
  try {
    const raw = JSON.parse(readFileSync(ukbConfigPath(env), "utf8"));
    return raw !== null && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}
