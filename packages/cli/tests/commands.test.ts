import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Card } from "@wayblink/using-kanban-core";
import { runCommand, type Io } from "../src/commands.js";
import { resolveActor } from "../src/identity.js";
import { UsageError } from "../src/argv.js";
import {
  formatBoard,
  formatCard,
  formatMine,
  formatProjects,
} from "../src/render.js";

const tempDirs: string[] = [];

/** The package `ukb init --for pi` points at, resolved from this file. */
function resolveLocalPackageForTest(): string {
  const url = new URL(import.meta.url);
  let dir = dirname(fileURLToPath(url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, "packages", "pi", "package.json");
    if (existsSync(candidate)) return dirname(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("packages/pi not found");
}

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

describe("priority", () => {
  it("sets it at creation and changes it by edit", async () => {
    const dir = tempDir();
    const added = await run(["add", "dial me", "--priority", "low"], dir);
    expect(added.out.join("\n")).toContain("#1 [todo] dial me low");

    const edited = await run(["edit", "1", "--priority", "high"], dir);
    expect(edited.out.join("\n")).toContain("#1 [todo] dial me high");

    const reset = await run(["edit", "1", "--priority", "normal"], dir);
    // normal prints nothing, so the line goes quiet again
    expect(reset.out.join("\n")).not.toContain("high");
    expect(reset.out.join("\n")).not.toContain("low");
  });

  it("names the accepted values when given a bad one", async () => {
    const dir = tempDir();
    await expect(
      runCommand(["add", "x", "--priority", "urgent"], makeIo(dir)),
    ).rejects.toThrow(/--priority expects high \| normal \| low/);
  });

  it("points `--priority pending` at the someday column", async () => {
    const dir = tempDir();
    await expect(
      runCommand(["add", "x", "--priority", "pending"], makeIo(dir)),
    ).rejects.toThrow(/shelving is now a column.*ukb move <id> someday/s);
  });

  it("orders a column high → normal → low", async () => {
    const dir = tempDir();
    await run(["add", "minor", "--priority", "low"], dir);
    await run(["add", "plain"], dir);
    await run(["add", "urgent", "--priority", "high"], dir);

    const board = await run(["board"], dir);
    const titles = board.out
      .join("\n")
      .split("\n")
      .filter((line) => line.includes("[todo]"))
      .map((line) => line.replace(/^\s*#\d+ \[todo\] /, "").split(" ")[0]);
    expect(titles).toEqual(["urgent", "plain", "minor"]);
  });

  it("puts the highest-priority todo card in the call to act", async () => {
    const dir = tempDir();
    await run(
      ["add", "background", "--priority", "low", "--assignee", "tester"],
      dir,
    );
    await run(
      ["add", "the real one", "--priority", "high", "--assignee", "tester"],
      dir,
    );

    const mine = await run(["mine", "--agent", "tester"], dir);
    expect(mine.out.join("\n")).toContain("ukb claim 2");
  });
});

describe("the someday shelf", () => {
  it("parks a card by move, clearing its owner", async () => {
    const dir = tempDir();
    await run(
      ["add", "parked", "--assignee", "tester", "--reviewer", "reviewer"],
      dir,
    );

    const moved = await run(["move", "1", "someday"], dir);
    expect(moved.out.join("\n")).toContain("moved to someday");
    expect(moved.out.join("\n")).toContain("#1 [someday] parked");

    const shown = await run(["show", "1"], dir);
    expect(shown.out.join("\n")).toContain("assignee: —");
    expect(shown.out.join("\n")).toContain("reviewer: —");
  });

  it("keeps a parked card out of `mine`", async () => {
    const dir = tempDir();
    await run(["add", "parked", "--assignee", "tester"], dir);
    await run(["move", "1", "someday"], dir);

    const mine = await run(["mine", "--agent", "tester"], dir);
    expect(mine.out.join("\n")).toContain("no open cards");
  });

  it("refuses a column it does not know", async () => {
    const dir = tempDir();
    await run(["add", "x"], dir);
    await expect(
      runCommand(["move", "1", "backlog"], makeIo(dir)),
    ).rejects.toThrow(/someday\|todo\|doing\|review\|done/);
  });
});

describe("umbrella cards", () => {
  async function epic(dir: string): Promise<void> {
    await run(["add", "epic"], dir);
    await run(["add", "part one"], dir);
    await run(["add", "part two"], dir);
    await run(["parent", "2", "--of", "1"], dir);
    await run(["parent", "3", "--of", "1"], dir);
  }

  it("links children and shows the hierarchy on both cards", async () => {
    const dir = tempDir();
    await epic(dir);
    await run(["done", "2"], dir);

    const parent = await run(["show", "1"], dir);
    const text = parent.out.join("\n");
    expect(text).toContain("children: 1/2 (1 todo · 1 done)");
    expect(text).toContain("#2 [done] part one");
    expect(text).toContain("#3 [todo] part two");

    const child = await run(["show", "3"], dir);
    expect(child.out.join("\n")).toContain("parent: #1 epic");
  });

  it("marks the board with ⤷ and ▸ progress", async () => {
    const dir = tempDir();
    await epic(dir);
    await run(["done", "2"], dir);

    const board = await run(["board"], dir);
    const text = board.out.join("\n");
    expect(text).toContain("#1 [todo] epic ▸1/2");
    expect(text).toContain("#2 [done] part one ⤷#1");
  });

  it("refuses to claim or review an umbrella with unfinished children", async () => {
    const dir = tempDir();
    await epic(dir);

    await expect(runCommand(["claim", "1"], makeIo(dir))).rejects.toThrow(
      /umbrella with 2 unfinished children/,
    );
    await expect(runCommand(["review", "1"], makeIo(dir))).rejects.toThrow(
      /umbrella with 2 unfinished children/,
    );
    // but `done` stays allowed — a card must always be closable
    const closed = await run(["done", "1"], dir);
    expect(closed.out.join("\n")).toContain("#1 [done] epic");
  });

  it("keeps the hierarchy one level", async () => {
    const dir = tempDir();
    await epic(dir);

    // #2 is a child, so it cannot become a parent
    await expect(
      runCommand(["parent", "3", "--of", "2"], makeIo(dir)),
    ).rejects.toThrow(/one level/);
  });

  it("unparents back to a top-level card", async () => {
    const dir = tempDir();
    await epic(dir);

    const out = await run(["unparent", "2"], dir);
    expect(out.out.join("\n")).toContain("now top-level");
    const shown = await run(["show", "2"], dir);
    expect(shown.out.join("\n")).toContain("parent: —");
    const parent = await run(["show", "1"], dir);
    expect(parent.out.join("\n")).toContain("children: 0/1");
  });
});

describe("batch card verbs", () => {
  /** A board with three todo cards, all in one project. */
  async function threeCards(dir: string): Promise<void> {
    for (const title of ["one", "two", "three"]) {
      await run(["add", title], dir);
    }
  }

  it("retires several cards in one command, one line each", async () => {
    const dir = tempDir();
    await threeCards(dir);

    const io = makeIo(dir);
    expect(await runCommand(["done", "1", "2", "3"], io)).toBe(0);
    expect(io.out).toEqual([
      "done #1 [done] one · todo → done",
      "done #2 [done] two · todo → done",
      "done #3 [done] three · todo → done",
    ]);
  });

  it("still takes a single id, unchanged", async () => {
    const dir = tempDir();
    await threeCards(dir);

    const io = makeIo(dir);
    expect(await runCommand(["done", "2"], io)).toBe(0);
    expect(io.out).toEqual(["done #2 [done] two · todo → done"]);
  });

  it("batches review and reopen too, and delete", async () => {
    const dir = tempDir();
    await threeCards(dir);

    const io = makeIo(dir);
    expect(
      await runCommand(
        ["claim", "1", "--agent", "pi", "--agent-type", "agent"],
        io,
      ),
    ).toBe(0);
    io.out.length = 0;
    expect(await runCommand(["review", "1"], io)).toBe(0);
    expect(io.out).toEqual([
      "moved to review #1 [review] one @pi · doing → review queue",
    ]);
    io.out.length = 0;
    expect(await runCommand(["reopen", "1", "2", "3"], io)).toBe(0);
    expect(io.out).toHaveLength(3);

    io.out.length = 0;
    expect(await runCommand(["delete", "1", "2", "3"], io)).toBe(0);
    expect(io.out).toEqual(["deleted #1", "deleted #2", "deleted #3"]);
  });

  it("stops at the first card the board refuses, after applying the rest", async () => {
    const dir = tempDir();
    await threeCards(dir);

    const io = makeIo(dir);
    // #1 is applied and printed; #999 stops the run, so #3 is never touched.
    await expect(
      runCommand(["done", "1", "999", "3"], io),
    ).rejects.toMatchObject({ code: "card_not_found" });
    expect(io.out).toEqual(["done #1 [done] one · todo → done"]);

    const board = await run(["board"], dir);
    expect(board.out.join("\n")).toContain("#3 [todo] three");
    expect(board.out.join("\n")).toContain("#1 [done] one");
  });

  it("rejects a non-numeric id instead of skipping it", async () => {
    const dir = tempDir();
    await threeCards(dir);

    const io = makeIo(dir);
    // Silently dropping `abc` would leave the caller believing three cards
    // were retired when two were.
    await expect(runCommand(["done", "1", "abc", "3"], io)).rejects.toThrow(
      /positive card ids/,
    );
    expect(io.out).toEqual([]);
  });

  it("refuses a batch claim, and says why", async () => {
    const dir = tempDir();
    await threeCards(dir);

    const io = makeIo(dir);
    // The board allows exactly one card in `doing`, so this is a
    // contradiction rather than a convenience.
    await expect(runCommand(["claim", "1", "2"], io)).rejects.toThrow(
      /exactly one card in doing/,
    );
    const board = await run(["board"], dir);
    expect(board.out.join("\n")).toContain("#1 [todo] one");
  });

  it("requires at least one id", async () => {
    const dir = tempDir();
    await threeCards(dir);
    await expect(runCommand(["done"], makeIo(dir))).rejects.toThrow(
      /at least one card id/,
    );
  });
});

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

  it("documents the Pi panel in its own gui section", async () => {
    // A panel you cannot discover is a panel you never use, and `ukb help` is
    // the one reference surface an operator already knows to look at.
    const help = await run(["help"], tempDir());
    const text = help.out.join("\n");
    const section = text.slice(text.indexOf("gui (the Pi panel"));

    expect(section).toContain("/ukb gui [show]");
    expect(section).toContain("/ukb gui more | less");
    expect(section).toContain("/ukb gui hide");
    expect(section).toContain("/ukb gui collapse | expand");
    expect(section).toContain("/ukb gui help");
    expect(section).toContain("scope: current-project | mine | all");
    expect(section).toContain("group: state | project | owner | none");
    // The retired spelling is deliberately absent: a deprecation belongs in the
    // runtime warning you get for using it, not in the help everyone reads.
    expect(section).not.toContain("ukb overlay");
  });

  it("keeps the gui section in step with the Pi extension's own help", async () => {
    // The CLI's section and the extension's `/ukb gui help` are two hand-written
    // copies of one vocabulary. This is the cheapest thing that stops them
    // drifting: every accepted value must appear in both.
    const extension = readFileSync(
      join(resolveLocalPackageForTest(), "extensions/using-kanban/index.ts"),
      "utf8",
    );
    const help = await run(["help"], tempDir());
    const cliSection = help.out
      .join("\n")
      .slice(help.out.join("\n").indexOf("gui (the Pi panel"));

    for (const value of [
      "current-project",
      "mine",
      "all",
      "project:<slug>",
      "state",
      "project",
      "owner",
      "none",
      "more",
      "less",
      "collapse",
      "expand",
      "hide",
    ]) {
      expect(cliSection, `ukb help lost "${value}"`).toContain(value);
      expect(extension, `extension help lost "${value}"`).toContain(value);
    }
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

describe("relations and notes", () => {
  it("relates two cards from either side and unrelates them", async () => {
    const dir = tempDir();
    await run(["add", "design"], dir);
    await run(["add", "implement"], dir);

    const upstream = await run(
      ["relate", "2", "--with", "1", "--as", "upstream"],
      dir,
    );
    expect(upstream.out.join("\n")).toContain("#2 now waits on #1");
    expect(upstream.out.join("\n")).toContain("blocked-by:1");

    // the same edge, named from the other card — no second relation, and the
    // upstream card now reports the downstream side of it
    const downstream = await run(
      ["relate", "1", "--with", "2", "--as", "downstream"],
      dir,
    );
    expect(downstream.out.join("\n")).toContain("#2 now waits on #1");
    expect((await run(["show", "1"], dir)).out.join("\n")).toContain(
      "blocks: #2",
    );

    const unrelated = await run(["unrelate", "1", "--with", "2"], dir);
    expect(unrelated.out.join("\n")).not.toContain("blocked-by");
    expect(unrelated.out.join("\n")).not.toContain("blocks:");
  });

  it("rejects a direction that is not upstream or downstream", async () => {
    const dir = tempDir();
    await run(["add", "one"], dir);
    await run(["add", "two"], dir);
    await expect(
      runCommand(
        ["relate", "2", "--with", "1", "--as", "sideways"],
        makeIo(dir),
      ),
    ).rejects.toThrowError(/upstream/);
  });

  it("adds, edits and removes a note with a document link", async () => {
    const dir = tempDir();
    await run(["add", "ship it"], dir);

    const noted = await run(
      ["note", "1", "design doc", "--url", "docs/design.md"],
      dir,
    );
    expect(noted.out.join("\n")).toContain("noted #2");
    expect(noted.out.join("\n")).toContain("docs/design.md");

    const shown = await run(["show", "1"], dir);
    expect(shown.out.join("\n")).toContain("notes:");
    expect(shown.out.join("\n")).toContain("design doc");

    const edited = await run(
      ["note-edit", "1", "2", "design doc v2", "--url", "docs/v2.md"],
      dir,
    );
    expect(edited.out.join("\n")).toContain("updated note #2");
    expect((await run(["show", "1"], dir)).out.join("\n")).toContain(
      "design doc v2",
    );

    const removed = await run(["note-remove", "1", "2"], dir);
    expect(removed.out.join("\n")).toContain("removed note #2");
    expect((await run(["show", "1"], dir)).out.join("\n")).not.toContain(
      "design doc v2",
    );
  });

  it("requires text for a note", async () => {
    const dir = tempDir();
    await run(["add", "ship it"], dir);
    await expect(runCommand(["note", "1"], makeIo(dir))).rejects.toThrowError(
      /ukb note needs text/,
    );
  });
});

describe("render", () => {
  const card: Card = {
    id: 3,
    title: "ship it",
    body: null,
    state: "todo",
    assignee: "codex",
    reviewer: "jyxc",
    project: null,
    priority: "normal",
    blockedBy: [1],
    blocks: [4],
    parent: null,
    children: [],
    notes: [
      {
        id: 9,
        text: "design doc",
        url: "docs/design.md",
        createdBy: "jyxc",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
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

  it("byte-pins the mutation reply, tuple included", async () => {
    // The tuple is derived from the emitted event, so this is the assertion
    // that catches a door drifting back to a hand-written sentence.
    const dir = tempDir();

    const added = await run(
      ["add", "ship it", "--reviewer", "jyxc", "--agent", "pi"],
      dir,
    );
    expect(added.out.join("\n")).toContain("#1 [todo] ship it");

    const claimed = await run(["claim", "1", "--agent", "pi"], dir);
    expect(claimed.out.join("\n")).toBe(
      "claimed #1 [doing] ship it @pi reviewer:jyxc · todo → doing · now assigned to pi",
    );

    const reviewed = await run(["review", "1", "--agent", "pi"], dir);
    expect(reviewed.out.join("\n")).toBe(
      "moved to review #1 [review] ship it @pi reviewer:jyxc · doing → review (jyxc)",
    );
  });

  it("does not send a card with no reviewer to a named person", async () => {
    const dir = tempDir();
    await run(["add", "ship it", "--agent", "pi"], dir);
    await run(["claim", "1", "--agent", "pi"], dir);
    const reviewed = await run(["review", "1", "--agent", "pi"], dir);
    expect(reviewed.out.join("\n")).toBe(
      "moved to review #1 [review] ship it @pi · doing → review queue",
    );
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
      someday: [],
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

  it("renders the project list, untagged bucket last", () => {
    const output = formatProjects([
      { project: "web", someday: 0, todo: 2, doing: 1, review: 0, done: 3 },
      { project: "api", someday: 0, todo: 0, doing: 0, review: 1, done: 2 },
      { project: null, someday: 0, todo: 4, doing: 0, review: 0, done: 0 },
    ]);
    expect(output).toContain("projects (3):");
    const rows = output.split("\n").slice(1, 4);
    // The counts column starts at the same offset on every row, so the numbers
    // are scannable down the page rather than ragged.
    const offsets = rows.map((row) => row.indexOf("doing"));
    expect(new Set(offsets).size).toBe(1);
    expect(output).toContain(
      "1 doing · 0 review · 2 todo · 0 someday · 3 done",
    );
    expect(output).toContain(
      "0 doing · 1 review · 0 todo · 0 someday · 2 done",
    );
    // The untagged bucket is named, not dropped: those cards match no filter.
    expect(output).toContain("(none)");
    expect(output).toContain(
      "0 doing · 0 review · 4 todo · 0 someday · 0 done",
    );
    expect(output).toContain("ukb board --project <slug>");
  });

  it("tells a new board how to get its first project", () => {
    expect(formatProjects([])).toContain("no projects yet");
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

describe("list", () => {
  it("counts every project, and the untagged bucket", async () => {
    const dir = tempDir();
    await run(["add", "web one", "--project", "web"], dir);
    await run(["add", "api one", "--project", "api"], dir);
    await run(["add", "untagged"], dir);
    await run(["claim", "1", "--agent", "pi", "--agent-type", "agent"], dir);

    const io = await run(["list"], dir);
    const out = io.out.join("\n");
    expect(out).toContain("projects (3):");
    expect(out).toContain("0 doing · 0 review · 1 todo · 0 someday · 0 done");
    expect(out).toContain("1 doing · 0 review · 0 todo · 0 someday · 0 done");
    expect(out).toContain("(none)");
    expect(out).toContain("ukb board --project <slug>");
  });

  it("is a read: it never creates a board", async () => {
    const dir = tempDir();
    await expect(runCommand(["list"], makeIo(dir))).rejects.toMatchObject({
      code: "board_not_found",
    });
  });

  it("emits machine-readable summaries with --json", async () => {
    const dir = tempDir();
    await run(["add", "web one", "--project", "web"], dir);
    await run(["add", "untagged"], dir);

    const io = await run(["list", "--json"], dir);
    expect(JSON.parse(io.out.join("\n"))).toEqual({
      projects: [
        { project: "web", someday: 0, todo: 1, doing: 0, review: 0, done: 0 },
        { project: null, someday: 0, todo: 1, doing: 0, review: 0, done: 0 },
      ],
    });
  });
});

describe("board --json", () => {
  it("emits every column and the projects in use as one JSON document", async () => {
    const dir = tempDir();
    await run(["add", "ship it", "--assignee", "pi", "--project", "web"], dir);
    await run(["add", "later", "--project", "api"], dir);
    await run(["claim", "1", "--agent", "pi", "--agent-type", "agent"], dir);

    const io = await run(["board", "--json"], dir);
    const parsed = JSON.parse(io.out.join("\n")) as {
      todo: { id: number; title: string }[];
      doing: { id: number; title: string; assignee: string | null }[];
      review: unknown[];
      done: unknown[];
      projects: string[];
    };

    expect(parsed.todo.map((card) => card.title)).toEqual(["later"]);
    expect(parsed.doing).toHaveLength(1);
    expect(parsed.doing[0]?.title).toBe("ship it");
    expect(parsed.doing[0]?.assignee).toBe("pi");
    expect(parsed.review).toEqual([]);
    expect(parsed.done).toEqual([]);
    expect(parsed.projects).toEqual(["api", "web"]);
  });

  it("emits a compact list projection with --brief", async () => {
    const dir = tempDir();
    await run(
      [
        "add",
        "ship it",
        "--body",
        "large private body",
        "--assignee",
        "pi",
        "--reviewer",
        "jyxc",
        "--project",
        "web",
      ],
      dir,
    );

    const raw = await run(["board", "--json"], dir);
    expect(raw.out.join("\n")).toContain("large private body");

    const brief = await run(["board", "--json", "--brief"], dir);
    const parsed = JSON.parse(brief.out.join("\n")) as {
      todo: Record<string, unknown>[];
    };
    expect(parsed.todo[0]).toEqual({
      id: 1,
      title: "ship it",
      state: "todo",
      assignee: "pi",
      reviewer: "jyxc",
      project: "web",
      priority: "normal",
      blockedBy: [],
      parent: null,
      children: [],
    });
    expect(brief.out.join("\n")).not.toContain("large private body");
    expect(parsed.todo[0]).not.toHaveProperty("notes");
    expect(parsed.todo[0]).not.toHaveProperty("createdBy");
  });

  it("scopes the JSON to --project", async () => {
    const dir = tempDir();
    await run(["add", "web card", "--project", "web"], dir);
    await run(["add", "api card", "--project", "api"], dir);

    const io = await run(["board", "--json", "--project", "web"], dir);
    const parsed = JSON.parse(io.out.join("\n")) as {
      todo: { title: string }[];
    };
    expect(parsed.todo.map((card) => card.title)).toEqual(["web card"]);
  });

  it("keeps the text board as the default", async () => {
    const dir = tempDir();
    await run(["add", "plain"], dir);
    const io = await run(["board"], dir);
    // The text renderer's column headers, not a JSON document.
    expect(io.out.join("\n")).toContain("todo (1):");
    expect(() => JSON.parse(io.out.join("\n"))).toThrow();
  });
});
