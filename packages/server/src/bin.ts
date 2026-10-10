#!/usr/bin/env node
import { startServer } from "./server.js";
import type { ServerOptions } from "./options.js";

interface ParsedArgs {
  options: ServerOptions;
  quiet: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const options: ServerOptions = {};
  let quiet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--dir":
        options.dir = next();
        break;
      case "--storage":
        options.storage = next() as ServerOptions["storage"];
        break;
      case "--host":
        options.host = next();
        break;
      case "--port":
        options.port = Number(next());
        break;
      case "--token":
        options.token = next();
        break;
      case "--actor":
        options.actor = { type: "human", name: next() };
        break;
      case "--actor-type":
        options.actor = {
          type: next() as "human" | "agent",
          name: String(options.actor?.name ?? ""),
        };
        break;
      case "--ui":
        options.uiDir = next();
        break;
      case "--doc-root":
        options.docRoots = [...(options.docRoots ?? []), next()];
        break;
      case "--cors-origin":
        options.corsOrigin = next();
        break;
      case "--quiet":
        quiet = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { options, quiet };
}

function printHelp(): void {
  process.stdout.write(
    [
      "ukb-server — local REST + SSE API for using-kanban",
      "",
      "Usage: ukb-server [options]",
      "",
      "  --dir <path>        board directory (store lives at <dir>/.ukb/)",
      "  --storage <kind>    sqlite (default) | jsonl | memory",
      "  --host <addr>       bind address (default 127.0.0.1)",
      "  --port <n>          port (default: random free port)",
      "  --token <token>     bearer token for mutations (default: generated)",
      "  --actor <name>      default actor name (default: $USER)",
      "  --actor-type <t>    human (default) | agent",
      "  --ui <dir>          static UI bundle to serve at /",
      "  --doc-root <dir>    a directory card notes may link documents from",
      "                      (repeatable; the store dir and cwd always count)",
      "  --cors-origin <o>   Access-Control-Allow-Origin (default: *)",
      "  --quiet             print only the URL",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const { options, quiet } = parseArgs(process.argv.slice(2));
  const running = await startServer(options);

  if (quiet) {
    process.stdout.write(`${running.url}\n`);
  } else {
    process.stdout.write(
      [
        `using-kanban server listening on ${running.url}`,
        "",
        `  board      GET  /api/board`,
        `  cards      GET  /api/cards?state=open&assignee=me`,
        `  events     GET  /api/events            (SSE, live board)`,
        `  openapi    GET  /openapi.json`,
        "",
        `  store      ${running.handler.options.dir}/.ukb (${running.handler.options.storage})`,
        `  actor      ${running.handler.options.actor.type}/${running.handler.options.actor.name}`,
        ...(running.handler.options.docRoots.length > 0
          ? [`  docs       ${running.handler.options.docRoots.join(", ")}`]
          : []),
        "",
        "Mutations need the token: Authorization: Bearer <token>, or ?token=<token>",
        "Press Ctrl+C to stop.",
        "",
      ].join("\n"),
    );
  }

  const shutdown = (): void => {
    void running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
