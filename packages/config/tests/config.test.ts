/**
 * The shared config file: where it lives, how it is validated, and who the
 * machine's owner is. Four front doors read this (CLI, MCP, HTTP server, Pi
 * extension), so the behaviour is pinned here rather than in each of them.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetConfigWarning,
  loadConfig,
  machineName,
  resolveConfigPath,
  resolveOwnerName,
  validateGuidanceFields,
  type UkbConfig,
} from "../src/index.js";

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

  it("reads owner, agent, guidance, and overlay", () => {
    const config = loadConfig(
      withConfig(
        tempHome(),
        JSON.stringify({
          owner: "jyxc",
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
            states: ["doing", "someday", "done"],
          },
        }),
      ),
    );
    expect(config).toEqual({
      owner: "jyxc",
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
        states: ["doing", "someday", "done"],
      },
    });
  });

  it("drops fields of the wrong type rather than failing the whole file", () => {
    const config = loadConfig(
      withConfig(
        tempHome(),
        JSON.stringify({
          owner: 42,
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

  it("reads the split pane block", () => {
    const config = loadConfig(
      withConfig(
        tempHome(),
        JSON.stringify({
          overlay: {
            split: {
              enabled: true,
              scope: "all",
              project: "web",
              states: ["someday"],
              groupBy: "project",
            },
          },
        }),
      ),
    );
    expect(config).toEqual({
      overlay: {
        split: {
          enabled: true,
          scope: "all",
          project: "web",
          states: ["someday"],
          groupBy: "project",
        },
      },
    });
  });

  it("drops fields of a wrong-typed split block, and the block if nothing is left", () => {
    expect(
      loadConfig(
        withConfig(
          tempHome(),
          JSON.stringify({ overlay: { split: { enabled: "yes" } } }),
        ),
      ),
    ).toEqual({});
    expect(
      loadConfig(
        withConfig(
          tempHome(),
          JSON.stringify({ overlay: { split: { enabled: false } } }),
        ),
      ),
    ).toEqual({ overlay: { split: { enabled: false } } });
  });

  it("validates split.states all-or-nothing, like overlay.states", () => {
    expect(
      loadConfig(
        withConfig(
          tempHome(),
          JSON.stringify({
            overlay: { split: { states: ["someday", "nope"] } },
          }),
        ),
      ),
    ).toEqual({});
  });

  it("validates overlay.states all-or-nothing", () => {
    // one unknown state falls back to the whole default list, so a typo cannot
    // silently drop a column the user asked for.
    const config = loadConfig(
      withConfig(
        tempHome(),
        JSON.stringify({ overlay: { states: ["doing", "backlog"] } }),
      ),
    );
    expect(config).toEqual({});
  });

  it("ignores a blank owner or agent name", () => {
    expect(loadConfig(withConfig(tempHome(), '{"agent":"   "}'))).toEqual({});
    expect(loadConfig(withConfig(tempHome(), '{"owner":"  "}'))).toEqual({});
  });

  it("reads auth only as a boolean", () => {
    expect(loadConfig(withConfig(tempHome(), '{"auth":false}'))).toEqual({
      auth: false,
    });
    expect(loadConfig(withConfig(tempHome(), '{"auth":"off"}'))).toEqual({});
  });

  it("reads openAccess only as a boolean", () => {
    expect(loadConfig(withConfig(tempHome(), '{"openAccess":true}'))).toEqual({
      openAccess: true,
    });
    expect(loadConfig(withConfig(tempHome(), '{"openAccess":false}'))).toEqual({
      openAccess: false,
    });
    expect(loadConfig(withConfig(tempHome(), '{"openAccess":"yes"}'))).toEqual(
      {},
    );
  });

  it("trims the owner name it hands back", () => {
    expect(loadConfig(withConfig(tempHome(), '{"owner":" pi "}'))).toEqual({
      owner: "pi",
    });
  });
});

describe("machineName", () => {
  it("strips the domain suffix so the owner is not an mDNS name", () => {
    expect(machineName({}, () => "JYXC-DZ-0101035deMacBook-Pro.local")).toBe(
      "JYXC-DZ-0101035deMacBook-Pro",
    );
  });

  it("keeps a name with no domain as it is", () => {
    expect(machineName({}, () => "buildbox")).toBe("buildbox");
  });

  it("prefers UKB_MACHINE_NAME when it is set", () => {
    // The escape hatch exists for containers and CI, where the hostname is a
    // container id that means nothing to a reader.
    expect(
      machineName({ UKB_MACHINE_NAME: "workshop" }, () => "a1b2c3d4e5f6"),
    ).toBe("workshop");
  });

  it("falls back to something usable when the hostname is empty", () => {
    expect(machineName({}, () => "")).toBe("someone");
    expect(machineName({}, () => ".local")).toBe("someone");
  });
});

describe("resolveOwnerName", () => {
  const config: UkbConfig = { owner: "jyxc" };

  it("prefers an explicit flag", () => {
    expect(
      resolveOwnerName({
        flag: "cli-owner",
        env: { UKB_OWNER: "env-owner" },
        config,
      }),
    ).toBe("cli-owner");
  });

  it("prefers the environment over the file", () => {
    expect(resolveOwnerName({ env: { UKB_OWNER: "env-owner" }, config })).toBe(
      "env-owner",
    );
  });

  it("prefers the file over the machine name", () => {
    expect(
      resolveOwnerName({ env: {}, config, hostname: () => "box.local" }),
    ).toBe("jyxc");
  });

  it("falls back to the machine name when nothing is configured", () => {
    expect(
      resolveOwnerName({ env: {}, config: {}, hostname: () => "box.local" }),
    ).toBe("box");
  });

  it("ignores blank values at every level", () => {
    expect(
      resolveOwnerName({
        flag: "   ",
        env: { UKB_OWNER: "  " },
        config: { owner: "" },
        hostname: () => "box.local",
      }),
    ).toBe("box");
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
