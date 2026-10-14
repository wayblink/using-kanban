import type {
  Board,
  Card,
  Event,
  ProjectSummary,
} from "@wayblink/using-kanban-core";
import {
  compareByPriority,
  sanitizeTerminalBlock,
  sanitizeTerminalText,
} from "@wayblink/using-kanban-core";

/**
 * Compact, greppable text renderings. Agents read these directly, so the
 * output favours one-fact-per-line over pretty boxes.
 *
 * Card text is untrusted — whoever ran `ukb add`/`edit`/`note` wrote it — and
 * this door has no `--json` equivalent, so these strings are the only copy the
 * caller ever sees. Same policy as the CLI renderer: sanitize on the way out,
 * and split `body` before sanitizing so its own line structure survives.
 */
export function formatCardBrief(card: Card): string {
  const parts = [
    `#${card.id} [${card.state}]`,
    sanitizeTerminalText(card.title),
  ];
  if (card.assignee) parts.push(`@${sanitizeTerminalText(card.assignee)}`);
  if (card.reviewer)
    parts.push(`reviewer:${sanitizeTerminalText(card.reviewer)}`);
  if (card.project) parts.push(`project:${sanitizeTerminalText(card.project)}`);
  // Only when it is not the default, so the common case stays quiet.
  if (card.priority !== "normal") parts.push(card.priority);
  if (card.blockedBy.length > 0)
    parts.push(`blocked-by:${card.blockedBy.join(",")}`);
  if (card.blocks.length > 0) parts.push(`blocks:${card.blocks.join(",")}`);
  if (card.notes.length > 0) parts.push(`notes:${card.notes.length}`);
  return parts.join(" ");
}

/**
 * Every project with its card counts.
 *
 * Counts include `done`, so the rows reconcile against the whole board. The
 * no-project bucket is printed as `(none)` rather than dropped — those cards
 * exist, and an agent about to filter by project needs to know they will never
 * match one.
 */
export function formatProjects(
  summaries: readonly ProjectSummary[],
  emptyMessage = "No projects in use yet — cards have no project until one is set.",
): string {
  if (summaries.length === 0) return emptyMessage;
  return summaries
    .map((summary) => {
      const name =
        summary.project === null
          ? "(none)"
          : sanitizeTerminalText(summary.project);
      return `${name}: ${summary.doing} doing, ${summary.review} review, ${summary.todo} todo, ${summary.done} done`;
    })
    .join("\n");
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
    // Priority order within the column, so a shelved card does not sit above
    // live work. Shared with the CLI so the two doors cannot disagree.
    for (const card of [...cards].sort(compareByPriority)) {
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
    `#${card.id} ${sanitizeTerminalText(card.title)} [${card.state}]`,
    `assignee: ${sanitizeTerminalText(card.assignee ?? "—")}`,
    `project: ${sanitizeTerminalText(card.project ?? "—")}`,
    `reviewer: ${sanitizeTerminalText(card.reviewer ?? "—")}`,
    `blocked by: ${card.blockedBy.length > 0 ? card.blockedBy.map((id) => `#${id}`).join(", ") : "—"}`,
    `blocks: ${card.blocks.length > 0 ? card.blocks.map((id) => `#${id}`).join(", ") : "—"}`,
    `created by: ${sanitizeTerminalText(card.createdBy)}  ·  revision ${card.revision}  ·  updated ${card.updatedAt}`,
  ];
  if (card.body) {
    lines.push(
      "body:",
      ...sanitizeTerminalBlock(card.body).map((bodyLine) => `  ${bodyLine}`),
    );
  }
  if (card.notes.length > 0) {
    lines.push("notes:");
    for (const note of card.notes) {
      lines.push(
        `  #${note.id} ${sanitizeTerminalText(note.text)}${note.url ? ` — ${sanitizeTerminalText(note.url)}` : ""} (${sanitizeTerminalText(note.createdBy)}, ${note.createdAt})`,
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
  const who = sanitizeTerminalText(
    `${event.actor.type}/${event.actor.name} via ${event.source}`,
  );
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
    case "card.note_added":
      return `added a note by ${who}`;
    case "card.note_updated":
      return `edited a note by ${who}`;
    case "card.note_removed": {
      const payload = event.payload as { note?: number };
      return `removed note #${payload.note ?? "?"} by ${who}`;
    }
    default:
      return `${event.type} by ${who}`;
  }
}
