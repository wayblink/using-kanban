/**
 * The MCP door's renderers. This package has no `--json` equivalent — `text()`
 * returns content only, no structuredContent — so these strings are the only
 * copy of a card the caller ever sees. That makes sanitizing here load-bearing,
 * and makes these tests the only thing standing between a card body and an
 * arbitrary host UI.
 */
import { describe, expect, it } from "vitest";
import type { Card } from "@wayblink/using-kanban-core";
import {
  formatBoard,
  formatCard,
  formatCardBrief,
  formatCards,
} from "../src/format.js";

function makeCard(over: Partial<Card> = {}): Card {
  return {
    id: 3,
    title: "ship it",
    body: null,
    state: "todo",
    assignee: "codex",
    reviewer: "jyxc",
    project: null,
    priority: "normal",
    blockedBy: [],
    blocks: [],
    parent: null,
    children: [],
    notes: [],
    createdBy: "jyxc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
    ...over,
  };
}

const CLEAR_SCREEN = "\u001b[2J";
const BIDI_OVERRIDE = "\u202e";

describe("formatCardBrief priority", () => {
  it("prints the priority only when it is not normal", () => {
    expect(formatCardBrief(makeCard())).not.toContain("normal");
    expect(formatCardBrief(makeCard({ priority: "high" }))).toContain("high");
    expect(formatCardBrief(makeCard({ priority: "low" }))).toContain("low");
  });

  it("orders a column high → normal → low", () => {
    const output = formatBoard({
      someday: [],
      todo: [
        makeCard({ id: 1, priority: "low", title: "minor" }),
        makeCard({ id: 2, title: "plain" }),
        makeCard({ id: 3, priority: "high", title: "urgent" }),
      ],
      doing: [],
      review: [],
      done: [],
    });
    const order = output
      .split("\n")
      .filter((line) => line.includes("[todo]"))
      .map((line) => line.trim().split(" ")[2]);
    expect(order).toEqual(["urgent", "plain", "minor"]);
  });
});

describe("formatCardBrief", () => {
  it("strips escapes out of every free-text field", () => {
    const output = formatCardBrief(
      makeCard({
        title: `evil${CLEAR_SCREEN}title`,
        assignee: "code\u0007x",
        reviewer: `review${BIDI_OVERRIDE}er`,
        project: "web",
      }),
    );
    expect(output).toBe(
      "#3 [todo] eviltitle @codex reviewer:reviewer project:web",
    );
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u202e");
  });

  it("keeps the id-derived fields verbatim", () => {
    const output = formatCardBrief(
      makeCard({
        blockedBy: [1, 2],
        blocks: [4],
        notes: [
          { id: 9, text: "x", url: null, createdBy: "y", createdAt: "z" },
        ],
      }),
    );
    expect(output).toContain("blocked-by:1,2");
    expect(output).toContain("blocks:4");
    expect(output).toContain("notes:1");
  });

  it("cannot be made to forge an extra row", () => {
    const output = formatCardBrief(
      makeCard({ title: "a\r#9 [done] impostor" }),
    );
    expect(output.split("\n")).toHaveLength(1);
  });
});

describe("formatBoard", () => {
  it("strips escapes out of titles", () => {
    const output = formatBoard({
      someday: [],
      todo: [makeCard({ title: `ship${CLEAR_SCREEN}` })],
      doing: [],
      review: [],
      done: [],
    });
    expect(output).toContain("#3 [todo] ship");
    expect(output).not.toContain("\u001b");
  });
});

describe("formatCards", () => {
  it("passes the empty message through untouched", () => {
    expect(formatCards([], "nothing here")).toBe("nothing here");
  });

  it("strips escapes out of the listed titles", () => {
    expect(formatCards([makeCard({ title: `x${CLEAR_SCREEN}` })], "none")).toBe(
      "#3 [todo] x @codex reviewer:jyxc",
    );
  });
});

describe("formatCard", () => {
  it("strips escapes from the header, the owner and the notes", () => {
    const output = formatCard(
      makeCard({
        title: `t${CLEAR_SCREEN}`,
        createdBy: "jy\u0007xc",
        notes: [
          {
            id: 9,
            text: `doc${CLEAR_SCREEN}`,
            url: `docs/design${BIDI_OVERRIDE}.md`,
            createdBy: `no${CLEAR_SCREEN}te`,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      [],
    );
    expect(output).toContain("#3 t [todo]");
    expect(output).toContain("created by: jyxc");
    expect(output).toContain("#9 doc — docs/design.md (note, 2026-01-01");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u202e");
  });

  it("keeps a multi-line body multi-line, sanitizing each line", () => {
    const output = formatCard(
      makeCard({ body: `step one\nstep ${CLEAR_SCREEN}two\nstep\rthree` }),
      [],
    );
    const body = output.slice(output.indexOf("body:"));
    expect(body.split("\n")).toEqual([
      "body:",
      "  step one",
      "  step two",
      "  step three",
    ]);
  });

  it("strips escapes out of the history's actor name", () => {
    const output = formatCard(makeCard(), [
      {
        id: 1,
        ts: "2026-01-01T00:00:00.000Z",
        actor: { type: "agent", name: `pi${CLEAR_SCREEN}` },
        source: "cli",
        type: "card.created",
        cardId: 3,
        payload: {},
      },
    ]);
    expect(output).toContain("created by agent/pi via cli");
    expect(output).not.toContain("\u001b");
  });
});

describe("formatBoard hierarchy progress", () => {
  const parent = makeCard({ id: 1, title: "epic", children: [2, 3] });
  const child = makeCard({ id: 2, state: "review", parent: 1 });
  const outside = makeCard({ id: 3, state: "done", parent: 1 });
  const slice = {
    someday: [],
    todo: [parent],
    doing: [],
    review: [child],
    done: [],
  };

  it("counts children outside the shown board when given an index", () => {
    const index = new Map([parent, child, outside].map((c) => [c.id, c]));
    expect(formatBoard(slice, index)).toContain("▸1/2");
  });

  it("degrades to a bare count without a resolvable child", () => {
    const output = formatBoard(slice);
    expect(output).toContain("▸2");
    expect(output).not.toContain("▸1/2");
  });

  it("prints the parent id when no parent card was resolved", () => {
    expect(formatCard(child, []).split("\n")).toContain("parent: #1");
  });
});
