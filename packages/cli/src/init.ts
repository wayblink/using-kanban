import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flagBoolean, flagString } from "./argv.js";
import type { Io } from "./commands.js";

const DOCS_START = "<!-- using-kanban:start -->";
const DOCS_END = "<!-- using-kanban:end -->";
/** Markers are keyed per server so several can coexist in one config file. */
const tomlMarkers = (key: string) => ({
  start: `# >>> using-kanban:${key} >>>`,
  end: `# <<< using-kanban:${key} <<<`,
});

interface FrameworkSpec {
  /** Agent name written into the MCP config. */
  agent: string;
  label: string;
  /** Config files this installer writes. */
  files: string[];
  /** Human notes printed after a successful run. */
  notes: string[];
  /** Each harness has its own MCP config shape. */
  entry: (projectDir: string, local: boolean) => Record<string, unknown>;
  write: (context: WriteContext) => void;
}

interface WriteContext {
  projectDir: string;
  home: string;
  entry: Record<string, unknown>;
  /** Second MCP server written when `--browser` is passed. */
  browserEntry?: Record<string, unknown> | undefined;
  docsPath: string;
  dryRun: boolean;
  /** `--local`: point at the sibling package instead of the published one. */
  local: boolean;
}

/** The optional Playwright MCP server, so agents can drive a browser too. */
function browserMcpEntry(): Record<string, unknown> {
  return {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--headless"],
  };
}

/**
 * The MCP server command for the generated config.
 *
 * Default: `npx -y @wayblink/using-kanban-mcp`, which is what you want once
 * the packages are published. `--local` instead points at the sibling package
 * in this checkout, so the config works before publishing — and survives the
 * package never being published at all.
 */
function mcpEntry(
  agent: string,
  projectDir: string,
  local: boolean,
): { command: string; args: string[] } {
  if (local) {
    const bin = resolveLocalMcpBin();
    if (!bin) {
      throw new Error(
        "ukb init --local could not find packages/mcp/dist/bin.js in this checkout. " +
          "Run `pnpm -r build` first, or drop --local to use the published package.",
      );
    }
    // process.execPath rather than "node": the agent harness may not have node
    // on its PATH, but it always has this one.
    // No --dir: the store is centralised, so every project shares one board and
    // separates its work with the `project` field.
    return { command: process.execPath, args: [bin, "--agent", agent] };
  }
  return {
    command: "npx",
    args: ["-y", "@wayblink/using-kanban-mcp", "--agent", agent],
  };
}

/**
 * Locate `packages/mcp/dist/bin.js` by walking up from this package, so it
 * works from a source checkout but not from an installed copy.
 */
function resolveLocalMcpBin(): string | undefined {
  const url = hereUrl();
  if (!url) return undefined;
  let dir = dirname(fileURLToPath(url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, "packages", "mcp", "dist", "bin.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** `import.meta.url` is undefined in the esbuild bundle — fall back to argv[1]. */
function hereUrl(): string | undefined {
  if (
    typeof import.meta.url === "string" &&
    import.meta.url.startsWith("file:")
  ) {
    return import.meta.url;
  }
  const entry = process.argv[1];
  return entry ? fileURLToPath(entry) : undefined;
}

const GENERIC_DOCS_SNIPPET = `${DOCS_START}
## Kanban — using-kanban

This project shares a kanban board (\`.ukb/\`) between you and the human.

- Start every turn with \`ukb\` — it lists your open cards. Treat it as work to do, not a status report.
- Before working a card, read it: \`ukb show <id>\` (the body holds the target files and acceptance criteria).
- Always claim before starting: \`ukb claim <id>\` — it moves the card to doing and marks you as the owner.
- When the work is ready: \`ukb review <id>\`. As the reviewer, approve with \`ukb done <id>\`.
- If work has to go back: \`ukb reopen <id>\` and say why via \`ukb edit <id> --body "..."\`.
- Wire up what a card depends on: \`ukb relate <id> --with <other> --as upstream\` (or \`downstream\`). Unfinished upstream work blocks a claim.
- Put the paperwork on the card, not in the body: \`ukb note <id> "design doc" --url docs/design.md\`. Local markdown and HTML render in the Web UI.
- Prefer the structured tools when they are available — the \`ukb\` tool on Pi, the \`kanban_*\` MCP tools elsewhere — and fall back to the CLI.

\`ukb board\` shows everything. \`ukb web\` opens the board in a browser.
${DOCS_END}`;

const FRAMEWORKS: Record<string, FrameworkSpec> = {
  "claude-code": {
    agent: "claude-code",
    label: "Claude Code",
    files: [".mcp.json", "CLAUDE.md"],
    entry: (projectDir, local) => mcpEntry("claude-code", projectDir, local),
    notes: [
      "Restart Claude Code (or reload the project) so it picks up .mcp.json.",
      "Commit .mcp.json if you want the whole team to share the board.",
    ],
    write: ({ projectDir, entry, browserEntry, docsPath, dryRun }) => {
      const config = join(projectDir, ".mcp.json");
      mergeJson(config, "mcpServers", "using-kanban", entry, dryRun);
      if (browserEntry)
        mergeJson(config, "mcpServers", "playwright", browserEntry, dryRun);
      upsertDocs(docsPath, dryRun);
    },
  },
  codex: {
    agent: "codex",
    label: "Codex",
    files: ["~/.codex/config.toml", "AGENTS.md"],
    entry: (projectDir, local) => mcpEntry("codex", projectDir, local),
    notes: [
      "The config.toml block is marker-delimited and safe to re-run.",
      "AGENTS.md is read by Codex on every run in this project.",
    ],
    write: ({ home, projectDir, entry, browserEntry, docsPath, dryRun }) => {
      const config = join(home, ".codex", "config.toml");
      upsertToml(config, "using-kanban", entry, dryRun);
      if (browserEntry) upsertToml(config, "playwright", browserEntry, dryRun);
      upsertDocs(docsPath, dryRun);
      void projectDir;
    },
  },
  opencode: {
    agent: "opencode",
    label: "opencode",
    files: ["opencode.json", "AGENTS.md"],
    entry: (projectDir, local) => {
      const { command, args } = mcpEntry("opencode", projectDir, local);
      return { type: "local", command: [command, ...args] };
    },
    notes: ["opencode reads opencode.json from the project root."],
    write: ({ projectDir, entry, browserEntry, docsPath, dryRun }) => {
      const config = join(projectDir, "opencode.json");
      mergeJson(config, "mcp", "using-kanban", entry, dryRun);
      if (browserEntry) {
        mergeJson(
          config,
          "mcp",
          "playwright",
          {
            type: "local",
            command: ["npx", ...(browserEntry.args as string[])],
          },
          dryRun,
        );
      }
      upsertDocs(docsPath, dryRun);
    },
  },
  pi: {
    agent: "pi",
    label: "Pi",
    files: ["~/.pi/agent/settings.json", "AGENTS.md"],
    // Pi has no project-level MCP file: it reads ~/.pi/agent/mcp.json for
    // servers and ~/.pi/agent/settings.json `packages` for extensions.
    entry: (projectDir, local) =>
      local
        ? {
            command: process.execPath,
            args: [resolveLocalMcpBin() ?? "", "--agent", "pi"],
          }
        : mcpEntry("pi", projectDir, false),
    notes: [
      "Pi picks the package up from ~/.pi/agent/settings.json — restart Pi to load it.",
      "The package ships both the extension (tools in context) and the skill (workflow).",
    ],
    write: ({ home, projectDir, dryRun }) => {
      registerPiPackage(home, dryRun);
      upsertDocs(join(projectDir, "AGENTS.md"), dryRun);
    },
  },
};

const ALIASES: Record<string, string> = {
  pi: "pi",
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  opencode: "opencode",
};

export async function runInit(
  flags: Record<string, string | true>,
  io: Io,
  projectDir: string,
  home: string = homedir(),
): Promise<number> {
  const requested = flagString(flags, "for");
  if (!requested) {
    io.stderr(
      "ukb init needs a framework: ukb init --for claude-code | codex | opencode\n",
    );
    io.stderr(
      `known frameworks: ${Object.keys(FRAMEWORKS).join(", ")} (others get the generic setup)\n`,
    );
    return 1;
  }

  const dryRun = flagBoolean(flags, "dry-run");
  const local = flagBoolean(flags, "local");
  const browserEntry = flagBoolean(flags, "browser")
    ? browserMcpEntry()
    : undefined;
  const key = ALIASES[requested] ?? requested;
  const spec = FRAMEWORKS[key];
  const agentName = spec?.agent ?? flagString(flags, "agent") ?? "agent";

  const entry = spec
    ? spec.entry(projectDir, local)
    : mcpEntry(agentName, projectDir, local);

  io.stdout(`ukb init — ${spec ? spec.label : requested}`);
  io.stdout(`  project  ${projectDir}`);
  io.stdout(`  agent    ${agentName}`);
  if (dryRun) io.stdout("  dry run  nothing will be written");
  if (local)
    io.stdout("  local    using this checkout, not the published package");
  io.stdout("");

  if (!spec) {
    // Unknown harness: print the config for the user to paste, and still teach
    // the workflow through the docs file every agent reads.
    io.stdout(
      `No dedicated installer for "${requested}" yet. Add this MCP server to your harness:`,
    );
    io.stdout("");
    const servers: Record<string, unknown> = { "using-kanban": entry };
    if (browserEntry) servers.playwright = browserEntry;
    io.stdout(JSON.stringify({ mcpServers: servers }, null, 2));
    io.stdout("");
    upsertDocs(join(projectDir, "AGENTS.md"), dryRun);
    io.stdout(
      `  wrote    AGENTS.md (workflow snippet — most harnesses read it)`,
    );
    return 0;
  }

  spec.write({
    projectDir,
    home,
    entry,
    browserEntry,
    docsPath: join(
      projectDir,
      key === "claude-code" ? "CLAUDE.md" : "AGENTS.md",
    ),
    dryRun,
    local,
  });

  for (const file of spec.files) {
    io.stdout(`  wrote    ${file}`);
  }
  if (browserEntry) {
    io.stdout("  wrote    playwright MCP server (agents can drive a browser)");
  }
  for (const note of spec.notes) {
    io.stdout(`  note     ${note}`);
  }
  return 0;
}

/* ------------------------------- writers ------------------------------- */

function mergeJson(
  path: string,
  section: string,
  key: string,
  entry: Record<string, unknown>,
  dryRun: boolean,
): void {
  const existing = readJson(path);
  const target = (existing[section] ?? {}) as Record<string, unknown>;
  target[key] = entry;
  existing[section] = target;
  writeText(path, `${JSON.stringify(existing, null, 2)}\n`, dryRun);
}

function upsertToml(
  path: string,
  key: string,
  entry: Record<string, unknown>,
  dryRun: boolean,
): void {
  const { start: startMarker, end: endMarker } = tomlMarkers(key);
  const args = (entry.args as string[]).map((arg) => `"${arg}"`).join(", ");
  const block = [
    startMarker,
    `[mcp_servers.${key}]`,
    `command = "${String(entry.command)}"`,
    `args = [${args}]`,
    endMarker,
  ].join("\n");

  const current = readText(path);
  let next: string;
  if (current.includes(startMarker) && current.includes(endMarker)) {
    const start = current.indexOf(startMarker);
    const end = current.indexOf(endMarker) + endMarker.length;
    next = `${current.slice(0, start)}${block}${current.slice(end)}`;
  } else {
    const separator =
      current.length === 0 || current.endsWith("\n\n")
        ? ""
        : current.endsWith("\n")
          ? "\n"
          : "\n\n";
    next = `${current}${separator}${block}\n`;
  }
  writeText(path, next, dryRun);
}

/**
 * Point Pi at the local `packages/pi` package by adding it to the `packages`
 * array in ~/.pi/agent/settings.json.
 *
 * A plain mcp.json entry is not enough: it defaults to `exposure: "codemode"`,
 * so the tools stay invisible to the model. The package instead registers a
 * native `ukb` tool (and a `/ukb` slash command) as a Pi extension, which lands
 * the board directly in the agent's tool list — the difference between an agent
 * using the board and never touching it.
 */
function registerPiPackage(home: string, dryRun: boolean): void {
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  const settings = readJson(settingsPath);
  const existing = Array.isArray(settings.packages)
    ? (settings.packages as unknown[])
    : [];
  const target = resolveLocalPiPackage();
  if (!target) {
    throw new Error(
      "ukb init --for pi could not find packages/pi in this checkout. " +
        "Run it from a source checkout, or add the package to ~/.pi/agent/settings.json by hand.",
    );
  }
  if (!existing.includes(target)) settings.packages = [...existing, target];
  writeText(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, dryRun);
}

/** `<repo>/packages/pi`, found by walking up from this package. */
function resolveLocalPiPackage(): string | undefined {
  const url = hereUrl();
  if (!url) return undefined;
  let dir = dirname(fileURLToPath(url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, "packages", "pi", "package.json");
    if (existsSync(candidate)) return dirname(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function upsertDocs(path: string, dryRun: boolean): void {
  const current = readText(path);
  let next: string;
  if (current.includes(DOCS_START) && current.includes(DOCS_END)) {
    const start = current.indexOf(DOCS_START);
    const end = current.indexOf(DOCS_END) + DOCS_END.length;
    next = `${current.slice(0, start)}${GENERIC_DOCS_SNIPPET}${current.slice(end)}`;
  } else {
    const separator =
      current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    next = `${current}${separator}${GENERIC_DOCS_SNIPPET}\n`;
  }
  writeText(path, next, dryRun);
}

/* -------------------------------- fs utils ------------------------------ */

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    throw new Error(
      `${path} exists but is not valid JSON — fix or remove it and re-run`,
    );
  }
  return {};
}

function readText(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function writeText(path: string, contents: string, dryRun: boolean): void {
  if (dryRun) return;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

export { FRAMEWORKS, GENERIC_DOCS_SNIPPET };
