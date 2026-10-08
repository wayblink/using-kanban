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

const logs = [
  ["memory", () => new MemoryEventLog()],
  ["jsonl", () => new JsonlEventLog(join(tempDir(), "events.jsonl"))],
  ["sqlite", () => new SqliteEventLog(join(tempDir(), "board.db"))],
] as const;

describe.each(logs)("%s event log", (_name, open) => {
  it("assigns sequential ids and links card.created to its own id", () => {
    const log = open();
    const [first, second] = log.append([created("a"), created("b")]);

    expect(first?.id).toBe(1);
    expect(first?.cardId).toBe(1);
    expect(second?.id).toBe(2);
    expect(second?.cardId).toBe(2);
    expect(log.maxId()).toBe(2);
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
