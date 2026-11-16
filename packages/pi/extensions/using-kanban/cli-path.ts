/**
 * cli-path.ts — where the extension finds the `ukb` CLI.
 *
 * The extension cannot ask the board where its own CLI is: `ukb` *is* the
 * board's front door, and this code runs inside a host that only knows a
 * package path. So the path has to be derived from the one fact the module
 * carries — where it was loaded from — and that fact is not stable. A module
 * loaded out of `<repo>/packages/pi` derives `<repo>/packages/cli/dist/bin.js`,
 * which is right in a working checkout and silently fatal when the checkout is
 * a worktree that later gets deleted, or a repository that moves: the module
 * keeps its old location in memory, so every tool call and the whole panel
 * spawn a path that does not exist and never will.
 *
 * That is not hypothetical. A session loaded this extension from
 * `using-kanban-wt/remote/packages/pi`; the worktree was removed; the panel
 * reported `Cannot find module .../using-kanban-wt/remote/packages/cli/dist/bin.js`
 * until the session was restarted.
 *
 * So resolution is a search with a stated answer instead of a constant:
 *
 * 1. `UKB_BIN` — an explicit choice, honoured even when it is wrong, because a
 *    person who names a binary wants to hear that it is missing rather than
 *    silently get a different one.
 * 2. the checkout's own `packages/cli/dist/bin.js` — the normal case, and the
 *    only one that tests the code you are editing.
 * 3. a `ukb` on `PATH` — the installed CLI, which is what still works after the
 *    checkout that loaded this module is gone.
 *
 * Every outcome carries `note`, so the caller can say which binary it will run
 * and what it skipped. When nothing resolves, `bin` is still the canonical
 * path, so the message can name the file to build.
 *
 * Pure and Pi-free, like `guidance.ts` and `board-digest.ts`, so it is tested
 * from packages/cli without a Pi host.
 */

import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";

/** Which rule picked the binary. */
export type CliBinSource = "env" | "checkout" | "path" | "missing";

export interface CliBinResolution {
  /** The path to spawn. Canonical location when nothing was found. */
  readonly bin: string;
  readonly source: CliBinSource;
  /** Whether `bin` exists right now. */
  readonly ready: boolean;
  /** One line for a human: what was chosen, and what was skipped. */
  readonly note: string | null;
}

export interface ResolveCliBinOptions {
  /** The extension module's own directory (`dirname(fileURLToPath(import.meta.url))`). */
  readonly here: string;
  /** Defaults to `process.env`; tests pass their own. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to `process.env.PATH`; tests pass their own. */
  readonly searchPath?: string | undefined;
  /** Injected for tests; defaults to `existsSync`. */
  readonly exists?: (path: string) => boolean;
}

/** `<repo>/packages/pi/extensions/using-kanban` -> `<repo>/packages/cli/dist/bin.js`. */
export function checkoutCliPath(here: string): string {
  return resolve(here, "../../../cli/dist/bin.js");
}

/**
 * Find the CLI to run.
 *
 * `ready` is recomputed by the caller on each use rather than cached here: a
 * session that starts before `pnpm -r build` finishes should start working once
 * the build lands, instead of needing a restart.
 */
export function resolveCliBin(options: ResolveCliBinOptions): CliBinResolution {
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;
  const searchPath = options.searchPath ?? env.PATH ?? "";
  const checkout = checkoutCliPath(options.here);

  const explicit = env.UKB_BIN?.trim();
  if (explicit) {
    const ready = exists(explicit);
    return {
      bin: explicit,
      source: "env",
      ready,
      note: ready ? null : `UKB_BIN=${explicit} does not exist`,
    };
  }

  if (exists(checkout)) {
    return { bin: checkout, source: "checkout", ready: true, note: null };
  }

  const installed = findOnPath("ukb", searchPath);
  if (installed !== null) {
    return {
      bin: installed,
      source: "path",
      ready: true,
      note: `${checkout} is not built, so this uses the ukb on PATH`,
    };
  }

  return {
    bin: checkout,
    source: "missing",
    ready: false,
    note: `no ukb CLI: ${checkout} is not built and PATH has no ukb — run \`pnpm -r build\` in the using-kanban checkout, or set UKB_BIN`,
  };
}

/**
 * First `ukb` executable on `PATH`.
 *
 * Empty entries are skipped rather than treated as the current directory: a
 * trailing `:` is common in hand-written `PATH`s, and resolving a binary out of
 * whatever directory a session happens to sit in is the kind of thing that
 * works until it silently runs the wrong file.
 */
function findOnPath(name: string, searchPath: string): string | null {
  const names = process.platform === "win32" ? [`${name}.cmd`, name] : [name];
  for (const entry of searchPath.split(delimiter)) {
    if (entry.trim() === "") continue;
    for (const candidate of names) {
      const path = resolve(entry, candidate);
      if (existsSync(path)) return path;
    }
  }
  return null;
}
