import type { Server } from "node:http";
import { createServer } from "node:http";
import { createKanbanHandler, type KanbanHandler } from "./handler.js";
import type { ServerOptions } from "./options.js";

/** A listening kanban server. */
export interface RunningServer {
  server: Server;
  handler: KanbanHandler;
  /** UI URL including the token — safe to open locally or hand to a browser. */
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

export function createKanbanServer(options: ServerOptions = {}): {
  server: Server;
  handler: KanbanHandler;
} {
  const handler = createKanbanHandler(options);
  const server = createServer(handler);
  return { server, handler };
}

/** Starts listening and resolves once the port is known. */
export async function startServer(
  options: ServerOptions = {},
): Promise<RunningServer> {
  const { server, handler } = createKanbanServer(options);
  const { host, port } = handler.options;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort =
    typeof address === "object" && address !== null ? address.port : port;
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const url = `http://${displayHost}:${actualPort}/?token=${handler.options.token}`;

  return {
    server,
    handler,
    url,
    port: actualPort,
    token: handler.options.token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        handler.close();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
