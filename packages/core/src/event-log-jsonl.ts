import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { StoredEventSchema } from "./schemas.js";
import type { Event, NewEvent } from "./types.js";
import type { EventLog } from "./event-log.js";

/**
 * Append-only JSONL event log — zero native dependencies, human-readable, and
 * diff-friendly in git.
 *
 * Reads refresh from disk when the file changed underneath us, so separate
 * processes see each other's appends. Concurrent *appends* from multiple
 * processes are not safe (no file locking) — use the SQLite log for that.
 */
export class JsonlEventLog implements EventLog {
  private events: Event[] = [];
  private readonly filePath: string;
  private nextId = 1;
  private loadedSize = -1;
  private loadedMtimeMs = -1;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.refresh();
  }

  append(rows: readonly NewEvent[]): Event[] {
    const stored: Event[] = [];
    const lines: string[] = [];
    for (const row of rows) {
      const id = this.nextId;
      this.nextId += 1;
      const event: Event = {
        id,
        ts: new Date().toISOString(),
        actor: row.actor,
        source: row.source,
        type: row.type,
        cardId: row.cardId ?? id,
        payload: row.payload,
      };
      this.events.push(event);
      stored.push(event);
      lines.push(`${JSON.stringify(event)}\n`);
    }
    if (lines.length > 0) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, lines.join(""), "utf8");
      this.markLoaded();
    }
    return stored;
  }

  since(id: number): Event[] {
    this.refresh();
    return this.events.filter((event) => event.id > id);
  }

  byCard(cardId: number): Event[] {
    this.refresh();
    return this.events.filter((event) => event.cardId === cardId);
  }

  maxId(): number {
    this.refresh();
    return this.nextId - 1;
  }

  close(): void {
    // nothing to release
  }

  /** Reloads the file when another process appended to it. */
  private refresh(): void {
    if (!existsSync(this.filePath)) return;
    const stat = statSync(this.filePath);
    if (stat.size === this.loadedSize && stat.mtimeMs === this.loadedMtimeMs)
      return;

    const text = readFileSync(this.filePath, "utf8");
    const events: Event[] = [];
    let nextId = 1;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const event = StoredEventSchema.parse(JSON.parse(trimmed) as unknown);
      events.push(event);
      nextId = event.id + 1;
    }
    this.events = events;
    this.nextId = nextId;
    this.loadedSize = stat.size;
    this.loadedMtimeMs = stat.mtimeMs;
  }

  private markLoaded(): void {
    if (!existsSync(this.filePath)) return;
    const stat = statSync(this.filePath);
    this.loadedSize = stat.size;
    this.loadedMtimeMs = stat.mtimeMs;
  }
}
