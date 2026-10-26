import type { Event, NewEvent } from "./types.js";

/**
 * Durable append-only event log. All front doors (CLI, MCP stdio, HTTP server)
 * share one log file, so appends must be atomic and ids must be unique across
 * processes — SQLite (WAL) gives that for free; JSONL is single-writer only.
 *
 * Two sequences live in here, and they are not the same one. An **event id** is
 * the log's own position: one per append, so a card that was edited ten times
 * occupies eleven. A **card id** counts cards. They used to be one sequence (a
 * card took the id of its `card.created` event), which meant ids grew with a
 * board's edit history — 446 cards on a busy board reached #2746, and the id is
 * the handle a human types (`ukb done 2743`). Each log therefore keeps its own
 * card counter, seeded above whatever card ids the events already carry so an
 * older board keeps going without collisions.
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
  private nextCardId = 1;

  append(rows: readonly NewEvent[]): Event[] {
    const stored: Event[] = [];
    for (const row of rows) {
      const id = this.nextId;
      this.nextId += 1;
      const cardId = row.cardId ?? this.nextCardId;
      // An explicit id (a row replayed from before the split) still reserves
      // its number, so the next allocation cannot land on it.
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
