import { describe, expect, it } from "vitest";
import { MemoryEventLog } from "../src/event-log.js";
import { Kanban } from "../src/kanban.js";
import { Projection } from "../src/projection.js";
import type { Actor } from "../src/types.js";

const human: Actor = { type: "human", name: "jyxc" };
const agent: Actor = { type: "agent", name: "claude-code" };

async function scenario(kanban: Kanban): Promise<void> {
  const first = (
    await kanban.add(
      { title: "design API", body: "REST + SSE", reviewer: "jyxc" },
      human,
    )
  ).card;
  const second = (
    await kanban.add(
      {
        title: "implement API",
        assignee: "claude-code",
        blockedBy: [first.id],
      },
      human,
    )
  ).card;

  await kanban.block(second.id, first.id, human);
  await kanban.edit(second.id, { body: "openapi.json first" }, human);
  // the blocker has to be finished before the blocked card may be claimed —
  // this scenario used to claim it first, which was only possible because
  // blockers were not enforced
  await kanban.done(first.id, human);
  await kanban.claim(second.id, agent, "mcp");
  await kanban.review(second.id, agent, "mcp");
  await kanban.remove(first.id, human);
  await kanban.reopen(second.id, human);
}

describe("Projection", () => {
  it("rebuilds an identical board from the event log alone", async () => {
    const log = new MemoryEventLog();
    const kanban = new Kanban({ log });
    await scenario(kanban);

    const replayed = new Projection();
    for (const event of await log.since(0)) {
      replayed.apply(event);
    }

    expect(replayed.board()).toEqual(await kanban.board());
    expect(replayed.lastAppliedEventId).toBe(await log.maxId());
  });

  it("files a card under its own id, not under its creation event's id", async () => {
    // Event ids and card ids are separate sequences: a card created after two
    // moves is card #2 but event #4. The projection used to key the new card on
    // `event.id`, which silently lost it as soon as the two diverged.
    const log = new MemoryEventLog();
    const kanban = new Kanban({ log });
    const first = (await kanban.add({ title: "a" }, human)).card;
    await kanban.claim(first.id, agent);
    await kanban.reopen(first.id, human);
    await kanban.add({ title: "b" }, human);

    const created = (await log.since(0))
      .filter((event) => event.type === "card.created")
      .at(-1);
    expect(created?.id).toBe(4);
    expect(created?.cardId).toBe(2);

    const replayed = new Projection();
    for (const event of await log.since(0)) replayed.apply(event);
    expect(replayed.card(created!.cardId)?.title).toBe("b");
    expect(replayed.card(created!.id)).toBeUndefined();
  });

  it("syncs incrementally", async () => {
    const log = new MemoryEventLog();
    const kanban = new Kanban({ log });
    const { card } = await kanban.add({ title: "task" }, human);

    const projection = new Projection();
    await projection.sync(log);
    expect(projection.card(card.id)?.state).toBe("todo");

    await kanban.claim(card.id, agent);
    await projection.sync(log);
    expect(projection.card(card.id)?.state).toBe("doing");
    expect(projection.card(card.id)?.assignee).toBe("claude-code");
  });

  it("rejects corrupt payloads instead of silently mis-projecting", async () => {
    const log = new MemoryEventLog();
    const kanban = new Kanban({ log });
    await kanban.add({ title: "task" }, human);

    const events = await log.since(0);
    const corrupt = { ...events[0]!, payload: { title: "" } };
    const projection = new Projection();
    expect(() => projection.apply(corrupt)).toThrow();
  });

  it("detects transitive cycles", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const a = (await kanban.add({ title: "a" }, human)).card;
    const b = (await kanban.add({ title: "b" }, human)).card;
    const c = (await kanban.add({ title: "c" }, human)).card;
    await kanban.block(b.id, a.id, human);
    await kanban.block(c.id, b.id, human);

    await expect(kanban.block(a.id, c.id, human)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
