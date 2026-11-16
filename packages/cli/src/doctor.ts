import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { openKanban } from "@wayblink/using-kanban-core";
import {
  loadConfig,
  resolveConfigPath,
  resolveOwnerName,
} from "@wayblink/using-kanban-config";
import type { Io } from "./commands.js";
import { resolveActor } from "./identity.js";

/** `ukb doctor` — one screen that says whether this project is wired up. */
export async function runDoctor(
  flags: Record<string, string | true>,
  io: Io,
  dir: string,
  storage: "sqlite" | "jsonl" | "memory" | "postgres",
  postgresUrl?: string | undefined,
  home: string = homedir(),
): Promise<number> {
  const checks: { ok: boolean; label: string; detail: string }[] = [];
  // One config file, four front doors. Doctor is where a reader finds out which
  // file that is and which name it resolves to, because "who am I" being wrong
  // looks exactly like a permissions bug from the outside.
  const config = loadConfig(io.env);
  const configPath = resolveConfigPath(io.env);
  const owner = resolveOwnerName({ env: io.env, config });
  const actor = resolveActor(flags, io.env, config);

  // 1. node version
  const major = Number(process.versions.node.split(".")[0] ?? 0);
  checks.push({
    ok: major >= 20,
    label: "node",
    detail: `${process.versions.node}${major >= 20 ? "" : " (need >= 20)"}`,
  });

  // 2. store directory
  const storeDir = join(dir, ".ukb");
  try {
    mkdirSync(storeDir, { recursive: true });
    accessSync(storeDir, constants.W_OK);
    const cards = await countCards(dir, storage, postgresUrl);
    checks.push({
      ok: true,
      label: "store",
      detail: `${storeDir} (${storage}, ${cards} cards)`,
    });
  } catch (error) {
    checks.push({
      ok: false,
      label: "store",
      detail: `${storeDir} is not writable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // 3. sqlite driver (only relevant for the default storage)
  if (storage === "sqlite") {
    try {
      const { SqliteEventLog } = await import("@wayblink/using-kanban-core");
      const log = new SqliteEventLog(join(storeDir, ".doctor-probe.db"));
      log.close();
      checks.push({
        ok: true,
        label: "sqlite",
        detail: "better-sqlite3 loaded",
      });
    } catch (error) {
      checks.push({
        ok: false,
        label: "sqlite",
        detail: `better-sqlite3 unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // 4. mcp server package
  try {
    resolveFromHere("@wayblink/using-kanban-mcp/package.json");
    checks.push({
      ok: true,
      label: "mcp server",
      detail: "@wayblink/using-kanban-mcp resolvable",
    });
  } catch {
    checks.push({
      ok: false,
      label: "mcp server",
      detail:
        "not installed — agents cannot connect (pnpm add -D @wayblink/using-kanban-mcp)",
    });
  }

  // 5. default web ui
  try {
    resolveFromHere("@wayblink/using-kanban-web/dist/index.html");
    checks.push({
      ok: true,
      label: "web ui",
      detail: "default UI resolvable (ukb web)",
    });
  } catch {
    checks.push({
      ok: false,
      label: "web ui",
      detail:
        "not installed — ukb web runs API-only (pnpm add -D @wayblink/using-kanban-web)",
    });
  }

  // 6. framework wiring in this project
  const wired = [
    existsSync(join(dir, ".mcp.json")) ? "claude-code (.mcp.json)" : null,
    existsSync(join(dir, "opencode.json")) ? "opencode (opencode.json)" : null,
    existsSync(join(dir, "AGENTS.md")) ? "AGENTS.md" : null,
    existsSync(join(dir, "CLAUDE.md")) ? "CLAUDE.md" : null,
  ].filter((entry): entry is string => entry !== null);
  checks.push({
    ok: wired.length > 0,
    label: "frameworks",
    detail:
      wired.length > 0
        ? wired.join(", ")
        : "none — run: ukb init --for <framework>",
  });

  checks.push({
    ok: true,
    label: "config",
    detail: `${configPath} (${
      existsSync(configPath) ? "found" : "absent — every default applies"
    })`,
  });
  // 7. the Pi front door. Unlike every other harness, Pi is wired through a
  //    package path in ~/.pi/agent/settings.json, and a path that moved or was
  //    never written produces no error at all: no tool, no guidance, no board.
  //    That silence is the whole reason this check exists.
  const pi = checkPiPackage(home);
  checks.push({ ok: pi.ok, label: "pi", detail: pi.detail });

  checks.push({
    ok: true,
    label: "owner",
    detail: `${owner}${config.owner ? " (from config)" : " (machine name)"}`,
  });

  checks.push({
    ok: true,
    label: "identity",
    detail: `${actor.type}/${actor.name} (override with --agent)`,
  });

  // 7. parent/child pairs that predate the rule. The engine refuses new ones,
  //    but the log is append-only — a board written earlier can still hold
  //    them, and only the owner can decide which end to move.
  const slanted = await hierarchyViolations(dir, storage, postgresUrl);
  if (slanted) {
    checks.push({
      ok: slanted.length === 0,
      label: "hierarchy",
      detail:
        slanted.length === 0
          ? "parent and child states agree"
          : `${slanted.length} pair(s) out of step — ${slanted
              .slice(0, 3)
              .join("; ")}${slanted.length > 3 ? "; …" : ""}`,
    });
  }

  let failures = 0;
  for (const check of checks) {
    io.stdout(
      `${check.ok ? "✓" : "✗"} ${check.label.padEnd(11)} ${check.detail}`,
    );
    if (!check.ok) failures += 1;
  }
  io.stdout("");
  io.stdout(
    failures === 0
      ? "everything looks good."
      : `${failures} problem(s) to fix.`,
  );
  return failures === 0 ? 0 : 1;
}

/** The package Pi loads for the board: one extension and one skill. */
const PI_PACKAGE_NAME = "@wayblink/using-kanban-pi";

/**
 * Whether Pi can actually reach the board from this machine.
 *
 * Pi reads its extensions from the `packages` array in
 * `~/.pi/agent/settings.json`; `ukb init --for pi` adds one entry, an absolute
 * path to `packages/pi` in a checkout. Nothing re-validates that entry later, so
 * a repository that moved, or a settings file written by hand with a typo, is
 * indistinguishable from a working install until somebody notices the agent
 * stopped touching the board.
 *
 * Three outcomes are worth telling apart:
 *
 * - no settings file: Pi has never run here, so there is nothing to wire and
 *   nothing to complain about;
 * - settings without the package: the install step was skipped;
 * - settings naming a path that is not there: the install worked once and the
 *   checkout moved, which is the silent failure.
 */
export function checkPiPackage(home: string): {
  ok: boolean;
  detail: string;
} {
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  if (!existsSync(settingsPath)) {
    return {
      ok: true,
      detail: `no ${settingsPath} — Pi never ran here, nothing to wire`,
    };
  }

  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    return {
      ok: false,
      detail: `${settingsPath} is not valid JSON — fix it and re-run`,
    };
  }

  const entries = Array.isArray(settings.packages)
    ? settings.packages.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];

  // The published spelling. Nothing writes it yet — the npm release is still
  // ahead — but a reader who installed it by hand should not be told off.
  if (entries.some((entry) => entry.startsWith(`npm:${PI_PACKAGE_NAME}`))) {
    return { ok: true, detail: `npm:${PI_PACKAGE_NAME} (registered)` };
  }

  // Relative entries resolve against the settings file's own directory, which
  // is how Pi resolves them.
  const agentDir = dirname(settingsPath);
  const paths = entries
    .filter((entry) => !entry.startsWith("npm:"))
    .map((entry) => resolve(agentDir, entry));

  if (paths.length === 0) {
    return {
      ok: false,
      detail: `no package registered in ${settingsPath} — run: ukb init --for pi`,
    };
  }

  for (const path of paths) {
    const manifest = join(path, "package.json");
    if (!existsSync(manifest)) continue;
    let name: unknown;
    let extensionPaths: string[] = [];
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: unknown;
        pi?: { extensions?: unknown };
      };
      name = parsed.name;
      const declared = parsed.pi?.extensions;
      if (Array.isArray(declared)) {
        extensionPaths = declared.filter(
          (entry): entry is string => typeof entry === "string",
        );
      }
    } catch {
      continue;
    }
    if (name !== PI_PACKAGE_NAME) continue;
    const missing = extensionPaths.filter(
      (entry) => !existsSync(resolve(path, entry)),
    );
    if (missing.length > 0) {
      return {
        ok: false,
        detail: `${path} is registered but ${missing.join(", ")} is missing — rebuild or re-run: ukb init --for pi`,
      };
    }
    return { ok: true, detail: `${path} (registered, ukb tool in context)` };
  }

  const onDisk = paths.some((path) => existsSync(join(path, "package.json")));
  return {
    ok: false,
    detail: onDisk
      ? `no ${PI_PACKAGE_NAME} among the registered packages — run: ukb init --for pi`
      : `${paths.join(", ")} is in settings.json but not on disk — re-run: ukb init --for pi`,
  };
}

/**
 * `require.resolve` from this file. `import.meta.url` is undefined in the
 * bundled binary (esbuild), so fall back to the invoked script path.
 */ function resolveFromHere(specifier: string): string | undefined {
  const url = hereUrl();
  if (!url) return undefined;
  return createRequire(url).resolve(specifier);
}

function hereUrl(): string | undefined {
  if (
    typeof import.meta.url === "string" &&
    import.meta.url.startsWith("file:")
  ) {
    return import.meta.url;
  }
  const entry = process.argv[1];
  return entry ? pathToFileURL(resolve(entry)).href : undefined;
}

async function countCards(
  dir: string,
  storage: "sqlite" | "jsonl" | "memory" | "postgres",
  postgresUrl?: string | undefined,
): Promise<number> {
  try {
    const kanban = openKanban({ dir, storage, postgresUrl });
    const count = (await kanban.cards()).length;
    kanban.close();
    return count;
  } catch {
    return -1;
  }
}

/**
 * One line per out-of-step pair, or `null` when the board cannot be read (the
 * store check already reported that — no point reporting it twice).
 */
async function hierarchyViolations(
  dir: string,
  storage: "sqlite" | "jsonl" | "memory" | "postgres",
  postgresUrl?: string | undefined,
): Promise<string[] | null> {
  try {
    const kanban = openKanban({ dir, storage, postgresUrl });
    const found = (await kanban.hierarchyViolations()).map(
      (entry) => entry.reason,
    );
    kanban.close();
    return found;
  } catch {
    return null;
  }
}
