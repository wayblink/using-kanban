/**
 * The one config file: `~/.config/ukb/config.json`.
 *
 * Four front doors read it — the CLI, the MCP server, the HTTP server behind
 * the Web UI, and the Pi extension — so it lives in its own zero-dependency
 * package rather than inside any of them. (Not in core: core pulls in
 * better-sqlite3, and the Pi extension must not be dragged into a native
 * dependency just to learn its owner's name.)
 *
 * Three kinds of thing live here:
 *
 * - `owner`: the human operating this machine. One person, one name, whatever
 *   front door is asking. Defaults to the machine's own name.
 * - `agent`: the name an agent front door acts as, when it was not told
 *   otherwise. `UKB_AGENT` still wins.
 * - `guidance` / `overlay`: the Pi tool's prompt copy and its panel.
 *
 * The file is optional and nothing here ever writes it. A missing file means
 * every default applies; a malformed file warns once and is treated as `{}`,
 * because a typo in a side panel's config must not take a session down.
 */

import { readFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { isAbsolute, join } from "node:path";

export const CONFIG_DIR_NAME = "ukb";
export const CONFIG_FILE_NAME = "config.json";

export interface UkbGuidanceConfig {
  /** Replaces the tool's one-line prompt snippet. */
  readonly promptSnippet?: string;
  /** Replaces the whole guideline list (all-or-nothing, never merged). */
  readonly promptGuidelines?: readonly string[];
}

export const OVERLAY_SCOPES = ["current-project", "mine", "all"] as const;
export type OverlayScope = (typeof OVERLAY_SCOPES)[number];

export const OVERLAY_GROUPS = ["state", "project", "owner", "none"] as const;
export type OverlayGroup = (typeof OVERLAY_GROUPS)[number];

export const OVERLAY_DISPLAYS = ["on-demand", "always"] as const;
export type OverlayDisplay = (typeof OVERLAY_DISPLAYS)[number];

/**
 * The states the panel can show. Mirrors core's `CARD_STATES`; this module has
 * no dependency on core on purpose (see the note at the top of overlay-render).
 */
export const OVERLAY_STATES = [
  "someday",
  "todo",
  "doing",
  "review",
  "done",
] as const;
export type OverlayState = (typeof OVERLAY_STATES)[number];

/**
 * Which states the panel shows by default.
 *
 * The flow, and only the flow: `done` is out because history is not what the
 * panel is for, and `someday` is out because a shelf of parked work competes
 * with live work for the same few rows. The shelf is not gone — the renderer
 * adds it back whenever the flow is quiet (`SOMEDAY_VISIBLE_BELOW` in
 * `overlay-render.ts`), and naming it in `overlay.states` keeps it always.
 */
export const DEFAULT_OVERLAY_STATES: readonly OverlayState[] = [
  "doing",
  "todo",
  "review",
];

/**
 * The second pane: a shelf beside the flow.
 *
 * Off by default — a panel that splits itself takes width from the thing the
 * reader was looking at. When it is on, `states` defaults to `someday`, and an
 * unset `scope` follows the left pane rather than picking one of its own: a
 * panel scoped to this repository should not quietly show another project's
 * shelf.
 */
export interface OverlaySplitConfig {
  readonly enabled?: boolean;
  /** Pane scope; omitted means "the same scope as the left pane". */
  readonly scope?: OverlayScope;
  readonly project?: string;
  /** Which states the pane shows. Defaults to `["someday"]`. */
  readonly states?: readonly OverlayState[];
  /** Omitted means the left pane's grouping. */
  readonly groupBy?: OverlayGroup;
}

export interface UkbOverlayConfig {
  /** false hides the widget entirely. */
  readonly enabled?: boolean;
  /** Content-row budget, heading included. */
  readonly maxLines?: number;
  /** Collapse/expand key spec, or the `off` sentinel. */
  readonly collapseKey?: string;
  /** Which cards enter the overlay. Defaults to the current Git project. */
  readonly scope?: OverlayScope;
  /** Explicit project slug; otherwise current-project is inferred from cwd. */
  readonly project?: string;
  /** How visible rows are ordered and labelled. */
  readonly groupBy?: OverlayGroup;
  /** On-demand by default; `always` restores a persistent widget. */
  readonly display?: OverlayDisplay;
  /**
   * Which states the panel shows — each one gets a heading count and, if it has
   * cards, rows. Defaults to `DEFAULT_OVERLAY_STATES` (the flow), where the
   * `someday` shelf joins automatically while the flow holds fewer than five
   * cards. Naming `someday` here keeps the shelf on regardless of how busy the
   * board is; naming `done` adds history.
   */
  readonly states?: readonly OverlayState[];
  /** The optional second pane. Absent means one pane, as before. */
  readonly split?: OverlaySplitConfig;
}

export interface UkbConfig {
  /**
   * The human operating this machine — one name for every front door.
   *
   * It is the default actor of the CLI and the Web UI, and the escape hatch for
   * permissions: the owner may edit or delete any card, which is what keeps a
   * solo board usable while agents claim work under their own names. Unset
   * means the machine's name (`machineName`).
   */
  readonly owner?: string;
  /** Default actor name for an agent front door; `UKB_AGENT` still wins. */
  readonly agent?: string;
  readonly guidance?: UkbGuidanceConfig;
  readonly overlay?: UkbOverlayConfig;
  /**
   * The board server this machine talks to, e.g. `https://board.example.com`.
   * When set, the CLI and MCP server use it instead of the local store. A per
   * machine credential lives in `credentials.json` beside this file.
   */
  readonly server?: string;
}

/* ------------------------------ file location ------------------------------ */

/** Expand a leading `~` / `~/`. A `~user` form is left alone, like the shell. */
function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

/**
 * Where the config file lives:
 *
 * 1. `$XDG_CONFIG_HOME/ukb/config.json` when that variable holds an absolute
 *    path (a leading `~` is expanded first, so `~/cfg` counts).
 * 2. `~/.config/ukb/config.json` otherwise — including when `XDG_CONFIG_HOME`
 *    is unset, empty, whitespace, or relative.
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || homedir();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg !== undefined && xdg !== "") {
    const expanded = expandHome(xdg, home);
    if (isAbsolute(expanded)) {
      return join(expanded, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
    }
  }
  return join(home, ".config", CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/* --------------------------------- reading -------------------------------- */

let warned = false;

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  process.stderr.write(`[using-kanban] ${message}\n`);
}

/** Test seam — the warning is once per process, tests need it once per case. */
export function __resetConfigWarning(): void {
  warned = false;
}

function readConfigDocument(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const path = resolveConfigPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Missing file (or unreadable): every default applies, silently.
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnOnce(`invalid JSON at ${path} — using defaults`);
    return {};
  }

  // An array or a scalar is not a config document. Treated as empty rather
  // than warned about: `null` and `[]` are what a half-written file looks like.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * `guidance` is validated all-or-nothing per field: a `promptGuidelines` array
 * with a single empty string falls back to the built-in list wholesale rather
 * than merging item by item. Partial merges produce a silently truncated rule
 * set, which is harder to notice than a clean fallback.
 */
export function validateGuidanceFields(
  value: unknown,
): UkbGuidanceConfig | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const guidance: {
    promptSnippet?: string;
    promptGuidelines?: readonly string[];
  } = {};

  const snippet = nonEmptyString(record.promptSnippet);
  if (snippet !== undefined) guidance.promptSnippet = snippet;

  const guidelines = record.promptGuidelines;
  if (Array.isArray(guidelines) && guidelines.length > 0) {
    const items = guidelines.map(nonEmptyString);
    if (items.every((item): item is string => item !== undefined)) {
      guidance.promptGuidelines = items;
    }
  }

  return Object.keys(guidance).length > 0 ? guidance : undefined;
}

function validateStates(
  value: unknown,
  fallback: readonly OverlayState[] | undefined,
): readonly OverlayState[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return fallback;
  const states = value.filter(
    (state): state is OverlayState =>
      typeof state === "string" &&
      (OVERLAY_STATES as readonly string[]).includes(state),
  );
  // All-or-nothing: one unknown entry falls back to the whole default list
  // rather than silently dropping a state the user asked for.
  return states.length === value.length ? states : fallback;
}

function validateSplit(value: unknown): OverlaySplitConfig | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const split: {
    enabled?: boolean;
    scope?: OverlayScope;
    project?: string;
    states?: readonly OverlayState[];
    groupBy?: OverlayGroup;
  } = {};

  if (typeof record.enabled === "boolean") split.enabled = record.enabled;

  if (
    typeof record.scope === "string" &&
    OVERLAY_SCOPES.includes(record.scope as OverlayScope)
  ) {
    split.scope = record.scope as OverlayScope;
  }

  const project = nonEmptyString(record.project);
  if (project !== undefined) split.project = project;

  const states = validateStates(record.states, undefined);
  if (states !== undefined) split.states = states;

  if (
    typeof record.groupBy === "string" &&
    OVERLAY_GROUPS.includes(record.groupBy as OverlayGroup)
  ) {
    split.groupBy = record.groupBy as OverlayGroup;
  }

  return Object.keys(split).length > 0 ? split : undefined;
}

function validateOverlay(value: unknown): UkbOverlayConfig | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const overlay: {
    enabled?: boolean;
    maxLines?: number;
    collapseKey?: string;
    scope?: OverlayScope;
    project?: string;
    groupBy?: OverlayGroup;
    display?: OverlayDisplay;
    states?: readonly OverlayState[];
    split?: OverlaySplitConfig;
  } = {};

  if (typeof record.enabled === "boolean") overlay.enabled = record.enabled;

  // The floor lives in overlay-config; validate the type here only.
  if (typeof record.maxLines === "number" && Number.isFinite(record.maxLines)) {
    overlay.maxLines = record.maxLines;
  }

  const collapseKey = nonEmptyString(record.collapseKey);
  if (collapseKey !== undefined) overlay.collapseKey = collapseKey;

  if (
    typeof record.scope === "string" &&
    OVERLAY_SCOPES.includes(record.scope as OverlayScope)
  ) {
    overlay.scope = record.scope as OverlayScope;
  }

  const project = nonEmptyString(record.project);
  if (project !== undefined) overlay.project = project;

  if (
    typeof record.groupBy === "string" &&
    OVERLAY_GROUPS.includes(record.groupBy as OverlayGroup)
  ) {
    overlay.groupBy = record.groupBy as OverlayGroup;
  }

  if (
    typeof record.display === "string" &&
    OVERLAY_DISPLAYS.includes(record.display as OverlayDisplay)
  ) {
    overlay.display = record.display as OverlayDisplay;
  }

  const states = validateStates(record.states, undefined);
  if (states !== undefined) overlay.states = states;

  const split = validateSplit(record.split);
  if (split !== undefined) overlay.split = split;

  return Object.keys(overlay).length > 0 ? overlay : undefined;
}

/** Read and validate the config file. Never throws; a bad file yields `{}`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): UkbConfig {
  const document = readConfigDocument(env);

  const config: {
    owner?: string;
    agent?: string;
    guidance?: UkbGuidanceConfig;
    overlay?: UkbOverlayConfig;
    server?: string;
  } = {};

  const owner = nonEmptyString(document.owner);
  if (owner !== undefined) config.owner = owner;

  const agent = nonEmptyString(document.agent);
  if (agent !== undefined) config.agent = agent;

  const guidance = validateGuidanceFields(document.guidance);
  if (guidance !== undefined) config.guidance = guidance;

  const overlay = validateOverlay(document.overlay);
  if (overlay !== undefined) config.overlay = overlay;

  const server = nonEmptyString(document.server);
  if (server !== undefined) config.server = server;

  return config;
}

/* -------------------------------- identity -------------------------------- */

/**
 * This machine's name, which is the owner's default.
 *
 * The domain suffix goes: `JYXC-DZ-0101035deMacBook-Pro.local` is an mDNS
 * name, and nobody wants to read `.local` on every card. `UKB_MACHINE_NAME`
 * overrides it, which is the escape hatch for containers and CI, where the
 * hostname is a container id that means nothing to a reader.
 */
export function machineName(
  env: NodeJS.ProcessEnv = process.env,
  hostname: () => string = osHostname,
): string {
  const override = env.UKB_MACHINE_NAME?.trim();
  if (override !== undefined && override !== "") return override;
  const raw = hostname().trim();
  const short = raw.split(".")[0]?.trim() ?? "";
  return short === "" ? "someone" : short;
}

export interface OwnerSources {
  /** A front door's own flag (`--actor`, or `--agent` when it is the human's). */
  readonly flag?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly config?: UkbConfig | undefined;
  /** Test seam for the machine's name. */
  readonly hostname?: (() => string) | undefined;
}

/**
 * Who the human on this machine is: flag → `UKB_OWNER` → `owner` in the file →
 * the machine's name.
 *
 * Kept in one function so the CLI, the Web UI and the MCP server cannot drift
 * into three different answers to "who am I", which is how a solo board ends up
 * with one person under three names.
 */
export function resolveOwnerName(sources: OwnerSources = {}): string {
  const env = sources.env ?? process.env;
  const flag = nonEmptyString(sources.flag);
  if (flag !== undefined) return flag;
  const fromEnv = nonEmptyString(env.UKB_OWNER);
  if (fromEnv !== undefined) return fromEnv;
  const fromFile = nonEmptyString(sources.config?.owner);
  if (fromFile !== undefined) return fromFile;
  return machineName(env, sources.hostname);
}

export * from "./credentials.js";
