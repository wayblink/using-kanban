import type { CardPatch } from "./schemas.js";
import {
  CardCreatedPayloadSchema,
  CardDependencyPayloadSchema,
  CardMovedPayloadSchema,
  CardUpdatedPayloadSchema,
} from "./schemas.js";
import type { Card, Event } from "./types.js";
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
          blockedBy: payload.blockedBy,
          createdBy: payload.createdBy,
          createdAt: event.ts,
          updatedAt: event.ts,
          revision: 1,
        });
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
        // Drop dangling dependency references.
        for (const card of this.cards.values()) {
          if (card.blockedBy.includes(event.cardId)) {
            this.cards.set(card.id, {
              ...card,
              blockedBy: card.blockedBy.filter((id) => id !== event.cardId),
              updatedAt: event.ts,
              revision: card.revision + 1,
            });
          }
        }
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
        return;
      }

      case "card.dependency_removed": {
        const { blockedBy } = CardDependencyPayloadSchema.parse(event.payload);
        const card = this.cards.get(event.cardId);
        if (!card) return;
        this.cards.set(event.cardId, {
          ...card,
          blockedBy: card.blockedBy.filter((id) => id !== blockedBy),
          updatedAt: event.ts,
          revision: card.revision + 1,
        });
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

  board(project?: string | null): {
    todo: Card[];
    doing: Card[];
    review: Card[];
    done: Card[];
  } {
    const all = this.inProject(project);
    return {
      todo: all.filter((card) => card.state === "todo"),
      doing: all.filter((card) => card.state === "doing"),
      review: all.filter((card) => card.state === "review"),
      done: all.filter((card) => card.state === "done"),
    };
  }

  /** Open cards (anything but done) assigned to `assignee`. */
  openFor(assignee: string, project?: string | null): Card[] {
    return this.inProject(project).filter(
      (card) => card.assignee === assignee && card.state !== "done",
    );
  }

  /** Cards in review where `reviewer` is the expected reviewer. */
  reviewQueueFor(reviewer: string, project?: string | null): Card[] {
    return this.inProject(project).filter(
      (card) => card.reviewer === reviewer && card.state === "review",
    );
  }

  /**
   * Cards in `project`, or every card when it is null/undefined. Cards with no
   * project are only visible when no project is selected — a project filter is
   * a partition, not a "show everything tagged" overlay.
   */
  private inProject(project?: string | null): Card[] {
    const all = this.all();
    if (project === undefined || project === null) return all;
    return all.filter((card) => card.project === project);
  }

  /**
   * Blockers of `card` that still stand in the way: they exist and are not
   * done. A blocker that has been deleted counts as satisfied — otherwise
   * deleting a card could block another one forever.
   */
  openBlockers(card: Card): number[] {
    const open: number[] = [];
    for (const id of card.blockedBy) {
      const blocker = this.cards.get(id);
      if (blocker && blocker.state !== "done") open.push(id);
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

  private touch(card: Card, patch: CardPatch | undefined, ts: string): Card {
    const next: Card = {
      ...card,
      ...(patch?.title !== undefined ? { title: patch.title } : {}),
      ...(patch?.body !== undefined ? { body: patch.body } : {}),
      ...(patch?.assignee !== undefined ? { assignee: patch.assignee } : {}),
      ...(patch?.reviewer !== undefined ? { reviewer: patch.reviewer } : {}),
      ...(patch?.project !== undefined ? { project: patch.project } : {}),
      updatedAt: ts,
      revision: card.revision + 1,
    };
    return next;
  }
}
