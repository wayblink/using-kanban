/**
 * `~/.config/ukb/config.json` parsing and guidance validation. The module lives
 * in packages/pi; see pi-overlay-render.test.ts for why this suite exercises it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetConfigWarning,
  loadConfig,
  resolveConfigPath,
  validateGuidanceFields,
} from "../../pi/extensions/using-kanban/config.js";

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-config-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => __resetConfigWarning());

/** Write a config file under `home` and return the env that points at it. */
function withConfig(home: string, contents: string): NodeJS.ProcessEnv {
  const dir = join(home, ".config", "ukb");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), contents, "utf8");
  return { HOME: home };
}

describe("resolveConfigPath", () => {
  it("uses ~/.config by default", () => {
    expect(resolveConfigPath({ HOME: "/home/x" })).toBe(
      "/home/x/.config/ukb/config.json",
    );
  });

  it("honours an absolute XDG_CONFIG_HOME", () => {
    expect(
      resolveConfigPath({ HOME: "/home/x", XDG_CONFIG_HOME: "/cfg" }),
    ).toBe("/cfg/ukb/config.json");
  });

  it("expands a leading ~ in XDG_CONFIG_HOME", () => {
    expect(
      resolveConfigPath({ HOME: "/home/x", XDG_CONFIG_HOME: "~/cfg" }),
    ).toBe("/home/x/cfg/ukb/config.json");
    expect(resolveConfigPath({ HOME: "/home/x", XDG_CONFIG_HOME: "~" })).toBe(
      "/home/x/ukb/config.json",
    );
  });

  it("ignores a relative, empty, or whitespace XDG_CONFIG_HOME", () => {
    for (const value of ["cfg", "", "   "]) {
      expect(
        resolveConfigPath({ HOME: "/home/x", XDG_CONFIG_HOME: value }),
      ).toBe("/home/x/.config/ukb/config.json");
    }
  });
});

describe("loadConfig", () => {
  it("treats a missing file as every default", () => {
    expect(loadConfig({ HOME: tempHome() })).toEqual({});
  });

  it("treats a malformed file as empty instead of throwing", () => {
    const env = withConfig(tempHome(), "{ not json");
    expect(loadConfig(env)).toEqual({});
  });

  it("treats an array, null, or scalar document as empty", () => {
    for (const contents of ["[]", "null", "42", '"text"']) {
      expect(loadConfig(withConfig(tempHome(), contents))).toEqual({});
    }
  });

  it("reads guidance, agent, and overlay", () => {
    const config = loadConfig(
      withConfig(
        tempHome(),
        JSON.stringify({
          agent: "codex",
          guidance: {
            promptSnippet: "Custom snippet",
            promptGuidelines: ["Rule one", "Rule two"],
          },
          overlay: {
            enabled: false,
            maxLines: 8,
            collapseKey: "alt+t",
            scope: "mine",
            project: "web",
            groupBy: "owner",
            display: "always",
          },
        }),
      ),
    );
    expect(config).toEqual({
      agent: "codex",
      guidance: {
        promptSnippet: "Custom snippet",
        promptGuidelines: ["Rule one", "Rule two"],
      },
      overlay: {
        enabled: false,
        maxLines: 8,
        collapseKey: "alt+t",
        scope: "mine",
        project: "web",
        groupBy: "owner",
        display: "always",
      },
    });
  });

  it("drops fields of the wrong type rather than failing the whole file", () => {
    const config = loadConfig(
      withConfig(
        tempHome(),
        JSON.stringify({
          agent: 42,
          guidance: "nope",
          overlay: {
            enabled: "yes",
            maxLines: "8",
            collapseKey: 7,
            scope: "bogus",
            project: 3,
            groupBy: "bogus",
            display: "sometimes",
          },
        }),
      ),
    );
    expect(config).toEqual({});
  });

  it("keeps the valid half of a partly-valid overlay block", () => {
    const config = loadConfig(
      withConfig(
        tempHome(),
        JSON.stringify({ overlay: { maxLines: 6, enabled: "x" } }),
      ),
    );
    expect(config).toEqual({ overlay: { maxLines: 6 } });
  });

  it("ignores a blank agent name", () => {
    expect(loadConfig(withConfig(tempHome(), '{"agent":"   "}'))).toEqual({});
  });
});

describe("validateGuidanceFields", () => {
  it("returns undefined for a missing or non-object block", () => {
    expect(validateGuidanceFields(undefined)).toBeUndefined();
    expect(validateGuidanceFields(null)).toBeUndefined();
    expect(validateGuidanceFields("x")).toBeUndefined();
    expect(validateGuidanceFields([])).toBeUndefined();
    expect(validateGuidanceFields({})).toBeUndefined();
  });

  it("accepts a non-empty snippet", () => {
    expect(validateGuidanceFields({ promptSnippet: " hi " })).toEqual({
      promptSnippet: "hi",
    });
  });

  it("rejects a blank or non-string snippet", () => {
    expect(validateGuidanceFields({ promptSnippet: "" })).toBeUndefined();
    expect(validateGuidanceFields({ promptSnippet: "   " })).toBeUndefined();
    expect(validateGuidanceFields({ promptSnippet: 7 })).toBeUndefined();
  });

  it("rejects an empty guidelines array", () => {
    expect(validateGuidanceFields({ promptGuidelines: [] })).toBeUndefined();
  });

  it("falls back wholesale when any guideline is an empty string", () => {
    // All-or-nothing: the array is never merged item by item, because a
    // silently shortened rule set is harder to notice than a clean fallback.
    expect(
      validateGuidanceFields({ promptGuidelines: ["valid", ""] }),
    ).toBeUndefined();
    expect(
      validateGuidanceFields({ promptGuidelines: ["valid", 3] }),
    ).toBeUndefined();
  });

  it("keeps a partly-valid block to the fields that are valid", () => {
    expect(
      validateGuidanceFields({ promptSnippet: "ok", promptGuidelines: [""] }),
    ).toEqual({ promptSnippet: "ok" });
  });
});
