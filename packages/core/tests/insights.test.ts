import { describe, expect, it } from "vitest";
import {
  addDays,
  buildInsights,
  dateInZone,
  percentile,
} from "../src/insights.js";
import type { Actor, Card, Event, EventType } from "../src/types.js";

const human: Actor = { type: "human", name: "jyxc" };
const NOW = new Date("2026-10-19T12:00:00.000Z");

let nextId = 1;

function event(
  ts: string,
  type: EventType,
  cardId: number,
  payload: Record<string, unknown> = {},
): Event {
  const id = nextId;
  nextId += 1;
  return { id, ts, actor: human, source: "cli", type, cardId, payload };
}

function created(ts: string, cardId: number): Event {
  return event(ts, "card.created", cardId, { title: `card ${cardId}` });
}

function moved(ts: string, cardId: number, from: string, to: string): Event {
  return event(ts, "card.moved", cardId, { from, to, action: "move" });
}

function card(overrides: Partial<Card> & { id: number }): Card {
  return {
    title: `card ${overrides.id}`,
    body: null,
    state: "todo",
    assignee: null,
    reviewer: null,
    project: null,
    priority: "normal",
    blockedBy: [],
    blocks: [],
    parent: null,
    children: [],
    notes: [],
    createdBy: "jyxc",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

function at<T>(values: readonly T[], index: number): T {
  return values[index] as T;
}

describe("date bucketing", () => {
  it("uses the caller's zone, not UTC", () => {
    const late = "2026-10-18T23:30:00.000Z";
    expect(dateInZone(late, "UTC")).toBe("2026-10-18");
    expect(dateInZone(late, "Asia/Shanghai")).toBe("2026-10-19");
  });

  it("does calendar arithmetic across month ends", () => {
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("buildInsights", () => {
  it("returns one dense day per day of the window, zero-filled", () => {
    const insights = buildInsights({
      events: [],
      cards: [],
      days: 7,
      now: NOW,
    });
    expect(insights.from).toBe("2026-10-13");
    expect(insights.to).toBe("2026-10-19");
    expect(insights.series).toHaveLength(7);
    expect(insights.series.map((day) => day.date)).toEqual([
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
    ]);
    expect(at(insights.series, 0).created).toBe(0);
    expect(at(insights.series, 0).states).toEqual({
      someday: 0,
      todo: 0,
      doing: 0,
      review: 0,
      done: 0,
    });
    expect(insights.cycle).toBeNull();
  });

  it("counts creations and completions on the day they happened", () => {
    const events = [
      created("2026-10-14T09:00:00.000Z", 1),
      moved("2026-10-14T10:00:00.000Z", 1, "todo", "done"),
      // reopen and finish again: still one card completed that day
      moved("2026-10-14T11:00:00.000Z", 1, "done", "todo"),
      moved("2026-10-14T12:00:00.000Z", 1, "todo", "done"),
      created("2026-10-15T09:00:00.000Z", 2),
      moved("2026-10-15T10:00:00.000Z", 2, "todo", "done"),
      created("2026-10-19T09:00:00.000Z", 3),
    ];

    const insights = buildInsights({ events, cards: [], days: 7, now: NOW });
    expect(
      insights.series.map((day) => [day.date, day.created, day.done]),
    ).toEqual([
      ["2026-10-13", 0, 0],
      ["2026-10-14", 1, 1],
      ["2026-10-15", 1, 1],
      ["2026-10-16", 0, 0],
      ["2026-10-17", 0, 0],
      ["2026-10-18", 0, 0],
      ["2026-10-19", 1, 0],
    ]);
  });

  it("carries the end-of-day shape across silent days", () => {
    const insights = buildInsights({
      events: [
        created("2026-10-14T09:00:00.000Z", 1),
        moved("2026-10-15T09:00:00.000Z", 1, "todo", "done"),
        created("2026-10-19T09:00:00.000Z", 2),
      ],
      cards: [],
      days: 7,
      now: NOW,
    });
    // Nothing happened on the 16th, so the 15th's shape stands.
    expect(at(insights.series, 3).states).toEqual({
      someday: 0,
      todo: 0,
      doing: 0,
      review: 0,
      done: 1,
    });
    expect(at(insights.series, 6).states).toEqual({
      someday: 0,
      todo: 1,
      doing: 0,
      review: 0,
      done: 1,
    });
  });

  it("counts a day in the zone it was worked in", () => {
    const events = [created("2026-10-18T23:30:00.000Z", 1)];
    const shanghai = buildInsights({
      events,
      cards: [],
      days: 2,
      now: NOW,
      timeZone: "Asia/Shanghai",
    });
    expect(at(shanghai.series, 1).date).toBe("2026-10-19");
    expect(at(shanghai.series, 1).created).toBe(1);

    const utc = buildInsights({
      events,
      cards: [],
      days: 2,
      now: NOW,
      timeZone: "UTC",
    });
    expect(at(utc.series, 0).date).toBe("2026-10-18");
    expect(at(utc.series, 0).created).toBe(1);
  });

  it("removes a deleted card from later snapshots but keeps its history", () => {
    const insights = buildInsights({
      events: [
        created("2026-10-14T09:00:00.000Z", 1),
        event("2026-10-14T10:00:00.000Z", "card.deleted", 1),
        created("2026-10-16T09:00:00.000Z", 2),
      ],
      cards: [],
      days: 7,
      now: NOW,
    });
    expect(at(insights.series, 1).created).toBe(1);
    expect(at(insights.series, 1).states.todo).toBe(0);
    expect(at(insights.series, 6).states.todo).toBe(1);
  });

  it("reports cycle time for cards finished inside the window", () => {
    const insights = buildInsights({
      events: [
        created("2026-10-10T09:00:00.000Z", 1),
        created("2026-10-12T09:00:00.000Z", 2),
        moved("2026-10-14T09:00:00.000Z", 1, "todo", "done"),
        moved("2026-10-14T09:00:00.000Z", 2, "todo", "done"),
      ],
      cards: [],
      days: 7,
      now: NOW,
    });
    expect(insights.cycle?.completed).toBe(2);
    expect(insights.cycle?.medianDays).toBe(3);
    expect(insights.cycle?.p85Days).toBe(3.7);
  });

  it("keeps the previous window's totals for the delta", () => {
    const insights = buildInsights({
      events: [
        created("2026-10-07T09:00:00.000Z", 1),
        moved("2026-10-08T09:00:00.000Z", 1, "todo", "done"),
        created("2026-10-14T09:00:00.000Z", 2),
      ],
      cards: [],
      days: 7,
      now: NOW,
    });
    expect(insights.previous).toEqual({
      from: "2026-10-06",
      to: "2026-10-12",
      created: 1,
      done: 1,
    });
  });

  it("shapes the current board from the projected cards", () => {
    const insights = buildInsights({
      events: [],
      cards: [
        card({ id: 1, project: "web", state: "todo" }),
        card({ id: 2, project: "web", state: "done" }),
        card({ id: 3, project: "api", state: "doing" }),
        card({ id: 4, project: "api", state: "review" }),
        card({ id: 5, project: null, state: "someday" }),
      ],
      days: 7,
      now: NOW,
    });
    expect(insights.states).toEqual({
      someday: 1,
      todo: 1,
      doing: 1,
      review: 1,
      done: 1,
    });
    // Most open work first; the no-project bucket sorts last.
    expect(insights.projects.map((project) => project.project)).toEqual([
      "api",
      "web",
      null,
    ]);
  });

  it("ages the cards sitting in doing and review", () => {
    const insights = buildInsights({
      events: [
        created("2026-10-10T09:00:00.000Z", 1),
        moved("2026-10-10T10:00:00.000Z", 1, "todo", "doing"),
        created("2026-10-17T09:00:00.000Z", 2),
        moved("2026-10-17T10:00:00.000Z", 2, "todo", "review"),
      ],
      cards: [
        card({ id: 1, state: "doing" }),
        card({ id: 2, state: "review" }),
        // waits on a card that is not even on the board any more
        card({ id: 3, state: "todo", blockedBy: [999] }),
      ],
      days: 7,
      now: NOW,
    });
    expect(at(insights.aging.doing, 0).id).toBe(1);
    expect(at(insights.aging.doing, 0).days).toBe(9);
    expect(at(insights.aging.review, 0).id).toBe(2);
    expect(at(insights.aging.review, 0).days).toBe(2);
    expect(insights.aging.blocked).toBe(1);
  });
});

describe("percentile", () => {
  it("interpolates between neighbours", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([], 50)).toBe(0);
  });
});
