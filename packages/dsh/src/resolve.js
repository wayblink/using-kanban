/**
 * resolve.js — which interpreter runs the `ukb` CLI.
 *
 * The Pi extension hardcoded `<repo>/packages/cli/dist/bin.js` and ran it with
 * `process.execPath`. In DSH that executable is Electron, and its embedded Node
 * cannot load native addons built for the system Node (observed: better-sqlite3
 * "compiled against a different Node.js version"). So the checkout's CLI is run
 * with a *real* Node found on this machine, and the Electron fallback is last.
 *
 * Order, most explicit first:
 *
 * 1. `ukb_path` / `$UKB_BIN` — an explicit path always wins.
 * 2. This checkout's CLI, run by the first usable `node`: `$UKB_NODE`, a PATH
 *    entry, the usual Homebrew locations, the DSH bundled runtime Node.
 * 3. `ukb` on PATH (its shebang resolves `node` through the host's own PATH).
 * 4. `ukb` in the usual install locations.
 * 5. The Electron executable as Node — last because of the ABI problem above.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(here, "..", "..", "..");

/** @param {string} path */
function expandHome(path) {
  return path.replace(/^~(?=$|\/)/, homedir());
}

/**
 * @typedef {object} UkbCommand
 * @property {string} command executable
 * @property {string[]} prefix arguments before the ukb argv
 * @property {Record<string, string>} [env] extra environment
 * @property {string} source human-readable description of where it came from
 */

/**
 * The first usable Node interpreter, or null.
 * @returns {string | null}
 */
export function resolveNode() {
  const configured = process.env.UKB_NODE?.trim();
  if (configured !== undefined && configured !== "") {
    const path = expandHome(configured);
    if (existsSync(path)) return path;
  }

  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "node");
    if (existsSync(candidate)) return candidate;
  }

  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node", join(homedir(), ".local", "bin", "node")]) {
    if (existsSync(candidate)) return candidate;
  }

  // The runtime shipped beside the DSH executable, when it is the desktop app.
  const bundled = resolve(process.execPath, "..", "..", "Resources", "runtime", "primary-runtime", "dependencies", "node", "bin", "node");
  if (existsSync(bundled)) return bundled;

  return null;
}

/**
 * @param {string | undefined} explicit
 * @returns {UkbCommand | null}
 */
export function resolveUkb(explicit) {
  const configured = explicit?.trim() || process.env.UKB_BIN?.trim();
  if (configured !== undefined && configured !== "") {
    const path = expandHome(configured);
    if (existsSync(path)) return { command: path, prefix: [], source: `configured: ${path}` };
  }

  const local = join(SKILL_ROOT, "packages", "cli", "dist", "bin.js");
  if (existsSync(local)) {
    const node = resolveNode();
    if (node !== null) {
      return {
        command: node,
        prefix: [local],
        source: `checkout: ${local} (node: ${node})`,
      };
    }
  }

  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "ukb");
    if (existsSync(candidate)) return { command: candidate, prefix: [], source: `PATH: ${candidate}` };
  }

  const home = homedir();
  for (const candidate of [
    "/opt/homebrew/bin/ukb",
    "/usr/local/bin/ukb",
    join(home, ".local", "bin", "ukb"),
  ]) {
    if (existsSync(candidate)) return { command: candidate, prefix: [], source: `installed: ${candidate}` };
  }

  if (existsSync(local)) {
    // Documented last resort: Electron's embedded Node, which cannot load a
    // native addon built for the system Node. It still works for a store-free
    // command, and the failure names the real cause.
    return {
      command: process.execPath,
      prefix: [local],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      source: `checkout via Electron Node: ${local} (native addons may not load)`,
    };
  }

  return null;
}
