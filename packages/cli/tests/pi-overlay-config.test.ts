/**
 * The overlay's settings resolvers live in packages/pi; see
 * pi-overlay-render.test.ts for why they are exercised from this suite.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERLAY_STATES,
  type UkbConfig,
} from "../../pi/extensions/using-kanban/config.js";
import {
  COLLAPSE_KEY_OFF,
  DEFAULT_COLLAPSE_KEY,
  DEFAULT_MAX_LINES,
  DEFAULT_OVERLAY_DISPLAY,
  DEFAULT_OVERLAY_GROUP,
  DEFAULT_OVERLAY_SCOPE,
  isOverlayDisabled,
  isValidCollapseKeySpec,
  normalizeOverlayProject,
  resolveCollapseKey,
  resolveMaxLines,
  resolveOverlayDisplay,
  resolveOverlayGroup,
  resolveOverlayProject,
  resolveOverlayScope,
  resolveOverlayStates,
} from "../../pi/extensions/using-kanban/overlay-config.js";

describe("isOverlayDisabled", () => {
  it("defaults to enabled", () => {
    expect(isOverlayDisabled({})).toBe(false);
    expect(isOverlayDisabled({}, {})).toBe(false);
  });

  it("lets the environment override the file in both directions", () => {
    const off: UkbConfig = { overlay: { enabled: false } };
    // env says on → the file's `false` loses
    expect(isOverlayDisabled({ UKB_OVERLAY: "on" }, off)).toBe(false);
    // env says off → wins over an enabled file
    expect(isOverlayDisabled({ UKB_OVERLAY: "off" }, {})).toBe(true);
    expect(isOverlayDisabled({ UKB_OVERLAY: " OFF " }, {})).toBe(true);
  });

  it("honours the file when the environment says nothing", () => {
    expect(isOverlayDisabled({}, { overlay: { enabled: false } })).toBe(true);
    expect(isOverlayDisabled({}, { overlay: { enabled: true } })).toBe(false);
  });

  it("ignores an unrelated environment value and falls through to the file", () => {
    expect(
      isOverlayDisabled(
        { UKB_OVERLAY: "yes" },
        { overlay: { enabled: false } },
      ),
    ).toBe(true);
  });
});

describe("overlay view", () => {
  it("defaults to on-demand, current project, grouped by state", () => {
    expect(resolveOverlayDisplay({})).toBe(DEFAULT_OVERLAY_DISPLAY);
    expect(resolveOverlayDisplay({})).toBe("on-demand");
    expect(resolveOverlayScope({})).toBe(DEFAULT_OVERLAY_SCOPE);
    expect(resolveOverlayScope({})).toBe("current-project");
    expect(resolveOverlayGroup({})).toBe(DEFAULT_OVERLAY_GROUP);
    expect(resolveOverlayGroup({})).toBe("state");
    expect(resolveOverlayProject({})).toBeNull();
  });

  it("lets env override config and invalid env fall through", () => {
    const config: UkbConfig = {
      overlay: {
        display: "always",
        scope: "mine",
        project: "web",
        groupBy: "owner",
      },
    };
    expect(
      resolveOverlayDisplay({ UKB_OVERLAY_DISPLAY: "on-demand" }, config),
    ).toBe("on-demand");
    expect(resolveOverlayScope({ UKB_OVERLAY_SCOPE: "all" }, config)).toBe(
      "all",
    );
    expect(resolveOverlayScope({ UKB_OVERLAY_SCOPE: "bogus" }, config)).toBe(
      "mine",
    );
    expect(resolveOverlayGroup({ UKB_OVERLAY_GROUP: "project" }, config)).toBe(
      "project",
    );
    expect(resolveOverlayGroup({ UKB_OVERLAY_GROUP: "bogus" }, config)).toBe(
      "owner",
    );
    expect(resolveOverlayProject({ UKB_OVERLAY_PROJECT: "api" }, config)).toBe(
      "api",
    );
  });

  it("normalizes and validates explicit project slugs", () => {
    expect(normalizeOverlayProject(" Using-Kanban ")).toBe("using-kanban");
    expect(normalizeOverlayProject("bad project")).toBeNull();
    expect(
      resolveOverlayProject(
        { UKB_OVERLAY_PROJECT: "bad project" },
        {
          overlay: { project: "web" },
        },
      ),
    ).toBe("web");
  });
});

describe("resolveOverlayStates", () => {
  it("defaults to the flow plus the shelf, without done", () => {
    expect(resolveOverlayStates({})).toEqual(DEFAULT_OVERLAY_STATES);
    expect(resolveOverlayStates({})).toEqual([
      "doing",
      "todo",
      "review",
      "someday",
    ]);
  });

  it("reads a comma-separated env list, overriding the file", () => {
    expect(
      resolveOverlayStates(
        { UKB_OVERLAY_STATES: "todo, done" },
        { overlay: { states: ["doing"] } },
      ),
    ).toEqual(["todo", "done"]);
  });

  it("takes the file list when the environment is absent", () => {
    expect(
      resolveOverlayStates({}, { overlay: { states: ["someday", "doing"] } }),
    ).toEqual(["someday", "doing"]);
  });

  it("falls back a level when a value names no known state", () => {
    expect(
      resolveOverlayStates({ UKB_OVERLAY_STATES: "todo,backlog" }),
    ).toEqual(DEFAULT_OVERLAY_STATES);
    expect(
      resolveOverlayStates(
        { UKB_OVERLAY_STATES: "todo,backlog" },
        { overlay: { states: ["doing"] } },
      ),
    ).toEqual(["doing"]);
  });
});

describe("resolveMaxLines", () => {
  it("defaults when nothing usable is set", () => {
    expect(resolveMaxLines({})).toBe(DEFAULT_MAX_LINES);
    expect(resolveMaxLines({ UKB_OVERLAY_LINES: "nope" })).toBe(
      DEFAULT_MAX_LINES,
    );
    expect(resolveMaxLines({ UKB_OVERLAY_LINES: "2" })).toBe(DEFAULT_MAX_LINES);
  });

  it("takes a value at or above the floor, floored to an integer", () => {
    expect(resolveMaxLines({ UKB_OVERLAY_LINES: "3" })).toBe(3);
    expect(resolveMaxLines({ UKB_OVERLAY_LINES: "20.7" })).toBe(20);
    expect(resolveMaxLines({}, { overlay: { maxLines: 8 } })).toBe(8);
  });

  it("lets an invalid environment value fall through to the file", () => {
    expect(
      resolveMaxLines({ UKB_OVERLAY_LINES: "2" }, { overlay: { maxLines: 9 } }),
    ).toBe(9);
    expect(
      resolveMaxLines(
        { UKB_OVERLAY_LINES: "16" },
        { overlay: { maxLines: 9 } },
      ),
    ).toBe(16);
  });
});

describe("isValidCollapseKeySpec", () => {
  it("accepts modifiers plus a printable or named key", () => {
    expect(isValidCollapseKeySpec("ctrl+shift+k")).toBe(true);
    expect(isValidCollapseKeySpec("alt+o")).toBe(true);
    expect(isValidCollapseKeySpec("f5")).toBe(true);
    expect(isValidCollapseKeySpec("/")).toBe(true);
  });

  it("rejects shapes pi-tui would mis-parse into a bare global key", () => {
    expect(isValidCollapseKeySpec("")).toBe(false);
    expect(isValidCollapseKeySpec("ctr+k")).toBe(false);
    expect(isValidCollapseKeySpec("ctrl+")).toBe(false);
    expect(isValidCollapseKeySpec("+k")).toBe(false);
    expect(isValidCollapseKeySpec("ctrl+ctrl+k")).toBe(false);
    expect(isValidCollapseKeySpec("bogus+k")).toBe(false);
  });
});

describe("resolveCollapseKey", () => {
  it("defaults when nothing usable is set", () => {
    expect(resolveCollapseKey({})).toBe(DEFAULT_COLLAPSE_KEY);
    expect(resolveCollapseKey({ UKB_OVERLAY_KEY: "  " })).toBe(
      DEFAULT_COLLAPSE_KEY,
    );
    expect(resolveCollapseKey({ UKB_OVERLAY_KEY: "ctr+k" })).toBe(
      DEFAULT_COLLAPSE_KEY,
    );
  });

  it("reads the file, lowercasing the spec", () => {
    expect(resolveCollapseKey({}, { overlay: { collapseKey: "ALT+O" } })).toBe(
      "alt+o",
    );
  });

  it("passes the off sentinel through from either level", () => {
    expect(resolveCollapseKey({ UKB_OVERLAY_KEY: "off" })).toBe(
      COLLAPSE_KEY_OFF,
    );
    expect(resolveCollapseKey({}, { overlay: { collapseKey: "off" } })).toBe(
      COLLAPSE_KEY_OFF,
    );
  });

  it("lets an invalid environment value fall through to the file", () => {
    expect(
      resolveCollapseKey(
        { UKB_OVERLAY_KEY: "ctr+k" },
        { overlay: { collapseKey: "alt+t" } },
      ),
    ).toBe("alt+t");
  });

  it("lets the environment beat a valid file value", () => {
    expect(
      resolveCollapseKey(
        { UKB_OVERLAY_KEY: "alt+o" },
        { overlay: { collapseKey: "alt+t" } },
      ),
    ).toBe("alt+o");
  });
});
