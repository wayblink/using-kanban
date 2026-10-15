import type { Event } from "@wayblink/using-kanban-core";
import { HttpError, sendJson } from "../http.js";
import type { RequestContext } from "../router.js";

const HEARTBEAT_MS = 15_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * `GET /api/log?limit=&before=&project=` — the shared log as JSON, newest
 * first.
 *
 * `/api/events` is the *stream* (SSE, for tailing). This is the *read*: an
 * audit view wants the last few hundred operations in one request, not a
 * connection it has to buffer itself. `before` is an event id cursor — pass the
 * oldest id you already hold to page further back — and `project` keeps only
 * the events that touched a card in that project.
 */
export function listEvents(ctx: RequestContext): void {
  const limit = parseLimit(ctx);
  const before = parseBefore(ctx);
  const project = parseProject(ctx);
  const all = ctx.kanban.events();
  const matching = project === null ? all : filterByProject(all, project);
  const older =
    before === null ? matching : matching.filter((event) => event.id < before);
  const page = older.slice(Math.max(0, older.length - limit)).reverse();
  sendJson(ctx.res, 200, { events: page, hasMore: older.length > limit });
}

// --- project attribution for the audit filter -------------------------

/** `project=slug`; absent or empty means "every project". */
function parseProject(ctx: RequestContext): string | null {
  const raw = ctx.query.get("project");
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  return value === "" ? null : value;
}

/**
 * Keep only events that touched a card in `project`.
 *
 * The project is not on the event — it lives on the card, can be changed, and
 * the card can be deleted. So fold it while walking the log in id order:
 * remember each card's project, apply a `patch.project` before using it, and
 * keep the deletion event (the card still belonged to that project when it
 * went). Without the fold a project filter could only ever see cards that still
 * exist — exactly what an audit view cannot afford.
 */
function filterByProject(events: readonly Event[], project: string): Event[] {
  const byCard = new Map<number, string | null>();
  const kept: Event[] = [];
  for (const event of events) {
    if (event.type === "card.created") {
      byCard.set(event.cardId, projectOf(event.payload.project));
    } else {
      const patch = event.payload.patch;
      if (typeof patch === "object" && patch !== null && "project" in patch) {
        byCard.set(event.cardId, projectOf(patch.project));
      }
    }
    if (byCard.get(event.cardId) === project) kept.push(event);
    if (event.type === "card.deleted") byCard.delete(event.cardId);
  }
  return kept;
}

function projectOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseLimit(ctx: RequestContext): number {
  const raw = ctx.query.get("limit");
  if (raw === null || raw === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new HttpError(
      400,
      "invalid_input",
      "limit must be a positive integer",
    );
  }
  return Math.min(value, MAX_LIMIT);
}

function parseBefore(ctx: RequestContext): number | null {
  const raw = ctx.query.get("before");
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new HttpError(
      400,
      "invalid_input",
      "before must be a positive event id",
    );
  }
  return value;
}

/**
 * `GET /api/events?since=<id>` — Server-Sent Events stream of the shared log.
 *
 * Backfills everything after `since`, then streams live events. Because the
 * broker tails the event log, mutations made by the CLI or an MCP server show
 * up here too.
 */
export function streamEvents(ctx: RequestContext): void {
  const since = parseSince(ctx);
  const res = ctx.res;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");

  const send = (event: Event): void => {
    // Each connection tracks its own cursor: the broker may hand us events the
    // client already received via backfill (or via an earlier poll).
    if (event.id <= lastSent) return;
    lastSent = event.id;
    if (res.writableEnded || res.destroyed) return;
    res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  let lastSent = since;
  for (const event of ctx.kanban.eventsSince(since)) {
    send(event);
  }

  const unsubscribe = ctx.broker.subscribe(send);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();

  res.on("close", () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
}

function parseSince(ctx: RequestContext): number {
  const raw = ctx.query.get("since");
  if (raw === null || raw === "") return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new HttpError(
      400,
      "invalid_input",
      "since must be a non-negative integer event id",
    );
  }
  return value;
}
