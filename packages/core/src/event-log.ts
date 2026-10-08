import type { Event, NewEvent } from "./types.js";

/**
 * Durable append-only event log. All front doors (CLI, MCP stdio, HTTP server)
 * share one log file, so appends must be atomic and ids must be unique across
 * processes — SQLite (WAL) gives that for free; JSONL is single-writer only.
 */
export interface EventLog {
  /** Atomically appends events and returns them with assigned ids. */
  append(events: readonly NewEvent[]): Event[];
  /** All events with an id greater than `id` (ascending). */
  since(id: number): Event[];
  /** All events for one card (ascending). */
  byCard(cardId: number): Event[];
  maxId(): number;
  close(): void;
}

/** In-process log. Used by tests and ephemeral boards. */
export class MemoryEventLog implements EventLog {
  private readonly events: Event[] = [];
  private nextId = 1;

  append(rows: readonly NewEvent[]): Event[] {
    const stored: Event[] = [];
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
    }
    return stored;
  }

  since(id: number): Event[] {
    return this.events.filter((event) => event.id > id);
  }

  byCard(cardId: number): Event[] {
    return this.events.filter((event) => event.cardId === cardId);
  }

  maxId(): number {
    return this.nextId - 1;
  }

  close(): void {
    // nothing to release
  }
}
