import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { JsonlEventLog } from "./event-log-jsonl.js";
import { MemoryEventLog } from "./event-log.js";
import { SqliteEventLog } from "./event-log-sqlite.js";
import { KanbanError } from "./errors.js";
import { Kanban } from "./kanban.js";

export type StorageKind = "sqlite" | "jsonl" | "memory";

export interface OpenKanbanOptions {
  /** Defaults to `sqlite`. */
  readonly storage?: StorageKind | undefined;
  /** Board directory. Defaults to `process.cwd()`. */
  readonly dir?: string | undefined;
  /** Explicit log file (overrides `dir` + storage default name). */
  readonly path?: string | undefined;
  /**
   * Create the store when it does not exist yet. Defaults to `true`.
   *
   * Pass `false` for read-only operations. Without it, `ukb board` in a
   * directory that has no board silently creates an empty one and reports an
   * empty board — which reads as "there is no work here" rather than "you are
   * in the wrong place". That distinction matters most to an agent, which
   * cannot tell the two apart otherwise.
   */
  readonly create?: boolean | undefined;
}

/** Per-project store directory, created on first open. */
export const DEFAULT_STORAGE_DIR = ".ukb";

const DEFAULT_FILE_NAMES: Record<Exclude<StorageKind, "memory">, string> = {
  sqlite: "board.db",
  jsonl: "events.jsonl",
};

/**
 * Opens a kanban backed by a per-project store at `<dir>/.ukb/`.
 *
 * No daemon: every call opens the store directly, which is safe because the
 * event log (SQLite WAL) supports concurrent appends from several processes.
 */
export function openKanban(options: OpenKanbanOptions = {}): Kanban {
  const storage = options.storage ?? "sqlite";
  if (storage === "memory") {
    return new Kanban({ log: new MemoryEventLog() });
  }

  const dir = resolve(options.dir ?? process.cwd());
  const path = options.path
    ? resolve(options.path)
    : join(dir, DEFAULT_STORAGE_DIR, DEFAULT_FILE_NAMES[storage]);
  if (options.create === false && !existsSync(path)) {
    throw new KanbanError(
      "board_not_found",
      `no board in ${dir} — create one first (ukb add / kanban_add)`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });

  const log =
    storage === "sqlite" ? new SqliteEventLog(path) : new JsonlEventLog(path);
  return new Kanban({ log });
}
