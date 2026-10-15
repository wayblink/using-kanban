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
 * Text rendering for the terminal: compact, greppable, one fact per line.
 * (Each front door formats for its own medium — the Web UI and MCP server
 * have their own renderers.)
 *
 * Every field that came from a card goes through `sanitizeTerminalText` first.
 * Card text is written by whoever ran `ukb add`/`edit`/`note` — any agent, and
 * any human — and this module is where it meets a terminal. Sanitizing happens
 * here and only here: `--json`, the Web UI and the event log keep the raw text.
 * Fields are treated as single-line except `body`, which is split before
 * sanitizing so its own line structure survives.
 */

/**
 * The priority, printed only when it is not the default.
 *
 * `normal` is silent so the common case stays quiet and the word means
 * something when it appears. One style for all three — a bare word — because a
 * line already carries `[state]`, `@assignee` and `project:` markers, and a
 * fourth visual dialect would be one more thing to learn.
 */
function priorityMarker(card: Card): string | null {
  return card.priority === "normal" ? null : card.priority;
}

export function formatCardBrief(card: Card): string {
  const parts = [
    `#${card.id} [${card.state}]`,
    sanitizeTerminalText(card.title),
  ];
  const priority = priorityMarker(card);
  if (priority) parts.push(priority);
  if (card.assignee) parts.push(`@${sanitizeTerminalText(card.assignee)}`);
  if (card.reviewer)
    parts.push(`reviewer:${sanitizeTerminalText(card.reviewer)}`);
  if (card.project) parts.push(`project:${sanitizeTerminalText(card.project)}`);
  if (card.blockedBy.length > 0)
    parts.push(`blocked-by:${card.blockedBy.join(",")}`);
  if (card.blocks.length > 0) parts.push(`blocks:${card.blocks.join(",")}`);
  if (card.notes.length > 0) parts.push(`notes:${card.notes.length}`);
  return parts.join(" ");
}

/**
 * `ukb list` — every project on the board with its card counts.
 *
 * Ordering is the caller's: `Kanban.projectSummary()` sorts (named projects
 * alphabetically, the no-project bucket last), and this renderer prints what it
 * is handed so it stays a pure function of its argument.
 *
 * The counts include `done` so the numbers reconcile against the whole board
 * rather than only open work, and the no-project bucket is printed as
 * `(none)` rather than omitted: those cards exist, and an operator filtering by
 * project needs to know they will never match one.
 */
export function formatProjects(summaries: readonly ProjectSummary[]): string {
  if (summaries.length === 0) {
    return 'no projects yet — ukb add "<title>" --project <slug>';
  }
  const label = (summary: ProjectSummary): string =>
    summary.project === null ? "(none)" : sanitizeTerminalText(summary.project);
  const width = summaries.reduce(
    (widest, summary) => Math.max(widest, label(summary).length),
    0,
  );
  const lines = [`projects (${summaries.length}):`];
  for (const summary of summaries) {
    const counts = [
      `${summary.doing} doing`,
      `${summary.review} review`,
      `${summary.todo} todo`,
      `${summary.someday} someday`,
      `${summary.done} done`,
    ].join(" · ");
    lines.push(`  ${label(summary).padEnd(width)}  ${counts}`);
  }
  lines.push("");
  lines.push("ukb board --project <slug>   see one project");
  return lines.join("\n");
}

export function formatBoard(
  board: Board,
  projects: readonly string[] = [],
): string {
  const columns: [string, readonly Card[]][] = [
    ["someday", board.someday],
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
    // Priority order within the column. The column itself is already the
    // primary grouping, and `someday` is printed first so the shelves read as
    // a separate area rather than the top of the to-do list.
    for (const card of [...cards].sort(compareByPriority)) {
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
  for (const card of [...cards].sort(compareByPriority)) {
    lines.push(`  ${formatCardBrief(card)}`);
  }
  lines.push("");
  const claimable = cards
    .filter((card) => card.state === "todo")
    .sort(compareByPriority);
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
    `#${card.id} ${sanitizeTerminalText(card.title)} [${card.state}]`,
    `assignee: ${sanitizeTerminalText(card.assignee ?? "—")}`,
    `reviewer: ${sanitizeTerminalText(card.reviewer ?? "—")}`,
    `project: ${sanitizeTerminalText(card.project ?? "—")}`,
    `priority: ${card.priority}`,
    `blocked by: ${card.blockedBy.length > 0 ? card.blockedBy.map((id) => `#${id}`).join(", ") : "—"}`,
    `blocks: ${card.blocks.length > 0 ? card.blocks.map((id) => `#${id}`).join(", ") : "—"}`,
    `created by: ${sanitizeTerminalText(card.createdBy)} · revision ${card.revision} · updated ${card.updatedAt}`,
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
