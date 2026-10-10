import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
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
  /**
   * Where the store lives: `<dir>/.ukb/`. Defaults to the home directory, so
   * every project on the machine shares ONE board and separates its work with
   * the `project` field instead. Pass a directory (or `path`) to use a
   * different store.
   */
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

  const dir = resolve(options.dir ?? homedir());
  const path = options.path
    ? resolve(options.path)
    : join(dir, DEFAULT_STORAGE_DIR, DEFAULT_FILE_NAMES[storage]);
  if (options.create === false && !existsSync(path)) {
    // Wording matters here, and both halves of it are measured rather than
    // guessed:
    //
    // 1. An agent that gets a bare "not found" concludes the tool is
    //    unavailable here and moves on — it abandoned the board and explored
    //    the filesystem instead. So say that adding a card is what creates the
    //    board, and that there is no setup step.
    // 2. Worse, "this project has none yet" invites the agent to go find the
    //    project that *does* have one. It duly hunted the filesystem, found
    //    another project's .ukb/ and read it with raw sqlite3, bypassing the
    //    API entirely. So say explicitly that each directory has its own board
    //    and that hunting is wrong.
    throw new KanbanError(
      "board_not_found",
      `no board in ${dir} — this directory has no board yet. ` +
        `Add the first card (ukb add / kanban_add) and one is created here; ` +
        `there is no setup step. Every directory has its own board, so do not ` +
        `go looking for another project's.`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });

  const log =
    storage === "sqlite" ? new SqliteEventLog(path) : new JsonlEventLog(path);
  return new Kanban({ log });
}
