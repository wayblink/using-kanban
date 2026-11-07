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
 * Which states appear at all is the view's `states`, defaulting to the flow and
 * **not** `done` or the `someday` shelf: history is not what the panel is for,
 * and it can grow without bound, while a shelf of parked work is noise on a
 * board that already has plenty to do. The shelf joins the panel only when the
 * flow is quiet (see `SOMEDAY_VISIBLE_BELOW`) — a parked card you cannot see is
 * a parked card you forget, so it must not be invisible on an idle board, but
 * it must not compete with live work either. That fallback belongs to a panel
 * that is the only one on screen: when a second pane is pinned to the shelf, the
 * left pane does not borrow it (`shelfElsewhere`), because the same parked rows
 * in both columns are worse than either pane alone. Adding either state back is
 * a config change, and rows are trimmed by the budget first. That is what keeps
 * the widget bounded on a board with a hundred cards in it.
 *
 * Inside a state, recency orders the rows: whatever was touched last sits on
 * top, which is the working set. Priority and then id break ties, so a board
 * whose brief JSON predates `updatedAt` (or a batch written at one instant)
 * still has a stable order — the same one it had before.
 *
 * An umbrella never gets split by that ordering: it sorts by the newest card
 * anywhere in its subtree and keeps its parts directly beneath it, so a fresh
 * part lifts its umbrella rather than escaping from it.
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
   * When the card last changed. `null` on brief JSON from a producer that
   * predates the field (and on a card nothing has been done to yet).
   */
  readonly updatedAt: string | null;
  /**
   * The umbrella this card is part of, or null. Absent on older brief JSON.
   * Hierarchies nest to any depth, so an umbrella can itself be a part.
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
   * The `someday` fallback is off because another pane already renders it.
   *
   * The fallback exists so a quiet board does not hide parked work; with a
   * second pane pinned to the shelf, that work is already on screen and the
   * fallback would print the same rows in both columns. Only the heuristic is
   * suppressed: a view that names `someday` itself still gets it, because an
   * explicit request outranks any heuristic in both directions.
   */
  readonly shelfElsewhere?: boolean;
  /**
   * Full-board index for resolving hierarchy progress. Defaults to the
   * snapshot's own cards; pass the unscoped index when rendering a scoped
   * snapshot so `▸done/total` counts children the scope filtered out.
   */
  readonly index?: ReadonlyMap<number, CardLite> | undefined;
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
    updatedAt: stringOrNull(value.updatedAt),
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

/**
 * The second pane's own view of the board.
 *
 * `scope` and `groupBy` are null when the pane should follow the left one, which
 * is the default: a panel scoped to this repository should not quietly show
 * another project's shelf. `states` is never inherited — the point of the pane
 * is a fixed shelf.
 */
export interface OverlayRightView {
  readonly scope: OverlayScope | null;
  readonly project: string | null;
  readonly states: readonly CardState[];
  readonly groupBy: OverlayGroup | null;
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
  /** Show the second pane beside the flow. Off by default. */
  readonly split: boolean;
  readonly right: OverlayRightView;
}

/** The view the second pane renders with, with inheritance resolved. */
export function rightPaneView(view: OverlayView): OverlayView {
  return {
    scope: view.right.scope ?? view.scope,
    project: view.right.project ?? view.project,
    agent: view.agent,
    groupBy: view.right.groupBy ?? view.groupBy,
    maxLines: view.maxLines,
    states: view.right.states,
    // The pane does not recurse: a split inside a split is not a layout.
    split: false,
    right: view.right,
  };
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
 * How many cards the rest of the panel may hold before the shelf is dropped.
 *
 * `someday` is a fallback, not a column the reader works from: while the flow
 * (doing/todo/review) holds this many cards or more, a parked card is noise —
 * but on a quiet board it is the only thing left worth showing, and a card you
 * cannot see is a card you forget. An idle board must never look broken.
 */
export const SOMEDAY_VISIBLE_BELOW = 5;

/**
 * The states the panel actually renders.
 *
 * The default view is the flow; the `someday` shelf joins it while fewer than
 * `SOMEDAY_VISIBLE_BELOW` cards are visible, and drops out again when the board
 * is busy enough to fill the panel on its own. A view that names its own states
 * — `overlay.states` in the config, `states=` on `/ukb gui` — is taken exactly
 * as written: a deliberate request outranks a heuristic, in both directions.
 *
 * `shelfElsewhere` turns the fallback off for a pane that is not the only one:
 * when a sibling pane is already pinned to the shelf, joining it would show the
 * same rows twice. The heuristic is what is dropped; `states` is untouched, so
 * an explicit request survives.
 */
export function effectiveStates(
  snapshot: BoardSnapshot,
  states: readonly CardState[] = DEFAULT_OVERLAY_STATES,
  options: { readonly shelfElsewhere?: boolean } = {},
): readonly CardState[] {
  if (!isDefaultView(states)) return states;
  // A copy, not the constant: `selectOverlayRows` and `visibleCardCount`
  // re-derive the states from whatever they are handed, and the default list
  // is recognised by identity, so returning the constant would let the very
  // next call put the shelf back.
  if (options.shelfElsewhere === true) return [...states];
  let visible = 0;
  for (const state of states) visible += snapshot[state].length;
  return visible < SOMEDAY_VISIBLE_BELOW ? [...states, "someday"] : states;
}

/**
 * Whether a view is the default one, i.e. nobody asked for a state list.
 *
 * Identity, not value: the default is one shared constant that
 * `resolveOverlayStates` hands back untouched, so a list the caller built —
 * even one that spells out the same three states — is an explicit request and
 * is taken as written. That is what lets `states=doing,todo,review` mean "the
 * flow only" to someone who does not want the shelf back on a quiet board.
 */
function isDefaultView(states: readonly CardState[]): boolean {
  return states === DEFAULT_OVERLAY_STATES;
}

/**
 * How many cards the panel accounts for given its displayed states. This is the
 * auto-hide test: zero means there is nothing to watch, so the caller
 * unregisters rather than leaving an empty banner. Unlike `openCardCount` it
 * honours the displayed states — a project whose only visible cards are on the
 * shelf still gets a panel, because the shelf joins an otherwise quiet view.
 */
export function visibleCardCount(
  snapshot: BoardSnapshot,
  states: readonly CardState[] = DEFAULT_OVERLAY_STATES,
): number {
  let total = 0;
  for (const state of effectiveStates(snapshot, states))
    total += snapshot[state].length;
  return total;
}

export interface OverlayRow {
  readonly card: CardLite;
  readonly state: CardState;
  /** Inline group column. Only the first row in a group prints the label. */
  readonly groupLabel: string | null;
  readonly groupStart: boolean;
  /**
   * How far below the root of its subtree this row sits: 0 for a top-level
   * card, 1 for a part, 2 for a part of a part, and so on. An umbrella's parts
   * are indented by it, whatever state they are in.
   */
  readonly depth: number;
}

export interface OverlayLayout {
  readonly rows: readonly OverlayRow[];
  readonly hidden: readonly OverlayRow[];
}

/** A comparator that puts the most recently touched card first. */
type CardOrder = (a: CardLite, b: CardLite) => number;

/**
 * Reading order tiebreak inside one state: priority, then id.
 *
 * Recency leads (see `selectOverlayRows`); these two are what makes a board
 * whose brief JSON carries no `updatedAt`, or a batch of cards written in the
 * same instant, come out in a stable order.
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

/**
 * A card's own last-change instant in ms, or 0 when the snapshot does not say.
 *
 * `Date.parse` rather than a string compare: the log writes the offset that was
 * current when the event happened, so a lexicographic order would file `+08:00`
 * and `Z` in the wrong sequence.
 */
function touchedAt(card: CardLite): number {
  if (!card.updatedAt) return 0;
  const parsed = Date.parse(card.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
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
  order: CardOrder,
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
      order(a.card, b.card),
  );
  let previous: string | null = null;
  return keyed.map(({ card, label }) => {
    const row: OverlayRow = {
      card,
      state: card.state,
      groupLabel: label,
      groupStart: label !== previous,
      depth: 0,
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
 * **Hierarchy nests, to any depth.** An umbrella is a row and its parts follow
 * it, each indented one step per level below it, whatever state they are in — a
 * `review` part of a `todo` umbrella sits under the umbrella, not in the review
 * group, and a part of that part follows it. A card whose parent is not
 * displayed (hidden state, or filtered out by scope) is a top-level row and
 * keeps its `⤷#parent` marker. Parts are never repeated in their own group: one
 * card, one row.
 *
 * **Recency orders the rows, and an umbrella is never split by it.** Inside a
 * state the last-touched card goes first; priority and then id break ties so a
 * snapshot without timestamps keeps the order it always had. An umbrella sorts
 * by the newest card anywhere in its subtree, so a fresh part lifts its own
 * umbrella instead of jumping out from under it, and its parts are ordered the
 * same way among themselves — each by its own subtree, so a phase looks as
 * fresh as the task someone just touched inside it.
 *
 * A state the view does not display is not displayed anywhere, including
 * nested: a `someday` part of a `todo` umbrella has no row while the shelf is
 * off. It still counts in the umbrella's `▸done/total`, because progress is a
 * property of the subtree rather than of what happens to fit on screen.
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
  const shown = DISPLAY_STATE_ORDER.filter((state) =>
    effectiveStates(snapshot, states).includes(state),
  );
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
  // Recency is the reading order, and an umbrella counts as fresh as the
  // freshest card anywhere in it — so a part touched today lifts its umbrella
  // instead of escaping from underneath it.
  const newestAt = new Map<number, number>();
  const subtreeRecency = (card: CardLite): number => {
    const cached = newestAt.get(card.id);
    if (cached !== undefined) return cached;
    let newest = touchedAt(card);
    for (const child of childrenByParent.get(card.id) ?? [])
      newest = Math.max(newest, subtreeRecency(child));
    newestAt.set(card.id, newest);
    return newest;
  };
  const compareByRecency: CardOrder = (a, b) =>
    subtreeRecency(b) - subtreeRecency(a) || compareByPriority(a, b);
  const sortCards = (list: readonly CardLite[]): readonly CardLite[] =>
    [...list].sort(compareByRecency);

  for (const list of childrenByParent.values()) list.sort(compareByRecency);

  const rootRows: OverlayRow[] =
    groupBy === "project" || groupBy === "owner"
      ? groupedRows(roots, groupBy, compareByRecency)
      : (groupBy === "none"
          ? sortCards(roots)
          : shown.flatMap((state) =>
              sortCards(roots.filter((card) => card.state === state)),
            )
        ).map((card) => ({
          card,
          state: card.state,
          groupLabel: null,
          groupStart: false,
          depth: 0,
        }));

  // Parts follow their umbrella at any depth, and none of them is repeated in
  // the group its own state belongs to: one card, one row.
  const all: OverlayRow[] = [];
  const appendSubtree = (
    card: CardLite,
    depth: number,
    groupLabel: string | null,
  ): void => {
    all.push({
      card,
      state: card.state,
      groupLabel,
      groupStart: false,
      depth,
    });
    for (const child of childrenByParent.get(card.id) ?? []) {
      appendSubtree(child, depth + 1, groupLabel);
    }
  };
  for (const row of rootRows) {
    all.push(row);
    for (const child of childrenByParent.get(row.card.id) ?? []) {
      appendSubtree(child, 1, row.groupLabel);
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
  const hierarchy = hierarchySuffix(row.card, byId, row.depth > 0);
  const hierarchyText = hierarchy ? ` ${hierarchy}` : "";
  const scope = showProject ? cardScope(row.card) : null;
  const scopeText = scope ? ` ${sanitizeTerminalText(scope)}` : "";
  const indent = "  ".repeat(row.depth);
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
/**
 * Narrowest half that is worth rendering. Below this, two columns hold two
 * truncated headings and the split costs more than it shows.
 */
export const MIN_SPLIT_COLUMN = 24;

export interface SplitColumnsOptions {
  readonly width: number;
  /** Already themed: the caller owns the colour of what sits between panes. */
  readonly gap: string;
  readonly truncate: (line: string, width: number) => string;
  readonly visibleWidth: (text: string) => number;
}

/**
 * Two rendered panels, side by side.
 *
 * The left pane takes half the width and the right pane the remainder, so the
 * pair always fills exactly the width it was given — a fixed right pane would
 * leave a ragged edge whenever the terminal was resized. Rows are padded to the
 * column width (a shorter pane shows blanks, it does not shift), and a line
 * longer than its half is truncated rather than allowed to run under the
 * neighbour. Too narrow to split, the left pane is returned alone: a split that
 * cannot be read is worse than the single pane it replaced.
 */
export function renderSplitColumns(
  left: readonly string[],
  right: readonly string[],
  options: SplitColumnsOptions,
): string[] {
  const gapWidth = options.visibleWidth(options.gap);
  const leftWidth = Math.floor((options.width - gapWidth) / 2);
  const rightWidth = options.width - gapWidth - leftWidth;
  if (leftWidth < MIN_SPLIT_COLUMN || rightWidth < MIN_SPLIT_COLUMN) {
    return trimTrailingBlanks([...left]);
  }

  const pad = (line: string, width: number): string => {
    const clipped = options.truncate(line, width);
    return (
      clipped + " ".repeat(Math.max(0, width - options.visibleWidth(clipped)))
    );
  };

  const height = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let index = 0; index < height; index += 1) {
    const leftLine = pad(left[index] ?? "", leftWidth);
    const rightLine = pad(right[index] ?? "", rightWidth).trimEnd();
    // A row both panes leave empty is a spacer, not a divider; anything else
    // keeps the bar, so the two columns read as one table rather than as two
    // lists that happen to sit next to each other.
    if (leftLine.trim() === "" && rightLine === "") {
      lines.push("");
      continue;
    }
    lines.push(`${leftLine}${options.gap}${rightLine}`.trimEnd());
  }
  return trimTrailingBlanks(lines);
}

/** One blank row at the end, the way a single panel renders. */
function trimTrailingBlanks(lines: string[]): string[] {
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  lines.push("");
  return lines;
}

export function renderOverlay(
  snapshot: BoardSnapshot,
  options: OverlayRenderOptions,
): string[] {
  const states = effectiveStates(
    snapshot,
    options.states ?? DEFAULT_OVERLAY_STATES,
    { shelfElsewhere: options.shelfElsewhere === true },
  );
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
    const indent = row.depth * 2;
    const hierarchy = hierarchySuffix(row.card, byId, row.depth > 0);
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
