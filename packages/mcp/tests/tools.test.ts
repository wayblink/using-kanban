import { mkdtempSync, rmSync } from "node:fs";
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
      "kanban_reopen",
      "kanban_review",
      "kanban_review_queue",
      "kanban_show",
      "kanban_unblock",
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
