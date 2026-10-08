#!/usr/bin/env node
/**
 * MCP stdio entry point.
 *
 * stdout carries the JSON-RPC protocol and nothing else — every diagnostic goes
 * to stderr, otherwise the transport corrupts.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { resolveMcpOptions } from "./options.js";

async function main(): Promise<void> {
  const options = resolveMcpOptions(process.argv.slice(2), process.env);
  if (options.usedDefaultAgent) {
    process.stderr.write(
      '[ukb-mcp] no agent name given — acting as "agent". Pass --agent <name> (or set UKB_AGENT) so cards are attributed correctly.\n',
    );
  }

  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());

  process.stderr.write(
    `[ukb-mcp] ready — agent=${options.actor.type}/${options.actor.name} dir=${options.dir} storage=${options.storage}\n`,
  );

  const shutdown = (): void => {
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[ukb-mcp] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
