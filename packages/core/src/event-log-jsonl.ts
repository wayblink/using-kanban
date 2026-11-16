import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { StoredEventSchema } from "./schemas.js";
import type { Event, NewEvent } from "./types.js";
import {
  assertImportable,
  importBlockedByTarget,
  type EventLog,
  type ImportEventsOptions,
  type ImportSummary,
} from "./event-log.js";

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
  /** Next card id to hand out. Counts cards, not events — see `EventLog`. */
  private nextCardId = 1;
  private loadedSize = -1;
  private loadedMtimeMs = -1;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.refresh();
  }

  async append(rows: readonly NewEvent[]): Promise<Event[]> {
    const stored: Event[] = [];
    const lines: string[] = [];
    for (const row of rows) {
      const id = this.nextId;
      this.nextId += 1;
      const cardId = row.cardId ?? this.nextCardId;
      this.nextCardId = Math.max(this.nextCardId, cardId + 1);
      const event: Event = {
        id,
        ts: new Date().toISOString(),
        actor: row.actor,
        source: row.source,
        type: row.type,
        cardId,
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

  async since(id: number): Promise<Event[]> {
    this.refresh();
    return this.events.filter((event) => event.id > id);
  }

  async byCard(cardId: number): Promise<Event[]> {
    this.refresh();
    return this.events.filter((event) => event.cardId === cardId);
  }

  async importEvents(
    events: readonly Event[],
    options: ImportEventsOptions = {},
  ): Promise<ImportSummary> {
    assertImportable(events);
    if (this.events.length > 0 && options.force !== true) {
      importBlockedByTarget(this.events.length);
    }
    const byId = new Map(this.events.map((event) => [event.id, event]));
    for (const event of events) byId.set(event.id, event);
    const merged = [...byId.values()].sort((a, b) => a.id - b.id);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(
      this.filePath,
      merged.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    this.events = merged;
    this.nextId = (merged.at(-1)?.id ?? 0) + 1;
    this.nextCardId =
      merged.reduce((max, event) => Math.max(max, event.cardId), 0) + 1;
    return {
      events: merged.length,
      maxEventId: merged.at(-1)?.id ?? 0,
      maxCardId: merged.reduce((max, event) => Math.max(max, event.cardId), 0),
    };
  }

  async maxId(): Promise<number> {
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
    let nextCardId = 1;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const event = StoredEventSchema.parse(JSON.parse(trimmed) as unknown);
      events.push(event);
      nextId = event.id + 1;
      // The file is the whole truth about card ids too: a board written before
      // the split carries ids from the event sequence, and new cards must
      // continue above them.
      nextCardId = Math.max(nextCardId, event.cardId + 1);
    }
    this.events = events;
    this.nextId = nextId;
    this.nextCardId = nextCardId;
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
