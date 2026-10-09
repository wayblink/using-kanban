import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  entry: (projectDir: string) => Record<string, unknown>;
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
}

/** The optional Playwright MCP server, so agents can drive a browser too. */
function browserMcpEntry(): Record<string, unknown> {
  return {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--headless"],
  };
}

/** `npx -y @using-kanban/mcp --agent <name> --dir <project>` */
function mcpArgs(agent: string, projectDir: string): string[] {
  return ["-y", "@using-kanban/mcp", "--agent", agent, "--dir", projectDir];
}

const GENERIC_DOCS_SNIPPET = `${DOCS_START}
## Kanban — using-kanban

This project shares a kanban board (\`.ukb/\`) between you and the human.

- Start every turn with \`ukb\` — it lists your open cards. Treat it as work to do, not a status report.
- Before working a card, read it: \`ukb show <id>\` (the body holds the target files and acceptance criteria).
- Always claim before starting: \`ukb claim <id>\` — it moves the card to doing and marks you as the owner.
- When the work is ready: \`ukb review <id>\`. As the reviewer, approve with \`ukb done <id>\`.
- If work has to go back: \`ukb reopen <id>\` and say why via \`ukb edit <id> --body "..."\`.
- Prefer the \`kanban_*\` MCP tools when they are available; fall back to the CLI.

\`ukb board\` shows everything. \`ukb web\` opens the board in a browser.
${DOCS_END}`;

const FRAMEWORKS: Record<string, FrameworkSpec> = {
  "claude-code": {
    agent: "claude-code",
    label: "Claude Code",
    files: [".mcp.json", "CLAUDE.md"],
    entry: (projectDir) => ({
      command: "npx",
      args: mcpArgs("claude-code", projectDir),
    }),
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
    entry: (projectDir) => ({
      command: "npx",
      args: mcpArgs("codex", projectDir),
    }),
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
    entry: (projectDir) => ({
      type: "local",
      command: ["npx", ...mcpArgs("opencode", projectDir)],
    }),
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
};

const ALIASES: Record<string, string> = {
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
  const browserEntry = flagBoolean(flags, "browser")
    ? browserMcpEntry()
    : undefined;
  const key = ALIASES[requested] ?? requested;
  const spec = FRAMEWORKS[key];
  const agentName = spec?.agent ?? flagString(flags, "agent") ?? "agent";

  const entry = spec
    ? spec.entry(projectDir)
    : { command: "npx", args: mcpArgs(agentName, projectDir) };

  io.stdout(`ukb init — ${spec ? spec.label : requested}`);
  io.stdout(`  project  ${projectDir}`);
  io.stdout(`  agent    ${agentName}`);
  if (dryRun) io.stdout("  dry run  nothing will be written");
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
