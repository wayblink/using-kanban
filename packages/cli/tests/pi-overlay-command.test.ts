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
  split: false,
  right: { scope: null, project: null, states: ["someday"], groupBy: null },
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

describe("the second pane", () => {
  it("switches on with `split`, and off with `split=off`", () => {
    expect(parseOverlayCommand("split", current).view.split).toBe(true);
    expect(parseOverlayCommand("split=on", current).view.split).toBe(true);
    const on: OverlayView = { ...current, split: true };
    expect(parseOverlayCommand("split=off", on).view.split).toBe(false);
    expect(parseOverlayCommand("split=maybe", current).error).toMatch(/split/);
  });

  it("scopes each pane on its own", () => {
    const afterRight = parseOverlayCommand(
      "right scope=mine states=someday",
      current,
    ).view;
    expect(afterRight.right.scope).toBe("mine");
    expect(afterRight.right.states).toEqual(["someday"]);
    // The left pane is untouched by a `right` clause ...
    expect(afterRight.scope).toBe("current-project");

    // ... and a later `left` clause goes back to it.
    const both = parseOverlayCommand("right scope=all left scope=mine", current)
      .view;
    expect(both.scope).toBe("mine");
    expect(both.right.scope).toBe("all");
  });

  it("keeps a bare parameter on the left pane", () => {
    // Backwards compatibility: `scope=` alone has always meant the panel.
    const view = parseOverlayCommand("scope=mine", current).view;
    expect(view.scope).toBe("mine");
    expect(view.right.scope).toBeNull();
  });

  it("names a project on whichever pane is selected", () => {
    const view = parseOverlayCommand("right project=web", current).view;
    expect(view.right).toMatchObject({
      scope: "current-project",
      project: "web",
    });
    expect(view.project).toBe("using-kanban");
  });

  it("shares one row budget between the panes, so they stay aligned", () => {
    // `right lines=20` is not a second budget: two panels that scroll on their
    // own would not line up, so the number is the pair's height.
    const view = parseOverlayCommand("right lines=20", current).view;
    expect(view.maxLines).toBe(20);
  });

  it("rejects a parameter a pane does not have", () => {
    expect(parseOverlayCommand("right noodle=1", current).error).toMatch(
      /right/,
    );
  });
});
