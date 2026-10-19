/**
 * Domain types for the kanban engine.
 *
 * The event log is the single source of truth: `cards` are a projection rebuilt
 * by replaying events. A card's id is the id of its `card.created` event.
 */

/**
 * A card's column, in board order (left to right).
 *
 * `someday` is leftmost: the freezer, not a stage of the flow. It is the one
 * state that answers "is this in play at all" rather than "how far along is
 * it" — the question a priority cannot answer. See `docs/shelved-state.md`.
 */
export const CARD_STATES = [
  "someday",
  "todo",
  "doing",
  "review",
  "done",
] as const;
export type CardState = (typeof CARD_STATES)[number];

/**
 * What a state *means* to the board's rules, independent of its name: whether
 * a card is in play, parked, or finished.
 *
 * This is the single source of the "is it open / is it on the radar / does it
 * count as finished" decisions. The code that used to write `state !== "done"`
 * scattered across the board now asks a predicate instead, so adding a state
 * (or a second member of a kind, like a future `canceled`) is a change here and
 * nothing else.
 *
 * Deliberately **not** a field on `Card` or in any event: it is derived from
 * `state`, and a stored copy could disagree with the state it came from.
 */
type StateKind = "shelved" | "active" | "terminal";

const STATE_KIND: Record<CardState, StateKind> = {
  someday: "shelved",
  todo: "active",
  doing: "active",
  review: "active",
  done: "terminal",
};

/** Parked: deliberately not in play, but not finished. */
export function isShelved(state: CardState): boolean {
  return STATE_KIND[state] === "shelved";
}

/** Finished. `done` today; the kind exists so a future `canceled` slots in. */
export function isTerminal(state: CardState): boolean {
  return STATE_KIND[state] === "terminal";
}

/** Still owed: anything that is not finished. */
export function isOpen(state: CardState): boolean {
  return !isTerminal(state);
}

/**
 * In play: someone has the card in hand. `doing` and `review` are the two
 * states where work is actually happening; `todo` is owed but untouched and
 * `someday` is parked. Distinct from `onRadar`, which also counts `todo` —
 * "is this in the running" and "is this being worked on" are different
 * questions, and the parent/child contract is stated in terms of the second.
 */
export function isInPlay(state: CardState): boolean {
  return state === "doing" || state === "review";
}

/**
 * In play: what "what should I work on" may offer. Excludes the shelf because
 * a parked card is not a candidate, which is the whole point of the shelf.
 */
export function onRadar(state: CardState): boolean {
  return STATE_KIND[state] === "active";
}

/**
 * How urgently a card wants attention.
 *
 * A pure urgency order, high to low. "Not now" is deliberately **not** here:
 * urgency and "is this in play at all" are different questions, and answering
 * the second with a priority made parked cards keep a `todo` slot and stay
 * claimable. That answer is the `someday` state instead.
 *
 * The array is in sort order, so `CARD_PRIORITIES.indexOf(a) - indexOf(b)` is
 * the whole comparator.
 */
export const CARD_PRIORITIES = ["high", "normal", "low"] as const;
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
  "card.parent_set",
  "card.parent_cleared",
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
   * The card this one is a part of, or null for a top-level card. Mirrored as
   * a member of that card's `children`.
   *
   * Hierarchy is deliberately **one level**: a card with a parent cannot have
   * children, and a card with children cannot have a parent. An umbrella and
   * its direct children — no grandchildren. This is a *composition* relation,
   * distinct from `blockedBy`, which is about order. See `docs/parent-child.md`.
   */
  readonly parent: number | null;
  /** Cards this one is composed of. Empty for a leaf card. */
  readonly children: readonly number[];
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
  readonly someday: readonly Card[];
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
  readonly someday: number;
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
