import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CARD_PRIORITIES,
  KanbanError,
  describeMutation,
  openKanban,
  type Actor,
  type Card,
  type CardPriority,
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
  formatProjects,
} from "./render.js";
import { runInit } from "./init.js";
import { runDoctor } from "./doctor.js";

/**
 * Each intent verb reports itself in its own words.
 *
 * Only the verb is per-door: the transition tuple itself comes from
 * `describeMutation`, so no call site can claim a move that did not happen.
 */
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

/** The fields a list consumer needs; leaves bodies, notes and audit metadata out. */
function briefCard(
  card: Card,
): Pick<
  Card,
  | "id"
  | "title"
  | "state"
  | "assignee"
  | "reviewer"
  | "project"
  | "priority"
  | "blockedBy"
  | "parent"
  | "children"
> {
  const {
    id,
    title,
    state,
    assignee,
    reviewer,
    project,
    priority,
    blockedBy,
    parent,
    children,
  } = card;
  return {
    id,
    title,
    state,
    assignee,
    reviewer,
    project,
    priority,
    blockedBy,
    parent,
    children,
  };
}

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
  "list",
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
  "parent",
  "unparent",
  "relate",
  "unrelate",
  "note",
  "note-edit",
  "note-remove",
  "web",
  "init",
  "doctor",
  "help",
] as const;

/**
 * `ukb help`.
 *
 * The `gui` section documents the Pi package's slash command rather than a CLI
 * verb, because this is the one reference surface an operator already knows to
 * look at — and a panel you cannot discover is a panel you never use. It mirrors
 * the help text in packages/pi/extensions/using-kanban/index.ts; the two are
 * pinned against each other by a test in packages/cli/tests/commands.test.ts.
 */
const USAGE = `ukb — using-kanban command line

usage: ukb [command] [args]

board:
  ukb                              your open cards (a call to act, not just a list)
  ukb list                         every project on the board with its counts
  ukb board [--project p] [--json [--brief]]
                                     the whole board, or one project's slice
                                     (--json emits { projects, someday, todo,
                                     doing, review, done } for scripts and the
                                     overlay)
  ukb show <id>                    card detail + event history

work:
  ukb add "<title>" [--body "..."] [--assignee X] [--reviewer Y] [--project p]
                                     [--priority high|normal|low]
  ukb claim <id>                   todo → doing, assigned to you (do this first!)
  ukb review <id> [<id> …]         → review, one line per card
  ukb done <id> [<id> …]           → done
  ukb reopen <id> [<id> …]         → todo
  ukb move <id> <someday|todo|doing|review|done>
                                     someday parks a card for later: it leaves
                                     the to-do list and is unhooked from its
                                     owner (assignee and reviewer are cleared)
  ukb edit <id> [--title T] [--body B] [--assignee X] [--reviewer Y] [--project p]
                                     [--priority high|normal|low]
  ukb delete <id> [<id> …]         creator only
  ukb block <id> --by <id>         make a card wait on another
  ukb unblock <id> --by <id>
  ukb parent <id> --of <id>        make a card a child of an umbrella
  ukb unparent <id>                make it a top-level card again
  ukb relate <id> --with <id> --as upstream|downstream
                                     name the direction of a relation;
                                     "upstream" = the other card is a
                                     predecessor, "downstream" = a successor
  ukb unrelate <id> --with <id>     drop the relation, either way round
  ukb note <id> "design doc" [--url docs/design.md]
                                     add a remark — a doc link, say
  ukb note-edit <id> <noteId> ["…"] [--url …]
  ukb note-remove <id> <noteId>

gui (the Pi panel — /ukb gui, not a CLI verb):
  /ukb gui [show] [scope=…] [group=…] [states=…] [project=…] [lines=<n>]
                                     mount the panel above the editor. On demand
                                     by default: the panel competes with the
                                     latest conversation, so you ask for it.
                                     Default scope is the current Git project.
  /ukb gui more | less              grow / shrink the row budget
  /ukb gui hide                     remove it
  /ukb gui collapse | expand        one line / full height
  /ukb gui help
  scope: current-project | mine | all | project:<slug>
  group: state | project | owner | none
  states: doing, todo, review, someday, done (default: all but done)
  rows: doing, then todo, then review, then someday — ordered by priority
                                     inside each state

setup:
  ukb web [--port N] [--no-open]    start the API + Web UI
  ukb web --doc-root <dir>[,<dir>]  let card notes link docs from there
                                     in Pi, /ukb web runs this in the background
                                     so the session keeps going; /ukb web stop
                                     winds it down again
  ukb init --for <framework> [--browser]
                                     wire this project into an agent framework
                                     (--browser also adds the Playwright MCP server)
                                     pi registers the extension + skill package
  ukb doctor                        check the environment

priority:
  high | normal | low   normal is the default. Rows sort high → normal → low
                                     inside each column. "not now" is not a
                                     priority — park a card with
                                     ukb move <id> someday instead. The Pi
                                     panel always prints the tag; the CLI text
                                     prints it only when it is not normal,
                                     because its lines already carry six other
                                     markers and ukb show states the priority
                                     outright.

hierarchy:
  Umbrella cards (a big goal) and their children (the work that supports it)
  are one level deep: an umbrella has children, a child has none. This is
  composition, not blocking — an umbrella does not block its children, and
  a card can be both someone's child and blocked by a third card. The two ends
  move together: an umbrella goes to doing first, then its parts may be doing
  or review, and the umbrella cannot be reviewed or done until every part is
  done. ukb board marks them ⤷#parent and ▸done/total.

global flags:
  --dir <path>       board directory (default: home; the store is <dir>/.ukb)
  --project <dir>    where "ukb init" writes the agent config (default: cwd)
  --storage <kind>   sqlite (default) | jsonl | memory
  --agent <name>     who you are (default: $USER) — agents should always pass this
  --agent-type <t>   human (default) | agent

frameworks for init: claude-code, codex, opencode (anything else gets the generic setup)
`;

/** Runs one command. Returns the process exit code. */
/** Commands that only look. Everything else may create the store. */
const READ_ONLY_COMMANDS = new Set(["mine", "list", "board", "show"]);

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

  const dir = resolveDir(parsed.flags, io.env);
  const storage = resolveStorage(parsed.flags, io.env);

  switch (command) {
    case "web":
      return runWeb(parsed.flags, io, dir, storage);
    case "init":
      // Onboarding a framework is about the project you are standing in, which
      // is no longer the board directory now that the store is centralised.
      // `--project` overrides where the config files are written.
      return runInit(
        parsed.flags,
        io,
        flagString(parsed.flags, "project") ?? io.cwd,
        io.home ?? homedir(),
      );
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
            new Map(kanban.cards().map((card) => [card.id, card])),
          ),
        );
        return 0;
      }
      case "list": {
        const summaries = kanban.projectSummary();
        if (flagBoolean(parsed.flags, "json")) {
          io.stdout(JSON.stringify({ projects: summaries }));
          return 0;
        }
        io.stdout(formatProjects(summaries));
        return 0;
      }
      case "board": {
        const board = kanban.board(flagString(parsed.flags, "project"));
        // `--json` is the raw machine door onto the same board the text
        // renderer shows. `--brief` is its list projection: the Pi overlay only
        // needs identity/ownership, not 100 KiB of bodies, notes and audit data.
        if (flagBoolean(parsed.flags, "json")) {
          const snapshot = flagBoolean(parsed.flags, "brief")
            ? {
                someday: board.someday.map(briefCard),
                todo: board.todo.map(briefCard),
                doing: board.doing.map(briefCard),
                review: board.review.map(briefCard),
                done: board.done.map(briefCard),
              }
            : board;
          io.stdout(
            JSON.stringify({ ...snapshot, projects: kanban.projects() }),
          );
          return 0;
        }
        io.stdout(
          formatBoard(
            board,
            kanban.projects(),
            // Full index: a project slice must still count children in other
            // projects, or an umbrella's `▸done/total` would undercount.
            new Map(kanban.cards().map((card) => [card.id, card])),
          ),
        );
        return 0;
      }
      case "show": {
        const id = requireId(parsed.positionals[0], command);
        const card = kanban.card(id);
        if (!card)
          throw new KanbanError("card_not_found", `card ${id} not found`);
        io.stdout(
          formatCard(card, kanban.history(id), {
            parent: card.parent === null ? null : kanban.card(card.parent),
            children: kanban.childrenOf(id),
          }),
        );
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
            priority: flagPriority(parsed.flags),
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
            priority: flagPriority(parsed.flags),
          },
          actor,
          "cli",
        );
        io.stdout(formatMutation(card, "updated"));
        return 0;
      }
      case "claim": {
        // Batch-claiming is refused rather than quietly ignored: the board's
        // invariant is exactly one card in `doing`, so `claim 1 2` is a
        // contradiction, not a convenience.
        if (parsed.positionals.length > 1) {
          throw new UsageError(
            "ukb claim takes one card at a time — the board allows exactly one card in doing. Claim each in turn.",
          );
        }
        const id = requireId(parsed.positionals[0], command);
        const result = TRANSITION_VERBS[command].run(kanban, id, actor);
        io.stdout(
          describeMutation(
            formatCardBrief(result.card),
            result,
            TRANSITION_VERBS[command].verb,
          ),
        );
        return 0;
      }
      case "review":
      case "done":
      case "reopen": {
        // Batch: one line per card, in the order given. A card the board
        // refuses throws, so the run stops there — a later card is not
        // transitioned on the strength of an earlier one that failed — and
        // everything applied before the stop has already been printed.
        const ids = requireIds(parsed.positionals, command);
        for (const id of ids) {
          const result = TRANSITION_VERBS[command].run(kanban, id, actor);
          io.stdout(
            describeMutation(
              formatCardBrief(result.card),
              result,
              TRANSITION_VERBS[command].verb,
            ),
          );
        }
        return 0;
      }
      case "move": {
        const id = requireId(parsed.positionals[0], command);
        const to = parsed.positionals[1];
        if (
          !to ||
          !["someday", "todo", "doing", "review", "done"].includes(to)
        ) {
          throw new UsageError(
            "ukb move needs a column: ukb move <id> <someday|todo|doing|review|done>",
          );
        }
        const result = kanban.move(id, to as CardState, actor, "cli");
        io.stdout(
          describeMutation(
            formatCardBrief(result.card),
            result,
            `moved to ${to}`,
          ),
        );
        return 0;
      }
      case "delete": {
        // Batch, like the transition verbs above.
        const ids = requireIds(parsed.positionals, command);
        for (const id of ids) {
          kanban.remove(id, actor, "cli");
          io.stdout(`deleted #${id}`);
        }
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
      case "parent":
      case "unparent": {
        const id = requireId(parsed.positionals[0], command);
        if (command === "unparent") {
          const { card } = kanban.unparent(id, actor, "cli");
          io.stdout(formatMutation(card, "now top-level"));
          return 0;
        }
        const of = Number(flagString(parsed.flags, "of"));
        if (!Number.isInteger(of) || of <= 0) {
          throw new UsageError("ukb parent needs --of <card id>");
        }
        const { card } = kanban.parent(id, of, actor, "cli");
        io.stdout(formatMutation(card, `child of #${of}`));
        return 0;
      }
      case "relate":
      case "unrelate": {
        const id = requireId(parsed.positionals[0], command);
        const withId = Number(flagString(parsed.flags, "with"));
        if (!Number.isInteger(withId) || withId <= 0) {
          throw new UsageError(`ukb ${command} needs --with <card id>`);
        }
        if (command === "unrelate") {
          const { card } = kanban.unrelate(id, withId, actor, "cli");
          io.stdout(formatMutation(card, `unrelated from #${withId}`));
          return 0;
        }
        const as = flagString(parsed.flags, "as") ?? "upstream";
        if (as !== "upstream" && as !== "downstream") {
          throw new UsageError(
            "ukb relate --as expects upstream (default) or downstream",
          );
        }
        const { card } = kanban.relate(id, withId, as, actor, "cli");
        const waiting = as === "upstream" ? id : withId;
        const waitedOn = as === "upstream" ? withId : id;
        io.stdout(
          formatMutation(card, `#${waiting} now waits on #${waitedOn}`),
        );
        return 0;
      }
      case "note": {
        const id = requireId(parsed.positionals[0], command);
        const text = parsed.positionals.slice(1).join(" ").trim();
        if (!text) {
          throw new UsageError(
            'ukb note needs text: ukb note 4 "design doc" --url docs/design.md',
          );
        }
        const { card } = kanban.addNote(
          id,
          { text, url: flagString(parsed.flags, "url") ?? null },
          actor,
          "cli",
        );
        const note = card.notes[card.notes.length - 1];
        io.stdout(
          formatMutation(
            card,
            `noted #${note?.id ?? "?"}${note?.url ? ` — ${note.url}` : ""}`,
          ),
        );
        return 0;
      }
      case "note-edit": {
        const id = requireId(parsed.positionals[0], command);
        const noteId = requireId(parsed.positionals[1], command);
        const text = parsed.positionals.slice(2).join(" ").trim();
        const url = flagString(parsed.flags, "url");
        if (!text && url === undefined) {
          throw new UsageError("ukb note-edit needs text and/or --url");
        }
        const { card } = kanban.updateNote(
          id,
          noteId,
          {
            ...(text ? { text } : {}),
            ...(url !== undefined ? { url } : {}),
          },
          actor,
          "cli",
        );
        io.stdout(formatMutation(card, `updated note #${noteId}`));
        return 0;
      }
      case "note-remove": {
        const id = requireId(parsed.positionals[0], command);
        const noteId = requireId(parsed.positionals[1], command);
        const { card } = kanban.removeNote(id, noteId, actor, "cli");
        io.stdout(formatMutation(card, `removed note #${noteId}`));
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
    // Where a card note's document link may point. Comma-separated because
    // the argv parser keeps the last of a repeated flag.
    docRoots: (flagString(flags, "doc-root") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  });

  io.stdout("");
  io.stdout(`using-kanban — ${running.url}`);
  io.stdout(`  store  ${dir}/.ukb (${storage})`);
  io.stdout(
    uiDir
      ? `  ui     ${uiDir}`
      : "  ui     none (install @wayblink/using-kanban-web or pass --ui <dir>)",
  );
  const docRoots = (flagString(flags, "doc-root") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  io.stdout(
    docRoots.length > 0
      ? `  docs   ${docRoots.join(", ")}`
      : "  docs   cwd and the store dir only (pass --doc-root to allow more)",
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

/**
 * `--priority`, validated here so the error names the accepted values rather
 * than surfacing as a zod message from three layers down.
 */
function flagPriority(
  flags: Record<string, string | true>,
): CardPriority | undefined {
  const value = flagString(flags, "priority");
  if (value === undefined) return undefined;
  if (value === "pending") {
    // Retired in favour of the `someday` state. The old value is common enough
    // in muscle memory (and in docs) that a bare "expects high | normal | low"
    // would read as a typo rather than a moved concept.
    throw new UsageError(
      '"--priority pending" is gone: shelving is now a column. Use `ukb move <id> someday` (or create the card and move it).',
    );
  }
  if (!(CARD_PRIORITIES as readonly string[]).includes(value)) {
    throw new UsageError(
      `--priority expects ${CARD_PRIORITIES.join(" | ")} (got "${value}")`,
    );
  }
  return value as CardPriority;
}

function requireId(value: string | undefined, command: string): number {
  const id = Number(value);
  if (!value || !Number.isInteger(id) || id <= 0) {
    throw new UsageError(`ukb ${command} needs a card id: ukb ${command} <id>`);
  }
  return id;
}

/**
 * Every positional as a card id, for the batch verbs.
 *
 * One id is the common case and must stay valid, so `ukb done 1` and
 * `ukb done 1 2` share this path. A bad id anywhere is a usage error rather than
 * a skipped card: silently dropping `done 1 abc 3` would leave the caller
 * believing three cards were retired.
 */
function requireIds(values: readonly string[], command: string): number[] {
  if (values.length === 0) {
    throw new UsageError(
      `ukb ${command} needs at least one card id: ukb ${command} <id> [<id> …]`,
    );
  }
  const ids = values.map((value) => Number(value));
  for (const [index, id] of ids.entries()) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new UsageError(
        `ukb ${command} expects positive card ids (got "${values[index]}")`,
      );
    }
  }
  return ids;
}

export { formatCardBrief, resolveDefaultUiDir };
/** Every subcommand the CLI accepts — other front doors check themselves against it. */
export const CLI_COMMANDS = COMMANDS;
