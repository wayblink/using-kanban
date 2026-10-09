import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  KanbanError,
  openKanban,
  type Actor,
  type CardState,
  type Kanban,
} from "@wayblink/using-kanban-core";
import {
  flagBoolean,
  flagNumbers,
  flagString,
  parseArgv,
  resolveDir,
  resolveStorage,
  UsageError,
} from "./argv.js";
import { resolveActor } from "./identity.js";
import {
  formatBoard,
  formatCard,
  formatCardBrief,
  formatMine,
  formatMutation,
} from "./render.js";
import { runInit } from "./init.js";
import { runDoctor } from "./doctor.js";

/** Each intent verb reports itself in its own words. */
const TRANSITION_VERBS = {
  claim: {
    verb: "claimed",
    run: (kanban: Kanban, id: number, actor: Actor) =>
      kanban.claim(id, actor, "cli"),
  },
  review: {
    verb: "moved to review",
    run: (kanban: Kanban, id: number, actor: Actor) =>
      kanban.review(id, actor, "cli"),
  },
  done: {
    verb: "done",
    run: (kanban: Kanban, id: number, actor: Actor) =>
      kanban.done(id, actor, "cli"),
  },
  reopen: {
    verb: "reopened",
    run: (kanban: Kanban, id: number, actor: Actor) =>
      kanban.reopen(id, actor, "cli"),
  },
} as const;

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Home directory used by installers (defaults to os.homedir()); injectable for tests. */
  home?: string | undefined;
}

const COMMANDS = [
  "mine",
  "board",
  "show",
  "add",
  "edit",
  "claim",
  "review",
  "done",
  "reopen",
  "move",
  "delete",
  "block",
  "unblock",
  "web",
  "init",
  "doctor",
  "help",
] as const;

const USAGE = `ukb — using-kanban command line

usage: ukb [command] [args]

board:
  ukb                              your open cards (a call to act, not just a list)
  ukb board [--project p]          the whole board, or one project's slice
  ukb show <id>                    card detail + event history

work:
  ukb add "<title>" [--body "..."] [--assignee X] [--reviewer Y] [--project p]
  ukb claim <id>                   todo → doing, assigned to you (do this first!)
  ukb review <id>                  → review
  ukb done <id>                    → done
  ukb reopen <id>                  → todo
  ukb move <id> <todo|doing|review|done>
  ukb edit <id> [--title T] [--body B] [--assignee X] [--reviewer Y] [--project p]
  ukb delete <id>                  creator only
  ukb block <id> --by <id>         make a card wait on another
  ukb unblock <id> --by <id>

setup:
  ukb web [--port N] [--no-open]    start the API + Web UI
  ukb init --for <framework> [--browser]
                                     wire this project into an agent framework
                                     (--browser also adds the Playwright MCP server)
                                     pi registers the extension + skill package
  ukb doctor                        check the environment

global flags:
  --dir <path>       board directory (default: current project; store at <dir>/.ukb)
  --storage <kind>   sqlite (default) | jsonl | memory
  --agent <name>     who you are (default: $USER) — agents should always pass this
  --agent-type <t>   human (default) | agent

frameworks for init: claude-code, codex, opencode (anything else gets the generic setup)
`;

/** Runs one command. Returns the process exit code. */
/** Commands that only look. Everything else may create the store. */
const READ_ONLY_COMMANDS = new Set(["mine", "board", "show"]);

export async function runCommand(
  argv: readonly string[],
  io: Io,
): Promise<number> {
  const parsed = parseArgv(argv);

  if (
    flagBoolean(parsed.flags, "help") ||
    flagBoolean(parsed.flags, "h") ||
    parsed.command === "help"
  ) {
    io.stdout(USAGE);
    return 0;
  }
  if (flagBoolean(parsed.flags, "version") || flagBoolean(parsed.flags, "v")) {
    io.stdout("ukb 0.1.0");
    return 0;
  }

  const command = parsed.command ?? "mine";
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(`unknown command "${command}" — try: ukb help`);
  }

  const dir = resolveDir(parsed.flags, io.env, io.cwd);
  const storage = resolveStorage(parsed.flags, io.env);

  switch (command) {
    case "web":
      return runWeb(parsed.flags, io, dir, storage);
    case "init":
      return runInit(parsed.flags, io, dir, io.home ?? homedir());
    case "doctor":
      return runDoctor(parsed.flags, io, dir, storage);
    default:
      break;
  }

  const actor = resolveActor(parsed.flags, io.env);
  // Reads must not conjure a board: `ukb board` in the wrong directory should
  // say so, not report an empty one.
  const kanban = openKanban({
    dir,
    storage,
    create: !READ_ONLY_COMMANDS.has(command),
  });
  try {
    switch (command) {
      case "mine": {
        io.stdout(
          formatMine(
            kanban.mine(actor.name, flagString(parsed.flags, "project")),
            actor.name,
          ),
        );
        return 0;
      }
      case "board": {
        io.stdout(
          formatBoard(
            kanban.board(flagString(parsed.flags, "project")),
            kanban.projects(),
          ),
        );
        return 0;
      }
      case "show": {
        const id = requireId(parsed.positionals[0], command);
        const card = kanban.card(id);
        if (!card)
          throw new KanbanError("card_not_found", `card ${id} not found`);
        io.stdout(formatCard(card, kanban.history(id)));
        return 0;
      }
      case "add": {
        const title = parsed.positionals.join(" ").trim();
        if (!title)
          throw new UsageError(
            'ukb add needs a title: ukb add "fix the flaky test"',
          );
        const { card } = kanban.add(
          {
            title,
            body: flagString(parsed.flags, "body") ?? null,
            assignee: flagString(parsed.flags, "assignee") ?? null,
            reviewer: flagString(parsed.flags, "reviewer") ?? null,
            project: flagString(parsed.flags, "project"),
            blockedBy: flagNumbers(parsed.flags, "blocked-by"),
          },
          actor,
          "cli",
        );
        io.stdout(formatMutation(card, "created"));
        return 0;
      }
      case "edit": {
        const id = requireId(parsed.positionals[0], command);
        const { card } = kanban.edit(
          id,
          {
            title: flagString(parsed.flags, "title"),
            body: flagString(parsed.flags, "body"),
            assignee: flagString(parsed.flags, "assignee"),
            reviewer: flagString(parsed.flags, "reviewer"),
            project: flagString(parsed.flags, "project"),
          },
          actor,
          "cli",
        );
        io.stdout(formatMutation(card, "updated"));
        return 0;
      }
      case "claim":
      case "review":
      case "done":
      case "reopen": {
        const id = requireId(parsed.positionals[0], command);
        const result = TRANSITION_VERBS[command].run(kanban, id, actor);
        io.stdout(formatMutation(result.card, TRANSITION_VERBS[command].verb));
        return 0;
      }
      case "move": {
        const id = requireId(parsed.positionals[0], command);
        const to = parsed.positionals[1];
        if (!to || !["todo", "doing", "review", "done"].includes(to)) {
          throw new UsageError(
            "ukb move needs a column: ukb move <id> <todo|doing|review|done>",
          );
        }
        const { card } = kanban.move(id, to as CardState, actor, "cli");
        io.stdout(formatMutation(card, `moved to ${to}`));
        return 0;
      }
      case "delete": {
        const id = requireId(parsed.positionals[0], command);
        kanban.remove(id, actor, "cli");
        io.stdout(`deleted #${id}`);
        return 0;
      }
      case "block":
      case "unblock": {
        const id = requireId(parsed.positionals[0], command);
        const by = Number(flagString(parsed.flags, "by"));
        if (!Number.isInteger(by) || by <= 0) {
          throw new UsageError(`ukb ${command} needs --by <card id>`);
        }
        const { card } =
          command === "block"
            ? kanban.block(id, by, actor, "cli")
            : kanban.unblock(id, by, actor, "cli");
        io.stdout(
          formatMutation(
            card,
            command === "block" ? `blocked on #${by}` : `unblocked from #${by}`,
          ),
        );
        return 0;
      }
      default:
        throw new UsageError(`unhandled command "${command}"`);
    }
  } finally {
    kanban.close();
  }
}

async function runWeb(
  flags: Record<string, string | true>,
  io: Io,
  dir: string,
  storage: "sqlite" | "jsonl" | "memory",
): Promise<number> {
  const { startServer } = await import("@wayblink/using-kanban-server");
  const uiDir = flagString(flags, "ui") ?? (await resolveDefaultUiDir());

  const running = await startServer({
    dir,
    storage,
    host: flagString(flags, "host"),
    port: flagString(flags, "port")
      ? Number(flagString(flags, "port"))
      : undefined,
    token: flagString(flags, "token"),
    uiDir,
  });

  io.stdout("");
  io.stdout(`using-kanban — ${running.url}`);
  io.stdout(`  store  ${dir}/.ukb (${storage})`);
  io.stdout(
    uiDir
      ? `  ui     ${uiDir}`
      : "  ui     none (install @wayblink/using-kanban-web or pass --ui <dir>)",
  );
  io.stdout("  Ctrl+C to stop");
  io.stdout("");

  if (!flagBoolean(flags, "no-open")) {
    openBrowser(running.url);
  }

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
  await running.close();
  return 0;
}

function openBrowser(url: string): void {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // opening a browser is best-effort
  }
}

async function resolveDefaultUiDir(): Promise<string | undefined> {
  try {
    const url = hereUrl();
    if (!url) return undefined;
    // require.resolve returns a filesystem path, not a URL.
    const require = createRequire(url);
    return dirname(
      require.resolve("@wayblink/using-kanban-web/dist/index.html"),
    );
  } catch {
    return undefined;
  }
}

/** `import.meta.url` is undefined in the bundled binary — fall back to argv[1]. */
function hereUrl(): string | undefined {
  if (
    typeof import.meta.url === "string" &&
    import.meta.url.startsWith("file:")
  ) {
    return import.meta.url;
  }
  const entry = process.argv[1];
  return entry ? pathToFileURL(resolve(entry)).href : undefined;
}

function requireId(value: string | undefined, command: string): number {
  const id = Number(value);
  if (!value || !Number.isInteger(id) || id <= 0) {
    throw new UsageError(`ukb ${command} needs a card id: ukb ${command} <id>`);
  }
  return id;
}

export { formatCardBrief, resolveDefaultUiDir };
