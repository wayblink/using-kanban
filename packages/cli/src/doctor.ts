import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { openKanban } from "@wayblink/using-kanban-core";
import type { Io } from "./commands.js";
import { resolveActor } from "./identity.js";

/** `ukb doctor` — one screen that says whether this project is wired up. */
export async function runDoctor(
  flags: Record<string, string | true>,
  io: Io,
  dir: string,
  storage: "sqlite" | "jsonl" | "memory",
): Promise<number> {
  const checks: { ok: boolean; label: string; detail: string }[] = [];
  const actor = resolveActor(flags, io.env);

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
    const cards = countCards(dir, storage);
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
    label: "identity",
    detail: `${actor.type}/${actor.name} (override with --agent)`,
  });

  // 7. parent/child pairs that predate the rule. The engine refuses new ones,
  //    but the log is append-only — a board written earlier can still hold
  //    them, and only the owner can decide which end to move.
  const slanted = hierarchyViolations(dir, storage);
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

/**
 * `require.resolve` from this file. `import.meta.url` is undefined in the
 * bundled binary (esbuild), so fall back to the invoked script path.
 */
function resolveFromHere(specifier: string): string | undefined {
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

function countCards(
  dir: string,
  storage: "sqlite" | "jsonl" | "memory",
): number {
  try {
    const kanban = openKanban({ dir, storage });
    const count = kanban.cards().length;
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
function hierarchyViolations(
  dir: string,
  storage: "sqlite" | "jsonl" | "memory",
): string[] | null {
  try {
    const kanban = openKanban({ dir, storage });
    const found = kanban.hierarchyViolations().map((entry) => entry.reason);
    kanban.close();
    return found;
  } catch {
    return null;
  }
}
