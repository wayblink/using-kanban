import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryEventLog, type EventLog } from "../src/event-log.js";
import { SqliteEventLog } from "../src/event-log-sqlite.js";
import { JsonlEventLog } from "../src/event-log-jsonl.js";
import { Kanban } from "../src/kanban.js";
import type { Actor } from "../src/types.js";

const human: Actor = { type: "human", name: "jyxc" };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ukb-import-"));
}

const targets: [string, () => EventLog][] = [
  ["memory", () => new MemoryEventLog()],
  ["sqlite", () => new SqliteEventLog(join(tempDir(), "board.db"))],
  ["jsonl", () => new JsonlEventLog(join(tempDir(), "events.jsonl"))],
];

async function sourceEvents(): Promise<{
  events: Awaited<ReturnType<EventLog["since"]>>;
  board: Awaited<ReturnType<Kanban["board"]>>;
  maxCard: number;
}> {
  const log = new SqliteEventLog(join(tempDir(), "source.db"));
  const kanban = new Kanban({ log });
  await kanban.add({ title: "one", project: "web" }, human);
  await kanban.add({ title: "two", blockedBy: [1] }, human);
  await kanban.claim(1, human);
  await kanban.done(1, human);
  await kanban.add({ title: "gone" }, human);
  await kanban.remove(3, human);
  await kanban.addNote(2, { text: "a note" }, human);
  const events = await log.since(0);
  const board = await kanban.board();
  log.close();
  return { events, board, maxCard: 3 };
}

describe.each(targets)("%s importEvents", (_name, open) => {
  it("replays events with their original ids and card ids", async () => {
    const { events, board, maxCard } = await sourceEvents();
    const log = open();
    const summary = await log.importEvents(events);
    expect(summary.events).toBe(events.length);
    expect(summary.maxEventId).toBe(events.at(-1)?.id);
    expect(summary.maxCardId).toBe(maxCard);

    const replayed = new Kanban({ log });
    const restored = await replayed.board();
    expect(restored.doing.map((card) => card.id)).toEqual(
      board.doing.map((card) => card.id),
    );
    expect(restored.todo.map((card) => card.title)).toEqual(
      board.todo.map((card) => card.title),
    );
    // The next append continues both sequences.
    const added = await replayed.add({ title: "after" }, human);
    expect(added.card.id).toBe(maxCard + 1);
    expect(added.events[0]?.id).toBe(events.length + 1);
    log.close();
  });

  it("refuses a non-empty target without force, then merges with it", async () => {
    const { events } = await sourceEvents();
    const log = open();
    await log.append([events[0]!]);
    await expect(log.importEvents(events)).rejects.toMatchObject({
      code: "conflict",
    });
    const summary = await log.importEvents(events, { force: true });
    expect(summary.events).toBe(events.length);
    log.close();
  });
});
