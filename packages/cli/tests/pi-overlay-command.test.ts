/** Pure `/ukb gui` parameter parsing; runtime mounting stays in index.ts. */
import { describe, expect, it } from "vitest";
import { MIN_MAX_LINES } from "../../pi/extensions/using-kanban/overlay-config.js";
import {
  OVERLAY_LINES_STEP,
  parseOverlayCommand,
} from "../../pi/extensions/using-kanban/overlay-command.js";
import type { OverlayView } from "../../pi/extensions/using-kanban/overlay-render.js";

const current: OverlayView = {
  scope: "current-project",
  project: "using-kanban",
  agent: "pi",
  groupBy: "state",
  maxLines: 12,
  states: ["doing", "todo", "review", "someday"],
};

describe("parseOverlayCommand", () => {
  it("shows the current project by default", () => {
    expect(parseOverlayCommand("", current)).toEqual({
      view: current,
      action: "show",
      error: null,
    });
  });

  it("accepts explicit actions", () => {
    for (const action of [
      "show",
      "hide",
      "help",
      "collapse",
      "expand",
      "more",
      "less",
    ] as const) {
      expect(parseOverlayCommand(action, current).action).toBe(action);
    }
  });

  it("rejects the removed toggle action", () => {
    expect(parseOverlayCommand("toggle", current).error).toContain(
      "usage: /ukb gui",
    );
  });

  it("changes scope and grouping for the current session", () => {
    expect(parseOverlayCommand("scope=mine group=owner", current)).toEqual({
      view: { ...current, scope: "mine", groupBy: "owner" },
      action: "show",
      error: null,
    });
    expect(
      parseOverlayCommand("scope=all groupBy=project", current).view,
    ).toEqual({ ...current, scope: "all", groupBy: "project" });
  });

  it("accepts explicit projects in either form", () => {
    expect(
      parseOverlayCommand("scope=project:Civil-Forest", current).view,
    ).toEqual({ ...current, project: "civil-forest" });
    expect(parseOverlayCommand("project=API", current).view).toEqual({
      ...current,
      project: "api",
    });
  });

  it("sets the displayed states for this session", () => {
    expect(
      parseOverlayCommand("states=todo,someday", current).view.states,
    ).toEqual(["todo", "someday"]);
    // duplicate values are collapsed rather than rejected
    expect(
      parseOverlayCommand("states=todo,todo", current).view.states,
    ).toEqual(["todo"]);
    expect(parseOverlayCommand("states=todo,backlog", current).error).toContain(
      "invalid overlay states",
    );
  });

  it("sets the row budget for this session", () => {
    expect(parseOverlayCommand("lines=30", current).view.maxLines).toBe(30);
    expect(parseOverlayCommand("max-lines=6", current).view.maxLines).toBe(6);
    // Clamped, not refused: `lines=2` is a wish for a small panel.
    expect(parseOverlayCommand("lines=2", current).view.maxLines).toBe(
      MIN_MAX_LINES,
    );
    expect(parseOverlayCommand("lines=abc", current).error).toContain(
      "invalid overlay lines",
    );
    expect(parseOverlayCommand("lines=0", current).error).toContain(
      "invalid overlay lines",
    );
  });

  it("leaves the budget alone unless a parameter says otherwise", () => {
    expect(parseOverlayCommand("scope=mine", current).view.maxLines).toBe(12);
    expect(parseOverlayCommand("", current).view.maxLines).toBe(12);
  });

  it("steps the budget by a visible amount", () => {
    // A zero step would make `more` a silent no-op, which is the dead end the
    // command exists to remove.
    expect(OVERLAY_LINES_STEP).toBeGreaterThan(0);
  });

  it("rejects bad values with actionable text", () => {
    expect(parseOverlayCommand("scope=bogus", current).error).toContain(
      "invalid overlay scope",
    );
    expect(parseOverlayCommand("group=bogus", current).error).toContain(
      "invalid overlay group",
    );
    expect(parseOverlayCommand("project=bad project", current).error).toContain(
      "usage:",
    );
    expect(parseOverlayCommand("wat", current).error).toContain("usage:");
  });
});
