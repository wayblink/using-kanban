import type { IncomingMessage, ServerResponse } from "node:http";
import { openKanban, type Kanban } from "@using-kanban/core";
import { authorizeRequest, resolveActor, resolveSource } from "./auth.js";
import { EventBroker } from "./broker.js";
import {
  HttpError,
  readJsonBody,
  sendFailure,
  sendJson,
  setCorsHeaders,
} from "./http.js";
import {
  resolveServerOptions,
  type ResolvedServerOptions,
  type ServerOptions,
} from "./options.js";
import { matchRoute, type RequestContext, type Route } from "./router.js";
import {
  blockCard,
  claimCard,
  createCard,
  deleteCard,
  doneCard,
  getBoard,
  getCard,
  getCardHistory,
  listCards,
  moveCard,
  reopenCard,
  reviewCard,
  unblockCard,
  updateCard,
} from "./routes/cards.js";
import { streamEvents } from "./routes/events.js";
import { health, me, openapi } from "./routes/meta.js";
import { serveStaticUi } from "./static.js";

const ROUTES: readonly Route[] = [
  { method: "GET", path: "/healthz", mutation: false, handler: health },
  { method: "GET", path: "/api/me", mutation: false, handler: me },
  { method: "GET", path: "/openapi.json", mutation: false, handler: openapi },
  { method: "GET", path: "/api/board", mutation: false, handler: getBoard },
  { method: "GET", path: "/api/cards", mutation: false, handler: listCards },
  { method: "POST", path: "/api/cards", mutation: true, handler: createCard },
  { method: "GET", path: "/api/cards/:id", mutation: false, handler: getCard },
  {
    method: "PATCH",
    path: "/api/cards/:id",
    mutation: true,
    handler: updateCard,
  },
  {
    method: "DELETE",
    path: "/api/cards/:id",
    mutation: true,
    handler: deleteCard,
  },
  {
    method: "GET",
    path: "/api/cards/:id/history",
    mutation: false,
    handler: getCardHistory,
  },
  {
    method: "POST",
    path: "/api/cards/:id/claim",
    mutation: true,
    handler: claimCard,
  },
  {
    method: "POST",
    path: "/api/cards/:id/review",
    mutation: true,
    handler: reviewCard,
  },
  {
    method: "POST",
    path: "/api/cards/:id/done",
    mutation: true,
    handler: doneCard,
  },
  {
    method: "POST",
    path: "/api/cards/:id/reopen",
    mutation: true,
    handler: reopenCard,
  },
  {
    method: "POST",
    path: "/api/cards/:id/move",
    mutation: true,
    handler: moveCard,
  },
  {
    method: "POST",
    path: "/api/cards/:id/block",
    mutation: true,
    handler: blockCard,
  },
  {
    method: "POST",
    path: "/api/cards/:id/unblock",
    mutation: true,
    handler: unblockCard,
  },
  {
    method: "GET",
    path: "/api/events",
    mutation: false,
    handler: streamEvents,
  },
];

export interface KanbanHandler {
  (req: IncomingMessage, res: ServerResponse): void;
  readonly kanban: Kanban;
  readonly broker: EventBroker;
  readonly options: ResolvedServerOptions;
  /** URL of the UI, token included, ready to open in a browser. */
  readonly url: string;
  close(): void;
}

/**
 * Builds the request handler. It is a plain `(req, res) => void` function, so it
 * drops into `http.createServer`, Express, Fastify, or any other host — that is
 * the embed-into-your-own-product path.
 */
export function createKanbanHandler(
  options: ServerOptions = {},
): KanbanHandler {
  const resolved = resolveServerOptions(options);
  const kanban = openKanban({ dir: resolved.dir, storage: resolved.storage });
  const broker = new EventBroker(kanban, resolved.ssePollMs);

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest(req, res, kanban, broker, resolved).catch(
      (error: unknown) => {
        sendFailure(res, error);
      },
    );
  };

  const bound = handler as KanbanHandler;
  Object.defineProperties(bound, {
    kanban: { value: kanban, enumerable: true },
    broker: { value: broker, enumerable: true },
    options: { value: resolved, enumerable: true },
    url: { value: buildUrl(resolved), enumerable: true },
    close: {
      value: (): void => {
        broker.close();
        kanban.close();
      },
      enumerable: true,
    },
  });
  return bound;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  kanban: Kanban,
  broker: EventBroker,
  options: ResolvedServerOptions,
): Promise<void> {
  setCorsHeaders(res, options.corsOrigin);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const pathname = url.pathname;

  if (pathname === "/" || pathname === "/index.html") {
    if (options.uiDir && serveStaticUi(res, options.uiDir, pathname)) return;
    sendJson(res, 200, {
      name: "using-kanban",
      docs: "/openapi.json",
      board: "/api/board",
      events: "/api/events",
      ui: options.uiDir
        ? "served from --ui"
        : "none configured (pass --ui <dir>)",
    });
    return;
  }

  const match = matchRoute(ROUTES, req.method ?? "GET", pathname);
  if (match.kind === "not-found") {
    if (options.uiDir && serveStaticUi(res, options.uiDir, pathname)) return;
    throw new HttpError(
      404,
      "not_found",
      `no route for ${req.method} ${pathname}`,
    );
  }
  if (match.kind === "method-not-allowed") {
    throw new HttpError(
      405,
      "method_not_allowed",
      `${req.method} is not allowed on ${pathname}`,
    );
  }

  const auth = authorizeRequest(req, url, options, match.route.mutation);
  if (!auth.ok) {
    throw new HttpError(auth.status, auth.code, auth.message);
  }

  const body = await readJsonBody(req);
  const ctx: RequestContext = {
    req,
    res,
    url,
    params: match.params,
    query: url.searchParams,
    body,
    actor: resolveActor(req, url, options.actor),
    source: resolveSource(req),
    kanban,
    broker,
    options,
  };

  await match.route.handler(ctx);
}

function buildUrl(options: ResolvedServerOptions): string {
  const displayHost =
    options.host === "0.0.0.0" || options.host === "::"
      ? "localhost"
      : options.host;
  const port = options.port === 0 ? "<port>" : String(options.port);
  return `http://${displayHost}:${port}/?token=${options.token}`;
}

export { createKanbanServer, startServer } from "./server.js";
