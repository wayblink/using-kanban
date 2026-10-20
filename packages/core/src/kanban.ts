import type { z } from "zod";
import { KanbanError } from "./errors.js";
import type { EventLog } from "./event-log.js";
import { Projection } from "./projection.js";
import {
  AddCardInputSchema,
  AddNoteInputSchema,
  CardStateSchema,
  EditCardInputSchema,
  MutationOptionsSchema,
  RelationDirectionSchema,
  UpdateNoteInputSchema,
} from "./schemas.js";
import type {
  AddCardInput,
  AddNoteInput,
  CardPatch,
  EditCardInput,
  MoveAction,
  MutationOptions,
  UpdateNoteInput,
} from "./schemas.js";
import { isShelved, isInPlay, isTerminal } from "./types.js";
import type {
  Actor,
  Board,
  Card,
  CardNote,
  CardState,
  Event,
  EventSource,
  NewEvent,
  ProjectSummary,
  RelationDirection,
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
  board(project?: string | null, subproject?: string | null): Board {
    this.projection.sync(this.log);
    return this.projection.board(project, subproject);
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
  mine(
    assignee: string,
    project?: string | null,
    subproject?: string | null,
  ): Card[] {
    this.projection.sync(this.log);
    return this.projection.openFor(assignee, project, subproject);
  }

  /** Cards waiting for `reviewer` to review. */
  reviewQueue(
    reviewer: string,
    project?: string | null,
    subproject?: string | null,
  ): Card[] {
    this.projection.sync(this.log);
    return this.projection.reviewQueueFor(reviewer, project, subproject);
  }

  /** Direct children of a card that still exist — an umbrella's parts. */
  childrenOf(id: number): Card[] {
    this.projection.sync(this.log);
    return this.projection.childrenOf(this.mustCard(id));
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

  /**
   * Per-project card counts, for `ukb list`.
   *
   * Named projects come first alphabetically; the no-project bucket is last so
   * it cannot sort into the middle of the list. Counts include `done`, so the
   * numbers reconcile against the whole board rather than only open work.
   */
  projectSummary(): ProjectSummary[] {
    this.projection.sync(this.log);
    const summaries = new Map<string | null, ProjectSummary>();
    const bucket = (project: string | null): ProjectSummary => {
      const existing = summaries.get(project);
      if (existing) return existing;
      const created: ProjectSummary = {
        project,
        someday: 0,
        todo: 0,
        doing: 0,
        review: 0,
        done: 0,
      };
      summaries.set(project, created);
      return created;
    };
    for (const card of this.projection.all()) {
      const entry = bucket(card.project ?? null);
      summaries.set(entry.project, {
        ...entry,
        [card.state]: entry[card.state] + 1,
      });
    }
    return [...summaries.values()].sort((a, b) => {
      if (a.project === null) return b.project === null ? 0 : 1;
      if (b.project === null) return -1;
      return a.project.localeCompare(b.project);
    });
  }

  /* ----------------------------- mutations ----------------------------- */

  add(
    input: AddCardInput,
    actor: Actor,
    source: EventSource = "cli",
  ): MutationResult {
    const parsed = this.parseInput(AddCardInputSchema, input);
    this.projection.sync(this.log);
    const project = parsed.project?.trim() || null;
    const subproject = parsed.subproject?.trim() || null;
    if (subproject !== null && project === null) {
      throw new KanbanError(
        "invalid_input",
        "a subproject needs a project — set the project (the repository name) first",
      );
    }
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
        project,
        subproject,
        priority: parsed.priority,
        blockedBy: parsed.blockedBy ?? [],
        notes: [],
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
    if (parsed.subproject !== undefined)
      patch.subproject = parsed.subproject?.trim() || null;
    // A direction without a repository is not a shape this board has. Clearing
    // the project takes its direction with it; setting one under no project is
    // refused rather than silently dropped.
    const nextProject =
      parsed.project !== undefined
        ? parsed.project?.trim() || null
        : card.project;
    // Moving a card to another repository drops its old direction: a
    // direction belongs to one repository, and silently carrying the name
    // across would invent a stream that repository may not have. An explicit
    // --subproject in the same edit still wins.
    const projectChanged =
      parsed.project !== undefined && nextProject !== card.project;
    let nextSubproject =
      parsed.subproject !== undefined
        ? parsed.subproject?.trim() || null
        : projectChanged
          ? null
          : card.subproject;
    if (nextProject === null) {
      if (nextSubproject !== null && parsed.subproject !== undefined) {
        throw new KanbanError(
          "invalid_input",
          "a subproject needs a project — set the project (the repository name) first",
        );
      }
      nextSubproject = null;
    }
    if (nextSubproject !== card.subproject) patch.subproject = nextSubproject;
    if (parsed.priority !== undefined) patch.priority = parsed.priority;
    if (Object.keys(patch).length === 0) {
      return { card, events: [] };
    }
    // The shelf's invariant is that a card there has no owner. Editing is the
    // other door that could break it, so refuse the write rather than silently
    // dropping the field and letting the caller believe it took.
    if (isShelved(card.state)) {
      if (
        (patch.assignee !== undefined && patch.assignee !== null) ||
        (patch.reviewer !== undefined && patch.reviewer !== null)
      ) {
        throw new KanbanError(
          "invalid_state",
          `card ${id} is in someday and cannot carry an assignee or reviewer — move it to another column first`,
        );
      }
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
      if (card.assignee !== null) {
        throw new KanbanError(
          "claim_conflict",
          `card ${id} is already being worked by ${card.assignee}`,
        );
      }
      // `move <id> doing` can park a card in the working column with nobody
      // owning it. Claiming it is the fix, not a conflict: `claim` is the verb
      // that means "this is mine", and refusing here would report a phantom
      // owner and send the caller off to "pick another card" over work that
      // is genuinely up for grabs.
      return this.transition(id, "doing", "claim", actor, source, {
        assignee: actor.name,
      });
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
    this.mustCard(id);
    this.mustCard(blockedById);
    return this.addEdge(id, blockedById, actor, source);
  }

  /** Remove a dependency between two cards. */
  unblock(
    id: number,
    blockedById: number,
    actor: Actor,
    source: EventSource = "cli",
  ): MutationResult {
    this.projection.sync(this.log);
    this.mustCard(id);
    return this.removeEdge(id, blockedById, actor, source);
  }

  /**
   * Make card `id` a part of card `parentId`.
   *
   * Hierarchy is deliberately one level: the child must be a leaf and the parent
   * must be top-level, so nothing can gain a grandparent.
   *
   * Attaching makes `parentId` an umbrella and `id` one of its parts, so the pair
   * has to satisfy the same contract `transition` enforces. It is checked here
   * as well because no transition happens: the event log cannot be corrected
   * afterwards, so an inconsistent pair must never be written in the first place.
   *
   * Re-parenting replaces the old parent in one event; the caller does not have
   * to remember an `unparent` first. `id` is the child: attaching changes that
   * card, so its creator or assignee is the one who may do it.
   */
  parent(
    id: number,
    parentId: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): MutationResult {
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    const parentCard = this.mustCard(parentId);
    this.checkRevision(card, options);
    this.assertCanModify(card, actor);
    if (id === parentId) {
      throw new KanbanError(
        "invalid_input",
        `card ${id} cannot be its own parent`,
      );
    }
    if (card.parent === parentId) return { card, events: [] };
    if (card.children.length > 0) {
      throw new KanbanError(
        "invalid_state",
        `card ${id} has children of its own — the hierarchy is one level, so a card cannot be both a parent and a child`,
      );
    }
    if (parentCard.parent !== null) {
      throw new KanbanError(
        "invalid_state",
        `card ${parentId} is itself a child of #${parentCard.parent} — the hierarchy is one level, so it cannot also be a parent`,
      );
    }
    if (isInPlay(card.state) && parentCard.state !== "doing") {
      throw new KanbanError(
        "invalid_state",
        `card ${id} is in ${card.state} and card ${parentId} is in ${parentCard.state} — a part cannot be in doing or review before its umbrella is in doing; move ${parentId} to doing first`,
      );
    }
    if (
      (parentCard.state === "review" || parentCard.state === "done") &&
      card.state !== "done"
    ) {
      throw new KanbanError(
        "invalid_state",
        `card ${parentId} is in ${parentCard.state} — an umbrella cannot take on the unfinished card ${id} (${card.state})`,
      );
    }
    return this.emit({
      actor,
      source,
      type: "card.parent_set",
      cardId: id,
      payload: { parent: parentId },
    });
  }

  /** Make card `id` a top-level card again. Idempotent. */
  unparent(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): MutationResult {
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    this.checkRevision(card, options);
    this.assertCanModify(card, actor);
    if (card.parent === null) return { card, events: [] };
    return this.emit({
      actor,
      source,
      type: "card.parent_cleared",
      cardId: id,
      payload: {},
    });
  }

  /**
   * Relate two cards. `direction` is the side `otherId` sits on relative to
   * `id`: `upstream` makes this card wait on it, `downstream` makes it wait on
   * this card. Both directions land on the same edge, so relating twice in
   * opposite orders cannot create two edges.
   */
  relate(
    id: number,
    otherId: number,
    direction: RelationDirection,
    actor: Actor,
    source: EventSource = "cli",
  ): MutationResult {
    const side = this.parseInput(RelationDirectionSchema, direction);
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    const other = this.mustCard(otherId);
    if (id === otherId) {
      throw new KanbanError(
        "invalid_input",
        `card ${id} cannot be related to itself`,
      );
    }
    const successorId = side === "upstream" ? card.id : other.id;
    const upstreamId = side === "upstream" ? other.id : card.id;
    return this.addEdge(successorId, upstreamId, actor, source);
  }

  /** Remove the relation between two cards, whichever way round it is. */
  unrelate(
    id: number,
    otherId: number,
    actor: Actor,
    source: EventSource = "cli",
  ): MutationResult {
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    const other = this.mustCard(otherId);
    if (card.blockedBy.includes(otherId)) {
      return this.removeEdge(card.id, other.id, actor, source);
    }
    if (other.blockedBy.includes(card.id)) {
      return this.removeEdge(other.id, card.id, actor, source);
    }
    return { card, events: [] };
  }

  /** Attach a remark — text plus an optional document link — to a card. */
  addNote(
    id: number,
    input: AddNoteInput,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): MutationResult {
    const parsed = this.parseInput(AddNoteInputSchema, input);
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    this.checkRevision(card, options);
    this.assertCanModify(card, actor);
    return this.emit({
      actor,
      source,
      type: "card.note_added",
      cardId: id,
      payload: { text: parsed.text, url: parsed.url ?? null },
    });
  }

  /** Edit a note's text and/or link. The note id is its `card.note_added` id. */
  updateNote(
    id: number,
    noteId: number,
    input: UpdateNoteInput,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): MutationResult {
    const parsed = this.parseInput(UpdateNoteInputSchema, input);
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    this.checkRevision(card, options);
    this.assertCanModify(card, actor);
    this.mustNote(card, noteId);
    return this.emit({
      actor,
      source,
      type: "card.note_updated",
      cardId: id,
      payload: {
        note: noteId,
        patch: {
          ...(parsed.text !== undefined ? { text: parsed.text } : {}),
          ...(parsed.url !== undefined ? { url: parsed.url } : {}),
        },
      },
    });
  }

  /** Remove a note from a card. */
  removeNote(
    id: number,
    noteId: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): MutationResult {
    this.projection.sync(this.log);
    const card = this.mustCard(id);
    this.checkRevision(card, options);
    this.assertCanModify(card, actor);
    this.mustNote(card, noteId);
    return this.emit({
      actor,
      source,
      type: "card.note_removed",
      cardId: id,
      payload: { note: noteId },
    });
  }

  close(): void {
    this.log.close();
  }

  /* ------------------------------ internals ----------------------------- */

  /**
   * The one place an edge is written: `successorId` waits on `upstreamId`.
   * Both `block` and `relate` funnel through here, so a relation is stored
   * exactly once no matter which card you started from.
   */
  private addEdge(
    successorId: number,
    upstreamId: number,
    actor: Actor,
    source: EventSource,
  ): MutationResult {
    const card = this.mustCard(successorId);
    this.mustCard(upstreamId);
    this.assertCanModify(card, actor);
    if (successorId === upstreamId) {
      throw new KanbanError(
        "invalid_input",
        `card ${successorId} cannot be related to itself`,
      );
    }
    if (card.blockedBy.includes(upstreamId)) return { card, events: [] };
    if (this.projection.isBlockedTransitively(upstreamId, successorId)) {
      throw new KanbanError(
        "invalid_input",
        `making card ${successorId} wait on card ${upstreamId} would create a circular dependency`,
      );
    }
    return this.emit({
      actor,
      source,
      type: "card.dependency_added",
      cardId: successorId,
      payload: { blockedBy: upstreamId },
    });
  }

  private removeEdge(
    successorId: number,
    upstreamId: number,
    actor: Actor,
    source: EventSource,
  ): MutationResult {
    const card = this.mustCard(successorId);
    this.assertCanModify(card, actor);
    if (!card.blockedBy.includes(upstreamId)) return { card, events: [] };
    return this.emit({
      actor,
      source,
      type: "card.dependency_removed",
      cardId: successorId,
      payload: { blockedBy: upstreamId },
    });
  }
  private transition(
    id: number,
    to: CardState,
    action: MoveAction,
    actor: Actor,
    source: EventSource,
    patch?: CardPatch,
  ): MutationResult {
    const card = this.mustCard(id);
    // Entering `someday` clears both owner fields. This is the engine's
    // invariant — "a shelved card has no owner" — not a side effect of one
    // verb, so the CLI, MCP, the Web UI and the Pi overlay all land the same
    // way. It is the one place `move` is not blind, and it is defensible
    // because it *removes* information (nobody owns it) rather than inventing
    // it the way an implicit `move`-into-doing assignment would.
    const effective: CardPatch = {
      ...patch,
      ...(isShelved(to) ? { assignee: null, reviewer: null } : {}),
    };
    const stateChanges = card.state !== to;
    const ownerChanges =
      (effective.assignee !== undefined &&
        effective.assignee !== card.assignee) ||
      (effective.reviewer !== undefined &&
        effective.reviewer !== card.reviewer);
    if (!stateChanges && !ownerChanges) {
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
    // An umbrella is the goal and its children are the parts of it, so the two
    // ends cannot disagree. See `assertHierarchy`.
    this.assertHierarchy(card, to);
    return this.emit({
      actor,
      source,
      type: "card.moved",
      cardId: id,
      payload: {
        from: card.state,
        to,
        action,
        ...(Object.keys(effective).length > 0 ? { patch: effective } : {}),
      },
    });
  }

  /**
   * The parent/child contract, checked on every transition.
   *
   * An umbrella is the goal; its children are the parts that add up to it. The
   * two ends have to agree, so four rules follow from that one idea:
   *
   *  - a child may only be in play (`doing`/`review`) while its umbrella is
   *    `doing` — "this is under way" is what makes a part claimable;
   *  - an umbrella may only be reviewed or finished once every child is `done`
   *    — the whole cannot be accepted while a part is still open;
   *  - an umbrella may not drop out of `doing` while a child is in play, or the
   *    first rule would already be broken;
   *  - a child may not leave `done` while its umbrella is in `review`/`done`,
   *    which is the second rule seen from the other end.
   *
   * This replaces the earlier "an umbrella is a container, so it may not be in
   * doing/review at all": that rule made the umbrella the last thing to start
   * and the first thing to finish, which is backwards — the parts are what you
   * work on *while* the goal is in play.
   *
   * Checked on the transition rather than derived afterwards: an event log
   * cannot reject a write it already holds, and a projection that silently
   * corrected itself would disagree with the events it is built from. A board
   * written before this rule may still hold such a pair (see `ukb doctor`); the
   * next move of either card is where it surfaces, and the message says which
   * end to move first.
   */
  private assertHierarchy(card: Card, to: CardState): void {
    const parent =
      card.parent === null ? null : this.projection.card(card.parent);
    const children = this.projection.childrenOf(card);

    if (parent && isInPlay(to) && parent.state !== "doing") {
      throw new KanbanError(
        "invalid_state",
        `card ${card.id} is a part of #${parent.id} (${parent.state}) — a child cannot be in ${to} until its umbrella is in doing; move #${parent.id} to doing first`,
      );
    }

    if (children.length > 0) {
      if (to === "review" || to === "done") {
        const open = children.filter((child) => !isTerminal(child.state));
        if (open.length > 0) {
          const listed = open
            .map((child) => `#${child.id} (${child.state})`)
            .join(", ");
          const target = to === "done" ? "done" : "in review";
          throw new KanbanError(
            "invalid_state",
            `card ${card.id} is an umbrella with ${open.length} unfinished ${
              open.length === 1 ? "child" : "children"
            } — a card cannot be ${target} until every part is done; finish or unparent ${open.length === 1 ? "it" : "them"} first: ${listed}`,
          );
        }
      }

      if (card.state === "doing" && !isInPlay(to)) {
        const working = children.filter((child) => isInPlay(child.state));
        if (working.length > 0) {
          const listed = working
            .map((child) => `#${child.id} (${child.state})`)
            .join(", ");
          throw new KanbanError(
            "invalid_state",
            `card ${card.id} still has ${
              working.length === 1 ? "a part" : "parts"
            } in play — move ${working.length === 1 ? "it" : "them"} out of doing/review before the umbrella leaves doing: ${listed}`,
          );
        }
      }
    }

    if (
      parent &&
      isTerminal(card.state) &&
      (parent.state === "review" || parent.state === "done")
    ) {
      throw new KanbanError(
        "invalid_state",
        `card ${card.id} is a part of #${parent.id}, which is in ${parent.state} — move #${parent.id} back out of ${parent.state} before reopening this card`,
      );
    }
  }

  /**
   * Pairs on the board that break the parent/child contract.
   *
   * The engine refuses to create new ones, but a board written before the rule
   * existed can still hold them: the log is append-only, so they are reported
   * rather than rewritten. `ukb doctor` prints them; the fix is one move of the
   * end the message names.
   */
  hierarchyViolations(): { card: Card; reason: string }[] {
    this.projection.sync(this.log);
    return this.projection.hierarchyViolations();
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

  private mustNote(card: Card, noteId: number): CardNote {
    const note = card.notes.find((entry) => entry.id === noteId);
    if (!note) {
      throw new KanbanError(
        "card_not_found",
        `note ${noteId} is not on card ${card.id}`,
      );
    }
    return note;
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
