import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCommand, type Io } from "../src/commands.js";
import { FRAMEWORKS } from "../src/init.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-init-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeIo(dir: string, home: string): Io & { out: string[] } {
  const out: string[] = [];
  return {
    cwd: dir,
    env: { USER: "tester" },
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
    home,
    out,
  };
}

/** Runs `ukb init` against a sandboxed project + home. */
async function init(
  framework: string,
  options: {
    dryRun?: boolean;
    browser?: boolean;
    files?: Record<string, string>;
    homeFiles?: Record<string, string>;
    local?: boolean;
  } = {},
): Promise<{ project: string; home: string; out: string[] }> {
  const project = tempDir();
  const home = tempDir();
  writeFiles(project, options.files ?? {});
  writeFiles(home, options.homeFiles ?? {});

  const io = makeIo(project, home);
  const argv = [
    "init",
    "--for",
    framework,
    ...(options.dryRun ? ["--dry-run"] : []),
    ...(options.browser ? ["--browser"] : []),
    ...(options.local ? ["--local"] : []),
  ];
  const code = await runCommand(argv, io);
  expect(code).toBe(0);
  return { project, home, out: io.out };
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }
}

describe("ukb init", () => {
  it("requires a framework", async () => {
    const io = makeIo(tempDir(), tempDir());
    expect(await runCommand(["init"], io)).toBe(1);
    expect(io.out.join("\n")).toContain("needs a framework");
  });

  it("wires up Claude Code idempotently and preserves existing config", async () => {
    const first = await init("claude-code", {
      files: {
        ".mcp.json": JSON.stringify(
          { mcpServers: { other: { command: "x" } }, keepme: true },
          null,
          2,
        ),
      },
    });

    const mcp = JSON.parse(
      readFileSync(join(first.project, ".mcp.json"), "utf8"),
    ) as {
      keepme: boolean;
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(mcp.keepme).toBe(true);
    expect(Object.keys(mcp.mcpServers).sort()).toEqual([
      "other",
      "using-kanban",
    ]);
    expect(mcp.mcpServers["using-kanban"]?.command).toBe("npx");
    expect(mcp.mcpServers["using-kanban"]?.args).toContain("claude-code");
    expect(mcp.mcpServers["using-kanban"]?.args).toContain(first.project);
    expect(readFileSync(join(first.project, "CLAUDE.md"), "utf8")).toContain(
      "using-kanban:start",
    );

    // re-running must not duplicate anything: the files come back byte-identical
    const mcpBefore = readFileSync(join(first.project, ".mcp.json"), "utf8");
    const docsBefore = readFileSync(join(first.project, "CLAUDE.md"), "utf8");
    await runCommand(
      ["init", "--for", "claude-code"],
      makeIo(first.project, tempDir()),
    );
    expect(readFileSync(join(first.project, ".mcp.json"), "utf8")).toBe(
      mcpBefore,
    );
    expect(readFileSync(join(first.project, "CLAUDE.md"), "utf8")).toBe(
      docsBefore,
    );
  });

  it("writes a marker-delimited Codex block and keeps the rest of the file", async () => {
    const { project, home } = await init("codex", {
      homeFiles: {
        ".codex/config.toml": '# my codex config\nmodel = "gpt-5"\n',
      },
    });

    const configPath = join(home, ".codex", "config.toml");
    const contents = readFileSync(configPath, "utf8");
    expect(contents).toContain('model = "gpt-5"');
    expect(contents).toContain("[mcp_servers.using-kanban]");
    expect(contents).toContain('"codex"');
    expect(contents).toContain(project);
    expect(contents.split("# >>> using-kanban:using-kanban >>>")).toHaveLength(
      2,
    );
    expect(
      contents.trimEnd().endsWith("# <<< using-kanban:using-kanban <<<"),
    ).toBe(true);

    // idempotent: a second run replaces the block instead of appending another
    await runCommand(["init", "--for", "codex"], makeIo(project, home));
    expect(
      readFileSync(configPath, "utf8").split(
        "# >>> using-kanban:using-kanban >>>",
      ),
    ).toHaveLength(2);

    // and the project gets the workflow docs
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toContain(
      "using-kanban:start",
    );
  });

  it("merges into opencode.json without dropping other keys", async () => {
    const { project } = await init("opencode", {
      files: {
        "opencode.json": JSON.stringify(
          { theme: "dark", mcp: { other: true } },
          null,
          2,
        ),
      },
    });

    const config = JSON.parse(
      readFileSync(join(project, "opencode.json"), "utf8"),
    ) as {
      theme: string;
      mcp: Record<string, { type: string; command: string[] }>;
    };
    expect(config.theme).toBe("dark");
    expect(Object.keys(config.mcp).sort()).toEqual(["other", "using-kanban"]);
    expect(config.mcp["using-kanban"]?.type).toBe("local");
    expect(config.mcp["using-kanban"]?.command).toContain("opencode");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toContain(
      "using-kanban:start",
    );
  });

  it("falls back to a printable config for unknown frameworks", async () => {
    const { project, out } = await init("deepseek");
    const text = out.join("\n");
    expect(text).toContain('No dedicated installer for "deepseek"');
    expect(text).toContain('"mcpServers"');
    expect(text).toContain('"@wayblink/using-kanban-mcp"');
    // The docs snippet still lands, because most harnesses read it.
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toContain(
      "using-kanban:start",
    );
  });

  it("refuses to clobber an unparseable config file", async () => {
    const project = tempDir();
    writeFileSync(join(project, ".mcp.json"), "{ not json", "utf8");
    const io = makeIo(project, tempDir());
    await expect(
      runCommand(["init", "--for", "claude-code"], io),
    ).rejects.toThrowError(/not valid JSON/);
  });

  it("writes nothing on a dry run", async () => {
    const { project } = await init("claude-code", { dryRun: true });
    expect(existsSync(join(project, ".mcp.json"))).toBe(false);
    expect(existsSync(join(project, "CLAUDE.md"))).toBe(false);
  });

  it("covers every framework it advertises", () => {
    for (const [key, spec] of Object.entries(FRAMEWORKS)) {
      expect(spec.agent).toBeTruthy();
      expect(spec.files.length).toBeGreaterThan(0);
      expect(spec.notes.length).toBeGreaterThan(0);
      expect(key).toBe(spec.agent);
    }
  });
});

describe("ukb init --local", () => {
  it("points at the sibling package instead of the published one", async () => {
    const { project } = await init("claude-code", { local: true });
    const config = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"));
    const entry = config.mcpServers["using-kanban"];

    // an absolute path into this checkout, run by the current node binary
    expect(entry.command).toBe(process.execPath);
    expect(entry.args[0]).toMatch(/packages\/mcp\/dist\/bin\.js$/);
    expect(existsSync(entry.args[0])).toBe(true);
    expect(entry.args).toContain("--dir");
    expect(entry.args).toContain(project);
    // crucially, no npx and no unpublished package name
    expect(entry.command).not.toBe("npx");
    expect(entry.args.join(" ")).not.toContain("@wayblink/using-kanban-mcp");
  });

  it("uses npx and the published package without --local", async () => {
    const { project } = await init("claude-code");
    const config = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"));
    const entry = config.mcpServers["using-kanban"];

    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual([
      "-y",
      "@wayblink/using-kanban-mcp",
      "--agent",
      "claude-code",
      "--dir",
      project,
    ]);
  });

  it("stays idempotent with --local", async () => {
    const { project } = await init("claude-code", { local: true });
    const first = readFileSync(join(project, ".mcp.json"), "utf8");
    const io = makeIo(project, tempDir());
    expect(
      await runCommand(["init", "--for", "claude-code", "--local"], io),
    ).toBe(0);
    expect(readFileSync(join(project, ".mcp.json"), "utf8")).toBe(first);
  });

  it("also applies to opencode's array command shape", async () => {
    const { project } = await init("opencode", { local: true });
    const config = JSON.parse(
      readFileSync(join(project, "opencode.json"), "utf8"),
    );
    const entry = config.mcp["using-kanban"];

    expect(entry.type).toBe("local");
    expect(entry.command[0]).toBe(process.execPath);
    expect(entry.command[1]).toMatch(/packages\/mcp\/dist\/bin\.js$/);
    expect(entry.command).toContain("--dir");
    expect(entry.command.join(" ")).not.toContain("@wayblink/using-kanban-mcp");
  });

  it("says so in the printed header", async () => {
    const { out } = await init("claude-code", { local: true });
    expect(out.join("\n")).toContain("using this checkout");
  });
});

describe("ukb init --browser", () => {
  it("adds the Playwright MCP server next to the board for Claude Code", async () => {
    const { project, out } = await init("claude-code", { browser: true });
    const mcp = JSON.parse(
      readFileSync(join(project, ".mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(Object.keys(mcp.mcpServers).sort()).toEqual([
      "playwright",
      "using-kanban",
    ]);
    expect(mcp.mcpServers.playwright?.command).toBe("npx");
    expect(mcp.mcpServers.playwright?.args).toContain("@playwright/mcp@latest");
    expect(out.join("\n")).toContain("playwright MCP server");
  });

  it("adds a second marker block to the Codex config", async () => {
    const { home } = await init("codex", { browser: true });
    const contents = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(contents).toContain("[mcp_servers.using-kanban]");
    expect(contents).toContain("[mcp_servers.playwright]");
    expect(contents).toContain("@playwright/mcp@latest");
    // both blocks stay marker-delimited and idempotent
    expect(contents.split("# >>> using-kanban:using-kanban >>>")).toHaveLength(
      2,
    );
    expect(contents.split("# >>> using-kanban:playwright >>>")).toHaveLength(2);
  });

  it("adds it to opencode.json in opencode's shape", async () => {
    const { project } = await init("opencode", { browser: true });
    const config = JSON.parse(
      readFileSync(join(project, "opencode.json"), "utf8"),
    ) as {
      mcp: Record<string, { type: string; command: string[] }>;
    };
    expect(Object.keys(config.mcp).sort()).toEqual([
      "playwright",
      "using-kanban",
    ]);
    expect(config.mcp.playwright?.type).toBe("local");
    expect(config.mcp.playwright?.command).toContain("@playwright/mcp@latest");
  });

  it("prints it for unknown frameworks", async () => {
    const { out } = await init("stepcode", { browser: true });
    const text = out.join("\n");
    expect(text).toContain('"playwright"');
    expect(text).toContain('"using-kanban"');
  });

  it("does nothing browser-related without the flag", async () => {
    const { project } = await init("claude-code");
    const mcp = JSON.parse(
      readFileSync(join(project, ".mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual(["using-kanban"]);
  });
});

describe("ukb init --for pi", () => {
  const readSettings = (home: string) =>
    JSON.parse(
      readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"),
    );

  it("registers the pi package in ~/.pi/agent/settings.json", async () => {
    const { project, home } = await init("pi", {
      homeFiles: { ".pi/agent/settings.json": '{"theme":"dark"}\n' },
    });

    const settings = readSettings(home);
    expect(settings.theme).toBe("dark");
    expect(settings.packages).toEqual([expect.stringMatching(/packages\/pi$/)]);
    // and it must be a real package, not just a path string
    expect(existsSync(join(settings.packages[0], "package.json"))).toBe(true);
    // AGENTS.md is still written, for harnesses that read it
    expect(existsSync(join(project, "AGENTS.md"))).toBe(true);
  });

  it("is idempotent and preserves other packages", async () => {
    const { home } = await init("pi", {
      homeFiles: {
        ".pi/agent/settings.json": JSON.stringify({
          packages: ["/some/other/package"],
        }),
      },
    });
    const first = readSettings(home);
    expect(first.packages).toHaveLength(2);
    expect(first.packages[0]).toBe("/some/other/package");

    const io = makeIo(tempDir(), home);
    expect(await runCommand(["init", "--for", "pi"], io)).toBe(0);
    expect(readSettings(home)).toEqual(first);
  });

  it("creates settings.json when Pi has never been configured", async () => {
    const { home } = await init("pi");
    expect(readSettings(home).packages).toEqual([
      expect.stringMatching(/packages\/pi$/),
    ]);
  });

  it("writes nothing on a dry run", async () => {
    const { home } = await init("pi", {
      dryRun: true,
      homeFiles: { ".pi/agent/settings.json": '{"theme":"dark"}\n' },
    });
    expect(existsSync(join(home, ".pi", "agent", "settings.json"))).toBe(true);
    expect(readSettings(home)).toEqual({ theme: "dark" });
  });

  it("the package it points at declares both an extension and a skill", async () => {
    const { home } = await init("pi");
    const pkg = readSettings(home).packages[0] as string;
    const manifest = JSON.parse(
      readFileSync(join(pkg, "package.json"), "utf8"),
    );

    expect(manifest.pi.extensions).toEqual(["./extensions"]);
    expect(manifest.pi.skills).toEqual(["./skills"]);
    // the extension must exist and register the MCP server with direct exposure
    const extension = readFileSync(
      join(pkg, "extensions/using-kanban/index.ts"),
      "utf8",
    );
    expect(extension).toContain('exposure: "direct"');
    expect(extension).toContain("registerMcpServer");
    // and the skill must carry the workflow
    const skill = readFileSync(
      join(pkg, "skills/using-kanban/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("ukb claim");
    expect(skill).toContain("name: using-kanban");
  });
});
