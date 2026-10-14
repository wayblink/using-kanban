/**
 * Domain types for the kanban engine.
 *
 * The event log is the single source of truth: `cards` are a projection rebuilt
 * by replaying events. A card's id is the id of its `card.created` event.
 */

export const CARD_STATES = ["todo", "doing", "review", "done"] as const;
export type CardState = (typeof CARD_STATES)[number];

/**
 * How urgently a card wants attention, and — for `pending` — whether it wants
 * any at all right now.
 *
 * `low` and `pending` are different intents, not two spellings of the same
 * thing: `low` means minor but still wanted eventually, `pending` means
 * deliberately shelved until something outside the card changes. Collapsing
 * them would lose the distinction between "do this later" and "do not do this
 * yet", which is the one an operator acts on.
 *
 * The array is in sort order, so `CARD_PRIORITIES.indexOf(a) - indexOf(b)` is
 * the whole comparator.
 */
export const CARD_PRIORITIES = ["high", "normal", "low", "pending"] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];

/** The priority a card has when nothing says otherwise. */
export const DEFAULT_CARD_PRIORITY: CardPriority = "normal";

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
  "card.note_added",
  "card.note_updated",
  "card.note_removed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Which side of a relation the other card sits on.
 *
 * The relation itself is one edge stored once (`card.dependency_*`):
 * `upstream` means the other card is a predecessor this card waits on,
 * `downstream` means it is a successor waiting on this card. Both directions
 * are read back off every card, so a card is many cards' predecessor and many
 * cards' successor at the same time.
 */
export const RELATION_DIRECTIONS = ["upstream", "downstream"] as const;
export type RelationDirection = (typeof RELATION_DIRECTIONS)[number];

export interface Card {
  readonly id: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: CardState;
  /** Actor name this card is assigned to, or null. */
  readonly assignee: string | null;
  /** Actor name expected to review this card, or null. */
  readonly reviewer: string | null;
  /** Project slug this card belongs to, or null for "no project". */
  readonly project: string | null;
  /**
   * How urgently this card wants attention. `normal` unless set, including on
   * cards created before priorities existed — see `CardCreatedPayloadSchema`.
   */
  readonly priority: CardPriority;
  /**
   * Card ids this card is waiting on — its predecessors. Mirrored as `blocks`
   * on those cards, so the relation can be managed from either side.
   */
  readonly blockedBy: readonly number[];
  /** Card ids waiting on this card — its successors. */
  readonly blocks: readonly number[];
  /**
   * Free-form remarks, oldest first. The intended use is links to documents
   * (a design doc for the requirement, say) that a card cannot carry in its
   * body. A note's id is the id of the event that added it.
   */
  readonly notes: readonly CardNote[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Bumped on every mutation; used for optimistic concurrency. */
  readonly revision: number;
}

/** A remark attached to a card — text plus an optional document link. */
export interface CardNote {
  /** The id of the `card.note_added` event, so it is stable across replays. */
  readonly id: number;
  readonly text: string;
  /** A document link: http(s) URL, or a path to a local file. */
  readonly url: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface Board {
  readonly todo: readonly Card[];
  readonly doing: readonly Card[];
  readonly review: readonly Card[];
  readonly done: readonly Card[];
}

/**
 * One project's share of the board.
 *
 * `project` is `null` for cards that carry no slug. They are counted here
 * rather than dropped, because a card with no project is invisible to every
 * `--project` filter — an operator needs to see that bucket exists before they
 * wonder where the missing cards went.
 */
export interface ProjectSummary {
  readonly project: string | null;
  readonly todo: number;
  readonly doing: number;
  readonly review: number;
  readonly done: number;
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
