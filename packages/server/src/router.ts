import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor, EventSource, Kanban } from "@using-kanban/core";
import type { EventBroker } from "./broker.js";
import type { ResolvedServerOptions } from "./options.js";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body (`undefined` for bodiless requests). */
  body: unknown;
  actor: Actor;
  source: EventSource;
  kanban: Kanban;
  broker: EventBroker;
  options: ResolvedServerOptions;
}

export type RouteHandler = (ctx: RequestContext) => Promise<void> | void;

export interface Route {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  /** Mutations require the token even on loopback. */
  mutation: boolean;
  handler: RouteHandler;
}

export type RouteMatch =
  | { kind: "match"; route: Route; params: Record<string, string> }
  | { kind: "method-not-allowed" }
  | { kind: "not-found" };

/** Matches `/api/cards/:id`-style patterns. */
export function matchRoute(
  routes: readonly Route[],
  method: string,
  pathname: string,
): RouteMatch {
  const segments = splitPath(pathname);
  let pathExists = false;

  for (const route of routes) {
    const params = matchSegments(splitPath(route.path), segments);
    if (!params) continue;
    pathExists = true;
    if (route.method === method) return { kind: "match", route, params };
  }

  return pathExists ? { kind: "method-not-allowed" } : { kind: "not-found" };
}

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function matchSegments(
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index];
    const received = actual[index];
    if (expected === undefined || received === undefined) return null;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(received);
      continue;
    }
    if (expected !== received) return null;
  }
  return params;
}
