/**
 * args.js — structured tool params → `ukb` CLI argv.
 *
 * Ported from `packages/pi/extensions/using-kanban/index.ts` (the argument model
 * only). Pure and host-free so it is unit-testable without a DSH runtime.
 *
 * Validation is left to the CLI on purpose: a missing id or title surfaces as
 * the CLI's own error message, which is what the user should read. Identity
 * flags (`--agent`, `--agent-type`) are added by the caller.
 */

export const ACTIONS = [
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
];

export const COLUMNS = ["someday", "todo", "doing", "review", "done"];

/** Mirrors core's CARD_PRIORITIES, in sort order. */
export const PRIORITIES = ["high", "normal", "low"];

/**
 * Verbs whose card ids are all positionals, so several can be given at once.
 *
 * `claim` is in this set only so the CLI receives every id and can refuse with
 * the message that explains the one-card-in-`doing` rule. Silently dropping the
 * extra ids would turn a contradiction into a half-executed command.
 */
const BATCH_ACTIONS = new Set(["review", "done", "reopen", "delete", "claim"]);

/** Which side of a relation the other card sits on. */
export const DIRECTIONS = ["upstream", "downstream"];

/** Actions whose first positional is a card id. */
const ID_ACTIONS = new Set([
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

/**
 * @typedef {object} UkbParams
 * @property {string} action
 * @property {number} [id]
 * @property {number[]} [ids]
 * @property {string} [priority]
 * @property {string} [title]
 * @property {string} [body]
 * @property {string} [column]
 * @property {string} [assignee]
 * @property {string} [reviewer]
 * @property {number} [blockedBy]
 * @property {string} [project]
 * @property {number} [other]
 * @property {number} [parent]
 * @property {string} [direction]
 * @property {number} [noteId]
 * @property {string} [text]
 * @property {string} [url]
 * @property {boolean} [json]
 * @property {boolean} [brief]
 */

/**
 * `ids` when several were given, else the single `id`, else nothing.
 * @param {UkbParams} params
 * @returns {number[]}
 */
export function cardIds(params) {
  if (params.ids !== undefined) return params.ids;
  return params.id === undefined ? [] : [params.id];
}

/**
 * Map structured params to CLI argv, e.g. `{ action: "claim", id: 3 }` →
 * `["claim", "3"]`.
 * @param {UkbParams} params
 * @returns {string[]}
 */
export function buildArgs(params) {
  /** @type {string[]} */
  const args = [params.action];
  /** @param {string} name @param {string | number | undefined} value */
  const flag = (name, value) => {
    if (value !== undefined) args.push(name, String(value));
  };

  if (BATCH_ACTIONS.has(params.action)) {
    for (const id of cardIds(params)) args.push(String(id));
  } else if (ID_ACTIONS.has(params.action) && params.id !== undefined) {
    args.push(String(params.id));
  }

  switch (params.action) {
    case "mine":
    case "board":
      flag("--project", params.project);
      if (params.json === true) args.push("--json");
      if (params.brief === true) args.push("--brief");
      break;
    case "list":
      if (params.json === true) args.push("--json");
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
 * A compact one-line summary for the tool-call header.
 * @param {UkbParams} params
 * @returns {string}
 */
export function summarizeCall(params) {
  /** @type {string[]} */
  const parts = [params.action];
  if (BATCH_ACTIONS.has(params.action)) {
    parts.push(...cardIds(params).map((id) => `#${id}`));
  } else if (ID_ACTIONS.has(params.action) && params.id !== undefined) {
    parts.push(`#${params.id}`);
  }
  if (params.action === "add" && params.title !== undefined) {
    parts.push(
      /[\s"']/.test(params.title) ? JSON.stringify(params.title) : params.title,
    );
  }
  if (params.action === "move" && params.column !== undefined)
    parts.push(params.column);
  if (params.blockedBy !== undefined) parts.push(`--by #${params.blockedBy}`);
  if (params.project !== undefined) parts.push(`--project ${params.project}`);
  return parts.join(" ");
}

/**
 * Split a slash-command string into argv tokens, honouring quotes.
 * @param {string} input
 * @returns {string[]}
 */
export function splitTokens(input) {
  /** @type {string[]} */
  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  for (const match of input.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}
