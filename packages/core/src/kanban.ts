import type { z } from "zod";
import { KanbanError } from "./errors.js";
import type { EventLog } from "./event-log.js";
import { Projection } from "./projection.js";
import {
  AddCardInputSchema,
  CardStateSchema,
  EditCardInputSchema,
  MutationOptionsSchema,
} from "./schemas.js";
import type {
  AddCardInput,
  EditCardInput,
  MutationOptions,
} from "./schemas.js";
import type {
  Actor,
  Board,
  Card,
  CardState,
  Event,
  EventSource,
  NewEvent,
} from "./types.js";

export interface MutationResult {
  readonly card: Card;
  /** Events appended by this mutation — front doors broadcast these (SSE). */
  readonly events: readonly Event[];
}

export interface KanbanOptions {
  readonly log: EventLog;
}

/**
 * The kanban service: validates intent, appends events, applies them to the
 * in-memory projection. Every public method syncs from the log first, so a
 * long-lived process (MCP server, HTTP server) always sees writes made by
 * other processes.
 *
 * Permissions are cooperative, not cryptographic: actions carry an actor name
 * and `delete` is creator-only, `edit`/`block` are creator-or-assignee.
 */
export class Kanban {
  private readonly projection = new Projection();

  constructor(private readonly options: KanbanOptions) {}

  private get log(): EventLog {
    return this.options.log;
  }

  /* ------------------------------ queries ------------------------------ */

  /** The whole board, or just one project's slice of it. */
  board(project?: string | null): Board {
    this.projection.sync(this.log);
    const { todo, doing, review, done } = this.projection.board(project);
    return { todo, doing, review, done };
  }

  cards(): Card[] {
    this.projection.sync(this.log);
    return this.projection.all();
  }

  card(id: number): Card | null {
    this.projection.sync(this.log);
    return this.projection.card(id) ?? null;
  }

  /** Full event history for one card, oldest first. */
  history(id: number): Event[] {
    return this.log.byCard(id);
  }

  /** Every event in the log — used for SSE replay on connect. */
  events(): Event[] {
    return this.log.since(0);
  }

  /** Events appended after `id` — used to tail the log for SSE. */
  eventsSince(id: number): Event[] {
    return this.log.since(id);
  }

  /** Open cards assigned to `assignee` — the "what should I work on" call. */
  mine(assignee: string, project?: string | null): Card[] {
    this.projection.sync(this.log);
    return this.projection.openFor(assignee, project);
  }

  /** Cards waiting for `reviewer` to review. */
  reviewQueue(reviewer: string, project?: string | null): Card[] {
    this.projection.sync(this.log);
    return this.projection.reviewQueueFor(reviewer, project);
  }

  /** Every distinct project in use, sorted — drives filter dropdowns. */
  projects(): string[] {
    this.projection.sync(this.log);
    const names = new Set<string>();
    for (const card of this.projection.all()) {
      if (card.project) names.add(card.project);
    }
    return [...names].sort();
  }

  /* ----------------------------- mutations ----------------------------- */

  add(
    input: AddCardInput,
    actor: Actor,
    source: EventSource = "cli",
  ): MutationResult {
    const parsed = this.parseInput(AddCardInputSchema, input);
    this.projection.sync(this.log);
    for (const blockerId of parsed.blockedBy ?? []) {
      this.mustCard(blockerId);
    }
    return this.emit({
      actor,
      source,
      type: "card.created",
      cardId: null,
      payload: {
        title: parsed.title,
        body: parsed.body ?? null,
        assignee: parsed.assignee ?? null,
        reviewer: parsed.reviewer ?? null,
        project: parsed.project?.trim() || null,
        blockedBy: parsed.blockedBy ?? [],
        createdBy: actor.name,
      },
    });
  }

  edit(
    id: number,
    input: EditCardInput,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): MutationResult {
    const parsed = this.parseInput(EditCardInputSchema, input);
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    this.checkRevision(card, options);
    this.assertCanModify(card, actor);

    const patch: Record<string, string | null> = {};
    if (parsed.title !== undefined) patch.title = parsed.title;
    if (parsed.body !== undefined) patch.body = parsed.body;
    if (parsed.assignee !== undefined)
      patch.assignee = parsed.assignee?.trim() || null;
    if (parsed.reviewer !== undefined)
      patch.reviewer = parsed.reviewer?.trim() || null;
    if (parsed.project !== undefined)
      patch.project = parsed.project?.trim() || null;
    if (Object.keys(patch).length === 0) {
      return { card, events: [] };
    }

    return this.emit({
      actor,
      source,
      type: "card.updated",
      cardId: id,
      payload: { patch },
    });
  }

  /** Start working a todo card: moves it to `doing` and assigns it to the actor. */
  claim(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): MutationResult {
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    this.checkRevision(card, options);
    if (card.state === "done") {
      throw new KanbanError(
        "invalid_state",
        `card ${id} is done and cannot be claimed`,
      );
    }
    if (card.state === "doing") {
      if (card.assignee === actor.name) return { card, events: [] };
      throw new KanbanError(
        "claim_conflict",
        `card ${id} is already being worked by ${card.assignee ?? "someone else"}`,
      );
    }
    if (card.state === "review") {
      throw new KanbanError(
        "claim_conflict",
        `card ${id} is in review and cannot be claimed`,
      );
    }
    return this.transition(id, "doing", "claim", actor, source, {
      assignee: actor.name,
    });
  }

  /** Hand a card to its reviewer: moves it to `review`. */
  review(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): MutationResult {
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    this.checkRevision(card, options);
    if (card.state === "done") {
      throw new KanbanError(
        "invalid_state",
        `card ${id} is done and cannot be reviewed`,
      );
    }
    return this.transition(id, "review", "review", actor, source);
  }

  /** Mark a card complete. Idempotent. */
  done(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): MutationResult {
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    this.checkRevision(card, options);
    if (card.state === "done") return { card, events: [] };
    return this.transition(id, "done", "done", actor, source);
  }

  /** Send a card back to `todo` (from any state). */
  reopen(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): MutationResult {
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    this.checkRevision(card, options);
    return this.transition(id, "todo", "reopen", actor, source);
  }

  /** Move a card to an arbitrary column. */
  move(
    id: number,
    to: CardState,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): MutationResult {
    const target = this.parseInput(CardStateSchema, to);
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    this.checkRevision(card, options);
    return this.transition(id, target, "move", actor, source);
  }

  /** Permanently delete a card. Creator only. */
  remove(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
  ): MutationResult {
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    if (card.createdBy !== actor.name) {
      throw new KanbanError(
        "forbidden",
        `only the creator (${card.createdBy}) can delete card ${id}`,
      );
    }
    return this.emit({
      actor,
      source,
      type: "card.deleted",
      cardId: id,
      payload: {},
    });
  }

  /** Make card `id` wait on card `blockedById`. */
  block(
    id: number,
    blockedById: number,
    actor: Actor,
    source: EventSource = "cli",
  ): MutationResult {
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    this.mustCard(blockedById);
    this.assertCanModify(card, actor);
    if (id === blockedById) {
      throw new KanbanError("invalid_input", `card ${id} cannot block itself`);
    }
    if (card.blockedBy.includes(blockedById)) return { card, events: [] };
    if (this.projection.isBlockedTransitively(blockedById, id)) {
      throw new KanbanError(
        "invalid_input",
        `blocking card ${id} on card ${blockedById} would create a circular dependency`,
      );
    }
    return this.emit({
      actor,
      source,
      type: "card.dependency_added",
      cardId: id,
      payload: { blockedBy: blockedById },
    });
  }

  /** Remove a dependency between two cards. */
  unblock(
    id: number,
    blockedById: number,
    actor: Actor,
    source: EventSource = "cli",
  ): MutationResult {
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    this.assertCanModify(card, actor);
    if (!card.blockedBy.includes(blockedById)) return { card, events: [] };
    return this.emit({
      actor,
      source,
      type: "card.dependency_removed",
      cardId: id,
      payload: { blockedBy: blockedById },
    });
  }

  close(): void {
    this.log.close();
  }

  /* ------------------------------ internals ----------------------------- */

  private transition(
    id: number,
    to: CardState,
    action: "move" | "claim" | "review" | "done" | "reopen",
    actor: Actor,
    source: EventSource,
    patch?: { assignee: string },
  ): MutationResult {
    const card = this.mustCard(id);
    if (card.state === to && patch === undefined) {
      return { card, events: [] };
    }
    // Starting work on a card whose blockers are unfinished would let someone
    // pick up work that is not actually ready. `done` is deliberately not
    // gated: a card must always be closable, or an irrelevant blocker becomes a
    // dead end with no way out.
    if (to === "doing") {
      const open = this.projection.openBlockers(card);
      if (open.length > 0) {
        const waiting = open
          .map((blockerId) => {
            const blocker = this.projection.card(blockerId);
            return blocker
              ? `#${blockerId} (${blocker.state})`
              : `#${blockerId}`;
          })
          .join(", ");
        throw new KanbanError(
          "invalid_state",
          `card ${id} is blocked by ${waiting} — finish or unblock ${
            open.length === 1 ? "it" : "them"
          } first`,
        );
      }
    }
    return this.emit({
      actor,
      source,
      type: "card.moved",
      cardId: id,
      payload: { from: card.state, to, action, ...(patch ? { patch } : {}) },
    });
  }

  private emit(event: NewEvent): MutationResult {
    const [stored] = this.log.append([event]);
    if (!stored) {
      throw new KanbanError(
        "internal_error",
        "event log did not return the appended event",
      );
    }
    // Capture the pre-event state so `card.deleted` can still return the card
    // that was just removed (SSE consumers want the last known snapshot).
    const before = this.projection.card(stored.cardId) ?? null;
    this.projection.apply(stored);
    const card = this.projection.card(stored.cardId) ?? before;
    if (!card) {
      throw new KanbanError(
        "card_not_found",
        `card ${stored.cardId} not found`,
      );
    }
    return { card, events: [stored] };
  }

  /** Validates front-door input, converting Zod issues into stable error codes. */
  private parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    const path =
      issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new KanbanError(
      "invalid_input",
      `${path}${issue?.message ?? "invalid input"}`,
    );
  }

  private mustCard(id: number): Card {
    const card = this.projection.card(id);
    if (!card) {
      throw new KanbanError("card_not_found", `card ${id} not found`);
    }
    return card;
  }

  private assertCanModify(card: Card, actor: Actor): void {
    if (card.createdBy === actor.name || card.assignee === actor.name) return;
    throw new KanbanError(
      "forbidden",
      `only the creator (${card.createdBy}) or assignee (${card.assignee ?? "unassigned"}) can modify card ${card.id}`,
    );
  }

  private checkRevision(card: Card, options?: MutationOptions): void {
    const parsed = this.parseInput(MutationOptionsSchema, options ?? {});
    const expected = parsed.expectedRevision;
    if (expected !== undefined && expected !== card.revision) {
      throw new KanbanError(
        "revision_conflict",
        `card ${card.id} changed: expected revision ${expected}, current revision ${card.revision}`,
      );
    }
  }
}
