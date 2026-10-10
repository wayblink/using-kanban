import type { Board, Card, Event } from "@wayblink/using-kanban-core";

/**
 * Text rendering for the terminal: compact, greppable, one fact per line.
 * (Each front door formats for its own medium — the Web UI and MCP server
 * have their own renderers.)
 */

export function formatCardBrief(card: Card): string {
  const parts = [`#${card.id} [${card.state}]`, card.title];
  if (card.assignee) parts.push(`@${card.assignee}`);
  if (card.reviewer) parts.push(`reviewer:${card.reviewer}`);
  if (card.project) parts.push(`project:${card.project}`);
  if (card.blockedBy.length > 0)
    parts.push(`blocked-by:${card.blockedBy.join(",")}`);
  if (card.blocks.length > 0) parts.push(`blocks:${card.blocks.join(",")}`);
  if (card.notes.length > 0) parts.push(`notes:${card.notes.length}`);
  return parts.join(" ");
}

export function formatBoard(
  board: Board,
  projects: readonly string[] = [],
): string {
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
  if (projects.length > 0) {
    lines.push("");
    lines.push(`projects: ${projects.join(", ")}`);
  }
  return lines.join("\n");
}

/** The no-args output: a list of cards plus an explicit call to act. */
export function formatMine(cards: readonly Card[], actor: string): string {
  if (cards.length === 0) {
    return `no open cards assigned to ${actor}.\n\nukb board — see the whole board`;
  }
  const lines = [`your open cards (${actor}):`, ""];
  for (const card of cards) {
    lines.push(`  ${formatCardBrief(card)}`);
  }
  lines.push("");
  const claimable = cards.filter((card) => card.state === "todo");
  if (claimable.length > 0) {
    lines.push(
      `next: claim a todo card before working it — ukb claim ${claimable[0]?.id} — then ukb show ${claimable[0]?.id} for the details`,
    );
  } else {
    lines.push("next: finish what is in progress, then ukb review <id>");
  }
  return lines.join("\n");
}

export function formatCard(card: Card, events: readonly Event[]): string {
  const lines = [
    `#${card.id} ${card.title} [${card.state}]`,
    `assignee: ${card.assignee ?? "—"}`,
    `reviewer: ${card.reviewer ?? "—"}`,
    `project: ${card.project ?? "—"}`,
    `blocked by: ${card.blockedBy.length > 0 ? card.blockedBy.map((id) => `#${id}`).join(", ") : "—"}`,
    `blocks: ${card.blocks.length > 0 ? card.blocks.map((id) => `#${id}`).join(", ") : "—"}`,
    `created by: ${card.createdBy} · revision ${card.revision} · updated ${card.updatedAt}`,
  ];
  if (card.body) {
    lines.push("body:", ...card.body.split("\n").map((line) => `  ${line}`));
  }
  if (card.notes.length > 0) {
    lines.push("notes:");
    for (const note of card.notes) {
      lines.push(
        `  #${note.id} ${note.text}${note.url ? ` — ${note.url}` : ""} (${note.createdBy}, ${note.createdAt})`,
      );
    }
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
    case "card.dependency_added":
      return `blocked on #${(event.payload as { blockedBy?: number }).blockedBy ?? "?"} by ${who}`;
    case "card.dependency_removed":
      return `unblocked from #${(event.payload as { blockedBy?: number }).blockedBy ?? "?"} by ${who}`;
    case "card.note_added":
      return `added a note by ${who}`;
    case "card.note_updated":
      return `edited a note by ${who}`;
    case "card.note_removed":
      return `removed note #${(event.payload as { note?: number }).note ?? "?"} by ${who}`;
    default:
      return `${event.type} by ${who}`;
  }
}

export function formatMutation(card: Card, verb: string): string {
  return `${verb} ${formatCardBrief(card)}`;
}
