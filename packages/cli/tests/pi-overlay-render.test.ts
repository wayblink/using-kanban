/**
 * The overlay's pure modules live in packages/pi, but that package declares no
 * dependencies on purpose: Pi supplies its host modules at runtime, and any
 * devDependency there makes pnpm auto-install those peers — a second copy of
 * pi-tui/typebox in the workspace. The modules are deliberately Pi-free (that
 * is why they are unit-testable at all), so they are exercised from this suite,
 * which already reads the packages/pi tree (see init.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  type BoardSnapshot,
  type CardLite,
  countCards,
  openCardCount,
  parseBoardJson,
  renderOverlay,
  sanitizeTerminalText,
  scopeBoard,
  selectOverlayRows,
  visibleCardCount,
} from "../../pi/extensions/using-kanban/overlay-render.js";

/* ------------------------------- fixtures -------------------------------- */

function card(over: Partial<CardLite> & { id: number }): CardLite {
  return {
    title: `card ${over.id}`,
    state: "todo",
    assignee: null,
    reviewer: null,
    project: null,
    blockedBy: [],
    priority: "normal",
    ...over,
  };
}

/** A card as a pre-priority brief-JSON producer would have written it. */
function omitPriority(card: CardLite): CardLite {
  const { priority: _dropped, ...rest } = card;
  void _dropped;
  return rest;
}

function snapshot(over: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    projects: [],
    someday: [],
    todo: [],
    doing: [],
    review: [],
    done: [],
    ...over,
  };
}

/** Identity theme: assertions read the plain text, no escape codes to strip. */
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  strikethrough: (text: string) => text,
};

const truncate = (line: string, width: number): string =>
  line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`;

const renderOptions = (
  over: Partial<Parameters<typeof renderOverlay>[1]> = {},
) => ({
  theme,
  truncate,
  visibleWidth: (text: string) => text.length,
  width: 200,
  budget: 12,
  collapsed: false,
  collapseKey: "ctrl+shift+k",
  ...over,
});

/* --------------------------------- parse --------------------------------- */

describe("parseBoardJson", () => {
  it("decodes every column and the projects in use", () => {
    const parsed = parseBoardJson(
      JSON.stringify({
        todo: [
          {
            id: 2,
            title: "later",
            assignee: null,
            reviewer: null,
            project: "api",
            blockedBy: [1],
          },
        ],
        doing: [
          {
            id: 1,
            title: "ship it",
            assignee: "pi",
            reviewer: null,
            project: "web",
            blockedBy: [],
          },
        ],
        review: [],
        done: [
          {
            id: 9,
            title: "old",
            assignee: null,
            reviewer: null,
            project: null,
            blockedBy: [],
          },
        ],
        projects: ["api", "web"],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.todo.map((c) => c.title)).toEqual(["later"]);
    expect(parsed?.todo[0]?.blockedBy).toEqual([1]);
    expect(parsed?.doing[0]?.assignee).toBe("pi");
    expect(parsed?.done.map((c) => c.id)).toEqual([9]);
    expect(parsed?.projects).toEqual(["api", "web"]);
  });

  it("returns null for output that is not the board", () => {
    expect(parseBoardJson("")).toBeNull();
    expect(
      parseBoardJson("board_not_found: no board at /home/.ukb"),
    ).toBeNull();
    expect(parseBoardJson("[1,2,3]")).toBeNull();
    expect(parseBoardJson("null")).toBeNull();
  });

  it("returns null when a column is missing — a half board is not a board", () => {
    expect(
      parseBoardJson(JSON.stringify({ todo: [], doing: [], review: [] })),
    ).toBeNull();
  });

  it("skips a malformed card but keeps the rest", () => {
    const parsed = parseBoardJson(
      JSON.stringify({
        todo: [
          { id: 1, title: "good" },
          { id: "not-a-number", title: "bad" },
          { id: 2 },
          null,
        ],
        doing: [],
        review: [],
        done: [],
        projects: [1, "web"],
      }),
    );
    expect(parsed?.todo.map((c) => c.id)).toEqual([1]);
    expect(parsed?.projects).toEqual(["web"]);
  });
});

/* ------------------------------- selectors -------------------------------- */

describe("counts", () => {
  it("counts each column and the open total", () => {
    const board = snapshot({
      todo: [card({ id: 1 }), card({ id: 2 })],
      doing: [card({ id: 3 })],
      review: [card({ id: 4 })],
      done: [card({ id: 5 }), card({ id: 6 })],
      someday: [card({ id: 7, state: "someday" })],
    });
    expect(countCards(board)).toEqual({
      someday: 1,
      todo: 2,
      doing: 1,
      review: 1,
      done: 2,
    });
    // A parked card is not open work the panel watches.
    expect(openCardCount(board)).toBe(4);
    expect(openCardCount(snapshot({ done: [card({ id: 1 })] }))).toBe(0);
  });

  it("counts the displayed states for the auto-hide decision", () => {
    const board = snapshot({
      someday: [card({ id: 1, state: "someday" })],
    });
    // someday is displayed by default, so a shelf-only board still gets a panel
    expect(visibleCardCount(board)).toBe(1);
    expect(visibleCardCount(board, ["todo", "doing", "review"])).toBe(0);
    // openCardCount stays what it always was: actionable work only
    expect(openCardCount(board)).toBe(0);
  });
});

describe("scopeBoard", () => {
  const board = snapshot({
    projects: ["api", "web"],
    todo: [
      card({ id: 1, project: "web", assignee: "pi" }),
      card({ id: 2, project: "api", reviewer: "pi" }),
      card({ id: 3, project: "api", assignee: "codex" }),
    ],
    review: [card({ id: 4, project: "web", reviewer: "human" })],
    done: [card({ id: 5, project: "web", state: "done" })],
  });

  it("defaults the project view to one project's counts and rows", () => {
    const scoped = scopeBoard(board, {
      scope: "current-project",
      project: "web",
      agent: "pi",
      groupBy: "state",
      maxLines: 12,
      states: ["doing", "todo", "review", "someday"],
    });
    expect(scoped.label).toBe("web");
    expect(countCards(scoped.snapshot)).toEqual({
      someday: 0,
      todo: 1,
      doing: 0,
      review: 1,
      done: 1,
    });
  });

  it("defines mine as assigned to or reviewed by the current actor", () => {
    const scoped = scopeBoard(board, {
      scope: "mine",
      project: null,
      agent: "pi",
      groupBy: "state",
      maxLines: 12,
      states: ["doing", "todo", "review", "someday"],
    });
    expect(scoped.label).toBe("mine:pi");
    expect(scoped.snapshot.todo.map((item) => item.id)).toEqual([1, 2]);
  });

  it("falls back visibly to all when no current project can be inferred", () => {
    const scoped = scopeBoard(board, {
      scope: "current-project",
      project: null,
      agent: "pi",
      groupBy: "state",
      maxLines: 12,
      states: ["doing", "todo", "review", "someday"],
    });
    expect(scoped.label).toBe("all");
    expect(scoped.snapshot.todo).toHaveLength(3);
  });
});

describe("priority ordering", () => {
  it("orders rows high → normal → low inside a state", () => {
    const board = snapshot({
      todo: [
        card({ id: 1, priority: "low", title: "minor" }),
        card({ id: 2, title: "plain" }),
        card({ id: 3, priority: "high", title: "urgent" }),
        card({ id: 4, priority: "low", title: "minor too" }),
      ],
    });
    const { rows } = selectOverlayRows(board, 10);
    expect(rows.map((row) => row.card.title)).toEqual([
      "urgent",
      "plain",
      "minor",
      "minor too",
    ]);
  });

  it("prints the priority as a tag right after the state tag", () => {
    // `[todo][high] #1 …`, not `[todo] #1 … high`: the two attributes read as a
    // pair before the id, and a trailing word reads as part of the title.
    const board = snapshot({
      todo: [
        card({ id: 1, priority: "high", title: "urgent thing" }),
        card({ id: 2, title: "ordinary thing" }),
      ],
    });
    const lines = renderOverlay(board, renderOptions());
    expect(lines[1]).toBe("├─ [todo][high] #1 urgent thing");
    // `normal` prints too: a row missing the tag reads as malformed next to
    // rows that have one, and "normal" must be distinguishable from "this card
    // predates priorities".
    expect(lines[2]).toBe("└─ [todo][normal] #2 ordinary thing");
  });

  it("does not let priority outrank the state grouping", () => {
    // State is the panel's structure; priority only breaks ties inside it. A
    // high-priority todo must not jump above the card actually being worked on.
    const board = snapshot({
      doing: [card({ id: 9, state: "doing", title: "in flight" })],
      todo: [
        card({ id: 1, priority: "high", title: "urgent" }),
        card({ id: 2, title: "plain" }),
      ],
    });
    const { rows } = selectOverlayRows(board, 10);
    expect(rows.map((row) => row.card.title)).toEqual([
      "in flight",
      "urgent",
      "plain",
    ]);
  });

  it("treats brief JSON with no priority as normal", () => {
    const parsed = parseBoardJson(
      JSON.stringify({
        projects: [],
        todo: [{ id: 7, title: "legacy" }],
        doing: [],
        review: [],
        done: [],
      }),
    );
    expect(parsed?.todo[0]?.priority).toBe("normal");
    // a missing someday column (an older producer) reads as an empty shelf
    expect(parsed?.someday).toEqual([]);
    // and it still sorts as normal rather than dropping to the back
    const board = snapshot({
      todo: [
        card({ id: 1, priority: "low", title: "minor" }),
        omitPriority(card({ id: 2, title: "legacy" })),
      ],
    });
    const { rows } = selectOverlayRows(board, 10);
    expect(rows.map((row) => row.card.title)).toEqual(["legacy", "minor"]);
  });

  it("ignores a priority outside the scale", () => {
    const parsed = parseBoardJson(
      JSON.stringify({
        projects: [],
        todo: [{ id: 7, title: "odd", priority: "whenever" }],
        doing: [],
        review: [],
        done: [],
      }),
    );
    expect(parsed?.todo[0]?.priority).toBe("normal");
  });
});

describe("selectOverlayRows", () => {
  it("orders doing, then todo, then review, each by id", () => {
    const board = snapshot({
      todo: [card({ id: 30 }), card({ id: 10 })],
      doing: [card({ id: 3 }), card({ id: 1 })],
      review: [card({ id: 20 })],
      done: [card({ id: 99 })],
    });
    const { rows, hidden } = selectOverlayRows(board, 10);
    expect(rows.map((row) => `${row.state}:${row.card.id}`)).toEqual([
      "doing:1",
      "doing:3",
      "todo:10",
      "todo:30",
      "review:20",
    ]);
    expect(hidden).toEqual([]);
  });

  it("puts actionable work ahead of the review queue", () => {
    // The regression this order exists for: a project with eleven review cards
    // and fourteen todo cards showed ten review rows and hid every piece of
    // available work, so the panel read as "nothing to do".
    const board = snapshot({
      todo: [card({ id: 1 }), card({ id: 2 })],
      review: [card({ id: 50 }), card({ id: 51 }), card({ id: 52 })],
    });
    const { rows } = selectOverlayRows(board, 4);
    expect(rows.map((row) => row.state)).toEqual(["todo", "todo", "review"]);
  });

  it("keeps doing rows and drops the todo tail first, reserving a summary row", () => {
    const board = snapshot({
      todo: [
        card({ id: 1 }),
        card({ id: 2 }),
        card({ id: 3 }),
        card({ id: 4 }),
      ],
      doing: [card({ id: 10 })],
      review: [],
    });
    const { rows, hidden } = selectOverlayRows(board, 4);
    // 4 body rows = 3 visible + 1 summary.
    expect(rows.map((row) => row.card.id)).toEqual([10, 1, 2]);
    expect(hidden.map((row) => row.card.id)).toEqual([3, 4]);
  });

  it("groups by project with an inline label only on the group's first row", () => {
    const board = snapshot({
      doing: [
        card({ id: 1, project: "web", state: "doing" }),
        card({ id: 2, project: "api", state: "doing" }),
      ],
      review: [card({ id: 3, project: "api", state: "review" })],
    });
    const { rows } = selectOverlayRows(board, 10, "project");
    expect(
      rows.map((row) => [row.card.id, row.groupLabel, row.groupStart]),
    ).toEqual([
      [2, "api", true],
      [3, "api", false],
      [1, "web", true],
    ]);
  });

  it("groups by the person the row is waiting on", () => {
    const board = snapshot({
      doing: [card({ id: 1, state: "doing", assignee: "pi" })],
      review: [card({ id: 2, state: "review", reviewer: "pi" })],
      todo: [card({ id: 3 })],
    });
    const { rows } = selectOverlayRows(board, 10, "owner");
    expect(rows.map((row) => row.groupLabel)).toEqual([
      "@pi",
      "@pi",
      "unassigned",
    ]);
    expect(rows.map((row) => row.groupStart)).toEqual([true, false, true]);
  });

  it("truncates the in-flight tail only when doing alone overflows", () => {
    const board = snapshot({
      doing: [card({ id: 1 }), card({ id: 2 }), card({ id: 3 })],
      review: [card({ id: 9 })],
    });
    const { rows, hidden } = selectOverlayRows(board, 3);
    expect(rows.map((row) => row.card.id)).toEqual([1, 2]);
    expect(hidden.map((row) => `${row.state}:${row.card.id}`)).toEqual([
      "doing:3",
      "review:9",
    ]);
  });
});

/* -------------------------------- rendering -------------------------------- */

describe("renderOverlay", () => {
  it("heads with the column counts and shows in-flight rows", () => {
    const board = snapshot({
      doing: [
        card({
          id: 41,
          title: "Fix flaky retry test",
          state: "doing",
          assignee: "pi",
        }),
      ],
      review: [
        card({
          id: 38,
          title: "Overlay widget",
          state: "review",
          reviewer: "human",
        }),
      ],
      todo: [card({ id: 45, title: "Add sanitizer" })],
      someday: [card({ id: 7, title: "Parked idea", state: "someday" })],
      done: [card({ id: 9, title: "Ship overlay", state: "done" })],
    });
    const lines = renderOverlay(board, renderOptions());
    // done is not displayed by default, so it is not in the heading either.
    expect(lines[0]).toBe("● ukb · 1 doing · 1 todo · 1 review · 1 someday");
    expect(lines[1]).toContain("[doing][normal] #41 Fix flaky retry test");
    expect(lines[1]).toContain("@pi");
    // todo comes before review: available work ahead of the waiting queue.
    expect(lines[2]).toContain("[todo][normal] #45 Add sanitizer");
    expect(lines[3]).toContain("[review][normal] #38 Overlay widget");
    expect(lines[3]).toContain("→ human");
    // the shelf is displayed, after review and before history.
    expect(lines[4]).toContain("[someday][normal] #7 Parked idea");
    // done is history: never given a row.
    expect(lines.join("\n")).not.toContain("Ship overlay");
  });

  it("honours the view's displayed states", () => {
    const board = snapshot({
      todo: [card({ id: 1, title: "live" })],
      someday: [card({ id: 2, title: "parked", state: "someday" })],
      done: [card({ id: 3, title: "history", state: "done" })],
    });
    const lines = renderOverlay(
      board,
      renderOptions({ states: ["todo", "done"] }),
    );
    // order is fixed: someday would sit before done, and both follow the flow
    expect(lines[0]).toBe("○ ukb · 1 todo · 1 done");
    const panel = lines.join("\n");
    expect(panel).toContain("[todo][normal] #1 live");
    expect(panel).toContain("[done][normal] #3 history");
    expect(panel).not.toContain("parked");
  });

  it("returns nothing when every displayed state is empty", () => {
    const board = snapshot({
      someday: [card({ id: 1, state: "someday" })],
    });
    expect(renderOverlay(board, renderOptions({ states: ["todo"] }))).toEqual(
      [],
    );
  });

  it("shows a shelf-only board, because someday is displayed by default", () => {
    const board = snapshot({
      someday: [card({ id: 1, title: "parked", state: "someday" })],
    });
    const lines = renderOverlay(board, renderOptions());
    expect(lines[0]).toBe("○ ukb · 1 someday");
    expect(lines[1]).toContain("[someday][normal] #1 parked");
  });

  it("spells the state out in front of each row instead of drawing an icon", () => {
    const board = snapshot({
      doing: [card({ id: 1, state: "doing" })],
      review: [card({ id: 2, state: "review" })],
      todo: [card({ id: 3 })],
    });
    const body = renderOverlay(board, renderOptions()).join("\n");
    expect(body).toContain("[doing][normal] #1");
    expect(body).toContain("[review][normal] #2");
    expect(body).toContain("[todo][normal] #3");
    // No private legend to learn: the old state glyphs must not survive.
    for (const glyph of ["○", "◐", "◆"]) {
      expect(body).not.toContain(glyph);
    }
  });

  it("drops the owner suffix when it would only repeat the state tag", () => {
    const board = snapshot({
      review: [
        card({ id: 1, state: "review" }),
        card({ id: 2, state: "review", reviewer: "human" }),
      ],
    });
    const lines = renderOverlay(board, renderOptions());
    // No reviewer: `[review]` already says it, so nothing is appended.
    expect(lines[1]).toBe("├─ [review][normal] #1 card 1");
    expect(lines[1]).not.toContain("→");
    // A named reviewer is a person to chase, which the tag cannot say.
    expect(lines[2]).toContain("[review][normal] #2 card 2");
    expect(lines[2]).toContain("→ human");
  });

  it("names the active scope in the heading", () => {
    const board = snapshot({ todo: [card({ id: 1 })] });
    expect(
      renderOverlay(board, renderOptions({ scopeLabel: "using-kanban" }))[0],
    ).toBe("○ ukb · using-kanban · 1 todo");
  });

  it("renders inline project groups without spending a row on headings", () => {
    const board = snapshot({
      doing: [
        card({ id: 1, project: "api", state: "doing" }),
        card({ id: 2, project: "api", state: "doing" }),
        card({ id: 3, project: "web", state: "doing" }),
      ],
    });
    const lines = renderOverlay(board, renderOptions({ groupBy: "project" }));
    expect(lines[1]).toContain("api");
    expect(lines[2]).not.toContain("api");
    expect(lines[3]).toContain("web");
  });

  it("omits zero counts from the heading", () => {
    const board = snapshot({ todo: [card({ id: 1 })] });
    expect(renderOverlay(board, renderOptions())[0]).toBe("○ ukb · 1 todo");
  });

  it("aligns the owner column across rows", () => {
    const board = snapshot({
      doing: [
        card({ id: 1, title: "short", state: "doing", assignee: "pi" }),
        card({
          id: 2,
          title: "a much longer title",
          state: "doing",
          assignee: "codex",
        }),
      ],
    });
    const lines = renderOverlay(board, renderOptions());
    const firstAt = lines[1]?.indexOf("@pi") ?? -1;
    const secondAt = lines[2]?.indexOf("@codex") ?? -1;
    expect(firstAt).toBeGreaterThan(0);
    expect(firstAt).toBe(secondAt);
  });

  it("summarizes what it could not fit", () => {
    const board = snapshot({
      todo: [
        card({ id: 1 }),
        card({ id: 2 }),
        card({ id: 3 }),
        card({ id: 4 }),
      ],
      doing: [card({ id: 10, state: "doing" })],
    });
    const lines = renderOverlay(board, renderOptions({ budget: 5 }));
    // heading + doing + 2 todo + summary = 5 rows, then the spacer.
    expect(lines).toHaveLength(6);
    expect(lines.at(-2)).toContain("+2 more (2 todo)");
    expect(lines.at(-1)).toBe("");
  });

  it("collapses to the heading plus a key hint", () => {
    const board = snapshot({ doing: [card({ id: 10, state: "doing" })] });
    const lines = renderOverlay(board, renderOptions({ collapsed: true }));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("ukb");
    expect(lines[1]).toContain("ctrl+shift+k to expand");
  });

  it("renders a static label when the collapse key is off", () => {
    const board = snapshot({ doing: [card({ id: 10, state: "doing" })] });
    const lines = renderOverlay(
      board,
      renderOptions({ collapsed: true, collapseKey: "off" }),
    );
    expect(lines[1]).toBe("└─ collapsed");
  });

  it("returns nothing when there is no open work", () => {
    const board = snapshot({ done: [card({ id: 9, state: "done" })] });
    expect(renderOverlay(board, renderOptions())).toEqual([]);
  });

  it("strips escape sequences out of a card title", () => {
    const board = snapshot({
      todo: [card({ id: 7, title: "evil\u001b[2Jtitle\u001b]0;pwned\u0007" })],
    });
    const lines = renderOverlay(board, renderOptions());
    expect(lines[1]).toContain("eviltitle");
    expect(lines[1]).not.toContain("\u001b");
  });

  it("truncates a row to the widget width", () => {
    const board = snapshot({ todo: [card({ id: 7, title: "x".repeat(80) })] });
    const lines = renderOverlay(board, renderOptions({ width: 20 }));
    expect(lines[1]?.length).toBe(20);
    expect(lines[1]?.endsWith("…")).toBe(true);
  });
});

describe("sanitizeTerminalText", () => {
  it("drops control characters, separator runs, and bidi overrides", () => {
    expect(sanitizeTerminalText("a\u001b[31mb\u0007c")).toBe("abc");
    expect(sanitizeTerminalText("one\ntwo\tthree")).toBe("one two three");
    expect(sanitizeTerminalText("safe\u202ereordered")).toBe("safereordered");
    expect(sanitizeTerminalText("keep 🎯 unicode")).toBe("keep 🎯 unicode");
  });
});
