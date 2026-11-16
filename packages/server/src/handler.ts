import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AccountStore,
  openKanban,
  type AccountIdentity,
  type Kanban,
} from "@wayblink/using-kanban-core";
import {
  LoginThrottle,
  authorizeRequest,
  resolveActor,
  resolveSource,
} from "./auth.js";
import { EventBroker } from "./broker.js";
import {
  HttpError,
  readJsonBody,
  sendFailure,
  sendJson,
  setCorsHeaders,
} from "./http.js";
import {
  assertBindPolicy,
  resolveServerOptions,
  type ResolvedServerOptions,
  type ServerOptions,
} from "./options.js";
import { matchRoute, type RequestContext, type Route } from "./router.js";
import {
  addCardNote,
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
  parentCard,
  reopenCard,
  relateCard,
  removeCardNote,
  reviewCard,
  unblockCard,
  unparentCard,
  unrelateCard,
  updateCard,
  updateCardNote,
} from "./routes/cards.js";
import { getDoc } from "./routes/docs.js";
import { listEvents, streamEvents } from "./routes/events.js";
import { getInsights } from "./routes/insights.js";
import { health, me, openapi } from "./routes/meta.js";
import { serveStaticUi } from "./static.js";

const ROUTES: readonly Route[] = [
  { method: "GET", path: "/healthz", mutation: false, handler: health },
  { method: "GET", path: "/api/me", mutation: false, handler: me },
  { method: "GET", path: "/openapi.json", mutation: false, handler: openapi },
  { method: "GET", path: "/api/board", mutation: false, handler: getBoard },
  {
    method: "GET",
    path: "/api/insights",
    mutation: false,
    handler: getInsights,
  },
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
    method: "POST",
    path: "/api/cards/:id/parent",
    mutation: true,
    handler: parentCard,
  },
  {
    method: "POST",
    path: "/api/cards/:id/unparent",
    mutation: true,
    handler: unparentCard,
  },
  {
    method: "POST",
    path: "/api/cards/:id/relate",
    mutation: true,
    handler: relateCard,
  },
  {
    method: "POST",
    path: "/api/cards/:id/unrelate",
    mutation: true,
    handler: unrelateCard,
  },
  {
    method: "POST",
    path: "/api/cards/:id/notes",
    mutation: true,
    handler: addCardNote,
  },
  {
    method: "PATCH",
    path: "/api/cards/:id/notes/:noteId",
    mutation: true,
    handler: updateCardNote,
  },
  {
    method: "DELETE",
    path: "/api/cards/:id/notes/:noteId",
    mutation: true,
    handler: removeCardNote,
  },
  {
    // Always token-gated: it reads files off this machine, which is a
    // different thing from reading the board.
    method: "GET",
    path: "/api/doc",
    mutation: true,
    handler: getDoc,
  },
  {
    method: "GET",
    path: "/api/log",
    mutation: false,
    handler: listEvents,
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
  /** The account file this server enforces, empty when the board stays local. */
  readonly accounts: AccountStore;
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
  const accounts = AccountStore.inStoreDir(resolved.dir);
  assertBindPolicy(resolved, accounts.hasUsers());
  const throttle = new LoginThrottle();
  const kanban = openKanban({
    dir: resolved.dir,
    storage: resolved.storage,
    owner: resolved.owner,
    postgresUrl: resolved.postgresUrl,
  });
  const broker = new EventBroker(kanban, resolved.ssePollMs);

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest(
      req,
      res,
      kanban,
      broker,
      resolved,
      accounts,
      throttle,
    ).catch((error: unknown) => {
      sendFailure(res, error);
    });
  };

  const bound = handler as KanbanHandler;
  Object.defineProperties(bound, {
    kanban: { value: kanban, enumerable: true },
    broker: { value: broker, enumerable: true },
    accounts: { value: accounts, enumerable: true },
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
  accounts: AccountStore,
  throttle: LoginThrottle,
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
  const match = matchRoute(ROUTES, req.method ?? "GET", pathname);

  // Health stays anonymous for probes; everything else — including the static
  // UI — goes through the credential check before a byte of the board leaks.
  let identity: AccountIdentity | null = null;
  if (pathname !== "/healthz") {
    const auth = await authorizeRequest(
      req,
      url,
      options,
      accounts,
      match.kind === "match" ? match.route.mutation : false,
      req.socket.remoteAddress ?? "unknown",
      throttle,
    );
    if (!auth.ok) {
      if (auth.challenge) {
        res.setHeader("WWW-Authenticate", 'Basic realm="ukb", charset="UTF-8"');
      }
      throw new HttpError(auth.status, auth.code, auth.message);
    }
    identity = auth.identity;
  }

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

  const body = await readJsonBody(req);
  const ctx: RequestContext = {
    req,
    res,
    url,
    params: match.params,
    query: url.searchParams,
    body,
    actor: resolveActor(
      req,
      url,
      identity === null
        ? options.actor
        : { type: "human", name: identity.name },
    ),
    source: resolveSource(req),
    identity,
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
