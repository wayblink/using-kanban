/**
 * The terminal renderers are a contract: they are what a human and another
 * agent read. Two things are pinned here — that every card field is sanitized
 * before it reaches a terminal, and that a multi-line body keeps its lines.
 */
import { describe, expect, it } from "vitest";
import type { Board, Card } from "@wayblink/using-kanban-core";
import {
  formatBoard,
  formatCard,
  formatCardBrief,
  formatMine,
} from "../src/render.js";

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
    notes: [],
    createdBy: "jyxc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
    ...over,
  };
}

function board(cards: readonly Card[]): Board {
  return { todo: cards, doing: [], review: [], done: [] };
}

const CLEAR_SCREEN = "\u001b[2J";
const BIDI_OVERRIDE = "\u202e";

describe("formatCardBrief", () => {
  it("strips escape sequences and control characters from every field", () => {
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
    expect(output).not.toContain("\u0007");
  });

  it("keeps a carriage return from splitting a card across two lines", () => {
    const output = formatCardBrief(makeCard({ title: "a\r#9 [done] fake" }));
    expect(output.split("\n")).toHaveLength(1);
  });
});

describe("formatBoard", () => {
  it("cannot be made to print a forged extra row", () => {
    const output = formatBoard(
      board([makeCard({ title: "a\n  #1 [done] impostor" })]),
    );
    // todo header, the one card, then the three empty columns.
    expect(output.split("\n")).toHaveLength(8);
    expect(output).toContain("#3 [todo] a   #1 [done] impostor");
  });

  it("strips escapes out of a title", () => {
    const output = formatBoard(
      board([makeCard({ title: `ship${CLEAR_SCREEN}` })]),
    );
    expect(output).toContain("#3 [todo] ship");
    expect(output).not.toContain("\u001b");
  });
});

describe("formatMine", () => {
  it("strips escapes out of the listed titles", () => {
    const output = formatMine(
      [makeCard({ title: `x${CLEAR_SCREEN}` })],
      "codex",
    );
    expect(output).toContain("#3 [todo] x");
    expect(output).not.toContain("\u001b");
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
    expect(output).toContain("#9 doc — docs/design.md (note,");
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

  it("strips escapes out of the event history's actor name", () => {
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
