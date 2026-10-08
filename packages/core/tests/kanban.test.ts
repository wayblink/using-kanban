import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KanbanError } from "../src/errors.js";
import { MemoryEventLog } from "../src/event-log.js";
import { Kanban } from "../src/kanban.js";
import { openKanban, DEFAULT_STORAGE_DIR } from "../src/open.js";
import type { Actor } from "../src/types.js";

const human: Actor = { type: "human", name: "jyxc" };
const agent: Actor = { type: "agent", name: "claude-code" };
const otherAgent: Actor = { type: "agent", name: "codex" };

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanban-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeKanban(): Kanban {
  return new Kanban({ log: new MemoryEventLog() });
}

function expectKanbanError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(KanbanError);
    expect((error as KanbanError).code).toBe(code);
    return;
  }
  throw new Error(`expected a KanbanError with code "${code}"`);
}

describe("add", () => {
  it("creates a todo card with defaults", () => {
    const kanban = makeKanban();
    const { card } = kanban.add({ title: "write docs" }, human);

    expect(card.id).toBe(1);
    expect(card.title).toBe("write docs");
    expect(card.state).toBe("todo");
    expect(card.body).toBeNull();
    expect(card.assignee).toBeNull();
    expect(card.reviewer).toBeNull();
    expect(card.blockedBy).toEqual([]);
    expect(card.createdBy).toBe("jyxc");
    expect(card.revision).toBe(1);
  });

  it("trims the title and rejects an empty one", () => {
    const kanban = makeKanban();
    expect(kanban.add({ title: "  spaced  " }, human).card.title).toBe(
      "spaced",
    );
    expectKanbanError(
      () => kanban.add({ title: "   " }, human),
      "invalid_input",
    );
  });

  it("rejects blockers that do not exist", () => {
    const kanban = makeKanban();
    expectKanbanError(
      () => kanban.add({ title: "x", blockedBy: [42] }, human),
      "card_not_found",
    );
  });
});

describe("claim", () => {
  it("moves a todo card to doing and assigns the actor", () => {
    const kanban = makeKanban();
    const { card } = kanban.add({ title: "fix bug" }, human);

    const claimed = kanban.claim(card.id, agent, "mcp");
    expect(claimed.card.state).toBe("doing");
    expect(claimed.card.assignee).toBe("claude-code");
    expect(claimed.events).toHaveLength(1);
    expect(claimed.events[0]?.type).toBe("card.moved");
  });

  it("is idempotent for the same actor and conflicts for another", () => {
    const kanban = makeKanban();
    const { card } = kanban.add({ title: "fix bug" }, human);
    kanban.claim(card.id, agent);

    const again = kanban.claim(card.id, agent);
    expect(again.events).toHaveLength(0);

    expectKanbanError(
      () => kanban.claim(card.id, otherAgent),
      "claim_conflict",
    );
  });

  it("refuses cards in review or done", () => {
    const kanban = makeKanban();
    const inReview = kanban.add({ title: "a" }, human).card;
    kanban.review(inReview.id, agent);
    expectKanbanError(() => kanban.claim(inReview.id, agent), "claim_conflict");

    const finished = kanban.add({ title: "b" }, human).card;
    kanban.done(finished.id, human);
    expectKanbanError(() => kanban.claim(finished.id, agent), "invalid_state");
  });
});

describe("transitions", () => {
  it("moves through the full workflow", () => {
    const kanban = makeKanban();
    const { card } = kanban.add(
      { title: "ship it", assignee: "codex", reviewer: "jyxc" },
      human,
    );

    kanban.claim(card.id, otherAgent);
    expect(kanban.card(card.id)?.state).toBe("doing");

    kanban.review(card.id, otherAgent);
    expect(kanban.card(card.id)?.state).toBe("review");

    kanban.done(card.id, human);
    expect(kanban.card(card.id)?.state).toBe("done");
  });

  it("done is idempotent and reopen goes back to todo from any state", () => {
    const kanban = makeKanban();
    const { card } = kanban.add({ title: "task" }, human);

    kanban.done(card.id, human);
    expect(kanban.done(card.id, human).events).toHaveLength(0);

    kanban.reopen(card.id, human);
    expect(kanban.card(card.id)?.state).toBe("todo");
  });

  it("supports arbitrary moves", () => {
    const kanban = makeKanban();
    const { card } = kanban.add({ title: "task" }, human);
    kanban.move(card.id, "doing", human);
    expect(kanban.card(card.id)?.state).toBe("doing");
  });

  it("groups cards into board columns", () => {
    const kanban = makeKanban();
    kanban.add({ title: "a" }, human);
    kanban.add({ title: "b" }, human);
    const third = kanban.add({ title: "c" }, human).card;
    kanban.done(third.id, human);

    const board = kanban.board();
    expect(board.todo.map((c) => c.title)).toEqual(["a", "b"]);
    expect(board.done.map((c) => c.title)).toEqual(["c"]);
    expect(board.doing).toEqual([]);
    expect(board.review).toEqual([]);
  });
});

describe("permissions", () => {
  it("lets the creator and assignee edit, nobody else", () => {
    const kanban = makeKanban();
    const { card } = kanban.add({ title: "task", assignee: "codex" }, human);

    kanban.edit(card.id, { title: "renamed by creator" }, human);
    expect(kanban.card(card.id)?.title).toBe("renamed by creator");

    kanban.edit(card.id, { body: "notes from assignee" }, otherAgent);
    expect(kanban.card(card.id)?.body).toBe("notes from assignee");

    expectKanbanError(
      () => kanban.edit(card.id, { title: "nope" }, agent),
      "forbidden",
    );
  });

  it("clears optional fields with null and rejects an empty title", () => {
    const kanban = makeKanban();
    const { card } = kanban.add(
      { title: "task", assignee: "codex", body: "x" },
      human,
    );

    kanban.edit(card.id, { assignee: null, body: null }, human);
    const updated = kanban.card(card.id);
    expect(updated?.assignee).toBeNull();
    expect(updated?.body).toBeNull();

    expectKanbanError(
      () => kanban.edit(card.id, { title: "" }, human),
      "invalid_input",
    );
  });

  it("allows only the creator to delete and cleans dangling blockers", () => {
    const kanban = makeKanban();
    const first = kanban.add({ title: "first" }, human).card;
    const second = kanban.add(
      { title: "second", blockedBy: [first.id] },
      human,
    ).card;
    expect(kanban.card(second.id)?.blockedBy).toEqual([first.id]);

    expectKanbanError(() => kanban.remove(first.id, agent), "forbidden");

    kanban.remove(first.id, human);
    expect(kanban.card(first.id)).toBeNull();
    expect(kanban.card(second.id)?.blockedBy).toEqual([]);
  });
});

describe("dependencies", () => {
  it("blocks, unblocks, and rejects self-blocks, unknown cards, and cycles", () => {
    const kanban = makeKanban();
    const a = kanban.add({ title: "a" }, human).card;
    const b = kanban.add({ title: "b" }, human).card;
    const c = kanban.add({ title: "c" }, human).card;

    kanban.block(b.id, a.id, human);
    kanban.block(c.id, b.id, human);
    expect(kanban.card(c.id)?.blockedBy).toEqual([b.id]);

    kanban.unblock(c.id, b.id, human);
    expect(kanban.card(c.id)?.blockedBy).toEqual([]);

    expectKanbanError(() => kanban.block(a.id, a.id, human), "invalid_input");
    expectKanbanError(() => kanban.block(a.id, 999, human), "card_not_found");

    kanban.block(b.id, a.id, human);
    kanban.block(c.id, b.id, human);
    expectKanbanError(() => kanban.block(a.id, c.id, human), "invalid_input");
  });
});

describe("queries", () => {
  it("lists open cards per assignee and the review queue", () => {
    const kanban = makeKanban();
    kanban.add({ title: "for codex", assignee: "codex" }, human);
    kanban.add({ title: "for claude", assignee: "claude-code" }, human);
    const finished = kanban.add(
      { title: "old", assignee: "codex" },
      human,
    ).card;
    kanban.done(finished.id, human);
    kanban.add({ title: "review me", reviewer: "jyxc" }, human);
    const waiting = kanban.add(
      { title: "waiting review", reviewer: "jyxc" },
      human,
    ).card;
    kanban.review(waiting.id, agent);

    expect(kanban.mine("codex").map((c) => c.title)).toEqual(["for codex"]);
    expect(kanban.reviewQueue("jyxc").map((c) => c.title)).toEqual([
      "waiting review",
    ]);
  });

  it("exposes per-card history", () => {
    const kanban = makeKanban();
    const { card } = kanban.add({ title: "task" }, human);
    kanban.claim(card.id, agent);

    const types = kanban.history(card.id).map((event) => event.type);
    expect(types).toEqual(["card.created", "card.moved"]);
  });
});

describe("optimistic concurrency", () => {
  it("rejects mutations built on a stale revision", () => {
    const kanban = makeKanban();
    const { card } = kanban.add({ title: "task" }, human);
    const stale = card.revision;

    kanban.edit(card.id, { body: "first edit" }, human);
    expectKanbanError(
      () =>
        kanban.edit(card.id, { body: "second edit" }, human, "cli", {
          expectedRevision: stale,
        }),
      "revision_conflict",
    );
  });
});

describe("shared stores (no daemon)", () => {
  it("shares a sqlite board across independent instances", () => {
    const dir = tempDir();
    const writer = openKanban({ storage: "sqlite", dir });
    const { card } = writer.add({ title: "shared card" }, human);

    const reader = openKanban({ storage: "sqlite", dir });
    expect(reader.card(card.id)?.title).toBe("shared card");

    reader.claim(card.id, agent, "mcp");
    expect(writer.card(card.id)?.state).toBe("doing");
    expect(writer.card(card.id)?.assignee).toBe("claude-code");
  });

  it("shares a jsonl board across independent instances", () => {
    const dir = tempDir();
    const writer = openKanban({ storage: "jsonl", dir });
    const { card } = writer.add(
      { title: "jsonl card", assignee: "codex" },
      human,
    );

    const reader = openKanban({ storage: "jsonl", dir });
    expect(reader.card(card.id)?.title).toBe("jsonl card");

    reader.done(card.id, human);
    expect(writer.card(card.id)?.state).toBe("done");
  });

  it("defaults to a sqlite store at <dir>/.ukb/board.db", () => {
    const dir = tempDir();
    const kanban = openKanban({ dir });
    const { card } = kanban.add({ title: "default location" }, human);

    expect(existsSync(join(dir, DEFAULT_STORAGE_DIR, "board.db"))).toBe(true);
    expect(openKanban({ dir }).card(card.id)?.title).toBe("default location");
  });
});
