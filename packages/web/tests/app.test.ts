import { describe, expect, it } from "vitest";
import {
  COLUMNS,
  actionForColumn,
  actorOptions,
  blockedCardIds,
  escapeHtml,
  filterCards,
  formatRelativeTime,
  parseActor,
  sortCards,
} from "../src/app.js";

const card = (overrides = {}) => ({
  id: 1,
  title: "card",
  body: null,
  state: "todo",
  assignee: null,
  reviewer: null,
  blockedBy: [],
  createdBy: "jyxc",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 1,
  ...overrides,
});

describe("drag and drop maps to intent verbs", () => {
  it("resolves each column to its semantic action", () => {
    expect(actionForColumn("todo")).toBe("reopen");
    expect(actionForColumn("doing")).toBe("claim");
    expect(actionForColumn("review")).toBe("review");
    expect(actionForColumn("done")).toBe("done");
  });

  it("rejects unknown columns", () => {
    expect(() => actionForColumn("backlog")).toThrowError(/unknown column/);
  });

  it("covers every board column", () => {
    for (const column of COLUMNS) {
      expect(() => actionForColumn(column.id)).not.toThrow();
    }
  });
});

describe("filterCards", () => {
  const cards = [
    card({
      id: 1,
      title: "Fix login",
      body: "auth flow",
      assignee: "codex",
      reviewer: "jyxc",
    }),
    card({
      id: 2,
      title: "Write docs",
      assignee: "claude-code",
      state: "doing",
    }),
  ];

  it("matches on title and body, case-insensitively", () => {
    expect(filterCards(cards, { q: "LOGIN" }).map((c) => c.id)).toEqual([1]);
    expect(filterCards(cards, { q: "auth flow" }).map((c) => c.id)).toEqual([
      1,
    ]);
    expect(filterCards(cards, { q: "nothing" })).toHaveLength(0);
  });

  it("filters by assignee and reviewer", () => {
    expect(filterCards(cards, { assignee: "codex" }).map((c) => c.id)).toEqual([
      1,
    ]);
    expect(filterCards(cards, { reviewer: "jyxc" }).map((c) => c.id)).toEqual([
      1,
    ]);
  });

  it("treats empty filters as no-ops", () => {
    expect(filterCards(cards, {})).toHaveLength(2);
    expect(filterCards(cards, { q: "   " })).toHaveLength(2);
  });
});

describe("sortCards", () => {
  it("puts the most recently updated first", () => {
    const cards = [
      card({ id: 1, updatedAt: "2026-01-01T00:00:00.000Z" }),
      card({ id: 2, updatedAt: "2026-01-02T00:00:00.000Z" }),
      card({ id: 3, updatedAt: "2026-01-03T00:00:00.000Z" }),
    ];
    expect(sortCards(cards).map((c) => c.id)).toEqual([3, 2, 1]);
  });

  it("breaks ties by descending id", () => {
    const cards = [card({ id: 1 }), card({ id: 2 })];
    expect(sortCards(cards).map((c) => c.id)).toEqual([2, 1]);
  });

  it("does not mutate the input", () => {
    const cards = [card({ id: 1 }), card({ id: 2 })];
    sortCards(cards);
    expect(cards.map((c) => c.id)).toEqual([1, 2]);
  });
});

describe("blockedCardIds", () => {
  it("flags cards whose blockers are not done", () => {
    const cards = [
      card({ id: 1, state: "doing" }),
      card({ id: 2, blockedBy: [1] }),
      card({ id: 3, blockedBy: [1] }),
    ];
    expect([...blockedCardIds(cards)]).toEqual([2, 3]);
  });

  it("clears the flag once the blocker is done", () => {
    const cards = [
      card({ id: 1, state: "done" }),
      card({ id: 2, blockedBy: [1] }),
    ];
    expect([...blockedCardIds(cards)]).toEqual([]);
  });

  it("treats a missing blocker as blocking (defensive)", () => {
    const cards = [card({ id: 2, blockedBy: [99] })];
    expect([...blockedCardIds(cards)]).toEqual([2]);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-01-01T12:00:00.000Z").getTime();

  it("renders coarse buckets", () => {
    expect(formatRelativeTime("2026-01-01T11:59:50.000Z", now)).toBe(
      "just now",
    );
    expect(formatRelativeTime("2026-01-01T11:55:00.000Z", now)).toBe("5m ago");
    expect(formatRelativeTime("2026-01-01T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2025-12-30T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("never renders negative time for clock skew", () => {
    expect(formatRelativeTime("2026-01-01T12:05:00.000Z", now)).toBe(
      "just now",
    );
  });

  it("returns empty for garbage input", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });
});

describe("escapeHtml", () => {
  it("neutralises markup in user content", () => {
    expect(escapeHtml("<img src=x onerror=alert(1)>")).toBe(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(escapeHtml("\"quoted\" & 'single'")).toBe(
      "&quot;quoted&quot; &amp; &#39;single&#39;",
    );
  });

  it("passes through plain text and nullish values", () => {
    expect(escapeHtml("plain")).toBe("plain");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("parseActor", () => {
  const fallback = { name: "me", type: "human" };

  it("accepts a valid stored identity", () => {
    expect(
      parseActor('{"name":"claude-code","type":"agent"}', fallback),
    ).toEqual({
      name: "claude-code",
      type: "agent",
    });
  });

  it("falls back on invalid or missing data", () => {
    expect(parseActor("not json", fallback)).toEqual(fallback);
    expect(parseActor('{"name":"","type":"human"}', fallback)).toEqual(
      fallback,
    );
    expect(parseActor('{"name":"x","type":"robot"}', fallback)).toEqual(
      fallback,
    );
    expect(parseActor(null, fallback)).toEqual(fallback);
  });

  it("trims the name", () => {
    expect(parseActor('{"name":"  jyxc  ","type":"human"}', fallback)).toEqual({
      name: "jyxc",
      type: "human",
    });
  });
});

describe("actorOptions", () => {
  it("lists distinct, sorted names for a role", () => {
    const cards = [
      card({ id: 1, assignee: "codex", reviewer: "jyxc" }),
      card({ id: 2, assignee: "claude-code", reviewer: "jyxc" }),
      card({ id: 3, assignee: "codex", reviewer: null }),
    ];
    expect(actorOptions(cards, "assignee")).toEqual(["claude-code", "codex"]);
    expect(actorOptions(cards, "reviewer")).toEqual(["jyxc"]);
  });
});
