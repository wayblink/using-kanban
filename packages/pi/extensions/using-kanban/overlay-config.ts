/**
 * overlay-config.ts — the overlay's settings, resolved from the environment
 * and `~/.config/ukb/config.json`.
 *
 * Precedence is **env > config > default**, and an invalid value at a level is
 * treated as *unset* so the next level can still win. Environment wins because
 * it is the process-level escape hatch (`UKB_OVERLAY=off pi …` in a script has
 * to beat a file); the file wins over the default because that is the surface a
 * user actually edits.
 */

import {
  DEFAULT_OVERLAY_STATES,
  OVERLAY_DISPLAYS,
  OVERLAY_GROUPS,
  OVERLAY_SCOPES,
  OVERLAY_STATES,
  type OverlayDisplay,
  type OverlayGroup,
  type OverlayScope,
  type OverlayState,
  type UkbConfig,
} from "./config.js";

export const DEFAULT_MAX_LINES = 12;
export const MIN_MAX_LINES = 3;
export const DEFAULT_COLLAPSE_KEY = "ctrl+shift+k";
export const DEFAULT_OVERLAY_SCOPE: OverlayScope = "current-project";
export const DEFAULT_OVERLAY_GROUP: OverlayGroup = "state";
export const DEFAULT_OVERLAY_DISPLAY: OverlayDisplay = "on-demand";
/** Sentinel for `collapseKey` (config or env) that binds no shortcut at all. */
export const COLLAPSE_KEY_OFF = "off";

/**
 * Whether the overlay is switched off.
 *
 * `UKB_OVERLAY=off` disables it, `UKB_OVERLAY=on` enables it — the escape hatch
 * for a headless or non-interactive setup, or to override the file for one run.
 * Anything else (including an unset variable) defers to `overlay.enabled`.
 */
export function isOverlayDisabled(
  env: NodeJS.ProcessEnv,
  config: UkbConfig = {},
): boolean {
  const raw = env.UKB_OVERLAY?.trim().toLowerCase();
  if (raw === COLLAPSE_KEY_OFF) return true;
  if (raw === "on") return false;
  return config.overlay?.enabled === false;
}

/**
 * Content-row budget, heading included. Below the floor or not a number falls
 * through to the next level; there is no ceiling (a bigger board is the user's
 * call).
 */
export function resolveOverlayDisplay(
  env: NodeJS.ProcessEnv,
  config: UkbConfig = {},
): OverlayDisplay {
  const candidates: readonly unknown[] = [
    env.UKB_OVERLAY_DISPLAY,
    config.overlay?.display,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim().toLowerCase() as OverlayDisplay;
    if (OVERLAY_DISPLAYS.includes(value)) return value;
  }
  return DEFAULT_OVERLAY_DISPLAY;
}

export function resolveOverlayScope(
  env: NodeJS.ProcessEnv,
  config: UkbConfig = {},
): OverlayScope {
  const candidates: readonly unknown[] = [
    env.UKB_OVERLAY_SCOPE,
    config.overlay?.scope,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim().toLowerCase() as OverlayScope;
    if (OVERLAY_SCOPES.includes(value)) return value;
  }
  return DEFAULT_OVERLAY_SCOPE;
}

const PROJECT_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeOverlayProject(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return PROJECT_SLUG.test(normalized) ? normalized : null;
}

/** Explicit project override; null means infer it from the current Git root. */
export function resolveOverlayProject(
  env: NodeJS.ProcessEnv,
  config: UkbConfig = {},
): string | null {
  const candidates: readonly unknown[] = [
    env.UKB_OVERLAY_PROJECT,
    config.overlay?.project,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = normalizeOverlayProject(candidate);
    if (value !== null) return value;
  }
  return null;
}

export function resolveOverlayGroup(
  env: NodeJS.ProcessEnv,
  config: UkbConfig = {},
): OverlayGroup {
  const candidates: readonly unknown[] = [
    env.UKB_OVERLAY_GROUP,
    config.overlay?.groupBy,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim().toLowerCase() as OverlayGroup;
    if (OVERLAY_GROUPS.includes(value)) return value;
  }
  return DEFAULT_OVERLAY_GROUP;
}

/**
 * Which states the panel shows: env (comma-separated) > config array > default.
 * An entry that is not a known state makes the whole level unusable, so the
 * next level still wins — the same all-or-nothing rule the config validator
 * uses, applied per level.
 */
export function resolveOverlayStates(
  env: NodeJS.ProcessEnv,
  config: UkbConfig = {},
): readonly OverlayState[] {
  const candidates: readonly unknown[] = [
    env.UKB_OVERLAY_STATES,
    config.overlay?.states,
  ];
  for (const candidate of candidates) {
    const parsed = parseStates(candidate);
    if (parsed !== null) return parsed;
  }
  return DEFAULT_OVERLAY_STATES;
}

function parseStates(value: unknown): OverlayState[] | null {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;
  if (items === null) return null;
  const states = items.map((entry) => String(entry).trim().toLowerCase());
  if (states.length === 0 || states.some((state) => state === "")) return null;
  if (
    !states.every((state) =>
      (OVERLAY_STATES as readonly string[]).includes(state),
    )
  ) {
    return null;
  }
  // Dedupe while keeping the caller's order; display order is fixed anyway.
  return [...new Set(states)] as OverlayState[];
}

export function resolveMaxLines(
  env: NodeJS.ProcessEnv,
  config: UkbConfig = {},
): number {
  const candidates: readonly unknown[] = [
    env.UKB_OVERLAY_LINES,
    config.overlay?.maxLines,
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? Number(candidate) : candidate;
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= MIN_MAX_LINES
    ) {
      return Math.floor(value);
    }
  }
  return DEFAULT_MAX_LINES;
}

// Named keys pi-tui's key matcher understands, plus single printable characters.
const SPECIAL_KEYS = new Set([
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

/**
 * Validate a key spec against pi-tui's grammar. Checked strictly on purpose:
 * pi-tui takes the LAST `+`-part as the base key and ignores unknown parts, so
 * a typo like `ctr+k` would silently bind every bare `k` keypress globally.
 */
export function isValidCollapseKeySpec(spec: string): boolean {
  if (!spec) return false;
  if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++"))
    return false;
  const parts = spec.split("+");
  const base = parts[parts.length - 1] ?? "";
  const modifiers = parts.slice(0, -1);
  if (modifiers.length !== new Set(modifiers).size) return false;
  if (!modifiers.every((modifier) => MODIFIERS.has(modifier))) return false;
  return base.length === 1
    ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base)
    : SPECIAL_KEYS.has(base);
}

/**
 * The collapse/expand key: the first level that supplies a usable spec wins,
 * with the `off` sentinel passed through rather than rejected.
 */
export function resolveCollapseKey(
  env: NodeJS.ProcessEnv,
  config: UkbConfig = {},
): string {
  const candidates: readonly unknown[] = [
    env.UKB_OVERLAY_KEY,
    config.overlay?.collapseKey,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const spec = candidate.trim().toLowerCase();
    if (spec === "") continue;
    if (spec === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
    if (isValidCollapseKeySpec(spec)) return spec;
  }
  return DEFAULT_COLLAPSE_KEY;
}
