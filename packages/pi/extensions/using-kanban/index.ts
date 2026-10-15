import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text, type KeyId } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { resolveGuidance } from "./guidance.js";
import { OVERLAY_LINES_STEP, parseOverlayCommand } from "./overlay-command.js";
import { shouldRefreshAfterCommand } from "./overlay-refresh.js";
import {
  COLLAPSE_KEY_OFF,
  MIN_MAX_LINES,
  isOverlayDisabled,
  normalizeOverlayProject,
  resolveCollapseKey,
  resolveMaxLines,
  resolveOverlayDisplay,
  resolveOverlayGroup,
  resolveOverlayProject,
  resolveOverlayScope,
  resolveOverlayStates,
} from "./overlay-config.js";
import { BoardOverlay } from "./overlay.js";
import type { OverlayView } from "./overlay-render.js";

/**
 * Registers `ukb` as a native Pi tool (and a `/ukb` slash command) that drives
 * the board through the `ukb` CLI.
 *
 * Why a native tool rather than the MCP server: Pi renders every tool call in a
 * coloured shell — green on success, red on error — and lets a tool supply its
 * own `renderCall`/`renderResult`. That is what gives `ukb claim 3` the same
 * tight, colour-coded feedback as a first-class CLI verb, instead of a raw JSON
 * argument dump. The tool is a thin shell: it shells out to the one CLI binary
 * (shared with the HTTP API, the MCP server and every other front door), so
 * there is no second copy of the board logic to keep in sync.
 *
 * No board logic lives here beyond argument plumbing — the CLI owns parsing,
 * validation and formatting, and its exit code decides the block colour.
 */

/* ----------------------------- argument model ---------------------------- */

const ACTIONS = [
  "mine",
  "list",
  "board",
  "show",
  "add",
  "claim",
  "review",
  "done",
  "reopen",
  "move",
  "edit",
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
] as const;

const COLUMNS = ["someday", "todo", "doing", "review", "done"] as const;

/** Mirrors core's CARD_PRIORITIES, in sort order. */
const PRIORITIES = ["high", "normal", "low"] as const;

/**
 * Verbs whose card ids are all positionals, so several can be given at once.
 *
 * `claim` is in this set only so the CLI receives every id and can refuse with
 * the message that explains the one-card-in-`doing` rule. Silently dropping the
 * extra ids would turn a contradiction into a half-executed command.
 *
 * `move` is absent because `<id> <column>` is positional and `move 1 2 doing`
 * cannot be read unambiguously.
 */
const BATCH_ACTIONS: ReadonlySet<string> = new Set([
  "review",
  "done",
  "reopen",
  "delete",
  "claim",
]);

/** Which side of a relation the other card sits on. */
const DIRECTIONS = ["upstream", "downstream"] as const;

type Action = (typeof ACTIONS)[number];
type Column = (typeof COLUMNS)[number];
type Direction = (typeof DIRECTIONS)[number];

interface UkbParams {
  action: Action;
  id?: number | undefined;
  /** Several ids for the batch verbs; `id` stays the single-card form. */
  ids?: number[] | undefined;
  priority?: (typeof PRIORITIES)[number] | undefined;
  title?: string | undefined;
  body?: string | undefined;
  column?: Column | undefined;
  assignee?: string | undefined;
  reviewer?: string | undefined;
  blockedBy?: number | undefined;
  project?: string | undefined;
  /** The card on the other end of a relation. */
  other?: number | undefined;
  /** The umbrella card, for `parent`. */
  parent?: number | undefined;
  /** Which side `other` sits on, relative to `id`. */
  direction?: Direction | undefined;
  /** A note's id — the id `ukb show` prints beside it. */
  noteId?: number | undefined;
  /** A note's remark. */
  text?: string | undefined;
  /** A note's document link: https://… or a path to a local file. */
  url?: string | undefined;
}

/** Actions whose first positional is a card id. */
const ID_ACTIONS: ReadonlySet<Action> = new Set([
  "show",
  "claim",
  "review",
  "done",
  "reopen",
  "move",
  "edit",
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
]);

/** `ids` when several were given, else the single `id`, else nothing. */
function cardIds(params: UkbParams): number[] {
  if (params.ids !== undefined) return params.ids;
  return params.id === undefined ? [] : [params.id];
}

/**
 * Maps structured params to `ukb` CLI argv, e.g. `{ action: "claim", id: 3 }`
 * → `["claim", "3"]`. Validation is left to the CLI on purpose: a missing id or
 * title surfaces as the CLI's own error message, which is what the user should
 * read. Identity flags are added by the caller.
 */
function buildArgs(params: UkbParams): string[] {
  const args: string[] = [params.action];
  const flag = (name: string, value: string | number | undefined): void => {
    if (value !== undefined) args.push(name, String(value));
  };

  // Batch verbs take every id as a positional, exactly as on the command line.
  // `id` alone still works: one card is the common case and must not need a
  // different shape.
  if (BATCH_ACTIONS.has(params.action)) {
    for (const id of cardIds(params)) args.push(String(id));
  } else if (ID_ACTIONS.has(params.action) && params.id !== undefined) {
    args.push(String(params.id));
  }

  switch (params.action) {
    case "mine":
    case "board":
      flag("--project", params.project);
      break;
    case "add":
      if (params.title !== undefined) args.push(params.title);
      flag("--body", params.body);
      flag("--assignee", params.assignee);
      flag("--reviewer", params.reviewer);
      flag("--project", params.project);
      flag("--priority", params.priority);
      flag("--blocked-by", params.blockedBy);
      break;
    case "edit":
      flag("--title", params.title);
      flag("--body", params.body);
      flag("--assignee", params.assignee);
      flag("--reviewer", params.reviewer);
      flag("--project", params.project);
      flag("--priority", params.priority);
      break;
    case "move":
      if (params.column !== undefined) args.push(params.column);
      break;
    case "block":
    case "unblock":
      flag("--by", params.blockedBy);
      break;
    case "parent":
      flag("--of", params.parent);
      break;
    case "unparent":
      break;
    case "relate":
      flag("--with", params.other);
      flag("--as", params.direction);
      break;
    case "unrelate":
      flag("--with", params.other);
      break;
    case "note":
      // the remark is positional, exactly as on the command line
      if (params.text !== undefined) args.push(params.text);
      flag("--url", params.url);
      break;
    case "note-edit":
      if (params.noteId !== undefined) args.push(String(params.noteId));
      if (params.text !== undefined) args.push(params.text);
      flag("--url", params.url);
      break;
    case "note-remove":
      if (params.noteId !== undefined) args.push(String(params.noteId));
      break;
    default:
      break;
  }

  return args;
}

/**
 * A compact one-line summary for the tool-call header — the argument echo under
 * the bold `ukb` in the coloured shell, e.g. `add "Wire retry"`, `claim #3`,
 * `move #3 doing`, `block #4 --by #3`.
 */
function summarizeCall(params: UkbParams): string {
  const parts: string[] = [params.action];

  if (BATCH_ACTIONS.has(params.action)) {
    // `done #1 #2 #3` reads as one command; `#1,#2,#3` reads as a set of
    // arguments and hides that the CLI takes them positionally.
    parts.push(...cardIds(params).map((id) => `#${id}`));
  } else if (ID_ACTIONS.has(params.action) && params.id !== undefined) {
    parts.push(`#${params.id}`);
  }
  if (params.action === "add" && params.title !== undefined) {
    parts.push(quote(params.title));
  }
  // Only when it is not the default, matching how the CLI renders it — the
  // header stays quiet in the common case.
  if (
    (params.action === "add" || params.action === "edit") &&
    params.priority !== undefined &&
    params.priority !== "normal"
  ) {
    parts.push(`--priority ${params.priority}`);
  }
  if (params.action === "move" && params.column !== undefined) {
    parts.push(params.column);
  }
  if (
    (params.action === "block" || params.action === "unblock") &&
    params.blockedBy !== undefined
  ) {
    parts.push(`--by #${params.blockedBy}`);
  }
  if (params.action === "parent" && params.parent !== undefined) {
    parts.push(`--of #${params.parent}`);
  }
  if (params.action === "add" && params.blockedBy !== undefined) {
    parts.push(`--blocked-by #${params.blockedBy}`);
  }
  if (
    (params.action === "relate" || params.action === "unrelate") &&
    params.other !== undefined
  ) {
    parts.push(`--with #${params.other}`);
  }
  if (params.action === "relate" && params.direction !== undefined) {
    parts.push(`--as ${params.direction}`);
  }
  if (
    (params.action === "note-edit" || params.action === "note-remove") &&
    params.noteId !== undefined
  ) {
    parts.push(`#${params.noteId}`);
  }
  if (params.action === "note" && params.text !== undefined) {
    parts.push(quote(params.text));
  }
  if (
    (params.action === "note" || params.action === "note-edit") &&
    params.url !== undefined
  ) {
    parts.push(`--url ${params.url}`);
  }
  if (params.body !== undefined) parts.push("--body …");
  if (params.assignee !== undefined)
    parts.push(`--assignee ${params.assignee}`);
  if (params.reviewer !== undefined)
    parts.push(`--reviewer ${params.reviewer}`);
  if (params.project !== undefined) parts.push(`--project ${params.project}`);

  return parts.join(" ");
}

/** Split a slash-command string into argv tokens, honouring quotes. */
function splitTokens(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  for (const match of input.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

/** Cap rendered output so a big board cannot flood the transcript. */
function truncateOutput(
  text: string,
  maxLines = 24,
): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}

/** Pull the text out of a tool result's content blocks. */
function extractText(
  content: readonly { type: string; text?: unknown }[],
): string {
  const lines: string[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      lines.push(part.text);
    }
  }
  return lines.join("\n");
}

function quote(value: string): string {
  return /[\s"']/.test(value) ? JSON.stringify(value) : value;
}

/* -------------------------------- extension ------------------------------ */

/**
 * `~/.config/ukb/config.json`, read once at extension load. Changing it needs
 * `/reload`: the guidance is copied into the tool definition at registration,
 * and the overlay's key is bound at registration too.
 */
const CONFIG = loadConfig();

/**
 * The one word that names the panel rather than a card: `/ukb gui …`.
 *
 * `gui` and not `overlay` because it is three characters against seven, and
 * this is a command typed by hand. There is no second spelling — an alias that
 * exists to be retired is just two names for one thing, and the reader has to
 * learn which one is current.
 *
 * The namespace cannot simply be dropped: `/ukb` alone is "my open cards" and
 * `/ukb show <id>` is card detail, so a bare `/ukb show` would be ambiguous.
 */
const GUI_NAMESPACE = "gui";

function isGuiNamespace(token: string | undefined): boolean {
  return token?.toLowerCase() === GUI_NAMESPACE;
}

/** Who this front door acts as on the board (UKB_AGENT > config > "pi"). */
const AGENT = process.env.UKB_AGENT?.trim() || CONFIG.agent || "pi";
const IDENTITY = ["--agent", AGENT, "--agent-type", "agent"] as const;

const TOOL_NAME = "ukb";

/** Prompt copy resolved once — see guidance.ts for why it is its own module. */
const GUIDANCE = resolveGuidance(CONFIG);

const DESCRIPTION = [
  "Your shared kanban board — the todo list you and the human both see.",
  "Start each turn with `mine`: your open cards, a call to act rather than a status report.",
  "`list` names every project on the board with its counts; `board --project <slug>` narrows any",
  "read to one project.",
  "For each card: `show` it to read the body (target files + acceptance criteria), `claim` any",
  "todo card BEFORE starting work on it, do the work, then `review` (or `done` if you are the",
  "reviewer). Never work an unclaimed card; if `claim` fails with claim_conflict someone else got",
  "there first — pick another card.",
  "`relate`/`unrelate` wire cards together as upstream/downstream (a card with unfinished upstream",
  "work cannot be claimed), and `note` attaches a remark with a document link — the design doc for",
  "the requirement, say. Prefer it over an in-memory list for anything that spans sessions or",
  "needs handing off.",
].join(" ");

export default function usingKanbanExtension(pi: ExtensionAPI): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // <repo>/packages/pi/extensions/using-kanban -> <repo>/packages/cli/dist/bin.js
  // (three levels up: the extension dir, extensions/, then pi/).
  const bin = resolve(here, "../../../cli/dist/bin.js");
  const ready = existsSync(bin);

  // Said once at load rather than per call: an unbuilt CLI is a setup problem,
  // and the overlay now surfaces the same fact through `notify` when it is the
  // reason the panel is missing.
  if (!ready) {
    process.stderr.write(
      `[using-kanban] ukb CLI not built at ${bin} — run \`pnpm -r build\` in the using-kanban repo.\n`,
    );
  }

  /** Run the CLI and return its exit code plus combined output. */
  const run = async (
    argv: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<{ code: number; output: string }> => {
    const result = await pi.exec(
      process.execPath,
      [bin, ...argv],
      signal === undefined ? undefined : { signal },
    );
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    return { code: result.code, output: output || "(no output)" };
  };

  /* -------------------------------- panel --------------------------------- */

  // The board, above the editor. Read through the CLI's own `--json` door so
  // storage resolution stays in one place, and refreshed on triggers — session
  // start, the end of a `ukb` call, the start of each turn — never polled.
  const overlayEnabled = !isOverlayDisabled(process.env, CONFIG);
  const configuredProject = resolveOverlayProject(process.env, CONFIG);
  const overlayDisplay = resolveOverlayDisplay(process.env, CONFIG);
  let overlayView: OverlayView = {
    scope: resolveOverlayScope(process.env, CONFIG),
    project: configuredProject,
    agent: AGENT,
    groupBy: resolveOverlayGroup(process.env, CONFIG),
    maxLines: resolveMaxLines(process.env, CONFIG),
    states: resolveOverlayStates(process.env, CONFIG),
  };

  /** Current project = current Git root basename, falling back to cwd basename. */
  const inferCurrentProject = async (cwd: string): Promise<string | null> => {
    let root = cwd;
    try {
      const result = await pi.exec(
        "git",
        ["-C", cwd, "rev-parse", "--show-toplevel"],
        { timeout: 1500 },
      );
      if (result.code === 0 && result.stdout.trim())
        root = result.stdout.trim();
    } catch {
      // A non-Git cwd still has a useful basename.
    }
    return normalizeOverlayProject(basename(root));
  };

  /**
   * One-shot latch so a repeating refresh failure does not flood stderr. Cleared
   * by the next successful refresh.
   */
  let overlayRefreshFailed = false;

  const overlay = new BoardOverlay(
    async () => {
      if (!ready) {
        return {
          stdout: null,
          error: `ukb CLI not built at ${bin} — run \`pnpm -r build\` in the using-kanban repo`,
        };
      }
      try {
        const result = await pi.exec(process.execPath, [
          bin,
          "board",
          "--json",
          "--brief",
        ]);
        if (result.code !== 0) {
          const detail = result.stderr.trim().slice(0, 300);
          return {
            stdout: null,
            error: `ukb board --json --brief exited ${result.code}${detail ? `: ${detail}` : " (no stderr)"}`,
          };
        }
        return { stdout: result.stdout, error: null };
      } catch (error) {
        return {
          stdout: null,
          error: `could not run the CLI — ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    {
      collapseKey: resolveCollapseKey(process.env, CONFIG),
      view: overlayView,
      initiallyVisible: overlayDisplay === "always",
    },
  );

  /**
   * Repaint the overlay. A refresh must never take the session down — the
   * widget is a side view — but it must not fail silently either: the whole
   * point of the diagnostics work was that a stale panel and a missing panel
   * look identical from the outside.
   */
  const refreshOverlay = async (): Promise<void> => {
    if (!overlayEnabled) return;
    try {
      await overlay.refresh();
      overlayRefreshFailed = false;
    } catch (error) {
      if (!overlayRefreshFailed) {
        overlayRefreshFailed = true;
        try {
          process.stderr.write(
            `[using-kanban] overlay refresh failed — ${error instanceof Error ? error.message : String(error)}\n`,
          );
        } catch {
          // stderr is best-effort too.
        }
      }
    }
  };

  if (overlayEnabled) {
    pi.on("session_start", async (_event, ctx) => {
      // RPC can expose dialogs/notifications (`hasUI`) but not terminal
      // components. Widgets are a TUI-only surface.
      if (ctx.mode !== "tui") return;
      overlay.setUICtx(ctx.ui);
      if (overlayView.scope === "current-project") {
        overlayView = {
          ...overlayView,
          project: configuredProject ?? (await inferCurrentProject(ctx.cwd)),
        };
        overlay.setView(overlayView);
      }
      if (overlayDisplay === "always") await refreshOverlay();
    });
    pi.on("tool_execution_end", async (event) => {
      if (event.toolName !== TOOL_NAME || !overlay.status().visible) return;
      await refreshOverlay();
    });
    pi.on("turn_start", async () => {
      if (overlay.status().visible) await refreshOverlay();
    });
    pi.on("session_shutdown", async () => {
      // Teardown touches a possibly-stale UI ctx (disposal can race a session
      // replacement); a failed unhook must not reject the shutdown handler.
      try {
        overlay.dispose();
      } catch {
        // Nothing to do — the widget goes away with the session anyway.
      }
    });

    const collapseKey = resolveCollapseKey(process.env, CONFIG);
    if (collapseKey !== COLLAPSE_KEY_OFF) {
      try {
        pi.registerShortcut(collapseKey as KeyId, {
          description: "Collapse or expand the visible ukb board overlay",
          handler: (ctx) => {
            if (ctx.mode === "tui" && overlay.status().visible) {
              overlay.toggleCollapse();
            }
          },
        });
      } catch {
        // A key the host refuses must not take the extension down.
      }
    }
  }

  const overlayHelp = [
    "ukb gui — the on-demand board panel",
    "/ukb gui [show] [scope=…] [group=…] [states=…] [project=…] [lines=<n>]",
    "/ukb gui more | less              # grow / shrink the row budget",
    "/ukb gui hide",
    "/ukb gui collapse | expand        # one line / full height",
    "/ukb gui help",
    "scope: current-project | mine | all | project:<slug>",
    "group: state | project | owner | none",
    "states: doing, todo, review, someday, done (default: all but done)",
    "rows: doing, then todo, then review, then someday",
    "default: current Git project, grouped by state",
    "persistent settings: ~/.config/ukb/config.json → overlay",
  ].join("\n");

  const handleOverlayCommand = async (
    input: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    const command = parseOverlayCommand(input, overlayView);
    if (command.error) {
      ctx.ui.notify(command.error, "warning");
      return;
    }
    if (command.action === "help") {
      ctx.ui.notify(overlayHelp, "info");
      return;
    }
    if (!overlayEnabled) {
      ctx.ui.notify(
        "ukb gui is disabled by UKB_OVERLAY or config.overlay.enabled",
        "warning",
      );
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.notify("ukb gui requires Pi's interactive TUI", "warning");
      return;
    }

    // Bind the command's current context explicitly. This both diagnoses and
    // repairs a missed/stale session_start binding after reload.
    overlay.setUICtx(ctx.ui);
    overlayView = command.view;
    if (
      overlayView.scope === "current-project" &&
      overlayView.project === null
    ) {
      overlayView = {
        ...overlayView,
        project: configuredProject ?? (await inferCurrentProject(ctx.cwd)),
      };
    }
    // `more` / `less` step the budget, so the reader who sees "+15 more" can
    // get the rest of their board without naming a number or editing config.
    if (command.action === "more" || command.action === "less") {
      const step =
        command.action === "more" ? OVERLAY_LINES_STEP : -OVERLAY_LINES_STEP;
      overlayView = {
        ...overlayView,
        maxLines: Math.max(MIN_MAX_LINES, overlayView.maxLines + step),
      };
    }
    overlay.setView(overlayView);
    if (command.action === "hide") {
      overlay.hide();
    } else {
      overlay.show();
      await refreshOverlay();
      if (command.action === "collapse") overlay.collapse();
      if (command.action === "expand") overlay.expand();
    }

    const status = overlay.status();
    const counts = status.counts;
    const board = counts
      ? `${counts.doing} doing · ${counts.todo} todo · ${counts.review} review · ${counts.someday} someday · ${counts.done} done`
      : "board unreadable";
    const state = !status.visible
      ? "hidden"
      : status.registered
        ? status.collapsed
          ? "registered, collapsed"
          : "registered, expanded"
        : "not registered";
    const detail = status.error ? ` — ${status.error}` : "";
    ctx.ui.notify(
      `ukb gui: ${state}; scope=${status.scopeLabel || status.scope}; group=${status.groupBy}; lines=${status.maxLines}; ui=${status.uiBound ? "bound" : "missing"}; ${board}${detail}`,
      status.error ? "warning" : "info",
    );
  };

  pi.registerTool({
    name: TOOL_NAME,
    label: "Kanban board",
    description: DESCRIPTION,
    promptSnippet: GUIDANCE.promptSnippet,
    promptGuidelines: [...GUIDANCE.promptGuidelines],
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      id: Type.Optional(Type.Integer({ minimum: 1, description: "Card id" })),
      title: Type.Optional(
        Type.String({ description: "Card title for add/edit" }),
      ),
      body: Type.Optional(
        Type.String({
          description: "Target files, acceptance criteria, context",
        }),
      ),
      column: Type.Optional(StringEnum(COLUMNS)),
      assignee: Type.Optional(
        Type.String({ description: "Actor name to assign" }),
      ),
      reviewer: Type.Optional(
        Type.String({ description: "Actor name expected to review" }),
      ),
      blockedBy: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Card id this card waits on (add / block / unblock)",
        }),
      ),
      project: Type.Optional(
        Type.String({ description: "Project slug (e.g. web, api-core)" }),
      ),
      priority: Type.Optional(
        StringEnum(PRIORITIES, {
          description:
            "How urgently the card wants attention. normal is the default; low is minor but still wanted. Lower priorities sort after higher ones. To park a card for later, move it to the `someday` column instead — that is a state, not a priority.",
        }),
      ),
      other: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Card on the other end of a relation (relate/unrelate)",
        }),
      ),
      parent: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "Umbrella card id for `parent` — the card this one is a part of. One level only.",
        }),
      ),
      ids: Type.Optional(
        Type.Array(Type.Integer({ minimum: 1 }), {
          description:
            "Several card ids for one action — done/review/reopen/delete. Use this to clear a queue in one call; it stops at the first card the board refuses, so what it printed before that is what was applied.",
        }),
      ),
      direction: Type.Optional(
        StringEnum(DIRECTIONS, {
          description:
            "Which side `other` sits on relative to this card: upstream = a predecessor this card waits on, downstream = a successor waiting on it",
        }),
      ),
      noteId: Type.Optional(
        Type.Integer({ minimum: 1, description: "Note id (note-edit/remove)" }),
      ),
      text: Type.Optional(
        Type.String({ description: "A note's remark (note / note-edit)" }),
      ),
      url: Type.Optional(
        Type.String({
          description:
            "A note's document link — https://… or a path to a local file the Web UI renders",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      if (!ready) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `ukb CLI not built at ${bin} — run \`pnpm -r build\`.`,
            },
          ],
        };
      }
      const typed = params as UkbParams;
      const { code, output } = await run(
        [...IDENTITY, ...buildArgs(typed)],
        signal,
      );
      return {
        isError: code !== 0,
        content: [{ type: "text", text: output }],
        details: { action: typed.action, code },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ukb"))} ${theme.fg("accent", summarizeCall(args as UkbParams))}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const { text, truncated } = truncateOutput(extractText(result.content));
      const suffix = truncated ? theme.fg("muted", "\n… (truncated)") : "";
      return new Text(theme.fg("toolOutput", text) + suffix, 0, 0);
    },
  });

  pi.registerCommand(TOOL_NAME, {
    description:
      "using-kanban board — no args: open cards; gui help: panel commands",
    handler: async (input, ctx) => {
      const tokens = splitTokens(input.trim());
      if (isGuiNamespace(tokens[0])) {
        await handleOverlayCommand(tokens.slice(1).join(" "), ctx);
        return;
      }
      if (!ready) {
        ctx.ui.notify(`ukb CLI not built at ${bin}`, "error");
        return;
      }
      const argv = tokens.length > 0 ? tokens : ["mine"];
      try {
        const { code, output } = await run([...IDENTITY, ...argv], ctx.signal);
        ctx.ui.notify(output, code === 0 ? "info" : "error");
        // A slash command is a human driving the board directly, which bypasses
        // the `ukb` tool — so `tool_execution_end` never fires for it. Without
        // this the panel kept showing the pre-`done` board until the next agent
        // turn, which reads exactly like a broken panel.
        if (shouldRefreshAfterCommand(argv, code)) {
          await refreshOverlay();
        }
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });
}
