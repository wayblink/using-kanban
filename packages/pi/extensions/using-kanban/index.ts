import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
  "relate",
  "unrelate",
  "note",
  "note-edit",
  "note-remove",
] as const;

const COLUMNS = ["todo", "doing", "review", "done"] as const;

/** Which side of a relation the other card sits on. */
const DIRECTIONS = ["upstream", "downstream"] as const;

type Action = (typeof ACTIONS)[number];
type Column = (typeof COLUMNS)[number];
type Direction = (typeof DIRECTIONS)[number];

interface UkbParams {
  action: Action;
  id?: number | undefined;
  title?: string | undefined;
  body?: string | undefined;
  column?: Column | undefined;
  assignee?: string | undefined;
  reviewer?: string | undefined;
  blockedBy?: number | undefined;
  project?: string | undefined;
  /** The card on the other end of a relation. */
  other?: number | undefined;
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
  "relate",
  "unrelate",
  "note",
  "note-edit",
  "note-remove",
]);

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

  if (ID_ACTIONS.has(params.action) && params.id !== undefined) {
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
      flag("--blocked-by", params.blockedBy);
      break;
    case "edit":
      flag("--title", params.title);
      flag("--body", params.body);
      flag("--assignee", params.assignee);
      flag("--reviewer", params.reviewer);
      flag("--project", params.project);
      break;
    case "move":
      if (params.column !== undefined) args.push(params.column);
      break;
    case "block":
    case "unblock":
      flag("--by", params.blockedBy);
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

  if (ID_ACTIONS.has(params.action) && params.id !== undefined) {
    parts.push(`#${params.id}`);
  }
  if (params.action === "add" && params.title !== undefined) {
    parts.push(quote(params.title));
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

/** Who this front door acts as on the board (overridable via UKB_AGENT). */
const AGENT = process.env.UKB_AGENT ?? "pi";
const IDENTITY = ["--agent", AGENT, "--agent-type", "agent"] as const;

const DESCRIPTION = [
  "Your shared kanban board — the todo list you and the human both see.",
  "Start each turn with `mine`: your open cards, a call to act rather than a status report.",
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

  if (!ready) {
    // Never throw during startup — that would take the whole agent down. The
    // tool reports the missing binary when it is called instead.
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

  pi.registerTool({
    name: "ukb",
    label: "Kanban board",
    description: DESCRIPTION,
    promptSnippet:
      "Shared kanban board: see your cards, claim work before starting it, hand it off for review.",
    promptGuidelines: [
      "Use the ukb board as your todo list for anything another agent or a human may need to see.",
      "Claim a card before working it and move it to review when ready; read a card's body before acting on it.",
      "Link a card to what it depends on with relate, and put its design doc on it as a note.",
    ],
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
      other: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Card on the other end of a relation (relate/unrelate)",
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

  pi.registerCommand("ukb", {
    description:
      "using-kanban board — run without arguments to see your open cards",
    handler: async (input, ctx) => {
      if (!ready) {
        ctx.ui.notify(`ukb CLI not built at ${bin}`, "error");
        return;
      }
      const tokens = splitTokens(input.trim());
      const argv = tokens.length > 0 ? tokens : ["mine"];
      try {
        const { code, output } = await run([...IDENTITY, ...argv], ctx.signal);
        ctx.ui.notify(output, code === 0 ? "info" : "error");
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });
}
