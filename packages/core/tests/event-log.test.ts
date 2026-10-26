import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { JsonlEventLog } from "../src/event-log-jsonl.js";
import { MemoryEventLog } from "../src/event-log.js";
import { SqliteEventLog } from "../src/event-log-sqlite.js";
import type { Actor, NewEvent } from "../src/types.js";

const actor: Actor = { type: "agent", name: "claude-code" };

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanban-log-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function created(title: string): NewEvent {
  return {
    actor,
    source: "cli",
    type: "card.created",
    cardId: null,
    payload: {
      title,
      body: null,
      assignee: null,
      reviewer: null,
      blockedBy: [],
      createdBy: "jyxc",
    },
  };
}

function moved(cardId: number): NewEvent {
  return {
    actor,
    source: "mcp",
    type: "card.moved",
    cardId,
    payload: {
      from: "todo",
      to: "doing",
      action: "claim",
      patch: { assignee: "claude-code" },
    },
  };
}

function deleted(cardId: number): NewEvent {
  return {
    actor,
    source: "cli",
    type: "card.deleted",
    cardId,
    payload: {},
  };
}

/** A card-created event carrying its own id, as a pre-split board's rows do. */
function legacyCreated(title: string, cardId: number): NewEvent {
  return { ...created(title), cardId };
}

const logs = [
  ["memory", () => new MemoryEventLog()],
  ["jsonl", () => new JsonlEventLog(join(tempDir(), "events.jsonl"))],
  ["sqlite", () => new SqliteEventLog(join(tempDir(), "board.db"))],
] as const;

describe.each(logs)("%s event log", (_name, open) => {
  it("gives a card its own id, independent of the event sequence", () => {
    const log = open();
    const [first, second, third] = log.append([
      created("a"),
      moved(1),
      created("b"),
    ]);

    // Event ids are the log's own sequence: one per event, gaps allowed.
    expect([first?.id, second?.id, third?.id]).toEqual([1, 2, 3]);
    // Card ids count cards. A board's edit history must not inflate them: the
    // second card is #2 even though its creation is event 3.
    expect(first?.cardId).toBe(1);
    expect(second?.cardId).toBe(1);
    expect(third?.cardId).toBe(2);
    expect(log.maxId()).toBe(3);
    log.close();
  });

  it("starts above the card ids already in the log", () => {
    // A board written before the split carries card ids from the event
    // sequence — 900 here. The first new card must not collide with them.
    const log = open();
    log.append([legacyCreated("old", 900)]);
    const [fresh] = log.append([created("new")]);
    expect(fresh?.cardId).toBe(901);
    log.close();
  });

  it("does not reuse the id of a deleted card", () => {
    const log = open();
    log.append([created("a"), deleted(1)]);
    const [next] = log.append([created("b")]);
    expect(next?.cardId).toBe(2);
    log.close();
  });

  it("reads events incrementally and by card", () => {
    const log = open();
    log.append([created("a"), created("b")]);
    log.append([moved(1)]);

    expect(log.since(0).map((event) => event.id)).toEqual([1, 2, 3]);
    expect(log.since(2).map((event) => event.id)).toEqual([3]);
    expect(log.byCard(1).map((event) => event.type)).toEqual([
      "card.created",
      "card.moved",
    ]);
    expect(log.byCard(2)).toHaveLength(1);
    log.close();
  });

  it("appends atomically in one call", () => {
    const log = open();
    const events = log.append([created("a"), moved(1), created("b")]);
    expect(events.map((event) => event.id)).toEqual([1, 2, 3]);
    expect(log.since(0)).toHaveLength(3);
    log.close();
  });
});

describe("SqliteEventLog", () => {
  it("persists across reopen", () => {
    const path = join(tempDir(), "board.db");
    const first = new SqliteEventLog(path);
    first.append([created("persisted"), moved(1)]);
    first.close();

    const second = new SqliteEventLog(path);
    expect(second.maxId()).toBe(2);
    expect(second.byCard(1).map((event) => event.type)).toEqual([
      "card.created",
      "card.moved",
    ]);
    second.close();
  });

  it("keeps appending after reopen without reusing ids", () => {
    const path = join(tempDir(), "board.db");
    const first = new SqliteEventLog(path);
    first.append([created("a")]);
    first.close();

    const second = new SqliteEventLog(path);
    const [event] = second.append([created("b")]);
    expect(event?.id).toBe(2);
    second.close();
  });

  it("keeps card ids dense across a reopen, with events in between", () => {
    // The bug this replaces: before the split, `add, move, add` produced #3 for
    // the second card. The card sequence must survive a reopen too.
    const path = join(tempDir(), "board.db");
    const first = new SqliteEventLog(path);
    first.append([created("a"), moved(1), moved(1)]);
    first.close();

    const second = new SqliteEventLog(path);
    const [event] = second.append([created("b")]);
    expect(event?.id).toBe(4);
    expect(event?.cardId).toBe(2);
    second.close();
  });
});

describe("JsonlEventLog", () => {
  it("writes one JSON object per line and persists across reopen", () => {
    const path = join(tempDir(), "events.jsonl");
    const first = new JsonlEventLog(path);
    first.append([created("a"), moved(1)]);
    first.close();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).cardId).toBe(1);

    const second = new JsonlEventLog(path);
    expect(second.maxId()).toBe(2);
    expect(second.byCard(1)).toHaveLength(2);
    second.close();
  });

  it("keeps card ids dense across a reopen, with events in between", () => {
    const path = join(tempDir(), "events.jsonl");
    const first = new JsonlEventLog(path);
    first.append([created("a"), moved(1), moved(1)]);
    first.close();

    const second = new JsonlEventLog(path);
    const [event] = second.append([created("b")]);
    expect(event?.id).toBe(4);
    expect(event?.cardId).toBe(2);
    second.close();
  });

  it("creates the file lazily and tolerates a trailing newline", () => {
    const dir = tempDir();
    const path = join(dir, "nested", "events.jsonl");
    const log = new JsonlEventLog(path);
    expect(existsSync(path)).toBe(false);

    log.append([created("a")]);
    expect(existsSync(path)).toBe(true);

    const reopened = new JsonlEventLog(path);
    expect(reopened.maxId()).toBe(1);
    log.close();
    reopened.close();
  });
});
