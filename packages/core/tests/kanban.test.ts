import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KanbanError } from "../src/errors.js";
import { compareByPriority } from "../src/projection.js";
import { MemoryEventLog } from "../src/event-log.js";
import { Kanban } from "../src/kanban.js";
import { Projection } from "../src/projection.js";
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

async function expectKanbanError(
  fn: () => Promise<unknown>,
  code: string,
  message?: RegExp,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(KanbanError);
    expect((error as KanbanError).code).toBe(code);
    // The message is the whole UX of a refusal: it has to say which end to move
    // first, so a test can pin it without pinning the exact wording.
    if (message) expect((error as KanbanError).message).toMatch(message);
    return;
  }
  throw new Error(`expected a KanbanError with code "${code}"`);
}

describe("add", () => {
  it("creates a todo card with defaults", async () => {
    const kanban = makeKanban();
    const { card } = await kanban.add({ title: "write docs" }, human);

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

  it("trims the title and rejects an empty one", async () => {
    const kanban = makeKanban();
    expect((await kanban.add({ title: "  spaced  " }, human)).card.title).toBe(
      "spaced",
    );
    await expectKanbanError(
      async () => await kanban.add({ title: "   " }, human),
      "invalid_input",
    );
  });

  it("rejects blockers that do not exist", async () => {
    const kanban = makeKanban();
    await expectKanbanError(
      async () => await kanban.add({ title: "x", blockedBy: [42] }, human),
      "card_not_found",
    );
  });

  it("stores blank optional fields as null, not as empty strings", async () => {
    // `--reviewer "$REVIEWER"` with an unset shell variable is the everyday way
    // this happens, and an empty string is neither "unassigned" nor a name: it
    // silently drops out of `mine` and every assignee filter. `edit` already
    // normalises; `add` has to agree with it.
    const kanban = makeKanban();
    const { card } = await kanban.add(
      { title: "x", assignee: "   ", reviewer: "" },
      human,
    );

    expect(card.assignee).toBeNull();
    expect(card.reviewer).toBeNull();
  });

  it("trims a name it keeps", async () => {
    const kanban = makeKanban();
    const { card } = await kanban.add(
      { title: "x", assignee: "  codex  ", reviewer: " pi " },
      human,
    );

    expect(card.assignee).toBe("codex");
    expect(card.reviewer).toBe("pi");
  });
});

describe("claim", () => {
  it("moves a todo card to doing and assigns the actor", async () => {
    const kanban = makeKanban();
    const { card } = await kanban.add({ title: "fix bug" }, human);

    const claimed = await kanban.claim(card.id, agent, "mcp");
    expect(claimed.card.state).toBe("doing");
    expect(claimed.card.assignee).toBe("claude-code");
    expect(claimed.events).toHaveLength(1);
    expect(claimed.events[0]?.type).toBe("card.moved");
  });

  it("is idempotent for the same actor and conflicts for another", async () => {
    const kanban = makeKanban();
    const { card } = await kanban.add({ title: "fix bug" }, human);
    await kanban.claim(card.id, agent);

    const again = await kanban.claim(card.id, agent);
    expect(again.events).toHaveLength(0);

    await expectKanbanError(
      async () => await kanban.claim(card.id, otherAgent),
      "claim_conflict",
    );
  });

  it("claims a card that move left doing with nobody owning it", async () => {
    // `move <id> doing` does not assign, so the card sits in the working
    // column unowned. Claiming it is the fix, not a conflict: refusing here
    // reported a phantom owner and sent the caller off to "pick another card"
    // over work that was genuinely up for grabs.
    const kanban = makeKanban();
    const { card } = await kanban.add({ title: "queued" }, human);
    await kanban.move(card.id, "doing", otherAgent);
    expect((await kanban.card(card.id))?.assignee).toBeNull();

    const claimed = await kanban.claim(card.id, agent);
    expect(claimed.card.assignee).toBe(agent.name);
    expect(claimed.card.state).toBe("doing");
    expect(claimed.events).toHaveLength(1);
  });

  it("still conflicts when the doing card has a real owner", async () => {
    const kanban = makeKanban();
    const { card } = await kanban.add({ title: "mine" }, human);
    await kanban.claim(card.id, otherAgent);

    // The message must name the owner: there is no "someone else" case left to
    // fall back to, so an unowned doing card can no longer produce that string.
    await expectKanbanError(
      async () => await kanban.claim(card.id, agent),
      "claim_conflict",
    );
    try {
      await kanban.claim(card.id, agent);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toBe(
        `card ${card.id} is already being worked by ${otherAgent.name}`,
      );
    }
  });

  it("refuses cards in review or done", async () => {
    const kanban = makeKanban();
    const inReview = (await kanban.add({ title: "a" }, human)).card;
    await kanban.review(inReview.id, agent);
    await expectKanbanError(
      async () => await kanban.claim(inReview.id, agent),
      "claim_conflict",
    );

    const finished = (await kanban.add({ title: "b" }, human)).card;
    await kanban.done(finished.id, human);
    await expectKanbanError(
      async () => await kanban.claim(finished.id, agent),
      "invalid_state",
    );
  });
});

describe("transitions", () => {
  it("moves through the full workflow", async () => {
    const kanban = makeKanban();
    const { card } = await kanban.add(
      { title: "ship it", assignee: "codex", reviewer: "jyxc" },
      human,
    );

    await kanban.claim(card.id, otherAgent);
    expect((await kanban.card(card.id))?.state).toBe("doing");

    await kanban.review(card.id, otherAgent);
    expect((await kanban.card(card.id))?.state).toBe("review");

    await kanban.done(card.id, human);
    expect((await kanban.card(card.id))?.state).toBe("done");
  });

  it("done is idempotent and reopen goes back to todo from any state", async () => {
    const kanban = makeKanban();
    const { card } = await kanban.add({ title: "task" }, human);

    await kanban.done(card.id, human);
    expect((await kanban.done(card.id, human)).events).toHaveLength(0);

    await kanban.reopen(card.id, human);
    expect((await kanban.card(card.id))?.state).toBe("todo");
  });

  it("supports arbitrary moves", async () => {
    const kanban = makeKanban();
    const { card } = await kanban.add({ title: "task" }, human);
    await kanban.move(card.id, "doing", human);
    expect((await kanban.card(card.id))?.state).toBe("doing");
  });

  it("groups cards into board columns", async () => {
    const kanban = makeKanban();
    await kanban.add({ title: "a" }, human);
    await kanban.add({ title: "b" }, human);
    const third = (await kanban.add({ title: "c" }, human)).card;
    await kanban.done(third.id, human);

    const board = await kanban.board();
    expect(board.todo.map((c) => c.title)).toEqual(["a", "b"]);
    expect(board.done.map((c) => c.title)).toEqual(["c"]);
    expect(board.doing).toEqual([]);
    expect(board.review).toEqual([]);
  });
});

describe("permissions", () => {
  it("lets the creator and assignee edit, nobody else", async () => {
    const kanban = makeKanban();
    const { card } = await kanban.add(
      { title: "task", assignee: "codex" },
      human,
    );

    await kanban.edit(card.id, { title: "renamed by creator" }, human);
    expect((await kanban.card(card.id))?.title).toBe("renamed by creator");

    await kanban.edit(card.id, { body: "notes from assignee" }, otherAgent);
    expect((await kanban.card(card.id))?.body).toBe("notes from assignee");

    await expectKanbanError(
      async () => await kanban.edit(card.id, { title: "nope" }, agent),
      "forbidden",
    );
  });

  it("clears optional fields with null and rejects an empty title", async () => {
    const kanban = makeKanban();
    const { card } = await kanban.add(
      { title: "task", assignee: "codex", body: "x" },
      human,
    );

    await kanban.edit(card.id, { assignee: null, body: null }, human);
    const updated = await kanban.card(card.id);
    expect(updated?.assignee).toBeNull();
    expect(updated?.body).toBeNull();

    await expectKanbanError(
      async () => await kanban.edit(card.id, { title: "" }, human),
      "invalid_input",
    );
  });

  it("lets the machine's owner edit and delete anyone's card", async () => {
    // The solo-machine case: agents claim work under their own names, and the
    // person at the keyboard must not be locked out of their own board by a
    // name they never typed.
    const kanban = new Kanban({
      log: new MemoryEventLog(),
      owner: "jyxc",
    });
    const { card } = await kanban.add(
      { title: "claimed by an agent", assignee: "codex" },
      agent,
    );

    await kanban.edit(card.id, { title: "renamed by the owner" }, human);
    expect((await kanban.card(card.id))?.title).toBe("renamed by the owner");

    await kanban.remove(card.id, human);
    expect(await kanban.card(card.id)).toBeNull();
  });

  it("does not let a non-owner human through", async () => {
    const kanban = new Kanban({
      log: new MemoryEventLog(),
      owner: "someone-else",
    });
    const { card } = await kanban.add(
      { title: "task", assignee: "codex" },
      agent,
    );

    await expectKanbanError(
      async () => await kanban.edit(card.id, { title: "nope" }, human),
      "forbidden",
      /only the creator/,
    );
  });

  it("allows only the creator to delete and cleans dangling blockers", async () => {
    const kanban = makeKanban();
    const first = (await kanban.add({ title: "first" }, human)).card;
    const second = (
      await kanban.add({ title: "second", blockedBy: [first.id] }, human)
    ).card;
    expect((await kanban.card(second.id))?.blockedBy).toEqual([first.id]);

    await expectKanbanError(
      async () => await kanban.remove(first.id, agent),
      "forbidden",
    );

    await kanban.remove(first.id, human);
    expect(await kanban.card(first.id)).toBeNull();
    expect((await kanban.card(second.id))?.blockedBy).toEqual([]);
  });
});

describe("dependencies", () => {
  it("blocks, unblocks, and rejects self-blocks, unknown cards, and cycles", async () => {
    const kanban = makeKanban();
    const a = (await kanban.add({ title: "a" }, human)).card;
    const b = (await kanban.add({ title: "b" }, human)).card;
    const c = (await kanban.add({ title: "c" }, human)).card;

    await kanban.block(b.id, a.id, human);
    await kanban.block(c.id, b.id, human);
    expect((await kanban.card(c.id))?.blockedBy).toEqual([b.id]);

    await kanban.unblock(c.id, b.id, human);
    expect((await kanban.card(c.id))?.blockedBy).toEqual([]);

    await expectKanbanError(
      async () => await kanban.block(a.id, a.id, human),
      "invalid_input",
    );
    await expectKanbanError(
      async () => await kanban.block(a.id, 999, human),
      "card_not_found",
    );

    await kanban.block(b.id, a.id, human);
    await kanban.block(c.id, b.id, human);
    await expectKanbanError(
      async () => await kanban.block(a.id, c.id, human),
      "invalid_input",
    );
  });
});

describe("queries", () => {
  it("lists open cards per assignee and the review queue", async () => {
    const kanban = makeKanban();
    await kanban.add({ title: "for codex", assignee: "codex" }, human);
    await kanban.add({ title: "for claude", assignee: "claude-code" }, human);
    const finished = (
      await kanban.add({ title: "old", assignee: "codex" }, human)
    ).card;
    await kanban.done(finished.id, human);
    await kanban.add({ title: "review me", reviewer: "jyxc" }, human);
    const waiting = (
      await kanban.add({ title: "waiting review", reviewer: "jyxc" }, human)
    ).card;
    await kanban.review(waiting.id, agent);

    expect((await kanban.mine("codex")).map((c) => c.title)).toEqual([
      "for codex",
    ]);
    expect((await kanban.reviewQueue("jyxc")).map((c) => c.title)).toEqual([
      "waiting review",
    ]);
  });

  it("exposes per-card history", async () => {
    const kanban = makeKanban();
    const { card } = await kanban.add({ title: "task" }, human);
    await kanban.claim(card.id, agent);

    const types = (await kanban.history(card.id)).map((event) => event.type);
    expect(types).toEqual(["card.created", "card.moved"]);
  });
});

describe("optimistic concurrency", () => {
  it("rejects mutations built on a stale revision", async () => {
    const kanban = makeKanban();
    const { card } = await kanban.add({ title: "task" }, human);
    const stale = card.revision;

    await kanban.edit(card.id, { body: "first edit" }, human);
    await expectKanbanError(
      async () =>
        await kanban.edit(card.id, { body: "second edit" }, human, "cli", {
          expectedRevision: stale,
        }),
      "revision_conflict",
    );
  });
});

describe("shared stores (no daemon)", () => {
  it("shares a sqlite board across independent instances", async () => {
    const dir = tempDir();
    const writer = openKanban({ storage: "sqlite", dir });
    const { card } = await writer.add({ title: "shared card" }, human);

    const reader = openKanban({ storage: "sqlite", dir });
    expect((await reader.card(card.id))?.title).toBe("shared card");

    await reader.claim(card.id, agent, "mcp");
    expect((await writer.card(card.id))?.state).toBe("doing");
    expect((await writer.card(card.id))?.assignee).toBe("claude-code");
  });

  it("shares a jsonl board across independent instances", async () => {
    const dir = tempDir();
    const writer = openKanban({ storage: "jsonl", dir });
    const { card } = await writer.add(
      { title: "jsonl card", assignee: "codex" },
      human,
    );

    const reader = openKanban({ storage: "jsonl", dir });
    expect((await reader.card(card.id))?.title).toBe("jsonl card");

    await reader.done(card.id, human);
    expect((await writer.card(card.id))?.state).toBe("done");
  });

  it("defaults to a sqlite store at <dir>/.ukb/board.db", async () => {
    const dir = tempDir();
    const kanban = openKanban({ dir });
    const { card } = await kanban.add({ title: "default location" }, human);

    expect(existsSync(join(dir, DEFAULT_STORAGE_DIR, "board.db"))).toBe(true);
    expect((await openKanban({ dir }).card(card.id))?.title).toBe(
      "default location",
    );
  });
});

describe("priority", () => {
  it("defaults to normal and can be set at creation", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const plain = (await kanban.add({ title: "plain" }, human)).card;
    const urgent = (
      await kanban.add({ title: "urgent", priority: "high" }, human)
    ).card;

    expect(plain.priority).toBe("normal");
    expect(urgent.priority).toBe("high");
  });

  it("can be changed by edit, including back to normal", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const { card } = await kanban.add({ title: "x" }, human);

    const low = (await kanban.edit(card.id, { priority: "low" }, human)).card;
    expect(low.priority).toBe("low");

    const reset = (await kanban.edit(card.id, { priority: "normal" }, human))
      .card;
    expect(reset.priority).toBe("normal");
  });

  it("rejects a priority outside the scale", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    await expect(
      kanban.add(
        { title: "x", priority: "urgent" as unknown as "high" },
        human,
      ),
    ).rejects.toThrow();
  });

  it("treats an event written before priorities existed as normal", async () => {
    // The backward-compatibility contract: an old log replays unchanged, with
    // no migration step and no null to special-case at every read.
    const log = new MemoryEventLog();
    const kanban = new Kanban({ log });
    const { card, events } = await kanban.add({ title: "old card" }, human);
    const created = events[0]!;
    // Rewrite the event the way a pre-priority writer would have left it.
    const { priority: _dropped, ...payload } = created.payload as Record<
      string,
      unknown
    >;
    void _dropped;
    const legacy: typeof created = { ...created, payload };
    const legacyLog = new MemoryEventLog();
    await legacyLog.append([legacy]);

    const replayed = new Kanban({ log: legacyLog });
    expect((await replayed.card(card.id))?.priority).toBe("normal");
  });

  it("orders cards high → normal → low, then by id", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    await kanban.add({ title: "l", priority: "low" }, human);
    await kanban.add({ title: "n1" }, human);
    await kanban.add({ title: "h", priority: "high" }, human);
    await kanban.add({ title: "n2" }, human);

    const order = (await kanban.cards())
      .slice()
      .sort(compareByPriority)
      .map((card) => card.title);
    expect(order).toEqual(["h", "n1", "n2", "l"]);
  });

  it("no longer accepts `pending` — it is a state now, not a priority", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    await expect(
      kanban.add(
        { title: "x", priority: "pending" as unknown as "low" },
        human,
      ),
    ).rejects.toThrow();
  });
});

describe("someday", () => {
  it("is a real column, and a card enters it by move", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const { card } = await kanban.add({ title: "parked idea" }, human);

    await kanban.move(card.id, "someday", human, "cli");

    expect((await kanban.card(card.id))?.state).toBe("someday");
    expect((await kanban.board()).someday.map((c) => c.id)).toEqual([card.id]);
    expect((await kanban.board()).todo).toEqual([]);
  });

  it("clears the owner on entry — a shelved card has nobody on it", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const { card } = await kanban.add(
      { title: "owned", assignee: "codex", reviewer: "jyxc" },
      human,
    );

    const parked = (await kanban.move(card.id, "someday", human, "cli")).card;

    expect(parked.assignee).toBeNull();
    expect(parked.reviewer).toBeNull();
  });

  it("keeps a card out of `mine` — the shelf is not a to-do list", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const mine = (await kanban.add({ title: "mine", assignee: "pi" }, human))
      .card;
    const parked = (
      await kanban.add({ title: "parked", assignee: "pi" }, human)
    ).card;
    await kanban.move(parked.id, "someday", human, "cli");

    expect((await kanban.mine("pi")).map((c) => c.id)).toEqual([mine.id]);
  });

  it("can be claimed straight out of the shelf", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const { card } = await kanban.add({ title: "parked" }, human);
    await kanban.move(card.id, "someday", human, "cli");

    const claimed = (await kanban.claim(card.id, otherAgent, "cli")).card;

    expect(claimed.state).toBe("doing");
    expect(claimed.assignee).toBe("codex");
  });

  it("refuses to put an owner back on a shelved card by edit", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const { card } = await kanban.add({ title: "parked" }, human);
    await kanban.move(card.id, "someday", human, "cli");

    await expect(
      kanban.edit(card.id, { assignee: "codex" }, human),
    ).rejects.toThrow(/cannot carry an assignee/);
    expect((await kanban.card(card.id))?.assignee).toBeNull();
  });

  it("still blocks its dependents — later is not finished", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const parked = (await kanban.add({ title: "parked" }, human)).card;
    const waiting = (
      await kanban.add({ title: "waiting", blockedBy: [parked.id] }, human)
    ).card;
    await kanban.move(parked.id, "someday", human, "cli");

    // `later` is not `finished`: the parked blocker still stands in the way.
    await expectKanbanError(
      async () => await kanban.claim(waiting.id, human, "cli"),
      "invalid_state",
    );
  });

  it("is a no-op once a card is already there", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const { card } = await kanban.add({ title: "parked" }, human);
    await kanban.move(card.id, "someday", human, "cli");

    const again = await kanban.move(card.id, "someday", human, "cli");

    expect(again.events).toEqual([]);
  });
});

describe("parent / child", () => {
  async function tree() {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const parent = (await kanban.add({ title: "epic" }, human)).card;
    const a = (await kanban.add({ title: "a" }, human)).card;
    const b = (await kanban.add({ title: "b" }, human)).card;
    return { kanban, parent, a, b };
  }

  it("links a child to its parent, mirrored on both cards", async () => {
    const { kanban, parent, a } = await tree();

    const linked = (await kanban.parent(a.id, parent.id, human, "cli")).card;

    expect(linked.parent).toBe(parent.id);
    expect((await kanban.card(parent.id))?.children).toEqual([a.id]);
    // and the parent end comes back from a plain read
    expect((await kanban.childrenOf(parent.id)).map((c) => c.id)).toEqual([
      a.id,
    ]);
  });

  it("is idempotent and re-parents in one move", async () => {
    const { kanban, parent, a, b } = await tree();
    await kanban.parent(a.id, parent.id, human, "cli");
    expect((await kanban.parent(a.id, parent.id, human, "cli")).events).toEqual(
      [],
    );

    await kanban.parent(a.id, b.id, human, "cli");
    expect((await kanban.card(a.id))?.parent).toBe(b.id);
    expect((await kanban.card(parent.id))?.children).toEqual([]);
    expect((await kanban.card(b.id))?.children).toEqual([a.id]);
  });

  it("allows a child in another project", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const parent = (await kanban.add({ title: "epic", project: "web" }, human))
      .card;
    const child = (await kanban.add({ title: "part", project: "api" }, human))
      .card;

    // Composition is a relation, not a project partition: the two may differ,
    // and the project filter then shows a slice of the umbrella.
    await kanban.parent(child.id, parent.id, human, "cli");
    expect((await kanban.card(child.id))?.parent).toBe(parent.id);
  });

  it("nests to any depth", async () => {
    const { kanban, parent, a, b } = await tree();
    await kanban.parent(a.id, parent.id, human, "cli");

    // a is a part of the goal and a goal of its own: a part of a part is a
    // plan with chapters, not a second board
    await kanban.parent(b.id, a.id, human, "cli");
    expect((await kanban.card(b.id))?.parent).toBe(a.id);
    expect((await kanban.card(a.id))?.children).toEqual([b.id]);

    // and the tree can be walked in both directions
    expect((await kanban.card(a.id))?.parent).toBe(parent.id);
    expect((await kanban.card(parent.id))?.children).toEqual([a.id]);
  });

  it("refuses to make a card a part of something inside it", async () => {
    const { kanban, parent, a, b } = await tree();
    await kanban.parent(a.id, parent.id, human, "cli");
    await kanban.parent(b.id, a.id, human, "cli");

    // parent > a > b, so neither a nor parent may go under b
    await expectKanbanError(
      async () => await kanban.parent(a.id, b.id, human, "cli"),
      "invalid_input",
    );
    await expectKanbanError(
      async () => await kanban.parent(parent.id, b.id, human, "cli"),
      "invalid_input",
    );
  });

  it("keeps a deep chain's ends in agreement", async () => {
    const { kanban, parent, a, b } = await tree();
    await kanban.parent(a.id, parent.id, human, "cli");
    await kanban.parent(b.id, a.id, human, "cli");

    // the part of a part cannot start before its own goal does
    await expectKanbanError(
      async () => await kanban.claim(b.id, human, "cli"),
      "invalid_state",
    );
    await kanban.claim(parent.id, human, "cli");
    await expectKanbanError(
      async () => await kanban.claim(b.id, human, "cli"),
      "invalid_state",
    );
    await kanban.claim(a.id, human, "cli");
    await kanban.claim(b.id, human, "cli");

    // and no level can finish while a level below it is still open
    await expectKanbanError(
      async () => await kanban.done(a.id, human, "cli"),
      "invalid_state",
    );
    await expectKanbanError(
      async () => await kanban.done(parent.id, human, "cli"),
      "invalid_state",
    );

    // finishing bottom-up is what the rule allows
    await kanban.done(b.id, human, "cli");
    await kanban.done(a.id, human, "cli");
    await kanban.done(parent.id, human, "cli");
    expect((await kanban.card(parent.id))?.state).toBe("done");
  });

  it("refuses a card as its own parent", async () => {
    const { kanban, parent } = await tree();
    await expectKanbanError(
      async () => await kanban.parent(parent.id, parent.id, human, "cli"),
      "invalid_input",
    );
  });

  it("unparents, and is a no-op when already top-level", async () => {
    const { kanban, parent, a } = await tree();
    await kanban.parent(a.id, parent.id, human, "cli");

    const cleared = (await kanban.unparent(a.id, human, "cli")).card;
    expect(cleared.parent).toBeNull();
    expect((await kanban.card(parent.id))?.children).toEqual([]);
    expect((await kanban.unparent(a.id, human, "cli")).events).toEqual([]);
  });

  it("only the child's creator or assignee may attach it", async () => {
    const { kanban, parent, a } = await tree();
    await kanban.edit(a.id, { assignee: "codex" }, human);

    // `otherAgent` is codex: the assignee may attach its own card
    await kanban.parent(a.id, parent.id, otherAgent, "cli");
    expect((await kanban.card(a.id))?.parent).toBe(parent.id);

    const stranger: Actor = { type: "agent", name: "nobody" };
    const detached = (await kanban.unparent(a.id, otherAgent, "cli")).card;
    void detached;
    await expectKanbanError(
      async () => await kanban.parent(a.id, parent.id, stranger, "cli"),
      "forbidden",
    );
  });
});

describe("parent and child states have to agree", () => {
  async function umbrella() {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const parent = (await kanban.add({ title: "epic" }, human)).card;
    const child = (await kanban.add({ title: "part" }, human)).card;
    await kanban.parent(child.id, parent.id, human, "cli");
    return { kanban, parent, child };
  }

  it("lets the umbrella start, and then its parts", async () => {
    const { kanban, parent, child } = await umbrella();

    expect((await kanban.claim(parent.id, human, "cli")).card.state).toBe(
      "doing",
    );
    expect((await kanban.claim(child.id, human, "cli")).card.state).toBe(
      "doing",
    );
  });

  it("refuses a part in play while the umbrella is still todo", async () => {
    const { kanban, parent, child } = await umbrella();

    await expectKanbanError(
      async () => await kanban.claim(child.id, human, "cli"),
      "invalid_state",
      /part of #\d+ \(todo\)/,
    );
    await expectKanbanError(
      async () => await kanban.review(child.id, human, "cli"),
      "invalid_state",
    );
    // …and once the umbrella is under way, the same move is fine.
    await kanban.claim(parent.id, human, "cli");
    expect((await kanban.claim(child.id, human, "cli")).card.state).toBe(
      "doing",
    );
  });

  it("refuses to finish or review an umbrella with an open part", async () => {
    const { kanban, parent, child } = await umbrella();
    await kanban.claim(parent.id, human, "cli");
    await kanban.claim(child.id, human, "cli");

    await expectKanbanError(
      async () => await kanban.done(parent.id, human, "cli"),
      "invalid_state",
      /unfinished child/,
    );
    await expectKanbanError(
      async () => await kanban.review(parent.id, human, "cli"),
      "invalid_state",
    );

    await kanban.done(child.id, human, "cli");
    expect((await kanban.review(parent.id, human, "cli")).card.state).toBe(
      "review",
    );
  });

  it("refuses to park the umbrella while a part is in play", async () => {
    const { kanban, parent, child } = await umbrella();
    await kanban.claim(parent.id, human, "cli");
    await kanban.claim(child.id, human, "cli");

    await expectKanbanError(
      async () => await kanban.move(parent.id, "todo", human, "cli"),
      "invalid_state",
      /parts? in play/,
    );

    await kanban.done(child.id, human, "cli");
    expect(
      (await kanban.move(parent.id, "someday", human, "cli")).card.state,
    ).toBe("someday");
  });

  it("refuses to reopen a part of a reviewed or finished umbrella", async () => {
    const { kanban, parent, child } = await umbrella();
    await kanban.claim(parent.id, human, "cli");
    await kanban.claim(child.id, human, "cli");
    await kanban.done(child.id, human, "cli");
    await kanban.review(parent.id, human, "cli");

    await expectKanbanError(
      async () => await kanban.reopen(child.id, human, "cli"),
      "invalid_state",
      /move #\d+ back out of review/,
    );

    await kanban.reopen(parent.id, human, "cli");
    await kanban.claim(parent.id, human, "cli");
    expect((await kanban.reopen(child.id, human, "cli")).card.state).toBe(
      "todo",
    );
  });

  it("still closes a leaf card with nobody in the way", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const leaf = (await kanban.add({ title: "solo" }, human)).card;
    expect((await kanban.done(leaf.id, human, "cli")).card.state).toBe("done");
  });

  it("lets an in-flight card become an umbrella", async () => {
    // Working an umbrella is the normal case now: attaching a part to a card
    // that is already `doing` is exactly how a goal starts collecting parts.
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const parent = (await kanban.add({ title: "epic" }, human)).card;
    const child = (await kanban.add({ title: "part" }, human)).card;
    await kanban.claim(parent.id, human, "cli");

    expect(
      (await kanban.parent(child.id, parent.id, human, "cli")).card.parent,
    ).toBe(parent.id);
  });

  it("refuses to attach a part that is already in play under a parked umbrella", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const parent = (await kanban.add({ title: "epic" }, human)).card;
    const child = (await kanban.add({ title: "part" }, human)).card;
    await kanban.claim(child.id, human, "cli");

    await expectKanbanError(
      async () => await kanban.parent(child.id, parent.id, human, "cli"),
      "invalid_state",
      /a part cannot be in doing or review/,
    );
  });

  it("refuses to attach an unfinished part to a reviewed umbrella", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const parent = (await kanban.add({ title: "epic" }, human)).card;
    const doneChild = (await kanban.add({ title: "done part" }, human)).card;
    const openChild = (await kanban.add({ title: "open part" }, human)).card;
    await kanban.parent(doneChild.id, parent.id, human, "cli");
    await kanban.claim(parent.id, human, "cli");
    await kanban.done(doneChild.id, human, "cli");
    await kanban.review(parent.id, human, "cli");

    await expectKanbanError(
      async () => await kanban.parent(openChild.id, parent.id, human, "cli"),
      "invalid_state",
      /cannot take on the unfinished card/,
    );
  });
});

describe("a board written before the rule", () => {
  it("reports the pairs the engine would now refuse", async () => {
    const log = new MemoryEventLog();
    const kanban = new Kanban({ log });
    const epic = (await kanban.add({ title: "epic" }, human)).card;
    const part = (await kanban.add({ title: "part" }, human)).card;

    // Appended directly: the point is a log that already holds a pair the
    // engine no longer writes, so `claim`/`parent` cannot be used to build it.
    await log.append([
      {
        actor: human,
        source: "cli",
        type: "card.parent_set",
        cardId: part.id,
        payload: { parent: epic.id },
      },
      {
        actor: human,
        source: "cli",
        type: "card.moved",
        cardId: part.id,
        payload: { from: "todo", to: "doing", action: "claim" },
      },
    ]);

    const found = await kanban.hierarchyViolations();
    expect(found).toHaveLength(1);
    expect(found[0]?.card.id).toBe(part.id);
    expect(found[0]?.reason).toMatch(/is doing while its umbrella .* is todo/);

    // The pair is reported, never silently corrected: the card stays where the
    // log put it, and the move that would fix it is one `claim` away.
    expect((await kanban.card(part.id))?.state).toBe("doing");
    await kanban.claim(epic.id, human, "cli");
    expect(await kanban.hierarchyViolations()).toHaveLength(0);
  });

  it("reports an umbrella that was closed over an open part", async () => {
    const log = new MemoryEventLog();
    const kanban = new Kanban({ log });
    const epic = (await kanban.add({ title: "epic" }, human)).card;
    const donePart = (await kanban.add({ title: "done part" }, human)).card;
    const openPart = (await kanban.add({ title: "open part" }, human)).card;
    await kanban.parent(donePart.id, epic.id, human, "cli");
    await kanban.done(donePart.id, human, "cli");

    await log.append([
      {
        actor: human,
        source: "cli",
        type: "card.parent_set",
        cardId: openPart.id,
        payload: { parent: epic.id },
      },
      {
        actor: human,
        source: "cli",
        type: "card.moved",
        cardId: epic.id,
        payload: { from: "todo", to: "done", action: "done" },
      },
    ]);

    const found = await kanban.hierarchyViolations();
    expect(found).toHaveLength(1);
    expect(found[0]?.reason).toMatch(/is done with .* still open/);
  });
});

describe("deleting a card in a hierarchy", () => {
  it("orphans the children of a deleted umbrella", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const parent = (await kanban.add({ title: "epic" }, human)).card;
    const child = (await kanban.add({ title: "part" }, human)).card;
    await kanban.parent(child.id, parent.id, human, "cli");

    await kanban.remove(parent.id, human, "cli");

    expect(await kanban.card(parent.id)).toBeNull();
    expect((await kanban.card(child.id))?.parent).toBeNull();
  });

  it("removes a deleted child from its parent's list", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const parent = (await kanban.add({ title: "epic" }, human)).card;
    const child = (await kanban.add({ title: "part" }, human)).card;
    await kanban.parent(child.id, parent.id, human, "cli");

    await kanban.remove(child.id, human, "cli");

    expect((await kanban.card(parent.id))?.children).toEqual([]);
  });
});

describe("projects", () => {
  const web = { title: "web card", project: "web" };
  const api = { title: "api card", project: "api" };

  it("records the project on the card and lists the ones in use", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    await kanban.add(web, human);
    await kanban.add(api, human);
    await kanban.add({ title: "no project" }, human);

    expect((await kanban.board()).todo.map((card) => card.project)).toEqual([
      "web",
      "api",
      null,
    ]);
    expect(await kanban.projects()).toEqual(["api", "web"]);
  });

  it("summarises every project, with the untagged bucket last", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    await kanban.add(web, human);
    await kanban.add(api, human);
    await kanban.add({ title: "no project" }, human);
    const apiCard = (await kanban.add(api, human)).card;
    await kanban.claim(apiCard.id, human, "cli");
    await kanban.done(apiCard.id, human, "cli");

    expect(await kanban.projectSummary()).toEqual([
      { project: "api", someday: 0, todo: 1, doing: 0, review: 0, done: 1 },
      { project: "web", someday: 0, todo: 1, doing: 0, review: 0, done: 0 },
      // A card with no project is in no project, but it still has to be
      // counted — otherwise the rows do not add up to the board.
      { project: null, someday: 0, todo: 1, doing: 0, review: 0, done: 0 },
    ]);
  });

  it("filters the board to one project", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    await kanban.add(web, human);
    await kanban.add(api, human);
    await kanban.add({ title: "no project" }, human);

    const board = await kanban.board("web");
    expect(board.todo.map((card) => card.title)).toEqual(["web card"]);
    // no filter means every project, including the untagged card
    expect((await kanban.board()).todo).toHaveLength(3);
    // an unknown project is an empty board, not an error
    expect((await kanban.board("nope")).todo).toEqual([]);
  });

  it("filters mine and the review queue", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const a = await kanban.add(web, human);
    await kanban.add({ ...web, title: "other" }, human);
    await kanban.claim(a.card.id, agent);

    expect((await kanban.mine("claude-code")).map((c) => c.title)).toEqual([
      "web card",
    ]);
    expect(await kanban.mine("claude-code", "api")).toEqual([]);

    const r = await kanban.add({ ...api, reviewer: "jyxc" }, human);
    await kanban.review(r.card.id, agent);
    expect((await kanban.reviewQueue("jyxc")).map((c) => c.title)).toEqual([
      "api card",
    ]);
    expect(await kanban.reviewQueue("jyxc", "web")).toEqual([]);
  });

  it("lets the creator or assignee move a card between projects", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const added = await kanban.add(web, human);

    // an unrelated agent cannot, exactly as for any other field
    await expect(
      kanban.edit(added.card.id, { project: "api" }, agent),
    ).rejects.toThrow(KanbanError);

    await kanban.claim(added.card.id, agent);
    const moved = await kanban.edit(added.card.id, { project: "api" }, agent);
    expect(moved.card.project).toBe("api");

    const cleared = await kanban.edit(added.card.id, { project: null }, human);
    expect(cleared.card.project).toBeNull();
  });

  it("normalises the slug so Web and web cannot diverge", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const added = await kanban.add({ title: "x", project: "  Web  " }, human);
    expect(added.card.project).toBe("web");

    const viaEdit = await kanban.edit(added.card.id, { project: "API" }, human);
    expect(viaEdit.card.project).toBe("api");
  });

  it("rejects a slug that is not url/cli safe", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    await expect(
      kanban.add({ title: "x", project: "web ui" }, human),
    ).rejects.toThrow(KanbanError);
    await expect(
      kanban.add({ title: "x", project: "web/api" }, human),
    ).rejects.toThrow(KanbanError);
    await expect(
      kanban.add({ title: "x", project: "  " }, human),
    ).rejects.toThrow(KanbanError);
    await expect(
      kanban.add({ title: "x", project: "-leading-dash" }, human),
    ).rejects.toThrow(KanbanError);
    // 65 characters
    await expect(
      kanban.add({ title: "x", project: "a".repeat(65) }, human),
    ).rejects.toThrow(KanbanError);
  });

  it("replays events written before projects existed", async () => {
    const dir = tempDir();
    const added = await openKanban({ dir, storage: "jsonl" }).add(
      { title: "legacy", reviewer: "jyxc" },
      human,
    );
    // rewrite the log the way the pre-project code did: no `project` key at all
    const file = join(dir, DEFAULT_STORAGE_DIR, "events.jsonl");
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const event = JSON.parse(line);
          if (event.type === "card.created") delete event.payload.project;
          return JSON.stringify(event);
        })
        .join("\n") + "\n",
    );

    const reopened = openKanban({ dir, storage: "jsonl" });
    expect((await reopened.card(added.card.id))?.project).toBeNull();
    expect((await reopened.card(added.card.id))?.title).toBe("legacy");
    expect(await reopened.projects()).toEqual([]);
    expect((await reopened.board("web")).todo).toHaveLength(0);
    expect((await reopened.board()).todo).toHaveLength(1);
  });
});

describe("blockers gate starting work", () => {
  const setup = async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const blocker = (await kanban.add({ title: "blocker" }, human)).card;
    const blocked = (
      await kanban.add({ title: "blocked", blockedBy: [blocker.id] }, human)
    ).card;
    return { kanban, blocker, blocked };
  };

  it("refuses to claim a card whose blocker is unfinished", async () => {
    const { kanban, blocked, blocker } = await setup();
    let error: KanbanError | undefined;
    try {
      await kanban.claim(blocked.id, agent);
    } catch (caught) {
      error = caught as KanbanError;
    }
    expect(error).toBeInstanceOf(KanbanError);
    expect(error?.code).toBe("invalid_state");
    // the message must name the blocker and its state, so it is actionable
    expect(error?.message).toContain(`#${blocker.id}`);
    expect(error?.message).toContain("todo");
    expect((await kanban.card(blocked.id))?.state).toBe("todo");
  });

  it("refuses to move it into doing, but allows any other column", async () => {
    const { kanban, blocked } = await setup();
    await expect(kanban.move(blocked.id, "doing", agent)).rejects.toThrow(
      KanbanError,
    );
    // review is not gated: the work is already done by then, and refusing would
    // only create friction
    expect((await kanban.move(blocked.id, "review", agent)).card.state).toBe(
      "review",
    );
  });

  it("lets the card through once the blocker is done", async () => {
    const { kanban, blocked, blocker } = await setup();
    await kanban.done(blocker.id, agent);
    const claimed = await kanban.claim(blocked.id, agent);
    expect(claimed.card.state).toBe("doing");
    expect(claimed.card.assignee).toBe("claude-code");
  });

  it("treats a deleted blocker as satisfied", async () => {
    const { kanban, blocked, blocker } = await setup();
    await kanban.remove(blocker.id, human);
    // otherwise deleting a card could block another one forever
    expect((await kanban.claim(blocked.id, agent)).card.state).toBe("doing");
  });

  it("never gates done — a card must always be closable", async () => {
    const { kanban, blocked } = await setup();
    expect((await kanban.done(blocked.id, agent)).card.state).toBe("done");
  });

  it("reports every open blocker, not just the first", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const first = (await kanban.add({ title: "one" }, human)).card;
    const second = (await kanban.add({ title: "two" }, human)).card;
    const blocked = (
      await kanban.add(
        { title: "blocked", blockedBy: [first.id, second.id] },
        human,
      )
    ).card;

    let message = "";
    try {
      await kanban.claim(blocked.id, agent);
    } catch (caught) {
      message = (caught as KanbanError).message;
    }
    expect(message).toContain(`#${first.id}`);
    expect(message).toContain(`#${second.id}`);
    // plural, because there are two
    expect(message).toContain("them");
  });

  it("does not gate a card with no blockers", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const card = (await kanban.add({ title: "free" }, human)).card;
    expect((await kanban.claim(card.id, agent)).card.state).toBe("doing");
  });
});

describe("relations", () => {
  async function pair() {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const upstream = (await kanban.add({ title: "design the API" }, human))
      .card;
    const downstream = (
      await kanban.add(
        { title: "implement the API", assignee: "claude-code" },
        human,
      )
    ).card;
    return { kanban, upstream, downstream };
  }

  it("links from either side onto the same single edge", async () => {
    const { kanban, upstream, downstream } = await pair();

    await kanban.relate(downstream.id, upstream.id, "upstream", human);
    expect((await kanban.card(downstream.id))?.blockedBy).toEqual([
      upstream.id,
    ]);
    expect((await kanban.card(upstream.id))?.blocks).toEqual([downstream.id]);

    // saying it the other way round is the same edge, not a second one
    const again = await kanban.relate(
      upstream.id,
      downstream.id,
      "downstream",
      human,
    );
    expect(again.events).toHaveLength(0);
    expect((await kanban.card(downstream.id))?.blockedBy).toEqual([
      upstream.id,
    ]);
    expect((await kanban.card(upstream.id))?.blocks).toEqual([downstream.id]);
  });

  it("is many-to-many in both directions", async () => {
    const { kanban, upstream, downstream } = await pair();
    const third = (await kanban.add({ title: "docs" }, human)).card;

    await kanban.relate(downstream.id, upstream.id, "upstream", human);
    await kanban.relate(third.id, upstream.id, "upstream", human);
    await kanban.relate(third.id, downstream.id, "upstream", human);
    // saying it from the other end changes nothing — it is the same edge
    await kanban.relate(upstream.id, third.id, "downstream", human);

    expect((await kanban.card(third.id))?.blockedBy).toEqual([
      upstream.id,
      downstream.id,
    ]);
    expect((await kanban.card(upstream.id))?.blocks).toEqual([
      downstream.id,
      third.id,
    ]);
    expect((await kanban.card(downstream.id))?.blocks).toEqual([third.id]);
  });

  it("still gates claiming on the upstream side", async () => {
    const { kanban, upstream, downstream } = await pair();
    await kanban.relate(downstream.id, upstream.id, "upstream", human);
    await expectKanbanError(
      async () => await kanban.claim(downstream.id, agent),
      "invalid_state",
    );
    await kanban.done(upstream.id, human);
    expect((await kanban.claim(downstream.id, agent)).card.state).toBe("doing");
  });

  it("rejects cycles whichever side you start from", async () => {
    const { kanban, upstream, downstream } = await pair();
    await kanban.relate(downstream.id, upstream.id, "upstream", human);
    await expectKanbanError(
      async () =>
        await kanban.relate(upstream.id, downstream.id, "upstream", human),
      "invalid_input",
    );
  });

  it("rejects relating a card to itself", async () => {
    const { kanban, upstream } = await pair();
    await expectKanbanError(
      async () =>
        await kanban.relate(upstream.id, upstream.id, "upstream", human),
      "invalid_input",
    );
  });

  it("unrelates in whichever direction the edge runs", async () => {
    const { kanban, upstream, downstream } = await pair();
    await kanban.relate(downstream.id, upstream.id, "upstream", human);

    // start from the upstream card — the direction does not have to be known
    await kanban.unrelate(upstream.id, downstream.id, human);
    expect((await kanban.card(downstream.id))?.blockedBy).toEqual([]);
    expect((await kanban.card(upstream.id))?.blocks).toEqual([]);

    // unrelated cards are a no-op, not an error
    expect(
      (await kanban.unrelate(upstream.id, downstream.id, human)).events,
    ).toEqual([]);
  });

  it("keeps block/unblock working as the upstream spelling", async () => {
    const { kanban, upstream, downstream } = await pair();
    await kanban.block(downstream.id, upstream.id, human);
    expect((await kanban.card(upstream.id))?.blocks).toEqual([downstream.id]);
    await kanban.unblock(downstream.id, upstream.id, human);
    expect((await kanban.card(upstream.id))?.blocks).toEqual([]);
  });

  it("drops both ends of the edge when a card is deleted", async () => {
    const { kanban, upstream, downstream } = await pair();
    await kanban.relate(downstream.id, upstream.id, "upstream", human);
    await kanban.remove(upstream.id, human);
    expect((await kanban.card(downstream.id))?.blockedBy).toEqual([]);

    const other = (await kanban.add({ title: "other" }, human)).card;
    await kanban.relate(downstream.id, other.id, "downstream", human);
    expect((await kanban.card(other.id))?.blockedBy).toEqual([downstream.id]);
    await kanban.remove(other.id, human);
    expect((await kanban.card(downstream.id))?.blocks).toEqual([]);
  });

  it("mirrors blockers given at creation time", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const upstream = (await kanban.add({ title: "up" }, human)).card;
    const downstream = (
      await kanban.add({ title: "down", blockedBy: [upstream.id] }, human)
    ).card;
    expect((await kanban.card(upstream.id))?.blocks).toEqual([downstream.id]);
  });

  it("is creator-or-assignee on the card that gains the wait", async () => {
    const { kanban, upstream, downstream } = await pair();
    await expectKanbanError(
      async () =>
        await kanban.relate(downstream.id, upstream.id, "upstream", otherAgent),
      "forbidden",
    );
  });
});

describe("notes", () => {
  async function card() {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    return {
      kanban,
      card: (await kanban.add({ title: "ship the thing" }, human)).card,
    };
  }

  it("starts with no notes", async () => {
    const { kanban, card: created } = await card();
    expect((await kanban.card(created.id))?.notes).toEqual([]);
  });

  it("adds a note with a document link", async () => {
    const { kanban, card: created } = await card();
    const { card: updated } = await kanban.addNote(
      created.id,
      { text: "design doc", url: "docs/design.md" },
      human,
    );

    expect(updated.notes).toHaveLength(1);
    const note = updated.notes[0];
    expect(note?.text).toBe("design doc");
    expect(note?.url).toBe("docs/design.md");
    expect(note?.createdBy).toBe("jyxc");
    expect(note?.id).toBeGreaterThan(0);
  });

  it("keeps notes in order and bumps the revision", async () => {
    const { kanban, card: created } = await card();
    await kanban.edit(created.id, { assignee: "claude-code" }, human);
    const before = (await kanban.card(created.id))?.revision ?? 0;
    await kanban.addNote(created.id, { text: "first" }, human);
    const second = (await kanban.addNote(created.id, { text: "second" }, agent))
      .card;
    expect(second.notes.map((note) => note.text)).toEqual(["first", "second"]);
    expect(second.revision).toBe(before + 2);
  });

  it("edits a note's text and link", async () => {
    const { kanban, card: created } = await card();
    const added = (await kanban.addNote(created.id, { text: "draft" }, human))
      .card;
    const noteId = added.notes[0]?.id ?? 0;

    const updated = (
      await kanban.updateNote(
        created.id,
        noteId,
        { text: "design doc", url: "https://example.com/doc" },
        human,
      )
    ).card;
    expect(updated.notes[0]?.text).toBe("design doc");
    expect(updated.notes[0]?.url).toBe("https://example.com/doc");

    // a null url clears the link without touching the text
    const cleared = (
      await kanban.updateNote(created.id, noteId, { url: null }, human)
    ).card;
    expect(cleared.notes[0]?.url).toBeNull();
    expect(cleared.notes[0]?.text).toBe("design doc");
  });

  it("removes a note by id", async () => {
    const { kanban, card: created } = await card();
    const added = (await kanban.addNote(created.id, { text: "keep" }, human))
      .card;
    const noteId = added.notes[0]?.id ?? 0;
    await kanban.addNote(created.id, { text: "drop" }, human);

    const removed = (await kanban.removeNote(created.id, noteId, human)).card;
    expect(removed.notes.map((note) => note.text)).toEqual(["drop"]);
  });

  it("rejects an unknown note id, an empty note, and strangers", async () => {
    const { kanban, card: created } = await card();
    await expectKanbanError(
      async () => await kanban.removeNote(created.id, 99, human),
      "card_not_found",
    );
    await expectKanbanError(
      async () => await kanban.addNote(created.id, { text: "   " }, human),
      "invalid_input",
    );
    await expectKanbanError(
      async () => await kanban.addNote(created.id, { text: "hi" }, otherAgent),
      "forbidden",
    );
  });

  it("is creator-or-assignee, like every other edit", async () => {
    const { kanban, card: created } = await card();
    await kanban.edit(created.id, { assignee: "claude-code" }, human);
    const by = (
      await kanban.addNote(created.id, { text: "from the assignee" }, agent)
    ).card;
    expect(by.notes[0]?.createdBy).toBe("claude-code");
  });

  it("honours expectedRevision", async () => {
    const { kanban, card: created } = await card();
    await expectKanbanError(
      async () =>
        await kanban.addNote(created.id, { text: "x" }, human, "cli", {
          expectedRevision: 99,
        }),
      "revision_conflict",
    );
  });

  it("survives a replay of the log", async () => {
    const log = new MemoryEventLog();
    const kanban = new Kanban({ log });
    const created = (await kanban.add({ title: "notes" }, human)).card;
    const added = (
      await kanban.addNote(
        created.id,
        { text: "design", url: "docs/design.md" },
        human,
      )
    ).card;
    await kanban.updateNote(
      created.id,
      added.notes[0]?.id ?? 0,
      { text: "design v2" },
      human,
    );
    await kanban.removeNote(created.id, added.notes[0]?.id ?? 0, human);
    const other = (await kanban.add({ title: "other" }, human)).card;
    await kanban.relate(created.id, other.id, "downstream", human);

    const replayed = new Projection();
    for (const event of await log.since(0)) replayed.apply(event);
    expect(replayed.card(created.id)?.notes).toEqual(
      (await kanban.card(created.id))?.notes,
    );
    expect(replayed.board()).toEqual(await kanban.board());
  });
});

describe("project and subproject", () => {
  it("keeps a direction under its repository", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const { card } = await kanban.add(
      { title: "OAuth callback", project: "web", subproject: "auth" },
      human,
    );
    expect(card.project).toBe("web");
    expect(card.subproject).toBe("auth");

    const replayed = new Projection();
    for (const event of await kanban.events()) replayed.apply(event);
    expect(replayed.card(card.id)?.subproject).toBe("auth");
  });

  it("refuses a subproject without a project", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    await expect(
      kanban.add({ title: "orphan direction", subproject: "auth" }, human),
    ).rejects.toThrowError(/subproject needs a project/);
  });

  it("clears the direction when the project is cleared", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const { card } = await kanban.add(
      { title: "OAuth callback", project: "web", subproject: "auth" },
      human,
    );
    const cleared = (await kanban.edit(card.id, { project: null }, human)).card;
    expect(cleared.project).toBeNull();
    expect(cleared.subproject).toBeNull();
  });

  it("drops the direction when the card moves to another repository", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const { card } = await kanban.add(
      { title: "OAuth callback", project: "web", subproject: "auth" },
      human,
    );
    const moved = (await kanban.edit(card.id, { project: "api" }, human)).card;
    expect(moved.project).toBe("api");
    expect(moved.subproject).toBeNull();

    // An explicit direction in the same edit is the caller's choice.
    const both = (
      await kanban.edit(card.id, { project: "api", subproject: "auth" }, human)
    ).card;
    expect(both.subproject).toBe("auth");
  });

  it("refuses to add a direction to a card with no project", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const { card } = await kanban.add({ title: "loose work" }, human);
    await expect(
      kanban.edit(card.id, { subproject: "auth" }, human),
    ).rejects.toThrowError(/subproject needs a project/);
  });

  it("filters the board by project and direction", async () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const auth = (
      await kanban.add(
        { title: "OAuth", project: "web", subproject: "auth" },
        human,
      )
    ).card;
    await kanban.add(
      { title: "Billing", project: "web", subproject: "billing" },
      human,
    );
    await kanban.add(
      { title: "Other repo", project: "api", subproject: "auth" },
      human,
    );

    const web = await kanban.board("web");
    expect(web.todo).toHaveLength(2);
    const authOnly = await kanban.board("web", "auth");
    expect(authOnly.todo.map((card) => card.id)).toEqual([auth.id]);
  });
});
