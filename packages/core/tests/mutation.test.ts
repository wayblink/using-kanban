/**
 * The transition tuple. These assertions are byte-exact on purpose: the whole
 * point of `describeMutation` is that every door reports a mutation the same
 * way, and a test that only checked `toContain("doing")` would still pass if a
 * door regressed to a hand-written sentence.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { describeMutation, describeTransition } from "../src/mutation.js";
import { Kanban } from "../src/kanban.js";
import { MemoryEventLog } from "../src/event-log.js";
import type { Actor } from "../src/types.js";

const agent: Actor = { type: "agent", name: "pi" };

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeKanban(): { kanban: Kanban; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ukb-mutation-test-"));
  tempDirs.push(dir);
  return { kanban: new Kanban({ log: new MemoryEventLog() }), dir };
}

/** The CLI's own brief, so the composed reply is byte-pinned too. */
async function brief(kanban: Kanban, id: number): Promise<string> {
  const card = await kanban.card(id);
  const parts = [`#${id} [${card?.state}]`, card?.title ?? ""];
  if (card?.assignee) parts.push(`@${card.assignee}`);
  return parts.join(" ");
}

describe("describeTransition", () => {
  it("reports the column a card came from, which no door used to say", async () => {
    const { kanban } = makeKanban();
    await kanban.add({ title: "ship it" }, agent, "cli");
    const result = await kanban.claim(1, agent, "cli");
    expect(describeTransition(result)).toBe(
      "todo → doing · now assigned to pi",
    );
  });

  it("names the reviewer when there is one", async () => {
    const { kanban } = makeKanban();
    await kanban.add({ title: "x", reviewer: "jyxc" }, agent, "cli");
    await kanban.claim(1, agent, "cli");
    const result = await kanban.review(1, agent, "cli");
    expect(describeTransition(result)).toBe("doing → review (jyxc)");
  });

  it("distinguishes a hand-off to a named reviewer from a drop into the queue", async () => {
    // The column is called `review`, so no phrasing can avoid the substring
    // "→ review" — and "→ review" alone is not the problem. The problem is
    // that it reads the same whether a person was named or not. These two must
    // not be the same string.
    const { kanban } = makeKanban();
    await kanban.add({ title: "x" }, agent, "cli");
    await kanban.claim(1, agent, "cli");
    expect(describeTransition(await kanban.review(1, agent, "cli"))).toBe(
      "doing → review queue",
    );

    const named = makeKanban();
    await named.kanban.add({ title: "x", reviewer: "jyxc" }, agent, "cli");
    await named.kanban.claim(1, agent, "cli");
    expect(describeTransition(await named.kanban.review(1, agent, "cli"))).toBe(
      "doing → review (jyxc)",
    );
  });

  it("says out loud that a card moved to doing is unowned", async () => {
    const { kanban } = makeKanban();
    await kanban.add({ title: "x" }, agent, "cli");
    const result = await kanban.move(1, "doing", agent, "cli");
    expect(describeTransition(result)).toBe("todo → doing · unassigned");
  });

  it("reports claim on an unowned doing card as the assignment it is", async () => {
    const { kanban } = makeKanban();
    await kanban.add({ title: "x" }, agent, "cli");
    await kanban.move(1, "doing", agent, "cli");
    const result = await kanban.claim(1, agent, "cli");
    expect(describeTransition(result)).toBe(
      "doing → doing · now assigned to pi",
    );
  });

  it("carries no tuple when nothing changed, so no door can claim a move", async () => {
    const { kanban } = makeKanban();
    await kanban.add({ title: "x" }, agent, "cli");
    await kanban.claim(1, agent, "cli");
    const again = await kanban.claim(1, agent, "cli");
    expect(again.events).toHaveLength(0);
    expect(describeTransition(again)).toBeNull();
  });

  it("covers done and reopen", async () => {
    const { kanban } = makeKanban();
    await kanban.add({ title: "x" }, agent, "cli");
    await kanban.claim(1, agent, "cli");
    await kanban.review(1, agent, "cli");
    expect(describeTransition(await kanban.done(1, agent, "cli"))).toBe(
      "review → done",
    );
    expect(describeTransition(await kanban.reopen(1, agent, "cli"))).toBe(
      "done → todo",
    );
  });

  it("sanitizes a reviewer name that carries escapes", async () => {
    const { kanban } = makeKanban();
    await kanban.add({ title: "x", reviewer: "jy\u001b[2Jxc" }, agent, "cli");
    await kanban.claim(1, agent, "cli");
    const result = await kanban.review(1, agent, "cli");
    expect(describeTransition(result)).toBe("doing → review (jyxc)");
  });
});

describe("describeMutation", () => {
  it("puts the verb, the brief and the tuple together", async () => {
    const { kanban } = makeKanban();
    await kanban.add({ title: "ship it" }, agent, "cli");
    const result = await kanban.claim(1, agent, "cli");
    expect(describeMutation(await brief(kanban, 1), result, "claimed")).toBe(
      "claimed #1 [doing] ship it @pi · todo → doing · now assigned to pi",
    );
  });

  it("drops the tuple rather than inventing one for a no-op", async () => {
    const { kanban } = makeKanban();
    await kanban.add({ title: "x" }, agent, "cli");
    await kanban.claim(1, agent, "cli");
    const again = await kanban.claim(1, agent, "cli");
    expect(describeMutation(await brief(kanban, 1), again, "claimed")).toBe(
      "claimed #1 [doing] x @pi",
    );
  });
});
