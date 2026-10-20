/**
 * overlay-render.ts — pure rendering for the ukb board overlay.
 *
 * Nothing here imports a Pi module at runtime: the theme, the width truncator,
 * and the visible-width measurer are injected. That keeps the layout a pure
 * function of `(snapshot, options)` and unit-testable without a Pi host.
 * `overlay.ts` owns the widget lifecycle; `index.ts` owns wiring.
 *
 * The overlay shows what the reader can act on first — `doing`, then the `todo`
 * backlog — then the `review` queue, because a review row is work the reader is
 * *waiting* on rather than work they can pick up, then the `someday` shelf.
 *
 * Which states appear at all is the view's `states`, defaulting to the flow plus
 * the shelf and **not** `done`: history is not what the panel is for, and it can
 * grow without bound. Adding `done` back is a config change, and its rows are
 * trimmed first when the budget runs out. That is what keeps the widget bounded
 * on a board with a hundred cards in it.
 *
 * Inside a state, priority orders the rows: `high`, `normal`, `low`. Without
 * it a board with a long backlog interleaves minor work with live work, and the
 * panel stops answering "what should I do next".
 *
 * The order matters more than it looks. On a board where one project has eleven
 * review cards and fourteen todo cards, putting review first hid every piece of
 * available work behind a queue the reader cannot clear — the panel read as
 * "nothing to do" when the opposite was true.
 */

import {
  DEFAULT_OVERLAY_STATES,
  type OverlayGroup,
  type OverlayScope,
} from "./config.js";

/** Widget key registered with Pi's `setWidget`. Rename = the widget disappears. */
export const OVERLAY_WIDGET_KEY = "ukb-board";

export type CardState = "someday" | "todo" | "doing" | "review" | "done";

/**
 * How urgently a card wants attention. In sort order, so the index difference
 * is the priority difference.
 *
 * `low` is minor but still wanted. "Not now" is not here — it is the `someday`
 * state, because urgency and "is this in play" are different questions.
 */
export const CARD_PRIORITIES = ["high", "normal", "low"] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];

/** The subset of a card the overlay renders. */
export interface CardLite {
  readonly id: number;
  readonly title: string;
  readonly state: CardState;
  readonly assignee: string | null;
  readonly reviewer: string | null;
  readonly project: string | null;
  /** Direction inside the project. Absent on brief JSON written before it. */
  readonly subproject?: string | null;
  readonly blockedBy: readonly number[];
  /**
   * The umbrella this card is part of, or null. One level deep: a card is
   * either an umbrella or a child, never both. Absent on older brief JSON.
   */
  readonly parent?: number | null;
  readonly children?: readonly number[];
  /** Absent on brief JSON written before priorities existed. */
  readonly priority?: CardPriority;
}

/** The board as `ukb board --json` writes it. */
export interface BoardSnapshot {
  readonly projects: readonly string[];
  readonly someday: readonly CardLite[];
  readonly todo: readonly CardLite[];
  readonly doing: readonly CardLite[];
  readonly review: readonly CardLite[];
  readonly done: readonly CardLite[];
}

/**
 * The theme surface the renderer uses. Structural on purpose — Pi's `Theme`
 * satisfies it, and a test can pass an identity theme.
 */
export interface OverlayTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
}

export interface OverlayRenderOptions {
  readonly theme: OverlayTheme;
  readonly truncate: (line: string, width: number) => string;
  readonly visibleWidth: (text: string) => number;
  readonly width: number;
  /** Row budget including the heading but excluding the trailing spacer. */
  readonly budget: number;
  readonly collapsed: boolean;
  /** Resolved collapse key, or `"off"` when no shortcut is bound. */
  readonly collapseKey: string;
  /** Visible scope in the heading (`using-kanban`, `mine:pi`, or `all`). */
  readonly scopeLabel?: string;
  /** Row ordering and optional inline group column. */
  readonly groupBy?: OverlayGroup;
  /**
   * Print each card's scope (`project` or `project/subproject`).
   *
   * A card attribute, not a property of the view: the caller sets it in every
   * scope, so a row says where it lives even when the heading already names
   * the project. Grouping by project prints it as the group label, so that case
   * opts out rather than repeating it on every row.
   */
  readonly showProject?: boolean;
  /** Which states to show. Defaults to doing/todo/review/someday. */
  readonly states?: readonly CardState[];
  /**
   * Full-board index for resolving hierarchy progress. Defaults to the
   * snapshot's own cards; pass the unscoped index when rendering a scoped
   * snapshot so `▸done/total` counts children the scope filtered out.
   */
  readonly index?: ReadonlyMap<number, CardLite>;
}

const CARD_STATES: readonly CardState[] = [
  "someday",
  "todo",
  "doing",
  "review",
  "done",
];

/**
 * Display order for rows and for the heading counts: what you can act on,
 * then what you are waiting on, then the shelf, then history. State grouping
 * owns the structure; this owns the sequence.
 */
const DISPLAY_STATE_ORDER: readonly CardState[] = [
  "doing",
  "todo",
  "review",
  "someday",
  "done",
];

/**
 * State marker spelled out in front of every row.
 *
 * An icon-only marker (`○ ◐ ◆ ●`) reads as decoration: a reader has to learn a
 * private legend to know whether a card is being worked on or waiting for
 * review, and the legend is nowhere else in the board. `[doing]` says it in the
 * same words the board's own columns use, so the row is self-describing and a
 * screenshot of the terminal carries its own legend. The cost is six
 * characters of width, which the row budget absorbs — see `renderRow`.
 */
const STATE_TAG: Record<CardState, string> = {
  someday: "[someday]",
  todo: "[todo]",
  doing: "[doing]",
  review: "[review]",
  done: "[done]",
};

/** Label used when a column's name is spelled out in the overflow summary. */
const STATE_LABEL: Record<CardState, string> = {
  someday: "someday",
  todo: "todo",
  doing: "doing",
  review: "review",
  done: "done",
};

/* ------------------------------- sanitize -------------------------------- */

/**
 * Remove terminal control characters from model-authored card text before it
 * reaches Pi's renderer. Complete CSI/OSC sequences are dropped whole (no
 * printable `[31m` remnants), newlines and tabs become spaces so a field cannot
 * change the layout, and bidi controls are removed so a title cannot reorder
 * how neighbouring output reads.
 *
 * A card title is untrusted input — any agent that can `ukb add` can write it.
 *
 * This is a deliberate copy of the canonical implementation in
 * `packages/core/src/sanitize.ts` (which the CLI's renderer uses). Sharing it
 * would need a subpath export on core plus a core dependency here, and any
 * dependency on this package makes pnpm resolve its host-provided peers — a
 * churned lockfile that installs a second copy of pi-tui/typebox in CI. See
 * packages/cli/tests/pi-overlay-parity.test.ts: the two are asserted equal
 * byte-for-byte, so they cannot drift.
 */
/* eslint-disable no-control-regex -- matching control characters is exactly what
   this function is for; the rule guards against accidental ones. */
export function sanitizeTerminalText(value: string): string {
  return (
    value
      // CSI sequences, via both ESC-[ and the C1 single-byte introducer.
      .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
      // OSC sequences with their payload; an unterminated OSC swallows the rest
      // of the string, matching how a real terminal would treat it.
      .replace(
        /(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g,
        "",
      )
      // Any remaining two-character ESC sequence.
      .replace(/\u001b./g, "")
      // Unicode line/paragraph separators join lines like \n does below.
      .replace(/[\u2028\u2029]/g, " ")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
        character === "\n" || character === "\r" || character === "\t"
          ? " "
          : "",
      )
      // Bidi embedding/override/isolate controls and LRM/RLM marks.
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
  );
}
/* eslint-enable no-control-regex */

/* -------------------------------- parsing -------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toCardLite(value: unknown, state: CardState): CardLite | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  const title = value.title;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
  if (typeof title !== "string") return null;
  const priority = stringOrNull(value.priority);
  return {
    id,
    title,
    state,
    assignee: stringOrNull(value.assignee),
    reviewer: stringOrNull(value.reviewer),
    project: stringOrNull(value.project),
    subproject: stringOrNull(value.subproject),
    blockedBy: Array.isArray(value.blockedBy)
      ? value.blockedBy.filter(
          (entry): entry is number => typeof entry === "number",
        )
      : [],
    parent:
      typeof value.parent === "number" &&
      Number.isInteger(value.parent) &&
      value.parent > 0
        ? value.parent
        : null,
    children: Array.isArray(value.children)
      ? value.children.filter(
          (entry): entry is number =>
            typeof entry === "number" && Number.isInteger(entry) && entry > 0,
        )
      : [],
    priority:
      priority !== null &&
      (CARD_PRIORITIES as readonly string[]).includes(priority)
        ? (priority as CardPriority)
        : "normal",
  };
}

/**
 * Decode `ukb board --json`. Returns `null` for anything we cannot trust —
 * empty output, an error message, a shape missing a column — so the caller can
 * hide the widget instead of rendering a half-board.
 *
 * A single malformed card is skipped rather than failing the whole snapshot:
 * one bad row should not blank the overlay.
 */
export function parseBoardJson(text: string): BoardSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const columns: Record<CardState, CardLite[]> = {
    someday: [],
    todo: [],
    doing: [],
    review: [],
    done: [],
  };
  for (const state of CARD_STATES) {
    const raw = parsed[state];
    // `someday` is newer than the four flow columns, so a brief snapshot from an
    // older CLI may not carry it. Treat a missing column as empty rather than
    // rejecting the whole board; the other four are still required, so a shape
    // that is broken in the original way still hides the widget.
    if (raw === undefined && state === "someday") continue;
    if (!Array.isArray(raw)) return null;
    columns[state] = raw
      .map((entry) => toCardLite(entry, state))
      .filter((card): card is CardLite => card !== null);
  }

  const projects = Array.isArray(parsed.projects)
    ? parsed.projects.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];

  return {
    projects,
    someday: columns.someday,
    todo: columns.todo,
    doing: columns.doing,
    review: columns.review,
    done: columns.done,
  };
}

/* ------------------------------- selectors ------------------------------- */

export interface OverlayCounts {
  readonly someday: number;
  readonly todo: number;
  readonly doing: number;
  readonly review: number;
  readonly done: number;
}

export interface OverlayView {
  readonly scope: OverlayScope;
  readonly project: string | null;
  readonly agent: string;
  readonly groupBy: OverlayGroup;
  /**
   * Content-row budget including the heading. Part of the view rather than a
   * separate setting so `/ukb gui show lines=30` can raise it for one
   * session without touching the configured default.
   */
  readonly maxLines: number;
  /**
   * Which states the panel shows. A display setting like `groupBy`, so it
   * travels with the view and `/ukb gui show states=…` can override it for one
   * session. Defaults to doing/todo/review/someday — the shelf is visible, the
   * history is not.
   */
  readonly states: readonly CardState[];
}

export interface ScopedBoard {
  readonly snapshot: BoardSnapshot;
  readonly label: string;
}

/** Apply the view before counts, overflow and auto-hide are calculated. */
export function scopeBoard(
  snapshot: BoardSnapshot,
  view: OverlayView,
): ScopedBoard {
  let include: (card: CardLite) => boolean;
  let label: string;
  if (view.scope === "all") {
    include = () => true;
    label = "all";
  } else if (view.scope === "mine") {
    include = (card) =>
      card.assignee === view.agent || card.reviewer === view.agent;
    label = `mine:${view.agent}`;
  } else if (view.project) {
    include = (card) => card.project === view.project;
    label = view.project;
  } else {
    // Git-less / anonymous cwd: do not turn a healthy board into an invisible
    // empty widget. The heading says `all`, making the fallback explicit.
    include = () => true;
    label = "all";
  }

  return {
    label,
    snapshot: {
      projects: snapshot.projects,
      someday: snapshot.someday.filter(include),
      todo: snapshot.todo.filter(include),
      doing: snapshot.doing.filter(include),
      review: snapshot.review.filter(include),
      done: snapshot.done.filter(include),
    },
  };
}

export function countCards(snapshot: BoardSnapshot): OverlayCounts {
  return {
    someday: snapshot.someday.length,
    todo: snapshot.todo.length,
    doing: snapshot.doing.length,
    review: snapshot.review.length,
    done: snapshot.done.length,
  };
}

/** Every card in a snapshot, by id — for resolving ids a row references. */
export function cardIndex(snapshot: BoardSnapshot): Map<number, CardLite> {
  const index = new Map<number, CardLite>();
  for (const state of CARD_STATES) {
    for (const card of snapshot[state]) index.set(card.id, card);
  }
  return index;
}

/** Open work: everything not in `done`. Zero means there is nothing to watch. */
export function openCardCount(snapshot: BoardSnapshot): number {
  return snapshot.todo.length + snapshot.doing.length + snapshot.review.length;
}

/**
 * How many cards the panel accounts for given its displayed states. This is the
 * auto-hide test: zero means there is nothing to watch, so the caller
 * unregisters rather than leaving an empty banner. Unlike `openCardCount` it
 * honours the configured states — a project whose only visible cards are on the
 * shelf still gets a panel.
 */
export function visibleCardCount(
  snapshot: BoardSnapshot,
  states: readonly CardState[] = DEFAULT_OVERLAY_STATES,
): number {
  let total = 0;
  for (const state of states) total += snapshot[state].length;
  return total;
}

export interface OverlayRow {
  readonly card: CardLite;
  readonly state: CardState;
  /** Inline group column. Only the first row in a group prints the label. */
  readonly groupLabel: string | null;
  readonly groupStart: boolean;
  /** True for a child rendered under its umbrella, indented one level. */
  readonly nested: boolean;
}

export interface OverlayLayout {
  readonly rows: readonly OverlayRow[];
  readonly hidden: readonly OverlayRow[];
}

function byId(cards: readonly CardLite[]): readonly CardLite[] {
  return [...cards].sort(compareByPriority);
}

/**
 * Reading order inside one state: priority, then id.
 *
 * A deliberate copy of `compareByPriority` in `packages/core`, for the same
 * reason the sanitizer is a copy — see the note on `sanitizeTerminalText`.
 * `packages/cli/tests/pi-overlay-parity.test.ts` keeps the two honest.
 */
function compareByPriority(a: CardLite, b: CardLite): number {
  return (
    CARD_PRIORITIES.indexOf(a.priority ?? "normal") -
      CARD_PRIORITIES.indexOf(b.priority ?? "normal") || a.id - b.id
  );
}

/** Row order within a group: what you can act on, then the shelf, then history. */
const STATE_ORDER: Record<CardState, number> = {
  doing: 0,
  todo: 1,
  review: 2,
  someday: 3,
  done: 4,
};

function ownerGroup(card: CardLite): string {
  if (card.state === "review")
    return card.reviewer ? `@${card.reviewer}` : "review queue";
  return card.assignee ? `@${card.assignee}` : "unassigned";
}

/**
 * A card's scope as one token: `project` or `project/subproject`.
 *
 * The same spelling the CLI and the card badge use, so a direction is named
 * one way everywhere.
 */
export function cardScope(card: CardLite): string | null {
  if (!card.project) return null;
  return card.subproject ? `${card.project}/${card.subproject}` : card.project;
}

function groupedRows(
  cards: readonly CardLite[],
  groupBy: "project" | "owner",
): OverlayRow[] {
  const keyed = cards.map((card) => ({
    card,
    label:
      groupBy === "project"
        ? (cardScope(card) ?? "no project")
        : ownerGroup(card),
  }));
  keyed.sort(
    (a, b) =>
      a.label.localeCompare(b.label) ||
      STATE_ORDER[a.card.state] - STATE_ORDER[b.card.state] ||
      compareByPriority(a.card, b.card),
  );
  let previous: string | null = null;
  return keyed.map(({ card, label }) => {
    const row: OverlayRow = {
      card,
      state: card.state,
      groupLabel: label,
      groupStart: label !== previous,
      nested: false,
    };
    previous = label;
    return row;
  });
}

/**
 * Rows in display order — doing, todo, review, someday, done (only the states
 * the view displays) — trimmed to fit `bodyBudget`. When anything is trimmed
 * one row is reserved for the overflow summary, so `rows.length + 1 <=
 * bodyBudget` on the overflow path.
 *
 * **Hierarchy nests.** An umbrella is a top-level row and its children follow
 * it, indented one level, whatever state they are in — a `review` child of a
 * `todo` umbrella sits under the umbrella, not in the review group. A card
 * whose parent is not displayed (hidden state, or filtered out by scope) is a
 * top-level row and keeps its `⤷#parent` marker. Children are never repeated in
 * their own group: one card, one row.
 *
 * Earlier states win the budget: `doing` is only ever dropped when it alone
 * exceeds it, and the tail (the shelf, then history) goes first. A card someone
 * is working on is the last thing to vanish.
 */
export function selectOverlayRows(
  snapshot: BoardSnapshot,
  bodyBudget: number,
  groupBy: OverlayGroup = "state",
  states: readonly CardState[] = DEFAULT_OVERLAY_STATES,
): OverlayLayout {
  const shown = DISPLAY_STATE_ORDER.filter((state) => states.includes(state));
  // The column is authoritative. Tests deliberately reuse a card fixture with
  // a stale `state`, and old JSON producers may do the same.
  const cards: CardLite[] = shown.flatMap((state) =>
    snapshot[state].map((card) => ({ ...card, state })),
  );

  const displayed = new Map(cards.map((card) => [card.id, card]));
  const childrenByParent = new Map<number, CardLite[]>();
  const roots: CardLite[] = [];
  for (const card of cards) {
    const parent = card.parent ?? null;
    if (parent !== null && displayed.has(parent)) {
      const list = childrenByParent.get(parent) ?? [];
      list.push(card);
      childrenByParent.set(parent, list);
    } else {
      roots.push(card);
    }
  }
  for (const list of childrenByParent.values()) list.sort(compareByPriority);

  const rootRows: OverlayRow[] =
    groupBy === "project" || groupBy === "owner"
      ? groupedRows(roots, groupBy)
      : (groupBy === "none"
          ? byId(roots)
          : shown.flatMap((state) =>
              byId(roots.filter((card) => card.state === state)),
            )
        ).map((card) => ({
          card,
          state: card.state,
          groupLabel: null,
          groupStart: false,
          nested: false,
        }));

  const all: OverlayRow[] = [];
  for (const row of rootRows) {
    all.push(row);
    for (const child of childrenByParent.get(row.card.id) ?? []) {
      all.push({
        card: child,
        state: child.state,
        groupLabel: row.groupLabel,
        groupStart: false,
        nested: true,
      });
    }
  }

  if (all.length <= bodyBudget) return { rows: all, hidden: [] };

  const visibleCount = Math.max(0, bodyBudget - 1);
  return {
    rows: all.slice(0, visibleCount),
    hidden: all.slice(visibleCount),
  };
}

/* ------------------------------- rendering ------------------------------- */

/** Counts in the same order as the rows, so the panel reads top to bottom. */
function headingSegments(
  counts: OverlayCounts,
  states: readonly CardState[],
): string {
  const parts: string[] = [];
  for (const state of DISPLAY_STATE_ORDER) {
    if (!states.includes(state)) continue;
    if (counts[state] > 0) parts.push(`${counts[state]} ${STATE_LABEL[state]}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "empty";
}

/**
 * The priority as a bracketed tag, always printed.
 *
 * It sits immediately after the state tag, so the two attributes read as a pair
 * (`[todo][high]`) and the eye takes them in before the id.
 *
 * `normal` prints too. Suppressing it would save six characters on most rows,
 * but a row without the tag reads as malformed next to rows that have one, and
 * the reader cannot tell "normal" from "this card predates priorities" — which
 * matters, because the two sort differently against a `low` card.
 */
function priorityTag(card: CardLite): string {
  return `[${card.priority ?? "normal"}]`;
}

/**
 * Who the row is waiting on: the assignee while doing, the reviewer in review.
 *
 * A review row with no reviewer prints nothing. `[review]` at the front already
 * says the card is sitting in the review column, so `→ review` would repeat the
 * tag without naming anybody; the suffix only earns its width when it points at
 * a person who can be chased.
 */
function ownerSuffix(row: OverlayRow): string {
  if (row.state === "doing") return `@${row.card.assignee ?? "unassigned"}`;
  if (row.state === "review" && row.card.reviewer)
    return `→ ${row.card.reviewer}`;
  if (row.state === "todo" && row.card.assignee) return `@${row.card.assignee}`;
  return "";
}

/**
 * Hierarchy markers appended to a row: `⤷#38` names the umbrella, `▸4/6` is an
 * umbrella's derived progress. Distinct from the `⛓`-style dependency marks —
 * composition and order are different questions. Returns "" when neither
 * applies, so a leaf row stays exactly as wide as before.
 */
function hierarchySuffix(
  card: CardLite,
  byId: ReadonlyMap<number, CardLite>,
  nested = false,
): string {
  const parts: string[] = [];
  // A nested row already sits under its umbrella, so the parent marker would
  // repeat the indentation in words.
  if (!nested && card.parent != null) parts.push(`⤷#${card.parent}`);
  const children = card.children ?? [];
  if (children.length > 0) {
    const resolved = children
      .map((id) => byId.get(id))
      .filter((child): child is CardLite => child !== undefined);
    // `done` is the whole of "finished" in the overlay's copy of the rule.
    parts.push(
      resolved.length === children.length
        ? `▸${resolved.filter((child) => child.state === "done").length}/${children.length}`
        : `▸${children.length}`,
    );
  }
  return parts.join(" ");
}

function summarizeHidden(hidden: readonly OverlayRow[]): string {
  const counts: Record<CardState, number> = {
    someday: 0,
    todo: 0,
    doing: 0,
    review: 0,
    done: 0,
  };
  for (const row of hidden) counts[row.state] += 1;
  const parts: string[] = [];
  for (const state of DISPLAY_STATE_ORDER) {
    if (counts[state] > 0) parts.push(`${counts[state]} ${STATE_LABEL[state]}`);
  }
  // The command is on the line that needs it. A count of hidden rows with no
  // way to see them is a dead end, and the affordance is one short command.
  return `+${hidden.length} more (${parts.join(", ")}) — /ukb gui more`;
}

/**
 * Render one visible row, padded so the owner column lines up. The card text is
 * sanitized and the whole line is width-truncated by the injected `truncate`.
 */
function renderRow(
  row: OverlayRow,
  theme: OverlayTheme,
  truncate: (line: string, width: number) => string,
  visibleWidth: (text: string) => number,
  width: number,
  groupColumn: number,
  ownerColumn: number,
  last: boolean,
  byId: ReadonlyMap<number, CardLite>,
  showProject: boolean,
): string {
  const connector = theme.fg("dim", last ? "└─" : "├─");
  const stateColor =
    row.state === "doing"
      ? "warning"
      : row.state === "review"
        ? "accent"
        : row.state === "done"
          ? "muted"
          : "dim";
  const title = sanitizeTerminalText(row.card.title);
  const rawGroup = row.groupStart
    ? sanitizeTerminalText(row.groupLabel ?? "")
    : "";
  const groupPad =
    groupColumn > 0
      ? " ".repeat(Math.max(0, groupColumn - visibleWidth(rawGroup)))
      : "";
  const plainGroup = groupColumn > 0 ? `${rawGroup}${groupPad} ` : "";
  const coloredGroup =
    groupColumn > 0
      ? `${rawGroup ? theme.fg("muted", rawGroup) : ""}${groupPad} `
      : "";
  const priority = priorityTag(row.card);
  const hierarchy = hierarchySuffix(row.card, byId, row.nested);
  const hierarchyText = hierarchy ? ` ${hierarchy}` : "";
  const scope = showProject ? cardScope(row.card) : null;
  const scopeText = scope ? ` ${sanitizeTerminalText(scope)}` : "";
  const indent = row.nested ? "  " : "";
  const frozen = `${indent}${plainGroup}${STATE_TAG[row.state]}${priority ? priority : ""}${scopeText} #${row.card.id} ${title}${hierarchyText}`;
  const titleColor = row.state === "doing" ? "text" : "dim";
  const colored = `${coloredGroup}${theme.fg(stateColor, STATE_TAG[row.state])}${priority ? theme.fg("warning", priority) : ""}${scope ? ` ${theme.fg("muted", scope)}` : ""} ${theme.fg("accent", `#${row.card.id}`)} ${theme.fg(titleColor, title)}${hierarchy ? ` ${theme.fg("muted", hierarchy)}` : ""}`;

  const owner = ownerSuffix(row);
  const gap =
    owner && ownerColumn > 0
      ? " ".repeat(Math.max(2, ownerColumn - visibleWidth(frozen) + 2))
      : "";
  const suffix = owner ? `${gap}${theme.fg("muted", owner)}` : "";
  return truncate(`${indent}${connector} ${colored}${suffix}`, width);
}

/**
 * The widget body. Returns `[]` when nothing the view displays has any cards —
 * the caller unregisters the widget rather than leaving an idle banner above
 * the editor.
 */
export function renderOverlay(
  snapshot: BoardSnapshot,
  options: OverlayRenderOptions,
): string[] {
  const states = options.states ?? DEFAULT_OVERLAY_STATES;
  // Nothing visible means nothing to watch — the caller unregisters the widget.
  if (visibleCardCount(snapshot, states) === 0) return [];

  const counts = countCards(snapshot);
  const inFlight = counts.doing + counts.review;
  const active = inFlight > 0;
  const accent = active ? "accent" : "dim";
  const icon = active ? "●" : "○";
  const scope = options.scopeLabel ? ` · ${options.scopeLabel}` : "";
  const heading = options.truncate(
    `${options.theme.fg(accent, icon)} ${options.theme.fg(accent, options.theme.bold("ukb"))}${options.theme.fg("dim", `${scope} · ${headingSegments(counts, states)}`)}`,
    options.width,
  );

  if (options.collapsed) {
    const hint =
      options.collapseKey === "off"
        ? "collapsed"
        : `${options.collapseKey} to expand`;
    return [
      heading,
      options.truncate(options.theme.fg("dim", `└─ ${hint}`), options.width),
      "",
    ];
  }

  const bodyBudget = Math.max(0, options.budget - 1);
  const { rows, hidden } = selectOverlayRows(
    snapshot,
    bodyBudget,
    options.groupBy,
    states,
  );

  // Resolve children against the full board when the caller supplied one, so
  // `▸done/total` counts a child the scope filtered out (another project, or
  // `mine`). Falling back to the snapshot is fine for an unscoped board.
  const byId = options.index ?? cardIndex(snapshot);

  const groupColumn = rows.reduce(
    (widest, row) =>
      Math.max(
        widest,
        row.groupLabel
          ? options.visibleWidth(sanitizeTerminalText(row.groupLabel))
          : 0,
      ),
    0,
  );
  const ownerColumn = rows.reduce((widest, row) => {
    if (!ownerSuffix(row)) return widest;
    const groupWidth = groupColumn > 0 ? groupColumn + 1 : 0;
    const indent = row.nested ? 2 : 0;
    const hierarchy = hierarchySuffix(row.card, byId, row.nested);
    return Math.max(
      widest,
      indent +
        groupWidth +
        options.visibleWidth(
          `${STATE_TAG[row.state]}${priorityTag(row.card)}${
            options.showProject && cardScope(row.card)
              ? ` ${sanitizeTerminalText(cardScope(row.card) ?? "")}`
              : ""
          } #${row.card.id} ${sanitizeTerminalText(row.card.title)}${hierarchy ? ` ${hierarchy}` : ""}`,
        ),
    );
  }, 0);

  const lines: string[] = [heading];
  const summary = hidden.length > 0 ? summarizeHidden(hidden) : "";
  const showSummary = summary !== "" && bodyBudget >= 1;
  rows.forEach((row, index) => {
    const last = index === rows.length - 1 && !showSummary;
    lines.push(
      renderRow(
        row,
        options.theme,
        options.truncate,
        options.visibleWidth,
        options.width,
        groupColumn,
        ownerColumn,
        last,
        byId,
        options.showProject ?? false,
      ),
    );
  });
  if (showSummary) {
    lines.push(
      options.truncate(options.theme.fg("dim", `└─ ${summary}`), options.width),
    );
  }

  // Trailing blank row so the panel is not flush against the input box.
  lines.push("");
  return lines;
}
