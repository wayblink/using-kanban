#!/usr/bin/env node
/**
 * MCP stdio entry point.
 *
 * stdout carries the JSON-RPC protocol and nothing else — every diagnostic goes
 * to stderr, otherwise the transport corrupts.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "@wayblink/using-kanban-config";
import { createMcpServer } from "./server.js";
import { resolveMcpOptions } from "./options.js";

async function main(): Promise<void> {
  // The config file is read here, at the edge, so the resolvers stay pure and a
  // test can hand them `{}` instead of whatever happens to be on this machine.
  const config = loadConfig(process.env);
  const options = resolveMcpOptions(process.argv.slice(2), process.env, config);
  if (options.usedDefaultAgent) {
    process.stderr.write(
      '[ukb-mcp] no agent name given — acting as "agent". Pass --agent <name> (or set agent in ~/.config/ukb/config.json) so cards are attributed correctly.\n',
    );
  }

  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());

  process.stderr.write(
    `[ukb-mcp] ready — agent=${options.actor.type}/${options.actor.name} owner=${options.owner} dir=${options.dir} storage=${options.storage}\n`,
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
