/**
 * config.ts — `~/.config/ukb/config.json`, the policy surface for the Pi tool.
 *
 * Two things live here that a user needs to tune without editing a published
 * extension: the prompt copy the model is given about the board (`guidance`),
 * and the overlay's visibility, scope, grouping, size and key. Environment
 * variables remain as a process-level escape hatch, with the file as the real
 * home.
 *
 * The file is optional and this module never writes it. A missing file means
 * every default applies. A malformed file warns once and is treated as `{}`
 * rather than taking the extension down — the board is a side view, and a typo
 * in a config file must not cost a session.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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
 * The shelf is in — a parked card you cannot see is a parked card you forget —
 * and `done` is out, because history is not what the panel is for. Add `done`
 * back (or drop anything else) with `overlay.states`.
 */
export const DEFAULT_OVERLAY_STATES: readonly OverlayState[] = [
  "doing",
  "todo",
  "review",
  "someday",
];

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
   * cards, rows. Defaults to `DEFAULT_OVERLAY_STATES` (someday in, done out).
   */
  readonly states?: readonly OverlayState[];
}

export interface UkbConfig {
  readonly guidance?: UkbGuidanceConfig;
  /** Default actor name for this front door; `UKB_AGENT` still wins. */
  readonly agent?: string;
  readonly overlay?: UkbOverlayConfig;
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

  // All-or-nothing, like `guidance`: one unknown entry falls back to the whole
  // default list rather than silently dropping a state the user asked for.
  if (Array.isArray(record.states) && record.states.length > 0) {
    const states = record.states.filter(
      (state): state is OverlayState =>
        typeof state === "string" &&
        (OVERLAY_STATES as readonly string[]).includes(state),
    );
    if (states.length === record.states.length) overlay.states = states;
  }

  return Object.keys(overlay).length > 0 ? overlay : undefined;
}

/** Read and validate the config file. Never throws; a bad file yields `{}`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): UkbConfig {
  const document = readConfigDocument(env);

  const config: {
    guidance?: UkbGuidanceConfig;
    agent?: string;
    overlay?: UkbOverlayConfig;
  } = {};

  const guidance = validateGuidanceFields(document.guidance);
  if (guidance !== undefined) config.guidance = guidance;

  const agent = nonEmptyString(document.agent);
  if (agent !== undefined) config.agent = agent;

  const overlay = validateOverlay(document.overlay);
  if (overlay !== undefined) config.overlay = overlay;

  return config;
}
