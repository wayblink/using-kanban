import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Registers the existing MCP server as a Pi extension.
 *
 * Why an extension rather than a plain `mcp.json` entry: a server configured in
 * `mcp.json` defaults to `exposure: "codemode"`, which means its tools are only
 * reachable indirectly through codemode and never appear in the agent's tool
 * list. An extension can register the same server with `exposure: "direct"`,
 * which puts every tool in the context where the model actually looks — and
 * that is the difference between an agent using the board and ignoring it.
 *
 * No tool logic lives here. The server is the one package, shared with the CLI,
 * the HTTP API and every other front door.
 */
export default function usingKanbanExtension(pi: ExtensionAPI): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // <repo>/packages/pi/extensions/using-kanban -> <repo>/packages/mcp/dist/bin.js
  // (three levels: the extension dir itself, extensions/, then pi/ — dirname has
  // already stripped index.ts)
  const bin = resolve(here, "../../../mcp/dist/bin.js");

  pi.registerMcpServer("using-kanban", {
    command: process.execPath,
    args: [bin, "--agent", "pi"],
    // Direct, not codemode: the tools must be visible to the model.
    exposure: "direct",
    // Shows up in the `mcp_servers` section of the system prompt.
    description:
      "Shared kanban board for AI agents and humans — see your cards, claim work before starting it, hand it off for review. Each project has its own board in .ukb/.",
    enabled: true,
  });

  if (!existsSync(bin)) {
    // The extension must not throw during startup — that would take the whole
    // agent down. Warn instead: the tools simply will not appear.
    process.stderr.write(
      `[using-kanban] MCP server not built at ${bin} — run \`pnpm -r build\` in the using-kanban repo.\n`,
    );
  }
}
