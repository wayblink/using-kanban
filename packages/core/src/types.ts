/**
 * Domain types for the kanban engine.
 *
 * The event log is the single source of truth: `cards` are a projection rebuilt
 * by replaying events. A card's id is the id of its `card.created` event.
 */

export const CARD_STATES = ["todo", "doing", "review", "done"] as const;
export type CardState = (typeof CARD_STATES)[number];

export const ACTOR_TYPES = ["human", "agent"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * Who performed an action. `name` is a free-form label shared by humans and
 * agents (e.g. `jyxc`, `claude-code`) — it is what assignee/reviewer match on.
 */
export interface Actor {
  readonly type: ActorType;
  readonly name: string;
}

/** Which front door an action came through. */
export const EVENT_SOURCES = ["cli", "mcp", "api", "web", "system"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_TYPES = [
  "card.created",
  "card.updated",
  "card.moved",
  "card.deleted",
  "card.dependency_added",
  "card.dependency_removed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface Card {
  readonly id: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: CardState;
  /** Actor name this card is assigned to, or null. */
  readonly assignee: string | null;
  /** Actor name expected to review this card, or null. */
  readonly reviewer: string | null;
  /** Card ids this card is waiting on. */
  readonly blockedBy: readonly number[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Bumped on every mutation; used for optimistic concurrency. */
  readonly revision: number;
}

export interface Board {
  readonly todo: readonly Card[];
  readonly doing: readonly Card[];
  readonly review: readonly Card[];
  readonly done: readonly Card[];
}

export interface Event {
  readonly id: number;
  readonly ts: string;
  readonly actor: Actor;
  readonly source: EventSource;
  readonly type: EventType;
  readonly cardId: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** An event before the log assigns it an id. */
export interface NewEvent {
  readonly actor: Actor;
  readonly source: EventSource;
  readonly type: EventType;
  /**
   * Null for `card.created` — the log assigns the card id, which equals the
   * id of the creation event.
   */
  readonly cardId: number | null;
  readonly payload: Readonly<Record<string, unknown>>;
}
