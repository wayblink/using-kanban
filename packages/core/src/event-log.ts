import type { Event, NewEvent } from "./types.js";
import { KanbanError } from "./errors.js";

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
export interface ImportEventsOptions {
  /** Allow a non-empty target; existing event ids win. */
  readonly force?: boolean | undefined;
}

export interface ImportSummary {
  readonly events: number;
  readonly maxEventId: number;
  readonly maxCardId: number;
}

export interface EventLog {
  /** Atomically appends events and returns them with assigned ids. */
  append(events: readonly NewEvent[]): Promise<Event[]>;
  /** All events with an id greater than `id` (ascending). */
  since(id: number): Promise<Event[]>;
  /** All events for one card (ascending). */
  byCard(cardId: number): Promise<Event[]>;
  maxId(): Promise<number>;
  /**
   * Copies events in with their existing ids (migration/import). The target
   * must be empty unless `force`; imported ids are never reassigned.
   */
  importEvents(
    events: readonly Event[],
    options?: ImportEventsOptions,
  ): Promise<ImportSummary>;
  close(): void;
}

/** Rejects imports that would not be a faithful, ordered replay. */
export function assertImportable(events: readonly Event[]): void {
  let previous = 0;
  for (const event of events) {
    if (!Number.isInteger(event.id) || event.id <= 0) {
      throw new KanbanError(
        "invalid_input",
        "event ids must be positive integers",
      );
    }
    if (event.id <= previous) {
      throw new KanbanError(
        "invalid_input",
        `event ids must be strictly ascending (${previous} then ${event.id})`,
      );
    }
    if (!Number.isInteger(event.cardId) || event.cardId <= 0) {
      throw new KanbanError(
        "invalid_input",
        `event ${event.id} has an invalid card id`,
      );
    }
    previous = event.id;
  }
}

export function importBlockedByTarget(size: number): void {
  throw new KanbanError(
    "conflict",
    `the target event log is not empty (${size} events) — use force to merge`,
  );
}

/** In-process log. Used by tests and ephemeral boards. */
export class MemoryEventLog implements EventLog {
  private readonly events: Event[] = [];
  private nextId = 1;
  private nextCardId = 1;

  async append(rows: readonly NewEvent[]): Promise<Event[]> {
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

  async since(id: number): Promise<Event[]> {
    return this.events.filter((event) => event.id > id);
  }

  async byCard(cardId: number): Promise<Event[]> {
    return this.events.filter((event) => event.cardId === cardId);
  }

  async maxId(): Promise<number> {
    return this.nextId - 1;
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
    this.events.length = 0;
    this.events.push(...[...byId.values()].sort((a, b) => a.id - b.id));
    this.nextId = Math.max(0, ...this.events.map((event) => event.id)) + 1;
    this.nextCardId =
      Math.max(0, ...this.events.map((event) => event.cardId)) + 1;
    return this.summary();
  }

  private summary(): ImportSummary {
    return {
      events: this.events.length,
      maxEventId: this.events.at(-1)?.id ?? 0,
      maxCardId: this.events.reduce(
        (max, event) => Math.max(max, event.cardId),
        0,
      ),
    };
  }

  close(): void {
    // nothing to release
  }
}
