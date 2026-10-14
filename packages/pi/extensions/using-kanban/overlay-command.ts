/** Pure parser for `/ukb gui`; runtime wiring stays in index.ts. */
import {
  OVERLAY_GROUPS,
  OVERLAY_SCOPES,
  type OverlayGroup,
  type OverlayScope,
} from "./config.js";
import { MIN_MAX_LINES, normalizeOverlayProject } from "./overlay-config.js";
import type { OverlayView } from "./overlay-render.js";

/** How many rows `/ukb gui more` and `less` move the budget by. */
export const OVERLAY_LINES_STEP = 10;

export interface OverlayCommand {
  readonly view: OverlayView;
  readonly action:
    "show" | "hide" | "help" | "collapse" | "expand" | "more" | "less";
  readonly error: string | null;
}

function tokens(input: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  for (const match of input.matchAll(pattern)) {
    result.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return result;
}

/**
 * Runtime-only overrides for `/ukb gui`; config remains the persistent surface.
 * `overlay` is accepted as an alias for `gui`.
 *
 * `lines=<n>` sets the row budget for this session. `more` / `less` step it
 * without naming a number, because the reader who sees "+15 more" wants the
 * rest of their board now, not an argument to remember.
 */
export function parseOverlayCommand(
  input: string,
  current: OverlayView,
): OverlayCommand {
  let view = { ...current };
  let action: OverlayCommand["action"] = "show";
  for (const token of tokens(input.trim())) {
    const lower = token.toLowerCase();
    if (
      lower === "show" ||
      lower === "hide" ||
      lower === "help" ||
      lower === "collapse" ||
      lower === "expand" ||
      lower === "more" ||
      lower === "less"
    ) {
      action = lower;
      continue;
    }
    const separator = token.indexOf("=");
    if (separator <= 0) {
      return {
        view,
        action,
        error:
          "usage: /ukb gui [show|hide|help|collapse|expand|more|less] [scope=current-project|mine|all|project:<slug>] [group=state|project|owner|none] [project=<slug>] [lines=<n>]",
      };
    }
    const key = token.slice(0, separator).trim().toLowerCase();
    const raw = token
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    if (key === "scope") {
      if (raw.startsWith("project:")) {
        const project = normalizeOverlayProject(raw.slice("project:".length));
        if (project === null)
          return { view, action, error: `invalid project scope: ${raw}` };
        view = { ...view, scope: "current-project", project };
        continue;
      }
      if (!OVERLAY_SCOPES.includes(raw as OverlayScope)) {
        return { view, action, error: `invalid overlay scope: ${raw}` };
      }
      view = { ...view, scope: raw as OverlayScope };
      continue;
    }
    if (key === "group" || key === "groupby") {
      if (!OVERLAY_GROUPS.includes(raw as OverlayGroup)) {
        return { view, action, error: `invalid overlay group: ${raw}` };
      }
      view = { ...view, groupBy: raw as OverlayGroup };
      continue;
    }
    if (key === "project") {
      const project = normalizeOverlayProject(raw);
      if (project === null)
        return { view, action, error: `invalid overlay project: ${raw}` };
      view = { ...view, scope: "current-project", project };
      continue;
    }
    if (key === "lines" || key === "max-lines") {
      const value = Number(raw);
      // Clamped rather than rejected: `lines=2` is a wish for a small panel,
      // not a reason to refuse the whole command.
      if (!Number.isFinite(value) || value < 1) {
        return { view, action, error: `invalid overlay lines: ${raw}` };
      }
      view = { ...view, maxLines: Math.max(MIN_MAX_LINES, Math.floor(value)) };
      continue;
    }
    return { view, action, error: `unknown overlay parameter: ${key}` };
  }
  return { view, action, error: null };
}
