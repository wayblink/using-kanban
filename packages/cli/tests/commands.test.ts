import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCommand, type Io } from "../src/commands.js";
import { resolveActor } from "../src/identity.js";
import { UsageError } from "../src/argv.js";
import { formatBoard, formatCard, formatMine } from "../src/render.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A sandboxed Io. `UKB_DIR` points at `dir` because the store is centralised
 * under the home directory by default — the working directory is deliberately
 * not consulted, so tests must say where the board is.
 */
function makeIo(
  dir: string,
  env: NodeJS.ProcessEnv = {},
): Io & { out: string[] } {
  const out: string[] = [];
  return {
    cwd: dir,
    env: { USER: "tester", UKB_DIR: dir, ...env },
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
    out,
  };
}

async function run(
  argv: string[],
  dir: string,
  env: NodeJS.ProcessEnv = {},
): Promise<Io & { out: string[] }> {
  const io = makeIo(dir, env);
  const code = await runCommand(argv, io);
  expect(code).toBe(0);
  return io;
}

describe("board commands", () => {
  it("adds, lists, and transitions cards", async () => {
    const dir = tempDir();

    await run(
      ["add", "write", "docs", "--body", "AC: green", "--assignee", "codex"],
      dir,
    );
    const io = await run(["mine", "--agent", "codex"], dir);
    expect(io.out.join("\n")).toContain("write docs");
    // the list must end in an instruction, not a status report
    expect(io.out.join("\n")).toContain(
      "next: claim a todo card before working it",
    );

    const claimed = await run(
      ["claim", "1", "--agent", "claude-code", "--agent-type", "agent"],
      dir,
    );
    expect(claimed.out.join("\n")).toContain("claimed #1");
    expect(claimed.out.join("\n")).toContain("[doing]");

    const shown = await run(["show", "1"], dir);
    expect(shown.out.join("\n")).toContain("AC: green");
    expect(shown.out.join("\n")).toContain("history:");

    const done = await run(["done", "1", "--agent", "jyxc"], dir);
    expect(done.out.join("\n")).toContain("done #1");
  });

  it("reports a claim conflict as a domain error", async () => {
    const dir = tempDir();
    await run(["add", "contested"], dir);
    await run(
      ["claim", "1", "--agent", "claude-code", "--agent-type", "agent"],
      dir,
    );

    const io = makeIo(dir);
    await expect(
      runCommand(
        ["claim", "1", "--agent", "codex", "--agent-type", "agent"],
        io,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
  });

  it("errors on unknown cards and bad usage", async () => {
    const dir = tempDir();
    const io = makeIo(dir);
    // `show` is read-only, so the board has to exist before a missing *card* is
    // the thing that can be reported
    await runCommand(["add", "something"], io);

    await expect(runCommand(["show", "999"], io)).rejects.toMatchObject({
      code: "card_not_found",
    });
    await expect(runCommand(["add"], io)).rejects.toThrowError(UsageError);
    await expect(runCommand(["claim"], io)).rejects.toThrowError(
      /needs a card id/,
    );
    await expect(
      runCommand(["move", "1", "sideways"], io),
    ).rejects.toThrowError(/needs a column/);
    await expect(runCommand(["nonsense"], io)).rejects.toThrowError(
      /unknown command/,
    );
  });

  it("blocks and unblocks", async () => {
    const dir = tempDir();
    await run(["add", "first"], dir);
    await run(["add", "second"], dir);

    const blocked = await run(["block", "2", "--by", "1"], dir);
    expect(blocked.out.join("\n")).toContain("blocked on #1");

    const board = await run(["board"], dir);
    expect(board.out.join("\n")).toContain("blocked-by:1");

    const unblocked = await run(["unblock", "2", "--by", "1"], dir);
    expect(unblocked.out.join("\n")).toContain("unblocked from #1");
  });

  it("honours UKB_DIR and prints help without touching the board", async () => {
    const dir = tempDir();
    const io = makeIo("/nonexistent-cwd", { UKB_DIR: dir });
    // seed the board from a different cwd so the read below has something to read
    await runCommand(["add", "seeded"], makeIo(dir));

    const code = await runCommand(["board"], io);
    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("todo (1)");

    const help = await run(["help"], dir);
    expect(help.out.join("\n")).toContain("ukb — using-kanban command line");
  });

  it("refuses to read a board that does not exist, instead of inventing one", async () => {
    const dir = tempDir();
    const io = makeIo(dir);

    for (const command of [["board"], ["mine"], ["show", "1"]]) {
      const error = await runCommand(command, io).catch((caught) => caught);
      expect(error).toMatchObject({ code: "board_not_found" });
      // The message has to be actionable, not just diagnostic: an agent that
      // reads a bare "not found" concludes the tool is unavailable here and
      // moves on. It must say that adding a card is what creates the board…
      expect(String(error.message)).toContain("kanban_add");
      expect(String(error.message)).toContain("no setup step");
      // …and that hunting for another project's board is wrong, which an agent
      // otherwise does — it found an unrelated .ukb/ and read it with sqlite3.
      expect(String(error.message)).toContain("do not");
      expect(String(error.message)).toContain("own board");
    }
    // and nothing was created on disk
    expect(existsSync(join(dir, ".ukb"))).toBe(false);

    // a write is what brings the board into existence
    await runCommand(["add", "first"], io);
    expect(existsSync(join(dir, ".ukb"))).toBe(true);
    await expect(runCommand(["board"], io)).resolves.toBe(0);
  });
});

describe("identity", () => {
  it("prefers flags, then env, then the OS user", () => {
    expect(resolveActor({ agent: "codex", "agent-type": "agent" }, {})).toEqual(
      {
        type: "agent",
        name: "codex",
      },
    );
    expect(resolveActor({}, { UKB_AGENT: "opencode" })).toEqual({
      type: "human",
      name: "opencode",
    });
    expect(resolveActor({}, { USER: "fallback" })).toEqual({
      type: "human",
      name: "fallback",
    });
  });

  it("rejects an unknown actor type", () => {
    expect(() => resolveActor({ "agent-type": "robot" }, {})).toThrowError(
      /human \| agent/,
    );
  });
});

describe("render", () => {
  const card = {
    id: 3,
    title: "ship it",
    body: null,
    state: "todo" as const,
    assignee: "codex",
    reviewer: "jyxc",
    blockedBy: [1],
    createdBy: "jyxc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
  };

  it("frames an empty mine list as a next step, not a dead end", () => {
    expect(formatMine([], "codex")).toContain(
      "no open cards assigned to codex",
    );
    expect(formatMine([], "codex")).toContain("ukb board");
  });

  it("tells the actor exactly what to do next", () => {
    const output = formatMine([card], "codex");
    expect(output).toContain("your open cards (codex)");
    expect(output).toContain("ukb claim 3");
    expect(output).toContain("ukb show 3");
  });

  it("suggests finishing work when nothing is claimable", () => {
    const output = formatMine([{ ...card, state: "doing" }], "codex");
    expect(output).toContain("finish what is in progress");
  });

  it("renders the board with counts and card details", () => {
    const output = formatBoard({
      todo: [card],
      doing: [],
      review: [],
      done: [],
    });
    expect(output).toContain("todo (1):");
    expect(output).toContain(
      "#3 [todo] ship it @codex reviewer:jyxc blocked-by:1",
    );
    expect(output).toContain("doing (0):");
    expect(output).toContain("(empty)");
  });

  it("renders a card with body and history", () => {
    const output = formatCard(card, [
      {
        id: 1,
        ts: "2026-01-01T00:00:00.000Z",
        actor: { type: "human", name: "jyxc" },
        source: "cli",
        type: "card.created",
        cardId: 3,
        payload: {},
      },
    ]);
    expect(output).toContain("assignee: codex");
    expect(output).toContain("blocked by: #1");
    expect(output).toContain("created by human/jyxc via cli");
  });
});
