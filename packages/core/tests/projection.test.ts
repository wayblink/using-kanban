import { describe, expect, it } from "vitest";
import { KanbanError } from "../src/errors.js";
import { MemoryEventLog } from "../src/event-log.js";
import { Kanban } from "../src/kanban.js";
import { Projection } from "../src/projection.js";
import type { Actor } from "../src/types.js";

const human: Actor = { type: "human", name: "jyxc" };
const agent: Actor = { type: "agent", name: "claude-code" };

function scenario(kanban: Kanban): void {
  const first = kanban.add(
    { title: "design API", body: "REST + SSE", reviewer: "jyxc" },
    human,
  ).card;
  const second = kanban.add(
    { title: "implement API", assignee: "claude-code", blockedBy: [first.id] },
    human,
  ).card;

  kanban.block(second.id, first.id, human);
  kanban.edit(second.id, { body: "openapi.json first" }, human);
  // the blocker has to be finished before the blocked card may be claimed —
  // this scenario used to claim it first, which was only possible because
  // blockers were not enforced
  kanban.done(first.id, human);
  kanban.claim(second.id, agent, "mcp");
  kanban.review(second.id, agent, "mcp");
  kanban.remove(first.id, human);
  kanban.reopen(second.id, human);
}

describe("Projection", () => {
  it("rebuilds an identical board from the event log alone", () => {
    const log = new MemoryEventLog();
    const kanban = new Kanban({ log });
    scenario(kanban);

    const replayed = new Projection();
    for (const event of log.since(0)) {
      replayed.apply(event);
    }

    expect(replayed.board()).toEqual(kanban.board());
    expect(replayed.lastAppliedEventId).toBe(log.maxId());
  });

  it("syncs incrementally", () => {
    const log = new MemoryEventLog();
    const kanban = new Kanban({ log });
    const { card } = kanban.add({ title: "task" }, human);

    const projection = new Projection();
    projection.sync(log);
    expect(projection.card(card.id)?.state).toBe("todo");

    kanban.claim(card.id, agent);
    projection.sync(log);
    expect(projection.card(card.id)?.state).toBe("doing");
    expect(projection.card(card.id)?.assignee).toBe("claude-code");
  });

  it("rejects corrupt payloads instead of silently mis-projecting", () => {
    const log = new MemoryEventLog();
    const kanban = new Kanban({ log });
    kanban.add({ title: "task" }, human);

    const events = log.since(0);
    const corrupt = { ...events[0]!, payload: { title: "" } };
    const projection = new Projection();
    expect(() => projection.apply(corrupt)).toThrow();
  });

  it("detects transitive cycles", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const a = kanban.add({ title: "a" }, human).card;
    const b = kanban.add({ title: "b" }, human).card;
    const c = kanban.add({ title: "c" }, human).card;
    kanban.block(b.id, a.id, human);
    kanban.block(c.id, b.id, human);

    expectKanbanError(() => kanban.block(a.id, c.id, human), "invalid_input");
  });
});

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
