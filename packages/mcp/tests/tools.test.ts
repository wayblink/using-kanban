import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server.js";
import { resolveMcpOptions } from "../src/options.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-mcp-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

async function connect(
  dir: string,
  agent = "claude-code",
): Promise<{
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
}> {
  const server = createMcpServer(
    resolveMcpOptions([`--dir=${dir}`, `--agent=${agent}`], {}),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolResult> => {
    const result = await client.callTool({ name, arguments: args });
    return result as unknown as ToolResult;
  };

  return { client, call };
}

let dir = "";
let call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;

beforeEach(async () => {
  dir = tempDir();
  const connection = await connect(dir);
  call = connection.call;
});

describe("tool discovery", () => {
  it("exposes the full kanban toolset", async () => {
    const connection = await connect(tempDir());
    const { tools } = await connection.client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "kanban_add",
      "kanban_block",
      "kanban_board",
      "kanban_claim",
      "kanban_delete",
      "kanban_done",
      "kanban_edit",
      "kanban_move",
      "kanban_my_cards",
      "kanban_note_add",
      "kanban_note_remove",
      "kanban_note_update",
      "kanban_parent",
      "kanban_projects",
      "kanban_relate",
      "kanban_reopen",
      "kanban_review",
      "kanban_review_queue",
      "kanban_show",
      "kanban_unblock",
      "kanban_unparent",
      "kanban_unrelate",
    ]);

    // The workflow must live in the descriptions — that is what makes a naive
    // agent behave correctly.
    const mine = tools.find((tool) => tool.name === "kanban_my_cards");
    expect(mine?.description).toContain("claim");
    expect(mine?.description).toContain("call to act");

    const claim = tools.find((tool) => tool.name === "kanban_claim");
    expect(claim?.description).toContain("before starting work");
    await connection.client.close();
  });
});

describe("the agent workflow", () => {
  it("add → mine → show → claim → review → done", async () => {
    const added = await call("kanban_add", {
      title: "implement /api/cards",
      body: "target: packages/server/src/routes/cards.ts\nAC: vitest green",
      assignee: "claude-code",
      reviewer: "jyxc",
    });
    expect(added.isError).toBeFalsy();
    expect(added.content[0]?.text).toContain("#1");

    const mine = await call("kanban_my_cards");
    expect(mine.content[0]?.text).toContain("#1 [todo] implement /api/cards");
    expect(mine.content[0]?.text).toContain("reviewer:jyxc");

    const shown = await call("kanban_show", { id: 1 });
    expect(shown.content[0]?.text).toContain("AC: vitest green");
    expect(shown.content[0]?.text).toContain("history:");

    const claimed = await call("kanban_claim", { id: 1 });
    expect(claimed.content[0]?.text).toContain("doing");

    const reviewed = await call("kanban_review", { id: 1 });
    expect(reviewed.content[0]?.text).toContain("review");

    // A different actor (the human reviewer) finishes it.
    const human = await connect(dir, "jyxc");
    const done = await human.call("kanban_done", { id: 1 });
    expect(done.content[0]?.text).toContain("done");
    await human.client.close();
  });

  it("byte-pins the mutation reply, tuple included", async () => {
    // Same tuple as the CLI door: if one door regresses to a hand-written
    // sentence, this or the CLI's equivalent fails.
    const added = await call("kanban_add", {
      title: "ship it",
      reviewer: "jyxc",
    });
    expect(added.isError).toBeFalsy();

    const claimed = await call("kanban_claim", { id: 1 });
    expect(claimed.content[0]?.text).toBe(
      "claimed #1 [doing] ship it @claude-code reviewer:jyxc \u00b7 todo \u2192 doing \u00b7 now assigned to claude-code",
    );

    const reviewed = await call("kanban_review", { id: 1 });
    expect(reviewed.content[0]?.text).toBe(
      "moved to review #1 [review] ship it @claude-code reviewer:jyxc \u00b7 doing \u2192 review (jyxc)",
    );
  });

  it("does not send a card with no reviewer to a named person", async () => {
    await call("kanban_add", { title: "ship it" });
    await call("kanban_claim", { id: 1 });
    const reviewed = await call("kanban_review", { id: 1 });
    expect(reviewed.content[0]?.text).toBe(
      "moved to review #1 [review] ship it @claude-code \u00b7 doing \u2192 review queue",
    );
  });

  it("claims a card that move left doing with nobody owning it", async () => {
    await call("kanban_add", { title: "queued" });
    await call("kanban_move", { id: 1, to: "doing" });
    const shown = await call("kanban_show", { id: 1 });
    expect(shown.content[0]?.text).toContain("assignee: \u2014");

    const claimed = await call("kanban_claim", { id: 1 });
    expect(claimed.isError).toBeFalsy();
    expect(claimed.content[0]?.text).toBe(
      "claimed #1 [doing] queued @claude-code \u00b7 doing \u2192 doing \u00b7 now assigned to claude-code",
    );
  });

  it("reports claim conflicts and missing cards as tool errors with stable codes", async () => {
    await call("kanban_add", { title: "contested", assignee: "claude-code" });
    await call("kanban_claim", { id: 1 });

    const rival = await connect(dir, "codex");
    const conflict = await rival.call("kanban_claim", { id: 1 });
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0]?.text).toContain("claim_conflict");
    expect(conflict.content[0]?.text).toContain("claude-code");

    const missing = await call("kanban_show", { id: 999 });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("card_not_found");
    await rival.client.close();
  });

  it("enforces creator-only delete and creator-or-assignee edit", async () => {
    await call("kanban_add", { title: "guarded", assignee: "codex" });

    const stranger = await connect(dir, "droid");
    const badEdit = await stranger.call("kanban_edit", {
      id: 1,
      title: "hijacked",
    });
    expect(badEdit.isError).toBe(true);
    expect(badEdit.content[0]?.text).toContain("forbidden");

    // The assignee CAN edit.
    const assignee = await connect(dir, "codex");
    const goodEdit = await assignee.call("kanban_edit", {
      id: 1,
      body: "assignee notes",
    });
    expect(goodEdit.isError).toBeFalsy();

    // Only the creator can delete.
    const badDelete = await stranger.call("kanban_delete", { id: 1 });
    expect(badDelete.isError).toBe(true);
    expect(badDelete.content[0]?.text).toContain("forbidden");

    const goodDelete = await call("kanban_delete", { id: 1 });
    expect(goodDelete.content[0]?.text).toContain("deleted #1");
    await stranger.client.close();
    await assignee.client.close();
  });

  it("manages dependencies and rejects cycles", async () => {
    await call("kanban_add", { title: "a" });
    await call("kanban_add", { title: "b" });
    await call("kanban_add", { title: "c" });

    // 1 ← 2 ← 3: card 2 waits on 1, card 3 waits on 2.
    const first = await call("kanban_block", { id: 2, blockedBy: 1 });
    expect(first.content[0]?.text).toContain("blocked-by:1");
    const second = await call("kanban_block", { id: 3, blockedBy: 2 });
    expect(second.content[0]?.text).toContain("blocked-by:2");

    // Closing the loop must be refused.
    const cycle = await call("kanban_block", { id: 1, blockedBy: 3 });
    expect(cycle.isError).toBe(true);
    expect(cycle.content[0]?.text).toContain("circular");

    const selfBlock = await call("kanban_block", { id: 1, blockedBy: 1 });
    expect(selfBlock.isError).toBe(true);

    const unblocked = await call("kanban_unblock", { id: 2, blockedBy: 1 });
    expect(unblocked.content[0]?.text).not.toContain("blocked-by");
  });

  it("relates cards in both directions on one edge", async () => {
    await call("kanban_add", { title: "design" });
    await call("kanban_add", { title: "implement", assignee: "claude-code" });

    const upstream = await call("kanban_relate", {
      id: 2,
      other: 1,
      direction: "upstream",
    });
    expect(upstream.content[0]?.text).toContain("blocked-by:1");
    expect(upstream.content[0]?.text).toContain("#2 waits on #1");

    // saying it from the other card is the same edge, not a second one — and
    // #1 now reports the downstream side of it
    const fromUpstream = await call("kanban_relate", {
      id: 1,
      other: 2,
      direction: "downstream",
    });
    expect(fromUpstream.content[0]?.text).toContain("#2 waits on #1");

    const shown = await call("kanban_show", { id: 1 });
    expect(shown.content[0]?.text).toContain("blocks: #2");

    const unrelated = await call("kanban_unrelate", { id: 1, other: 2 });
    expect(unrelated.content[0]?.text).not.toContain("blocked-by");
    expect(unrelated.content[0]?.text).not.toContain("blocks:");
  });

  it("links an umbrella and its parts, one level deep", async () => {
    await call("kanban_add", { title: "epic" });
    await call("kanban_add", { title: "part one" });
    await call("kanban_add", { title: "part two" });

    const linked = await call("kanban_parent", { id: 2, parent: 1 });
    expect(linked.isError).toBeFalsy();
    expect(linked.content[0]?.text).toContain("child of #1");
    await call("kanban_parent", { id: 3, parent: 1 });
    await call("kanban_done", { id: 2 });

    const shown = await call("kanban_show", { id: 1 });
    expect(shown.content[0]?.text).toContain("children: 1/2");
    expect(shown.content[0]?.text).toContain("#2 [done] part one");

    const child = await call("kanban_show", { id: 3 });
    expect(child.content[0]?.text).toContain("parent: #1 epic");

    // One level only: a child cannot become a parent.
    const deeper = await call("kanban_parent", { id: 3, parent: 2 });
    expect(deeper.isError).toBe(true);
    expect(deeper.content[0]?.text).toContain("one level");

    const detached = await call("kanban_unparent", { id: 3 });
    expect(detached.content[0]?.text).toContain("now top-level");
  });

  it("keeps a note with a document link on the card", async () => {
    await call("kanban_add", { title: "ship it" });
    const added = await call("kanban_note_add", {
      id: 1,
      text: "requirement design doc",
      url: "docs/design.md",
    });
    expect(added.content[0]?.text).toContain("noted #2");
    expect(added.content[0]?.text).toContain("docs/design.md");
    expect(added.content[0]?.text).toContain("notes:1");

    const shown = await call("kanban_show", { id: 1 });
    expect(shown.content[0]?.text).toContain("requirement design doc");
    expect(shown.content[0]?.text).toContain("docs/design.md");

    const edited = await call("kanban_note_update", {
      id: 1,
      noteId: 2,
      url: "https://example.com/design",
    });
    expect(edited.isError).toBeUndefined();
    expect((await call("kanban_show", { id: 1 })).content[0]?.text).toContain(
      "https://example.com/design",
    );

    const removed = await call("kanban_note_remove", { id: 1, noteId: 2 });
    expect(removed.content[0]?.text).toContain("removed note #2");
    expect(
      (await call("kanban_show", { id: 1 })).content[0]?.text,
    ).not.toContain("requirement design doc");
  });

  it("rejects a note on a card the actor does not own", async () => {
    await call("kanban_add", { title: "someone else's" });
    const stranger = await connect(dir, "codex");
    const denied = await stranger.call("kanban_note_add", {
      id: 1,
      text: "hi",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("forbidden");
    await stranger.client.close();
  });

  it("moves and reopens cards", async () => {
    await call("kanban_add", { title: "movable" });
    const moved = await call("kanban_move", { id: 1, to: "doing" });
    expect(moved.content[0]?.text).toContain("doing");

    const reopened = await call("kanban_reopen", { id: 1 });
    expect(reopened.content[0]?.text).toContain("todo");
  });

  it("shows the board and the review queue", async () => {
    await call("kanban_add", { title: "todo item", reviewer: "jyxc" });
    await call("kanban_add", {
      title: "in review",
      reviewer: "jyxc",
      assignee: "claude-code",
    });
    await call("kanban_claim", { id: 2 });
    await call("kanban_review", { id: 2 });

    const board = await call("kanban_board");
    expect(board.content[0]?.text).toContain("todo (1):");
    expect(board.content[0]?.text).toContain("review (1):");

    const queue = await call("kanban_review_queue", { agent: "jyxc" });
    expect(queue.content[0]?.text).toContain("#2 [review] in review");
    expect(queue.content[0]?.text).not.toContain("#1");
  });
});

describe("resources", () => {
  it("serves the board as JSON", async () => {
    await call("kanban_add", { title: "resource card" });

    const server = createMcpServer(
      resolveMcpOptions([`--dir=${dir}`, "--agent=claude-code"], {}),
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.readResource({ uri: "kanban://board" });
    const first = result.contents[0];
    expect(first).toBeDefined();
    const board = JSON.parse("text" in first! ? first.text : "") as {
      todo: { title: string }[];
    };
    expect(board.todo[0]?.title).toBe("resource card");

    await client.close();
  });
});

describe("option resolution", () => {
  it("prefers CLI flags, then env, then defaults", () => {
    const fromFlags = resolveMcpOptions(
      ["--dir=/tmp/x", "--agent=codex", "--agent-type=agent"],
      {},
    );
    expect(fromFlags).toMatchObject({
      dir: "/tmp/x",
      actor: { type: "agent", name: "codex" },
      usedDefaultAgent: false,
    });

    const fromEnv = resolveMcpOptions([], {
      UKB_AGENT: "opencode",
      UKB_DIR: "/tmp/y",
    });
    expect(fromEnv).toMatchObject({
      dir: "/tmp/y",
      actor: { type: "agent", name: "opencode" },
      usedDefaultAgent: false,
    });

    const fallback = resolveMcpOptions([], {});
    expect(fallback.actor.name).toBe("agent");
    expect(fallback.usedDefaultAgent).toBe(true);
  });
});

describe("projects", () => {
  it("filters the board and my cards by project", async () => {
    const connection = await connect(tempDir());
    const call = (name: string, args: Record<string, unknown> = {}) =>
      connection.client.callTool({ name, arguments: args });
    const textOf = (result: Awaited<ReturnType<typeof call>>) =>
      (result.content as { text: string }[])[0]?.text ?? "";

    await call("kanban_add", { title: "web card", project: "web" });
    await call("kanban_add", { title: "api card", project: "api" });
    await call("kanban_add", { title: "untagged" });

    // discovery first — this is the call that keeps agents from guessing.
    // Counts come with the names, and the untagged bucket is named too, so an
    // agent can see that "untagged" will match no project filter.
    const projects = textOf(await call("kanban_projects"));
    expect(projects).toContain(
      "api: 0 doing, 0 review, 1 todo, 0 someday, 0 done",
    );
    expect(projects).toContain(
      "web: 0 doing, 0 review, 1 todo, 0 someday, 0 done",
    );
    expect(projects).toContain(
      "(none): 0 doing, 0 review, 1 todo, 0 someday, 0 done",
    );

    const webBoard = textOf(await call("kanban_board", { project: "web" }));
    expect(webBoard).toContain("web card");
    expect(webBoard).not.toContain("api card");
    expect(webBoard).not.toContain("untagged");

    // no filter still means everything
    const all = textOf(await call("kanban_board"));
    expect(all).toContain("api card");
    expect(all).toContain("untagged");

    // the project is visible on the card itself
    const shown = textOf(await call("kanban_show", { id: 1 }));
    expect(shown).toContain("project: web");
  });

  it("normalises the slug instead of creating a second project", async () => {
    const connection = await connect(tempDir());
    const call = (name: string, args: Record<string, unknown> = {}) =>
      connection.client.callTool({ name, arguments: args });
    const textOf = (result: Awaited<ReturnType<typeof call>>) =>
      (result.content as { text: string }[])[0]?.text ?? "";

    await call("kanban_add", { title: "a", project: "  Web  " });
    await call("kanban_add", { title: "b", project: "web" });

    expect(textOf(await call("kanban_projects"))).toContain(
      "web: 0 doing, 0 review, 2 todo, 0 someday, 0 done",
    );
  });

  it("moves a card to another project", async () => {
    const connection = await connect(tempDir());
    const call = (name: string, args: Record<string, unknown> = {}) =>
      connection.client.callTool({ name, arguments: args });
    const textOf = (result: Awaited<ReturnType<typeof call>>) =>
      (result.content as { text: string }[])[0]?.text ?? "";

    await call("kanban_add", { title: "movable", project: "web" });
    await call("kanban_edit", { id: 1, project: "api" });
    expect(textOf(await call("kanban_show", { id: 1 }))).toContain(
      "project: api",
    );
    expect(
      textOf(await call("kanban_board", { project: "web" })),
    ).not.toContain("movable");
  });

  it("rejects a slug that is not url/cli safe with a readable error", async () => {
    const connection = await connect(tempDir());
    const result = await connection.client.callTool({
      name: "kanban_add",
      arguments: { title: "x", project: "web ui" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toContain(
      "lowercase letters",
    );
  });

  it("filters my cards and the review queue by project", async () => {
    const connection = await connect(tempDir());
    const call = (name: string, args: Record<string, unknown> = {}) =>
      connection.client.callTool({ name, arguments: args });
    const textOf = (result: Awaited<ReturnType<typeof call>>) =>
      (result.content as { text: string }[])[0]?.text ?? "";

    await call("kanban_add", {
      title: "web work",
      project: "web",
      assignee: "claude-code",
    });
    await call("kanban_add", {
      title: "api work",
      project: "api",
      assignee: "claude-code",
      reviewer: "jyxc",
    });
    await call("kanban_claim", { id: 2 });
    await call("kanban_review", { id: 2 });

    const mine = textOf(await call("kanban_my_cards", { project: "web" }));
    expect(mine).toContain("web work");
    expect(mine).not.toContain("api work");

    const queue = textOf(await call("kanban_review_queue", { project: "web" }));
    expect(queue).toContain("Nothing waiting");
  });
});

describe("blockers gate starting work", () => {
  it("refuses to claim a blocked card with an actionable message", async () => {
    const connection = await connect(tempDir());
    const call = (name: string, args: Record<string, unknown> = {}) =>
      connection.client.callTool({ name, arguments: args });

    await call("kanban_add", { title: "blocker", reviewer: "jyxc" });
    await call("kanban_add", { title: "blocked", blockedBy: [1] });

    const result = await call("kanban_claim", { id: 2 });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    // the code is localisable, the detail names the blocker and its state
    expect(text).toContain("invalid_state");
    expect(text).toContain("#1");
    expect(text).toContain("todo");
    expect(text).toContain("unblock");
  });

  it("allows the claim once the blocker is done", async () => {
    const connection = await connect(tempDir());
    const call = (name: string, args: Record<string, unknown> = {}) =>
      connection.client.callTool({ name, arguments: args });

    await call("kanban_add", { title: "blocker" });
    await call("kanban_add", { title: "blocked", blockedBy: [1] });
    await call("kanban_done", { id: 1 });

    const result = await call("kanban_claim", { id: 2 });
    expect(result.isError).toBeFalsy();
    expect((result.content as { text: string }[])[0]?.text).toContain(
      "[doing]",
    );
  });

  it("still allows a blocked card to be reviewed and done", async () => {
    const connection = await connect(tempDir());
    const call = (name: string, args: Record<string, unknown> = {}) =>
      connection.client.callTool({ name, arguments: args });

    await call("kanban_add", { title: "blocker" });
    await call("kanban_add", {
      title: "blocked",
      blockedBy: [1],
      assignee: "claude-code",
    });
    // review is not gated — the work is already done by that point
    expect((await call("kanban_review", { id: 2 })).isError).toBeFalsy();
    expect((await call("kanban_done", { id: 2 })).isError).toBeFalsy();
  });
});

describe("a board that does not exist yet", () => {
  it("read tools fail loudly instead of reporting an empty board", async () => {
    const connection = await connect(tempDir());
    const call = (name: string, args: Record<string, unknown> = {}) =>
      connection.client.callTool({ name, arguments: args });

    for (const [name, args] of [
      ["kanban_board", {}],
      ["kanban_my_cards", {}],
      ["kanban_review_queue", {}],
      ["kanban_projects", {}],
      ["kanban_show", { id: 1 }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, `${name} should fail`).toBe(true);
      const text = (result.content as { text: string }[])[0]?.text ?? "";
      expect(text).toContain("board_not_found");
      // actionable, not just diagnostic — see the note in core/open.ts
      expect(text).toContain("kanban_add");
      expect(text).toContain("no setup step");
      // and it must not send the agent hunting for another project's board,
      // which it otherwise does — it found an unrelated .ukb/ and read it raw
      expect(text).toContain("do not");
      expect(text).toContain("own board");
    }
  });

  it("a write creates it, and reads then work", async () => {
    const connection = await connect(tempDir());
    const call = (name: string, args: Record<string, unknown> = {}) =>
      connection.client.callTool({ name, arguments: args });

    const added = await call("kanban_add", { title: "the first card" });
    expect(added.isError).toBeFalsy();

    const board = await call("kanban_board", {});
    expect(board.isError).toBeFalsy();
    expect((board.content as { text: string }[])[0]?.text).toContain(
      "the first card",
    );
  });

  it("does not leave a store behind after a failed read", async () => {
    const dir = tempDir();
    const connection = await connect(dir);
    await connection.client.callTool({ name: "kanban_board", arguments: {} });
    expect(existsSync(join(dir, ".ukb"))).toBe(false);
  });
});

describe("project directions", () => {
  it("stores a subproject and filters the board by it", async () => {
    await call("kanban_add", {
      title: "OAuth callback",
      project: "web",
      subproject: "auth",
    });
    await call("kanban_add", {
      title: "Billing",
      project: "web",
      subproject: "billing",
    });

    const board = await call("kanban_board", {
      project: "web",
      subproject: "auth",
    });
    expect(board.content[0]?.text).toContain("OAuth callback");
    expect(board.content[0]?.text).not.toContain("Billing");
    expect(board.content[0]?.text).toContain("project:web/auth");
  });

  it("refuses a direction without a repository", async () => {
    const added = await call("kanban_add", {
      title: "orphan",
      subproject: "auth",
    });
    expect(added.isError).toBe(true);
    expect(added.content[0]?.text).toMatch(/subproject needs a project/);
  });
});
