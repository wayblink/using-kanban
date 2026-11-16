/**
 * The one line the extension puts in front of the model at the start of a run.
 *
 * Why it exists: the `ukb` tool's `promptGuidelines` are static — written into
 * the system prompt once, at registration. After forty turns of a session they
 * read as background, and the maintenance half of the workflow (create, claim,
 * hand off) quietly stopped happening. A digest is a *fact about this turn*, so
 * it is worth reading every time, and it costs one short line.
 *
 * It lives in packages/pi like `guidance.ts` — pure and Pi-free — and is tested
 * here for the same reason: the Pi package has no test runner of its own.
 */
import { describe, expect, it } from "vitest";
import {
  DIGEST_OFF,
  MAX_DIGEST_CHARS,
  buildBoardDigest,
  isDigestDisabled,
} from "../../pi/extensions/using-kanban/board-digest.js";
import { parseBoardJson } from "../../pi/extensions/using-kanban/overlay-render.js";

const AGENT = "pi";

function board(columns: Partial<Record<string, unknown[]>>): string {
  return JSON.stringify({
    someday: [],
    todo: [],
    doing: [],
    review: [],
    done: [],
    projects: [],
    ...columns,
  });
}

function digest(json: string, project: string | null = null) {
  const snapshot = parseBoardJson(json);
  if (snapshot === null) throw new Error("fixture did not parse");
  return buildBoardDigest({ board: snapshot, agent: AGENT, project });
}

const card = (over: Record<string, unknown> = {}) => ({
  id: 1,
  title: "a card",
  assignee: null,
  reviewer: null,
  project: "web",
  subproject: null,
  priority: "normal",
  blockedBy: [],
  parent: null,
  children: [],
  updatedAt: "2026-11-05T00:00:00.000Z",
  ...over,
});

describe("buildBoardDigest", () => {
  it("says nothing when the board has no open work", () => {
    expect(digest(board({}))).toBeNull();
  });

  it("says nothing when the only cards are parked or finished", () => {
    const json = board({
      someday: [card({ id: 1, state: "someday" })],
      done: [card({ id: 2, state: "done" })],
    });
    expect(digest(json)).toBeNull();
  });

  it("names the card I am holding, the todo I could pick up, and the review waiting", () => {
    const json = board({
      doing: [
        card({ id: 2960, title: "用户页", assignee: AGENT }),
        card({ id: 77, title: "someone else's", assignee: "codex" }),
      ],
      todo: [card({ id: 5 }), card({ id: 6, assignee: AGENT })],
      review: [card({ id: 9, reviewer: null })],
    });
    const line = digest(json);
    expect(line).not.toBeNull();
    expect(line?.text).toContain("doing 1");
    expect(line?.text).toContain("#2960");
    expect(line?.text).toContain("todo 2");
    expect(line?.text).toContain("review 1");
    // Another agent's card is not mine to report as held.
    expect(line?.text).not.toContain("#77");
  });

  it("does not count a review that belongs to someone else", () => {
    const json = board({ review: [card({ id: 9, reviewer: "codex" })] });
    expect(digest(json)).toBeNull();
  });

  it("scopes the counts to one project, and counts everything when given none", () => {
    const json = board({
      todo: [card({ id: 1, project: "web" }), card({ id: 2, project: "api" })],
    });
    expect(digest(json, "web")?.text).toContain("todo 1");
    expect(digest(json, null)?.text).toContain("todo 2");
  });

  it("asks for the handoff when I am already holding a card, the claim otherwise", () => {
    const holding = digest(
      board({ doing: [card({ id: 1, assignee: AGENT })] }),
    );
    expect(holding?.text).toContain("review");

    const idle = digest(board({ todo: [card({ id: 1 })] }));
    expect(idle?.text).toContain("claim");
  });

  it("stays one line and one bounded length whatever the title", () => {
    const json = board({
      doing: [
        card({
          id: 1,
          title: `多行\n标题 ${"很长".repeat(200)}`,
          assignee: AGENT,
        }),
      ],
    });
    const line = digest(json);
    expect(line?.text).not.toContain("\n");
    expect((line?.text.length ?? 0) <= MAX_DIGEST_CHARS).toBe(true);
  });
});

describe("isDigestDisabled", () => {
  it("is on by default — the line exists precisely because silence was the bug", () => {
    expect(isDigestDisabled({})).toBe(false);
    expect(isDigestDisabled({ UKB_DIGEST: "on" })).toBe(false);
  });

  it("takes off, 0 and false as off, in any case", () => {
    expect(isDigestDisabled({ UKB_DIGEST: DIGEST_OFF })).toBe(true);
    expect(isDigestDisabled({ UKB_DIGEST: " OFF " })).toBe(true);
    expect(isDigestDisabled({ UKB_DIGEST: "0" })).toBe(true);
    expect(isDigestDisabled({ UKB_DIGEST: "false" })).toBe(true);
  });
});
