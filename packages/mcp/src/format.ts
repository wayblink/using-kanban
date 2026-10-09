import type { Board, Card, Event } from "@wayblink/using-kanban-core";

/**
 * Compact, greppable text renderings. Agents read these directly, so the
 * output favours one-fact-per-line over pretty boxes.
 */
export function formatCardBrief(card: Card): string {
  const parts = [`#${card.id} [${card.state}]`, card.title];
  if (card.assignee) parts.push(`@${card.assignee}`);
  if (card.reviewer) parts.push(`reviewer:${card.reviewer}`);
  if (card.project) parts.push(`project:${card.project}`);
  if (card.blockedBy.length > 0)
    parts.push(`blocked-by:${card.blockedBy.join(",")}`);
  return parts.join(" ");
}

export function formatBoard(board: Board): string {
  const columns: [string, readonly Card[]][] = [
    ["todo", board.todo],
    ["doing", board.doing],
    ["review", board.review],
    ["done", board.done],
  ];
  const lines: string[] = [];
  for (const [name, cards] of columns) {
    lines.push(`${name} (${cards.length}):`);
    if (cards.length === 0) {
      lines.push("  (empty)");
      continue;
    }
    for (const card of cards) {
      lines.push(`  ${formatCardBrief(card)}`);
    }
  }
  return lines.join("\n");
}

export function formatCards(
  cards: readonly Card[],
  emptyMessage: string,
): string {
  if (cards.length === 0) return emptyMessage;
  return cards.map((card) => formatCardBrief(card)).join("\n");
}

export function formatCard(card: Card, events: readonly Event[]): string {
  const lines: string[] = [
    `#${card.id} ${card.title} [${card.state}]`,
    `assignee: ${card.assignee ?? "—"}`,
    `project: ${card.project ?? "—"}`,
    `reviewer: ${card.reviewer ?? "—"}`,
    `blocked by: ${card.blockedBy.length > 0 ? card.blockedBy.map((id) => `#${id}`).join(", ") : "—"}`,
    `created by: ${card.createdBy}  ·  revision ${card.revision}  ·  updated ${card.updatedAt}`,
  ];
  if (card.body) {
    lines.push("body:", ...card.body.split("\n").map((line) => `  ${line}`));
  }
  if (events.length > 0) {
    lines.push("history:");
    for (const event of events) {
      lines.push(`  ${event.id}. ${event.ts} ${describeEvent(event)}`);
    }
  }
  return lines.join("\n");
}

function describeEvent(event: Event): string {
  const who = `${event.actor.type}/${event.actor.name} via ${event.source}`;
  switch (event.type) {
    case "card.created":
      return `created by ${who}`;
    case "card.updated":
      return `edited by ${who}`;
    case "card.moved": {
      const payload = event.payload as {
        from?: string;
        to?: string;
        action?: string;
      };
      return `${payload.action ?? "moved"} ${payload.from ?? "?"}→${payload.to ?? "?"} by ${who}`;
    }
    case "card.deleted":
      return `deleted by ${who}`;
    case "card.dependency_added": {
      const payload = event.payload as { blockedBy?: number };
      return `blocked on #${payload.blockedBy ?? "?"} by ${who}`;
    }
    case "card.dependency_removed": {
      const payload = event.payload as { blockedBy?: number };
      return `unblocked from #${payload.blockedBy ?? "?"} by ${who}`;
    }
    default:
      return `${event.type} by ${who}`;
  }
}
