import type { StorageKind } from "@using-kanban/core";

export interface ParsedArgv {
  /** The subcommand, or `null` when none was given (→ `mine`). */
  command: string | null;
  positionals: string[];
  flags: Record<string, string | true>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const BOOLEAN_FLAGS = new Set([
  "help",
  "h",
  "version",
  "v",
  "no-open",
  "dry-run",
  "yes",
  "force",
]);

/**
 * Minimal argv parser: `--flag value`, `--flag=value`, and boolean flags.
 * Kept dependency-free on purpose.
 */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  let command: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("-")) {
      if (command === null) command = token;
      else positionals.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const name = (equals === -1 ? token : token.slice(0, equals)).replace(
      /^--?/,
      "",
    );
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);

    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) {
      flags[name] = true;
      continue;
    }
    flags[name] = next;
    index += 1;
  }

  return { command, positionals, flags };
}

export function flagString(
  flags: Record<string, string | true>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBoolean(
  flags: Record<string, string | true>,
  name: string,
): boolean {
  return flags[name] === true;
}

/** Reads a repeatable flag (`--blocked-by 1 --blocked-by 2`). */
export function flagNumbers(
  flags: Record<string, string | true>,
  name: string,
): number[] {
  const value = flags[name];
  if (value === undefined) return [];
  const raw = typeof value === "string" ? [value] : [];
  const parsed = raw.map((entry) => Number(entry.trim()));
  for (const entry of parsed) {
    if (!Number.isInteger(entry) || entry <= 0) {
      throw new UsageError(`--${name} expects positive card ids`);
    }
  }
  return parsed;
}

export function resolveStorage(
  flags: Record<string, string | true>,
  env: NodeJS.ProcessEnv,
): StorageKind {
  const value = flagString(flags, "storage") ?? env.UKB_STORAGE ?? "sqlite";
  if (value !== "sqlite" && value !== "jsonl" && value !== "memory") {
    throw new UsageError(
      `--storage expects sqlite | jsonl | memory (got "${value}")`,
    );
  }
  return value;
}

export function resolveDir(
  flags: Record<string, string | true>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  return flagString(flags, "dir") ?? env.UKB_DIR ?? cwd;
}
