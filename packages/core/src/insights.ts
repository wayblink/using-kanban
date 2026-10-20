/**
 * Insights: the board over time.
 *
 * The event log is already the history of every column move, so the trends are
 * a fold over it rather than a second store that could drift. `buildInsights`
 * replays the log once and answers four questions at once:
 *
 *   - how much was created and finished, per day, in the caller's time zone
 *   - what the whole board looked like at the end of each day (the cumulative
 *     flow diagram)
 *   - how long the cards that finished in the window took
 *   - which cards are sitting in `doing` / `review` far longer than they should
 *
 * "Current" numbers come from the projected cards, not from the replay, so they
 * always agree with the board itself.
 *
 * Days are the viewer's days: events carry UTC timestamps, and bucketing them
 * in UTC would file an evening's work under the previous date for anyone east
 * of Greenwich. Callers pass an IANA zone.
 */

import {
  CARD_STATES,
  isOpen,
  type Card,
  type CardState,
  type Event,
  type ProjectSummary,
} from "./types.js";

/** How many days the page asks for by default. */
export const DEFAULT_INSIGHT_DAYS = 30;

/** Anything longer is a different product; the server clamps to this. */
export const MAX_INSIGHT_DAYS = 365;

/** Per-state counts — the shape of the board at one instant. */
export type StateCounts = Record<CardState, number>;

/** One day of the window. `states` is the snapshot at the end of that day. */
export interface InsightsDay {
  /** `YYYY-MM-DD` in the requested time zone. */
  readonly date: string;
  /** Cards created that day. */
  readonly created: number;
  /** Cards that reached `done` that day, counted once per card. */
  readonly done: number;
  readonly states: StateCounts;
}

/**
 * How long a card may sit in a column before it counts as stuck.
 *
 * Review gets less rope than doing: a card in review is finished work waiting
 * for a person, which is the queue this board exists to keep short. The numbers
 * live here so the API, the page and any future CLI report agree on one rule.
 */
export const STUCK_DAYS = { doing: 3, review: 2 } as const;

/** How many stuck cards the ranking shows. */
export const STUCK_LIMIT = 10;

/** A card that has been sitting in `doing` or `review` past its threshold. */
export interface StuckCard {
  readonly id: number;
  readonly title: string;
  readonly project: string | null;
  readonly state: "doing" | "review";
  readonly assignee: string | null;
  /** When it entered that column, ISO — the age is measured from here. */
  readonly since: string;
  /** The same instant as a calendar day in the requested zone. */
  readonly sinceDate: string;
  /** Whole days since it entered that column. */
  readonly days: number;
}

/** How long the cards completed in the window took, in days. */
export interface CycleTime {
  readonly completed: number;
  readonly medianDays: number;
  readonly p85Days: number;
}

export interface Insights {
  readonly days: number;
  readonly timeZone: string;
  /** First and last day of the window, inclusive. */
  readonly from: string;
  readonly to: string;
  /** One entry per day — empty days are present, with zeroes. */
  readonly series: readonly InsightsDay[];
  /** The board right now. */
  readonly states: StateCounts;
  /** The board right now, by project, most active first. */
  readonly projects: readonly ProjectSummary[];
  /** The same-length window immediately before this one, for the delta. */
  readonly previous: {
    readonly from: string;
    readonly to: string;
    readonly created: number;
    readonly done: number;
  };
  /**
   * The cards that have been sitting in `doing` / `review` longest.
   *
   * A snapshot of the board right now, not of the window: the ranking does not
   * move when the reader switches 7 / 30 / 90 days. `cards` is already sorted
   * (days descending, id ascending) and capped at `STUCK_LIMIT`, so every
   * client renders the same order rather than re-sorting its own slice.
   */
  readonly aging: {
    readonly cards: readonly StuckCard[];
    /** Open cards whose upstream dependency is not finished. */
    readonly blocked: number;
    /** Every card in the column, stuck or not. */
    readonly counts: { readonly doing: number; readonly review: number };
    /** Cards past `STUCK_DAYS` per column — what the ranking is drawn from. */
    readonly stale: { readonly doing: number; readonly review: number };
    /** The rule `stale` was counted with, so clients do not re-declare it. */
    readonly thresholds: { readonly doing: number; readonly review: number };
  };
  /** Null when nothing was completed in the window. */
  readonly cycle: CycleTime | null;
}

export interface BuildInsightsOptions {
  readonly events: readonly Event[];
  readonly cards: readonly Card[];
  readonly days?: number | undefined;
  /** IANA zone, e.g. `Asia/Shanghai`. Defaults to UTC. */
  readonly timeZone?: string | undefined;
  /** Injectable clock — tests should not depend on today. */
  readonly now?: Date | undefined;
}

const DAY_MS = 86_400_000;

/** The same shape as `InsightsDay`, without the readonly modifiers. */
interface MutableDay {
  date: string;
  created: number;
  done: number;
  states: StateCounts;
}

function zeroCounts(): StateCounts {
  return { someday: 0, todo: 0, doing: 0, review: 0, done: 0 };
}

const STATES = new Set<string>(CARD_STATES);

/** A formatter per zone, because constructing one is the expensive part. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  // Throws a RangeError for an unknown zone — callers validate before asking.
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  formatters.set(timeZone, created);
  return created;
}

/** `YYYY-MM-DD` for an instant, in `timeZone`. */
export function dateInZone(instant: Date | string, timeZone = "UTC"): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  const parts = formatterFor(timeZone).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

/** Calendar arithmetic on a `YYYY-MM-DD`, with no zone in sight. */
export function addDays(date: string, delta: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + delta);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Linear-interpolated percentile of an ascending array. Nearest-rank would be
 * defensible too, but with a dozen samples interpolation gives a steadier
 * number from week to week.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] as number;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low] as number;
  const highValue = sorted[high] as number;
  return lowValue + (highValue - lowValue) * (rank - low);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Replays the log and derives the windowed view.
 *
 * The replay is deliberately one pass over the whole log — not just the window
 * — because the counts at the start of the window need everything before it.
 * A day with no events carries the previous day's snapshot forward, which is
 * what makes the flow chart a step function instead of a dotted line.
 */
export function buildInsights(options: BuildInsightsOptions): Insights {
  const timeZone = options.timeZone ?? "UTC";
  formatterFor(timeZone); // validate early, with a RangeError for a bad zone
  const requested = options.days ?? DEFAULT_INSIGHT_DAYS;
  const days = Number.isFinite(requested)
    ? Math.max(1, Math.min(MAX_INSIGHT_DAYS, Math.trunc(requested)))
    : DEFAULT_INSIGHT_DAYS;
  const now = options.now ?? new Date();

  const to = dateInZone(now, timeZone);
  const from = addDays(to, -(days - 1));
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(days - 1));

  const dates: string[] = [];
  for (let index = 0; index < days; index += 1) {
    dates.push(addDays(from, index));
  }
  const indexByDate = new Map(dates.map((date, index) => [date, index]));

  const counts = zeroCounts();
  const stateByCard = new Map<number, CardState>();
  const createdTs = new Map<number, string>();
  const lastMove = new Map<number, { state: CardState; ts: string }>();
  const createdByDate = new Map<string, number>();
  const doneByDate = new Map<string, Set<number>>();
  /** The earliest completion inside the window, per card — cycle time's start. */
  const doneInWindow = new Map<number, string>();

  // Mutable while the replay fills it; the public type is readonly.
  const series: MutableDay[] = dates.map((date) => ({
    date,
    created: 0,
    done: 0,
    states: zeroCounts(),
  }));

  // Ids are the log's order; timestamps are how a day is chosen. Sorting by id
  // keeps replay correct even if two events share a millisecond.
  const events = [...options.events].sort((a, b) => a.id - b.id);
  // The last series index whose day is complete. Days before the first
  // in-window event are filled in one go when that event arrives.
  let filledThrough = -1;

  for (const event of events) {
    const date = dateInZone(event.ts, timeZone);
    const index = indexByDate.get(date);

    if (index !== undefined && index > filledThrough) {
      // Days with no events take the last known shape.
      for (let gap = filledThrough + 1; gap < index; gap += 1) {
        series[gap]!.states = { ...counts };
      }
      filledThrough = index - 1;
    }

    const payload = event.payload;
    switch (event.type) {
      case "card.created": {
        counts.todo += 1;
        stateByCard.set(event.cardId, "todo");
        createdTs.set(event.cardId, event.ts);
        if (date >= previousFrom && date <= to) {
          createdByDate.set(date, (createdByDate.get(date) ?? 0) + 1);
        }
        break;
      }
      case "card.moved": {
        const destination = payload.to;
        if (typeof destination !== "string" || !STATES.has(destination)) break;
        const toState = destination as CardState;
        const previous = stateByCard.get(event.cardId);
        // A move for a card the replay never saw created cannot be placed.
        if (previous === undefined) break;
        if (previous !== toState) {
          counts[previous] -= 1;
          counts[toState] += 1;
        }
        stateByCard.set(event.cardId, toState);
        lastMove.set(event.cardId, { state: toState, ts: event.ts });
        if (toState === "done" && date >= previousFrom && date <= to) {
          const done = doneByDate.get(date) ?? new Set<number>();
          done.add(event.cardId);
          doneByDate.set(date, done);
          if (index !== undefined && !doneInWindow.has(event.cardId)) {
            doneInWindow.set(event.cardId, event.ts);
          }
        }
        break;
      }
      case "card.deleted": {
        const previous = stateByCard.get(event.cardId);
        if (previous !== undefined) {
          counts[previous] -= 1;
          stateByCard.delete(event.cardId);
        }
        break;
      }
      default:
        break;
    }

    if (index !== undefined) {
      // Provisional end-of-day: a later event on the same date overwrites it.
      series[index]!.states = { ...counts };
    }
  }

  for (let index = filledThrough + 1; index < series.length; index += 1) {
    series[index]!.states = { ...counts };
  }
  for (const day of series) {
    day.created = createdByDate.get(day.date) ?? 0;
    day.done = doneByDate.get(day.date)?.size ?? 0;
  }

  let previousCreated = 0;
  let previousDone = 0;
  for (const [date, created] of createdByDate) {
    if (date >= previousFrom && date <= previousTo) previousCreated += created;
  }
  for (const [date, done] of doneByDate) {
    if (date >= previousFrom && date <= previousTo) previousDone += done.size;
  }

  return {
    days,
    timeZone,
    from,
    to,
    series,
    states: countsOf(options.cards),
    projects: projectSummaries(options.cards),
    previous: {
      from: previousFrom,
      to: previousTo,
      created: previousCreated,
      done: previousDone,
    },
    aging: ageCards(options.cards, lastMove, now, timeZone),
    cycle: cycleTime(doneInWindow, createdTs),
  };
}

function countsOf(cards: readonly Card[]): StateCounts {
  const counts = zeroCounts();
  for (const card of cards) counts[card.state] += 1;
  return counts;
}

/**
 * Per-project counts, most active first.
 *
 * The no-project bucket is included when it is non-empty — a card without a
 * project is invisible to every project filter, and an operator needs to see
 * that bucket before wondering where the missing cards went.
 */
function projectSummaries(cards: readonly Card[]): ProjectSummary[] {
  const summaries = new Map<string | null, ProjectSummary>();
  for (const card of cards) {
    const key = card.project ?? null;
    const current =
      summaries.get(key) ??
      ({
        project: key,
        someday: 0,
        todo: 0,
        doing: 0,
        review: 0,
        done: 0,
      } satisfies ProjectSummary);
    summaries.set(key, { ...current, [card.state]: current[card.state] + 1 });
  }
  const open = (summary: ProjectSummary): number =>
    summary.someday + summary.todo + summary.doing + summary.review;
  return [...summaries.values()].sort((a, b) => {
    const diff = open(b) - open(a);
    if (diff !== 0) return diff;
    if (a.done !== b.done) return b.done - a.done;
    // Named projects before the no-project bucket, then alphabetically.
    if (a.project === null) return 1;
    if (b.project === null) return -1;
    return a.project.localeCompare(b.project);
  });
}

function ageCards(
  cards: readonly Card[],
  lastMove: ReadonlyMap<number, { state: CardState; ts: string }>,
  now: Date,
  timeZone: string,
): Insights["aging"] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const counts = { doing: 0, review: 0 };
  const stale = { doing: 0, review: 0 };
  const entries: StuckCard[] = [];

  for (const card of cards) {
    if (card.state !== "doing" && card.state !== "review") continue;
    const moved = lastMove.get(card.id);
    const since = moved?.state === card.state ? moved.ts : card.createdAt;
    const elapsed = (now.getTime() - Date.parse(since)) / DAY_MS;
    const days = Number.isFinite(elapsed)
      ? Math.max(0, Math.floor(elapsed))
      : 0;
    counts[card.state] += 1;
    if (days < STUCK_DAYS[card.state]) continue;
    stale[card.state] += 1;
    entries.push({
      id: card.id,
      title: card.title,
      project: card.project,
      state: card.state,
      assignee: card.assignee,
      since,
      sinceDate: dateInZone(since, timeZone),
      // The age itself is elapsed time, not a calendar fact — the date beside
      // it is the zone-aware half.
      days,
    });
  }

  entries.sort((a, b) => b.days - a.days || a.id - b.id);

  let blocked = 0;
  for (const card of cards) {
    if (!isOpen(card.state)) continue;
    // The same rule the board uses: an upstream that is missing or unfinished
    // is a real blocker; a finished one is just history on the card.
    const waiting = card.blockedBy.some((id) => {
      const upstream = byId.get(id);
      return upstream === undefined || upstream.state !== "done";
    });
    if (waiting) blocked += 1;
  }

  return {
    cards: entries.slice(0, STUCK_LIMIT),
    blocked,
    counts,
    stale,
    thresholds: STUCK_DAYS,
  };
}

function cycleTime(
  doneInWindow: ReadonlyMap<number, string>,
  createdTs: ReadonlyMap<number, string>,
): CycleTime | null {
  const samples: number[] = [];
  for (const [cardId, doneTs] of doneInWindow) {
    const created = createdTs.get(cardId);
    if (created === undefined) continue;
    const start = Date.parse(created);
    const end = Date.parse(doneTs);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // A clock that went backwards is not a negative cycle time.
    samples.push(Math.max(0, (end - start) / DAY_MS));
  }
  if (samples.length === 0) return null;
  samples.sort((a, b) => a - b);
  return {
    completed: samples.length,
    medianDays: round2(percentile(samples, 50)),
    p85Days: round2(percentile(samples, 85)),
  };
}
