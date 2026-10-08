import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { JsonlEventLog } from "./event-log-jsonl.js";
import { MemoryEventLog } from "./event-log.js";
import { SqliteEventLog } from "./event-log-sqlite.js";
import { Kanban } from "./kanban.js";

export type StorageKind = "sqlite" | "jsonl" | "memory";

export interface OpenKanbanOptions {
  /** Defaults to `sqlite`. */
  readonly storage?: StorageKind | undefined;
  /** Board directory. Defaults to `process.cwd()`. */
  readonly dir?: string | undefined;
  /** Explicit log file (overrides `dir` + storage default name). */
  readonly path?: string | undefined;
}

const DEFAULT_FILE_NAMES: Record<Exclude<StorageKind, "memory">, string> = {
  sqlite: "board.db",
  jsonl: "events.jsonl",
};

/**
 * Opens a kanban backed by a per-project store at `<dir>/.kanban/`.
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
    : join(dir, ".kanban", DEFAULT_FILE_NAMES[storage]);
  mkdirSync(dirname(path), { recursive: true });

  const log =
    storage === "sqlite" ? new SqliteEventLog(path) : new JsonlEventLog(path);
  return new Kanban({ log });
}
