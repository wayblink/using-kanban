import type { CardPatch } from "./schemas.js";
import {
  CardCreatedPayloadSchema,
  CardDependencyPayloadSchema,
  CardMovedPayloadSchema,
  CardParentPayloadSchema,
  CardUpdatedPayloadSchema,
  NoteAddedPayloadSchema,
  NoteRemovedPayloadSchema,
  NoteUpdatedPayloadSchema,
} from "./schemas.js";
import {
  CARD_PRIORITIES,
  isInPlay,
  isTerminal,
  onRadar,
  type Card,
  type Event,
} from "./types.js";
import type { EventLog } from "./event-log.js";

/**
 * The board is a pure function of the event log: `apply` every event in id
 * order and you get the same cards, every time, on every machine.
 */
export class Projection {
  private readonly cards = new Map<number, Card>();
  private lastEventId = 0;

  get lastAppliedEventId(): number {
    return this.lastEventId;
  }

  /** Applies everything appended to the log since the last sync. */
  sync(log: EventLog): void {
    for (const event of log.since(this.lastEventId)) {
      this.apply(event);
    }
  }

  apply(event: Event): void {
    this.lastEventId = Math.max(this.lastEventId, event.id);

    switch (event.type) {
      case "card.created": {
        const payload = CardCreatedPayloadSchema.parse(event.payload);
        this.cards.set(event.id, {
          id: event.id,
          title: payload.title,
          body: payload.body,
          state: "todo",
          assignee: payload.assignee,
          reviewer: payload.reviewer,
          project: payload.project,
          subproject: payload.subproject,
          priority: payload.priority,
          blockedBy: payload.blockedBy,
          blocks: [],
          parent: null,
          children: [],
          notes: payload.notes,
          createdBy: payload.createdBy,
          createdAt: event.ts,
          updatedAt: event.ts,
          revision: 1,
        });
        // A card created with blockers is the successor end of those edges, so
        // the predecessors have to learn about it too.
        for (const upstreamId of payload.blockedBy) {
          this.link(event.id, upstreamId, event.ts);
        }
        return;
      }

      case "card.updated": {
        const { patch } = CardUpdatedPayloadSchema.parse(event.payload);
        this.patchCard(event.cardId, patch, event.ts);
        return;
      }

      case "card.moved": {
        const payload = CardMovedPayloadSchema.parse(event.payload);
        const card = this.cards.get(event.cardId);
        if (!card) return;
        this.cards.set(
          event.cardId,
          this.touch({ ...card, state: payload.to }, payload.patch, event.ts),
        );
        return;
      }

      case "card.deleted": {
        this.cards.delete(event.cardId);
        // Drop dangling references in every relation: the deleted card's own
        // lists go with it, and every card that named it loses the reference.
        // For the hierarchy that means orphaning its children — they become
        // top-level cards rather than vanishing — and removing it from its
        // parent's `children`.
        for (const card of this.cards.values()) {
          const blockedBy = card.blockedBy.filter((id) => id !== event.cardId);
          const blocks = card.blocks.filter((id) => id !== event.cardId);
          const children = card.children.filter((id) => id !== event.cardId);
          const parent = card.parent === event.cardId ? null : card.parent;
          if (
            blockedBy.length === card.blockedBy.length &&
            blocks.length === card.blocks.length &&
            children.length === card.children.length &&
            parent === card.parent
          ) {
            continue;
          }
          this.cards.set(card.id, {
            ...card,
            blockedBy,
            blocks,
            children,
            parent,
            updatedAt: event.ts,
            revision: card.revision + 1,
          });
        }
        return;
      }

      case "card.note_added": {
        const payload = NoteAddedPayloadSchema.parse(event.payload);
        const card = this.cards.get(event.cardId);
        if (!card) return;
        this.cards.set(event.cardId, {
          ...card,
          notes: [
            ...card.notes,
            {
              id: event.id,
              text: payload.text,
              url: payload.url,
              createdBy: event.actor.name,
              createdAt: event.ts,
            },
          ],
          updatedAt: event.ts,
          revision: card.revision + 1,
        });
        return;
      }

      case "card.note_updated": {
        const payload = NoteUpdatedPayloadSchema.parse(event.payload);
        const card = this.cards.get(event.cardId);
        if (!card) return;
        const index = card.notes.findIndex((note) => note.id === payload.note);
        if (index === -1) return;
        const current = card.notes[index];
        if (current === undefined) return;
        const notes = [...card.notes];
        notes[index] = {
          ...current,
          ...(payload.patch.text !== undefined
            ? { text: payload.patch.text }
            : {}),
          ...(payload.patch.url !== undefined
            ? { url: payload.patch.url }
            : {}),
        };
        this.cards.set(event.cardId, {
          ...card,
          notes,
          updatedAt: event.ts,
          revision: card.revision + 1,
        });
        return;
      }

      case "card.note_removed": {
        const payload = NoteRemovedPayloadSchema.parse(event.payload);
        const card = this.cards.get(event.cardId);
        if (!card) return;
        const notes = card.notes.filter((note) => note.id !== payload.note);
        if (notes.length === card.notes.length) return;
        this.cards.set(event.cardId, {
          ...card,
          notes,
          updatedAt: event.ts,
          revision: card.revision + 1,
        });
        return;
      }

      case "card.dependency_added": {
        const { blockedBy } = CardDependencyPayloadSchema.parse(event.payload);
        const card = this.cards.get(event.cardId);
        if (!card || card.blockedBy.includes(blockedBy)) return;
        this.cards.set(event.cardId, {
          ...card,
          blockedBy: [...card.blockedBy, blockedBy],
          updatedAt: event.ts,
          revision: card.revision + 1,
        });
        this.link(event.cardId, blockedBy, event.ts);
        return;
      }

      case "card.dependency_removed": {
        const { blockedBy } = CardDependencyPayloadSchema.parse(event.payload);
        const card = this.cards.get(event.cardId);
        if (!card) return;
        if (!card.blockedBy.includes(blockedBy)) return;
        this.cards.set(event.cardId, {
          ...card,
          blockedBy: card.blockedBy.filter((id) => id !== blockedBy),
          updatedAt: event.ts,
          revision: card.revision + 1,
        });
        this.unlink(event.cardId, blockedBy, event.ts);
        return;
      }

      case "card.parent_set": {
        const { parent } = CardParentPayloadSchema.parse(event.payload);
        const child = this.cards.get(event.cardId);
        const nextParent = this.cards.get(parent);
        if (!child || !nextParent) return;
        if (child.parent === parent) return;
        const previous = child.parent;
        this.cards.set(child.id, {
          ...child,
          parent,
          updatedAt: event.ts,
          revision: child.revision + 1,
        });
        this.attachChild(parent, child.id, event.ts);
        // Re-parenting is one event, not a clear-then-set the caller has to
        // remember: the old parent loses the child in the same step.
        if (previous !== null) this.detachChild(previous, child.id, event.ts);
        return;
      }

      case "card.parent_cleared": {
        const child = this.cards.get(event.cardId);
        if (!child || child.parent === null) return;
        const previous = child.parent;
        this.cards.set(child.id, {
          ...child,
          parent: null,
          updatedAt: event.ts,
          revision: child.revision + 1,
        });
        this.detachChild(previous, child.id, event.ts);
        return;
      }
    }
  }

  card(id: number): Card | undefined {
    return this.cards.get(id);
  }

  all(): Card[] {
    return [...this.cards.values()].sort((a, b) => a.id - b.id);
  }

  /** Direct children of `card` that still exist, in the order they were added. */
  childrenOf(card: Card): Card[] {
    const result: Card[] = [];
    for (const id of card.children) {
      const child = this.cards.get(id);
      if (child) result.push(child);
    }
    return result;
  }

  /** Unfinished direct children — what keeps an umbrella out of `doing`. */
  openChildren(card: Card): Card[] {
    return this.childrenOf(card).filter((child) => !isTerminal(child.state));
  }

  /**
   * Parent/child pairs that violate the contract the engine now enforces.
   *
   * Kept here rather than in the transition because it answers a different
   * question: the transition asks "may this move happen", this asks "which
   * pairs on the board already disagree" — boards written before the rule can
   * hold them, and the log cannot be rewritten to fix it.
   */
  hierarchyViolations(): { card: Card; reason: string }[] {
    const found: { card: Card; reason: string }[] = [];
    for (const card of this.cards.values()) {
      const parent = card.parent === null ? null : this.cards.get(card.parent);
      if (parent && isInPlay(card.state) && parent.state !== "doing") {
        found.push({
          card,
          reason: `#${card.id} is ${card.state} while its umbrella #${parent.id} is ${parent.state}`,
        });
      }
      if (card.state === "review" || card.state === "done") {
        const open = this.openChildren(card);
        if (open.length > 0) {
          found.push({
            card,
            reason: `#${card.id} is ${card.state} with ${open
              .map((child) => `#${child.id} (${child.state})`)
              .join(", ")} still open`,
          });
        }
      }
    }
    return found;
  }

  board(
    project?: string | null,
    subproject?: string | null,
  ): {
    someday: Card[];
    todo: Card[];
    doing: Card[];
    review: Card[];
    done: Card[];
  } {
    const all = this.inProject(project, subproject);
    return {
      someday: all.filter((card) => card.state === "someday"),
      todo: all.filter((card) => card.state === "todo"),
      doing: all.filter((card) => card.state === "doing"),
      review: all.filter((card) => card.state === "review"),
      done: all.filter((card) => card.state === "done"),
    };
  }

  /**
   * Cards in play (not shelved, not done) assigned to `assignee`. The shelf is
   * excluded deliberately: a parked card is not a candidate for "what should I
   * work on", which is the point of parking it.
   */
  openFor(
    assignee: string,
    project?: string | null,
    subproject?: string | null,
  ): Card[] {
    return this.inProject(project, subproject).filter(
      (card) => card.assignee === assignee && onRadar(card.state),
    );
  }

  /** Cards in review where `reviewer` is the expected reviewer. */
  reviewQueueFor(
    reviewer: string,
    project?: string | null,
    subproject?: string | null,
  ): Card[] {
    return this.inProject(project, subproject).filter(
      (card) => card.reviewer === reviewer && card.state === "review",
    );
  }

  /**
   * Cards in `project`, or every card when it is null/undefined. Cards with no
   * project are only visible when no project is selected — a project filter is
   * a partition, not a "show everything tagged" overlay.
   */
  private inProject(
    project?: string | null,
    subproject?: string | null,
  ): Card[] {
    let all = this.all();
    if (project !== undefined && project !== null) {
      all = all.filter((card) => card.project === project);
    }
    if (subproject !== undefined && subproject !== null) {
      all = all.filter((card) => card.subproject === subproject);
    }
    return all;
  }

  /**
   * Blockers of `card` that still stand in the way: they exist and are not done.
   * A shelved blocker still blocks — "later" is not "finished". A blocker that
   * has been deleted counts as satisfied, so deleting a card cannot block
   * another one forever.
   */
  openBlockers(card: Card): number[] {
    const open: number[] = [];
    for (const id of card.blockedBy) {
      const blocker = this.cards.get(id);
      if (blocker && !isTerminal(blocker.state)) open.push(id);
    }
    return open;
  }

  /** True when `targetId` is reachable from `fromId` by following blockedBy edges. */
  isBlockedTransitively(fromId: number, targetId: number): boolean {
    const seen = new Set<number>();
    const stack: number[] = [fromId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) continue;
      if (current === targetId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const card = this.cards.get(current);
      if (card) stack.push(...card.blockedBy);
    }
    return false;
  }

  private patchCard(cardId: number, patch: CardPatch, ts: string): void {
    const card = this.cards.get(cardId);
    if (!card) return;
    this.cards.set(cardId, this.touch(card, patch, ts));
  }

  /**
   * Records the successor side of an edge: `successorId` waits on `upstreamId`,
   * so `upstreamId` gains `successorId` in its `blocks` list. The event that
   * created the edge already bumped the successor's revision; the predecessor
   * only gets its derived list, so its revision is bumped too — its snapshot
   * really did change.
   */
  private link(successorId: number, upstreamId: number, ts: string): void {
    const upstream = this.cards.get(upstreamId);
    if (!upstream || upstream.blocks.includes(successorId)) return;
    this.cards.set(upstreamId, {
      ...upstream,
      blocks: [...upstream.blocks, successorId],
      updatedAt: ts,
      revision: upstream.revision + 1,
    });
  }

  private unlink(successorId: number, upstreamId: number, ts: string): void {
    const upstream = this.cards.get(upstreamId);
    if (!upstream || !upstream.blocks.includes(successorId)) return;
    this.cards.set(upstreamId, {
      ...upstream,
      blocks: upstream.blocks.filter((id) => id !== successorId),
      updatedAt: ts,
      revision: upstream.revision + 1,
    });
  }

  /**
   * Mirror an umbrella's `children`. Like `link`/`unlink` for dependencies, the
   * edge is stored once (the child's `parent`) and the parent's list is derived
   * from it — its revision is bumped because the snapshot really did change.
   */
  private attachChild(parentId: number, childId: number, ts: string): void {
    const parent = this.cards.get(parentId);
    if (!parent || parent.children.includes(childId)) return;
    this.cards.set(parentId, {
      ...parent,
      children: [...parent.children, childId],
      updatedAt: ts,
      revision: parent.revision + 1,
    });
  }

  private detachChild(parentId: number, childId: number, ts: string): void {
    const parent = this.cards.get(parentId);
    if (!parent || !parent.children.includes(childId)) return;
    this.cards.set(parentId, {
      ...parent,
      children: parent.children.filter((id) => id !== childId),
      updatedAt: ts,
      revision: parent.revision + 1,
    });
  }

  private touch(card: Card, patch: CardPatch | undefined, ts: string): Card {
    const next: Card = {
      ...card,
      ...(patch?.title !== undefined ? { title: patch.title } : {}),
      ...(patch?.body !== undefined ? { body: patch.body } : {}),
      ...(patch?.assignee !== undefined ? { assignee: patch.assignee } : {}),
      ...(patch?.reviewer !== undefined ? { reviewer: patch.reviewer } : {}),
      ...(patch?.project !== undefined ? { project: patch.project } : {}),
      ...(patch?.subproject !== undefined
        ? { subproject: patch.subproject }
        : {}),
      ...(patch?.priority !== undefined ? { priority: patch.priority } : {}),
      updatedAt: ts,
      revision: card.revision + 1,
    };
    return next;
  }
}

/**
 * Reading order within one state: priority, then id.
 *
 * Every door sorts with this so the CLI, the overlay and the Web UI cannot
 * disagree about which card comes first. State is deliberately *not* part of
 * the comparator — a caller that has already split by column wants priority
 * order within it, and a caller that has not layers its own state order on top.
 *
 * `CARD_PRIORITIES` is declared in sort order, so the index difference *is* the
 * priority difference.
 */
export function compareByPriority(a: Card, b: Card): number {
  return (
    CARD_PRIORITIES.indexOf(a.priority) - CARD_PRIORITIES.indexOf(b.priority) ||
    a.id - b.id
  );
}

/** How far along an umbrella is: `done` over all of its direct children. */
export interface ChildProgress {
  readonly total: number;
  readonly done: number;
}

/**
 * Derived progress of a parent card from its children. Nothing is stored: a
 * child's state is the truth, so this cannot go stale the way a counter can.
 * `done` is `isTerminal`, so a parked child counts as unfinished and keeps an
 * umbrella from advancing.
 */
export function childProgress(children: readonly Card[]): ChildProgress {
  return {
    total: children.length,
    done: children.filter((child) => isTerminal(child.state)).length,
  };
}
