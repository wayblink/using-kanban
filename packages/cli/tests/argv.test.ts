import { describe, expect, it } from "vitest";
import {
  flagBoolean,
  flagNumbers,
  flagString,
  parseArgv,
  resolveDir,
  resolveStorage,
  UsageError,
} from "../src/argv.js";

describe("parseArgv", () => {
  it("splits the command from positionals and flags", () => {
    const parsed = parseArgv([
      "add",
      "write",
      "docs",
      "--body",
      "AC: tests",
      "--assignee",
      "codex",
    ]);
    expect(parsed.command).toBe("add");
    expect(parsed.positionals).toEqual(["write", "docs"]);
    expect(parsed.flags).toEqual({ body: "AC: tests", assignee: "codex" });
  });

  it("supports --flag=value and boolean flags", () => {
    const parsed = parseArgv(["web", "--port=4173", "--no-open"]);
    expect(parsed.command).toBe("web");
    expect(parsed.flags.port).toBe("4173");
    expect(flagBoolean(parsed.flags, "no-open")).toBe(true);
  });

  it("treats a lone trailing flag as boolean rather than swallowing a value", () => {
    const parsed = parseArgv(["board", "--agent"]);
    expect(parsed.flags.agent).toBe(true);
    expect(flagString(parsed.flags, "agent")).toBeUndefined();
  });

  it("collects everything after -- as positionals", () => {
    const parsed = parseArgv(["add", "--", "--not-a-flag"]);
    expect(parsed.positionals).toEqual(["--not-a-flag"]);
  });

  it("returns a null command when none is given (→ mine)", () => {
    expect(parseArgv([]).command).toBeNull();
    expect(parseArgv(["--agent", "codex"]).command).toBeNull();
  });
});

describe("flag helpers", () => {
  it("parses repeatable numeric flags", () => {
    expect(flagNumbers({ "blocked-by": "3" }, "blocked-by")).toEqual([3]);
    expect(flagNumbers({}, "blocked-by")).toEqual([]);
  });

  it("rejects nonsense ids", () => {
    expect(() =>
      flagNumbers({ "blocked-by": "abc" }, "blocked-by"),
    ).toThrowError(UsageError);
    expect(() =>
      flagNumbers({ "blocked-by": "-1" }, "blocked-by"),
    ).toThrowError(UsageError);
  });
});

describe("storage and dir resolution", () => {
  it("prefers flags, then env, then defaults", () => {
    expect(resolveStorage({ storage: "jsonl" }, {})).toBe("jsonl");
    expect(resolveStorage({}, { UKB_STORAGE: "jsonl" })).toBe("jsonl");
    expect(resolveStorage({}, {})).toBe("sqlite");
  });

  it("rejects unknown storage kinds", () => {
    expect(() => resolveStorage({ storage: "postgres" }, {})).toThrowError(
      /sqlite \| jsonl \| memory/,
    );
  });

  it("resolves the board directory", () => {
    expect(resolveDir({ dir: "/tmp/x" }, {}, "/cwd")).toBe("/tmp/x");
    expect(resolveDir({}, { UKB_DIR: "/tmp/y" }, "/cwd")).toBe("/tmp/y");
    expect(resolveDir({}, {}, "/cwd")).toBe("/cwd");
  });
});
