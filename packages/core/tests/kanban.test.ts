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

  it("claims a card that move left doing with nobody owning it", () => {
    // `move <id> doing` does not assign, so the card sits in the working
    // column unowned. Claiming it is the fix, not a conflict: refusing here
    // reported a phantom owner and sent the caller off to "pick another card"
    // over work that was genuinely up for grabs.
    const kanban = makeKanban();
    const { card } = kanban.add({ title: "queued" }, human);
    kanban.move(card.id, "doing", otherAgent);
    expect(kanban.card(card.id)?.assignee).toBeNull();

    const claimed = kanban.claim(card.id, agent);
    expect(claimed.card.assignee).toBe(agent.name);
    expect(claimed.card.state).toBe("doing");
    expect(claimed.events).toHaveLength(1);
  });

  it("still conflicts when the doing card has a real owner", () => {
    const kanban = makeKanban();
    const { card } = kanban.add({ title: "mine" }, human);
    kanban.claim(card.id, otherAgent);

    // The message must name the owner: there is no "someone else" case left to
    // fall back to, so an unowned doing card can no longer produce that string.
    expectKanbanError(() => kanban.claim(card.id, agent), "claim_conflict");
    try {
      kanban.claim(card.id, agent);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toBe(
        `card ${card.id} is already being worked by ${otherAgent.name}`,
      );
    }
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

describe("priority", () => {
  it("defaults to normal and can be set at creation", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const plain = kanban.add({ title: "plain" }, human).card;
    const shelved = kanban.add(
      { title: "shelved", priority: "pending" },
      human,
    ).card;

    expect(plain.priority).toBe("normal");
    expect(shelved.priority).toBe("pending");
  });

  it("can be changed by edit, including back to normal", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const { card } = kanban.add({ title: "x" }, human);

    const low = kanban.edit(card.id, { priority: "low" }, human).card;
    expect(low.priority).toBe("low");

    const reset = kanban.edit(card.id, { priority: "normal" }, human).card;
    expect(reset.priority).toBe("normal");
  });

  it("rejects a priority outside the scale", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    expect(() =>
      kanban.add(
        { title: "x", priority: "urgent" as unknown as "high" },
        human,
      ),
    ).toThrow();
  });

  it("treats an event written before priorities existed as normal", () => {
    // The backward-compatibility contract: an old log replays unchanged, with
    // no migration step and no null to special-case at every read.
    const log = new MemoryEventLog();
    const kanban = new Kanban({ log });
    const { card, events } = kanban.add({ title: "old card" }, human);
    const created = events[0]!;
    // Rewrite the event the way a pre-priority writer would have left it.
    const { priority: _dropped, ...payload } = created.payload as Record<
      string,
      unknown
    >;
    void _dropped;
    const legacy: typeof created = { ...created, payload };
    const legacyLog = new MemoryEventLog();
    legacyLog.append([legacy]);

    const replayed = new Kanban({ log: legacyLog });
    expect(replayed.card(card.id)?.priority).toBe("normal");
  });

  it("orders cards high → normal → low → pending, then by id", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    kanban.add({ title: "p", priority: "pending" }, human);
    kanban.add({ title: "n1" }, human);
    kanban.add({ title: "h", priority: "high" }, human);
    kanban.add({ title: "l", priority: "low" }, human);
    kanban.add({ title: "n2" }, human);

    const order = kanban
      .cards()
      .slice()
      .sort(compareByPriority)
      .map((card) => card.title);
    expect(order).toEqual(["h", "n1", "n2", "l", "p"]);
  });
});

describe("projects", () => {
  const web = { title: "web card", project: "web" };
  const api = { title: "api card", project: "api" };

  it("records the project on the card and lists the ones in use", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    kanban.add(web, human);
    kanban.add(api, human);
    kanban.add({ title: "no project" }, human);

    expect(kanban.board().todo.map((card) => card.project)).toEqual([
      "web",
      "api",
      null,
    ]);
    expect(kanban.projects()).toEqual(["api", "web"]);
  });

  it("summarises every project, with the untagged bucket last", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    kanban.add(web, human);
    kanban.add(api, human);
    kanban.add({ title: "no project" }, human);
    const apiCard = kanban.add(api, human).card;
    kanban.claim(apiCard.id, human, "cli");
    kanban.done(apiCard.id, human, "cli");

    expect(kanban.projectSummary()).toEqual([
      { project: "api", todo: 1, doing: 0, review: 0, done: 1 },
      { project: "web", todo: 1, doing: 0, review: 0, done: 0 },
      // A card with no project is in no project, but it still has to be
      // counted — otherwise the rows do not add up to the board.
      { project: null, todo: 1, doing: 0, review: 0, done: 0 },
    ]);
  });

  it("filters the board to one project", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    kanban.add(web, human);
    kanban.add(api, human);
    kanban.add({ title: "no project" }, human);

    const board = kanban.board("web");
    expect(board.todo.map((card) => card.title)).toEqual(["web card"]);
    // no filter means every project, including the untagged card
    expect(kanban.board().todo).toHaveLength(3);
    // an unknown project is an empty board, not an error
    expect(kanban.board("nope").todo).toEqual([]);
  });

  it("filters mine and the review queue", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const a = kanban.add(web, human);
    kanban.add({ ...web, title: "other" }, human);
    kanban.claim(a.card.id, agent);

    expect(kanban.mine("claude-code").map((c) => c.title)).toEqual([
      "web card",
    ]);
    expect(kanban.mine("claude-code", "api")).toEqual([]);

    const r = kanban.add({ ...api, reviewer: "jyxc" }, human);
    kanban.review(r.card.id, agent);
    expect(kanban.reviewQueue("jyxc").map((c) => c.title)).toEqual([
      "api card",
    ]);
    expect(kanban.reviewQueue("jyxc", "web")).toEqual([]);
  });

  it("lets the creator or assignee move a card between projects", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const added = kanban.add(web, human);

    // an unrelated agent cannot, exactly as for any other field
    expect(() => kanban.edit(added.card.id, { project: "api" }, agent)).toThrow(
      KanbanError,
    );

    kanban.claim(added.card.id, agent);
    const moved = kanban.edit(added.card.id, { project: "api" }, agent);
    expect(moved.card.project).toBe("api");

    const cleared = kanban.edit(added.card.id, { project: null }, human);
    expect(cleared.card.project).toBeNull();
  });

  it("normalises the slug so Web and web cannot diverge", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const added = kanban.add({ title: "x", project: "  Web  " }, human);
    expect(added.card.project).toBe("web");

    const viaEdit = kanban.edit(added.card.id, { project: "API" }, human);
    expect(viaEdit.card.project).toBe("api");
  });

  it("rejects a slug that is not url/cli safe", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    expect(() => kanban.add({ title: "x", project: "web ui" }, human)).toThrow(
      KanbanError,
    );
    expect(() => kanban.add({ title: "x", project: "web/api" }, human)).toThrow(
      KanbanError,
    );
    expect(() => kanban.add({ title: "x", project: "  " }, human)).toThrow(
      KanbanError,
    );
    expect(() =>
      kanban.add({ title: "x", project: "-leading-dash" }, human),
    ).toThrow(KanbanError);
    // 65 characters
    expect(() =>
      kanban.add({ title: "x", project: "a".repeat(65) }, human),
    ).toThrow(KanbanError);
  });

  it("replays events written before projects existed", async () => {
    const dir = tempDir();
    const added = openKanban({ dir, storage: "jsonl" }).add(
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
    expect(reopened.card(added.card.id)?.project).toBeNull();
    expect(reopened.card(added.card.id)?.title).toBe("legacy");
    expect(reopened.projects()).toEqual([]);
    expect(reopened.board("web").todo).toHaveLength(0);
    expect(reopened.board().todo).toHaveLength(1);
  });
});

describe("blockers gate starting work", () => {
  const setup = () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const blocker = kanban.add({ title: "blocker" }, human).card;
    const blocked = kanban.add(
      { title: "blocked", blockedBy: [blocker.id] },
      human,
    ).card;
    return { kanban, blocker, blocked };
  };

  it("refuses to claim a card whose blocker is unfinished", () => {
    const { kanban, blocked, blocker } = setup();
    let error: KanbanError | undefined;
    try {
      kanban.claim(blocked.id, agent);
    } catch (caught) {
      error = caught as KanbanError;
    }
    expect(error).toBeInstanceOf(KanbanError);
    expect(error?.code).toBe("invalid_state");
    // the message must name the blocker and its state, so it is actionable
    expect(error?.message).toContain(`#${blocker.id}`);
    expect(error?.message).toContain("todo");
    expect(kanban.card(blocked.id)?.state).toBe("todo");
  });

  it("refuses to move it into doing, but allows any other column", () => {
    const { kanban, blocked } = setup();
    expect(() => kanban.move(blocked.id, "doing", agent)).toThrow(KanbanError);
    // review is not gated: the work is already done by then, and refusing would
    // only create friction
    expect(kanban.move(blocked.id, "review", agent).card.state).toBe("review");
  });

  it("lets the card through once the blocker is done", () => {
    const { kanban, blocked, blocker } = setup();
    kanban.done(blocker.id, agent);
    const claimed = kanban.claim(blocked.id, agent);
    expect(claimed.card.state).toBe("doing");
    expect(claimed.card.assignee).toBe("claude-code");
  });

  it("treats a deleted blocker as satisfied", () => {
    const { kanban, blocked, blocker } = setup();
    kanban.remove(blocker.id, human);
    // otherwise deleting a card could block another one forever
    expect(kanban.claim(blocked.id, agent).card.state).toBe("doing");
  });

  it("never gates done — a card must always be closable", () => {
    const { kanban, blocked } = setup();
    expect(kanban.done(blocked.id, agent).card.state).toBe("done");
  });

  it("reports every open blocker, not just the first", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const first = kanban.add({ title: "one" }, human).card;
    const second = kanban.add({ title: "two" }, human).card;
    const blocked = kanban.add(
      { title: "blocked", blockedBy: [first.id, second.id] },
      human,
    ).card;

    let message = "";
    try {
      kanban.claim(blocked.id, agent);
    } catch (caught) {
      message = (caught as KanbanError).message;
    }
    expect(message).toContain(`#${first.id}`);
    expect(message).toContain(`#${second.id}`);
    // plural, because there are two
    expect(message).toContain("them");
  });

  it("does not gate a card with no blockers", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const card = kanban.add({ title: "free" }, human).card;
    expect(kanban.claim(card.id, agent).card.state).toBe("doing");
  });
});

describe("relations", () => {
  function pair() {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const upstream = kanban.add({ title: "design the API" }, human).card;
    const downstream = kanban.add(
      { title: "implement the API", assignee: "claude-code" },
      human,
    ).card;
    return { kanban, upstream, downstream };
  }

  it("links from either side onto the same single edge", () => {
    const { kanban, upstream, downstream } = pair();

    kanban.relate(downstream.id, upstream.id, "upstream", human);
    expect(kanban.card(downstream.id)?.blockedBy).toEqual([upstream.id]);
    expect(kanban.card(upstream.id)?.blocks).toEqual([downstream.id]);

    // saying it the other way round is the same edge, not a second one
    const again = kanban.relate(
      upstream.id,
      downstream.id,
      "downstream",
      human,
    );
    expect(again.events).toHaveLength(0);
    expect(kanban.card(downstream.id)?.blockedBy).toEqual([upstream.id]);
    expect(kanban.card(upstream.id)?.blocks).toEqual([downstream.id]);
  });

  it("is many-to-many in both directions", () => {
    const { kanban, upstream, downstream } = pair();
    const third = kanban.add({ title: "docs" }, human).card;

    kanban.relate(downstream.id, upstream.id, "upstream", human);
    kanban.relate(third.id, upstream.id, "upstream", human);
    kanban.relate(third.id, downstream.id, "upstream", human);
    // saying it from the other end changes nothing — it is the same edge
    kanban.relate(upstream.id, third.id, "downstream", human);

    expect(kanban.card(third.id)?.blockedBy).toEqual([
      upstream.id,
      downstream.id,
    ]);
    expect(kanban.card(upstream.id)?.blocks).toEqual([downstream.id, third.id]);
    expect(kanban.card(downstream.id)?.blocks).toEqual([third.id]);
  });

  it("still gates claiming on the upstream side", () => {
    const { kanban, upstream, downstream } = pair();
    kanban.relate(downstream.id, upstream.id, "upstream", human);
    expectKanbanError(
      () => kanban.claim(downstream.id, agent),
      "invalid_state",
    );
    kanban.done(upstream.id, human);
    expect(kanban.claim(downstream.id, agent).card.state).toBe("doing");
  });

  it("rejects cycles whichever side you start from", () => {
    const { kanban, upstream, downstream } = pair();
    kanban.relate(downstream.id, upstream.id, "upstream", human);
    expectKanbanError(
      () => kanban.relate(upstream.id, downstream.id, "upstream", human),
      "invalid_input",
    );
  });

  it("rejects relating a card to itself", () => {
    const { kanban, upstream } = pair();
    expectKanbanError(
      () => kanban.relate(upstream.id, upstream.id, "upstream", human),
      "invalid_input",
    );
  });

  it("unrelates in whichever direction the edge runs", () => {
    const { kanban, upstream, downstream } = pair();
    kanban.relate(downstream.id, upstream.id, "upstream", human);

    // start from the upstream card — the direction does not have to be known
    kanban.unrelate(upstream.id, downstream.id, human);
    expect(kanban.card(downstream.id)?.blockedBy).toEqual([]);
    expect(kanban.card(upstream.id)?.blocks).toEqual([]);

    // unrelated cards are a no-op, not an error
    expect(kanban.unrelate(upstream.id, downstream.id, human).events).toEqual(
      [],
    );
  });

  it("keeps block/unblock working as the upstream spelling", () => {
    const { kanban, upstream, downstream } = pair();
    kanban.block(downstream.id, upstream.id, human);
    expect(kanban.card(upstream.id)?.blocks).toEqual([downstream.id]);
    kanban.unblock(downstream.id, upstream.id, human);
    expect(kanban.card(upstream.id)?.blocks).toEqual([]);
  });

  it("drops both ends of the edge when a card is deleted", () => {
    const { kanban, upstream, downstream } = pair();
    kanban.relate(downstream.id, upstream.id, "upstream", human);
    kanban.remove(upstream.id, human);
    expect(kanban.card(downstream.id)?.blockedBy).toEqual([]);

    const other = kanban.add({ title: "other" }, human).card;
    kanban.relate(downstream.id, other.id, "downstream", human);
    expect(kanban.card(other.id)?.blockedBy).toEqual([downstream.id]);
    kanban.remove(other.id, human);
    expect(kanban.card(downstream.id)?.blocks).toEqual([]);
  });

  it("mirrors blockers given at creation time", () => {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    const upstream = kanban.add({ title: "up" }, human).card;
    const downstream = kanban.add(
      { title: "down", blockedBy: [upstream.id] },
      human,
    ).card;
    expect(kanban.card(upstream.id)?.blocks).toEqual([downstream.id]);
  });

  it("is creator-or-assignee on the card that gains the wait", () => {
    const { kanban, upstream, downstream } = pair();
    expectKanbanError(
      () => kanban.relate(downstream.id, upstream.id, "upstream", otherAgent),
      "forbidden",
    );
  });
});

describe("notes", () => {
  function card() {
    const kanban = new Kanban({ log: new MemoryEventLog() });
    return {
      kanban,
      card: kanban.add({ title: "ship the thing" }, human).card,
    };
  }

  it("starts with no notes", () => {
    const { kanban, card: created } = card();
    expect(kanban.card(created.id)?.notes).toEqual([]);
  });

  it("adds a note with a document link", () => {
    const { kanban, card: created } = card();
    const { card: updated } = kanban.addNote(
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

  it("keeps notes in order and bumps the revision", () => {
    const { kanban, card: created } = card();
    kanban.edit(created.id, { assignee: "claude-code" }, human);
    const before = kanban.card(created.id)?.revision ?? 0;
    kanban.addNote(created.id, { text: "first" }, human);
    const second = kanban.addNote(created.id, { text: "second" }, agent).card;
    expect(second.notes.map((note) => note.text)).toEqual(["first", "second"]);
    expect(second.revision).toBe(before + 2);
  });

  it("edits a note's text and link", () => {
    const { kanban, card: created } = card();
    const added = kanban.addNote(created.id, { text: "draft" }, human).card;
    const noteId = added.notes[0]?.id ?? 0;

    const updated = kanban.updateNote(
      created.id,
      noteId,
      { text: "design doc", url: "https://example.com/doc" },
      human,
    ).card;
    expect(updated.notes[0]?.text).toBe("design doc");
    expect(updated.notes[0]?.url).toBe("https://example.com/doc");

    // a null url clears the link without touching the text
    const cleared = kanban.updateNote(
      created.id,
      noteId,
      { url: null },
      human,
    ).card;
    expect(cleared.notes[0]?.url).toBeNull();
    expect(cleared.notes[0]?.text).toBe("design doc");
  });

  it("removes a note by id", () => {
    const { kanban, card: created } = card();
    const added = kanban.addNote(created.id, { text: "keep" }, human).card;
    const noteId = added.notes[0]?.id ?? 0;
    kanban.addNote(created.id, { text: "drop" }, human);

    const removed = kanban.removeNote(created.id, noteId, human).card;
    expect(removed.notes.map((note) => note.text)).toEqual(["drop"]);
  });

  it("rejects an unknown note id, an empty note, and strangers", () => {
    const { kanban, card: created } = card();
    expectKanbanError(
      () => kanban.removeNote(created.id, 99, human),
      "card_not_found",
    );
    expectKanbanError(
      () => kanban.addNote(created.id, { text: "   " }, human),
      "invalid_input",
    );
    expectKanbanError(
      () => kanban.addNote(created.id, { text: "hi" }, otherAgent),
      "forbidden",
    );
  });

  it("is creator-or-assignee, like every other edit", () => {
    const { kanban, card: created } = card();
    kanban.edit(created.id, { assignee: "claude-code" }, human);
    const by = kanban.addNote(
      created.id,
      { text: "from the assignee" },
      agent,
    ).card;
    expect(by.notes[0]?.createdBy).toBe("claude-code");
  });

  it("honours expectedRevision", () => {
    const { kanban, card: created } = card();
    expectKanbanError(
      () =>
        kanban.addNote(created.id, { text: "x" }, human, "cli", {
          expectedRevision: 99,
        }),
      "revision_conflict",
    );
  });

  it("survives a replay of the log", () => {
    const log = new MemoryEventLog();
    const kanban = new Kanban({ log });
    const created = kanban.add({ title: "notes" }, human).card;
    const added = kanban.addNote(
      created.id,
      { text: "design", url: "docs/design.md" },
      human,
    ).card;
    kanban.updateNote(
      created.id,
      added.notes[0]?.id ?? 0,
      { text: "design v2" },
      human,
    );
    kanban.removeNote(created.id, added.notes[0]?.id ?? 0, human);
    const other = kanban.add({ title: "other" }, human).card;
    kanban.relate(created.id, other.id, "downstream", human);

    const replayed = new Projection();
    for (const event of log.since(0)) replayed.apply(event);
    expect(replayed.card(created.id)?.notes).toEqual(
      kanban.card(created.id)?.notes,
    );
    expect(replayed.board()).toEqual(kanban.board());
  });
});
