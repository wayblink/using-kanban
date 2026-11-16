/**
 * Where the Pi extension looks for the `ukb` CLI.
 *
 * The extension used to derive one path — `<its own checkout>/packages/cli/dist/bin.js`
 * — and use it forever. That is correct in a working checkout and silently
 * fatal everywhere else: the module remembers where it was loaded from, so a
 * worktree that is deleted or a repository that is moved leaves every tool call
 * and the whole panel failing on a path nobody can repair without a restart.
 * The reported failure was exactly that: a session loaded the extension from
 * `using-kanban-wt/remote/packages/pi` and kept spawning
 * `using-kanban-wt/remote/packages/cli/dist/bin.js` after that worktree was gone.
 *
 * So resolution is a search with a stated outcome, not a constant: an explicit
 * `UKB_BIN`, then the checkout's own build, then a `ukb` on `PATH`. Whatever it
 * picks, the caller can say which one and why.
 *
 * Lives in packages/pi like `guidance.ts` and `board-digest.ts` — pure and
 * Pi-free, tested from packages/cli because the Pi package has no runner.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveCliBin } from "../../pi/extensions/using-kanban/cli-path.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-cli-path-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A checkout shaped like this repo: <root>/packages/pi/extensions/using-kanban. */
function checkout(options: { built?: boolean } = {}): {
  here: string;
  cli: string;
} {
  const root = tempDir();
  const here = join(root, "packages", "pi", "extensions", "using-kanban");
  mkdirSync(here, { recursive: true });
  const cli = join(root, "packages", "cli", "dist", "bin.js");
  if (options.built !== false) {
    mkdirSync(join(root, "packages", "cli", "dist"), { recursive: true });
    writeFileSync(cli, "#!/usr/bin/env node\n");
  }
  return { here, cli };
}

/** A directory that looks like a bin dir with a `ukb` in it. */
function onPath(): { dir: string; ukb: string } {
  const dir = tempDir();
  const ukb = join(dir, "ukb");
  writeFileSync(ukb, "#!/bin/sh\n");
  return { dir, ukb };
}

describe("resolveCliBin", () => {
  it("uses the checkout's own build when it exists", () => {
    const { here, cli } = checkout();
    const { dir } = onPath();
    const resolution = resolveCliBin({ here, env: {}, searchPath: dir });
    expect(resolution.bin).toBe(cli);
    expect(resolution.source).toBe("checkout");
    expect(resolution.ready).toBe(true);
    expect(resolution.note).toBeNull();
  });

  it("falls back to a ukb on PATH when the checkout was never built", () => {
    // The regression: an unbuilt checkout used to be the end of the story.
    const { here, cli } = checkout({ built: false });
    const { dir, ukb } = onPath();
    const resolution = resolveCliBin({ here, env: {}, searchPath: dir });
    expect(resolution.bin).toBe(ukb);
    expect(resolution.source).toBe("path");
    expect(resolution.ready).toBe(true);
    // Says what it skipped, so "which ukb am I talking to" is answerable.
    expect(resolution.note).toContain(cli);
  });

  it("falls back to PATH when the checkout is gone altogether", () => {
    // The reported failure: the worktree holding the loaded module was deleted,
    // so nothing at `here` resolves and the derived path cannot ever be built.
    const root = tempDir();
    const here = join(
      root,
      "vanished-wt",
      "packages",
      "pi",
      "extensions",
      "using-kanban",
    );
    const { dir, ukb } = onPath();
    const resolution = resolveCliBin({ here, env: {}, searchPath: dir });
    expect(resolution.bin).toBe(ukb);
    expect(resolution.source).toBe("path");
    expect(resolution.ready).toBe(true);
  });

  it("honours UKB_BIN above everything else", () => {
    const { here } = checkout();
    const { dir } = onPath();
    const explicit = join(tempDir(), "custom-ukb");
    writeFileSync(explicit, "");
    const resolution = resolveCliBin({
      here,
      env: { UKB_BIN: ` ${explicit} ` },
      searchPath: dir,
    });
    expect(resolution.bin).toBe(explicit);
    expect(resolution.source).toBe("env");
    expect(resolution.ready).toBe(true);
  });

  it("says UKB_BIN is wrong rather than quietly using another one", () => {
    const { here } = checkout();
    const { dir } = onPath();
    const missing = join(tempDir(), "nope-ukb");
    const resolution = resolveCliBin({
      here,
      env: { UKB_BIN: missing },
      searchPath: dir,
    });
    expect(resolution.source).toBe("env");
    expect(resolution.ready).toBe(false);
    expect(resolution.note).toContain(missing);
  });

  it("reports where the CLI should have been when there is none anywhere", () => {
    const { here, cli } = checkout({ built: false });
    const emptyPath = tempDir();
    const resolution = resolveCliBin({ here, env: {}, searchPath: emptyPath });
    expect(resolution.bin).toBe(cli);
    expect(resolution.source).toBe("missing");
    expect(resolution.ready).toBe(false);
    // Actionable: names the build command, not just "not found".
    expect(resolution.note).toContain("pnpm -r build");
  });

  it("ignores an empty PATH entry instead of resolving against the cwd", () => {
    const { here } = checkout({ built: false });
    const { dir, ukb } = onPath();
    const resolution = resolveCliBin({
      here,
      env: {},
      searchPath: [dir, "", delimiter].join(delimiter),
    });
    expect(resolution.bin).toBe(ukb);
    expect(resolve(resolution.bin)).toBe(resolve(ukb));
  });
});
