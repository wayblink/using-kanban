import type { CardState } from "@wayblink/using-kanban-core";
import { CARD_STATES } from "@wayblink/using-kanban-core";
import {
  HttpError,
  parseIfMatch,
  readBodyObject,
  sendJson,
  sendNoContent,
} from "../http.js";
import type { RequestContext } from "../router.js";

/* ------------------------------- queries ------------------------------- */

export function getBoard(ctx: RequestContext): void {
  sendJson(ctx.res, 200, ctx.kanban.board());
}

export function listCards(ctx: RequestContext): void {
  const { query, kanban, actor } = ctx;

  const state = query.get("state");
  const assignee = query.get("assignee");
  const reviewer = query.get("reviewer");
  const text = query.get("q")?.toLowerCase();

  let cards = kanban.cards();

  if (state === "open") {
    cards = cards.filter((card) => card.state !== "done");
  } else if (state !== null) {
    if (!isCardState(state)) {
      throw new HttpError(
        400,
        "invalid_state",
        `state must be one of ${CARD_STATES.join(", ")} or "open"`,
      );
    }
    cards = cards.filter((card) => card.state === state);
  }

  if (assignee !== null) {
    const name = assignee === "me" ? actor.name : assignee;
    cards = cards.filter((card) => card.assignee === name);
  }
  if (reviewer !== null) {
    const name = reviewer === "me" ? actor.name : reviewer;
    cards = cards.filter((card) => card.reviewer === name);
  }
  if (text) {
    cards = cards.filter(
      (card) =>
        card.title.toLowerCase().includes(text) ||
        (card.body ?? "").toLowerCase().includes(text),
    );
  }

  sendJson(ctx.res, 200, { cards });
}

export function getCard(ctx: RequestContext): void {
  const id = parseId(ctx);
  const card = ctx.kanban.card(id);
  if (!card) {
    throw notFound(id);
  }
  sendJson(ctx.res, 200, { card, history: ctx.kanban.history(id) });
}

export function getCardHistory(ctx: RequestContext): void {
  const id = parseId(ctx);
  const card = ctx.kanban.card(id);
  if (!card) {
    throw notFound(id);
  }
  sendJson(ctx.res, 200, { events: ctx.kanban.history(id) });
}

/* ------------------------------ mutations ------------------------------ */

export function createCard(ctx: RequestContext): void {
  const input = readBodyObject(ctx.body);
  const result = ctx.kanban.add(
    input as Parameters<typeof ctx.kanban.add>[0],
    ctx.actor,
    ctx.source,
  );
  sendJson(ctx.res, 201, { card: result.card });
}

export function updateCard(ctx: RequestContext): void {
  const id = parseId(ctx);
  const patch = readBodyObject(ctx.body);
  const result = ctx.kanban.edit(
    id,
    patch as Parameters<typeof ctx.kanban.edit>[1],
    ctx.actor,
    ctx.source,
    { expectedRevision: expectedRevision(ctx, patch) },
  );
  sendJson(ctx.res, 200, { card: result.card });
}

export function deleteCard(ctx: RequestContext): void {
  const id = parseId(ctx);
  ctx.kanban.remove(id, ctx.actor, ctx.source);
  sendNoContent(ctx.res);
}

export function claimCard(ctx: RequestContext): void {
  const id = parseId(ctx);
  const result = ctx.kanban.claim(id, ctx.actor, ctx.source, {
    expectedRevision: expectedRevision(ctx, readBodyObject(ctx.body)),
  });
  sendJson(ctx.res, 200, { card: result.card });
}

export function reviewCard(ctx: RequestContext): void {
  const id = parseId(ctx);
  const result = ctx.kanban.review(id, ctx.actor, ctx.source, {
    expectedRevision: expectedRevision(ctx, readBodyObject(ctx.body)),
  });
  sendJson(ctx.res, 200, { card: result.card });
}

export function doneCard(ctx: RequestContext): void {
  const id = parseId(ctx);
  const result = ctx.kanban.done(id, ctx.actor, ctx.source, {
    expectedRevision: expectedRevision(ctx, readBodyObject(ctx.body)),
  });
  sendJson(ctx.res, 200, { card: result.card });
}

export function reopenCard(ctx: RequestContext): void {
  const id = parseId(ctx);
  const result = ctx.kanban.reopen(id, ctx.actor, ctx.source, {
    expectedRevision: expectedRevision(ctx, readBodyObject(ctx.body)),
  });
  sendJson(ctx.res, 200, { card: result.card });
}

export function moveCard(ctx: RequestContext): void {
  const id = parseId(ctx);
  const body = readBodyObject(ctx.body);
  const to = body.to;
  if (!isCardState(to)) {
    throw new HttpError(
      400,
      "invalid_state",
      `body.to must be one of ${CARD_STATES.join(", ")}`,
    );
  }
  const result = ctx.kanban.move(id, to, ctx.actor, ctx.source, {
    expectedRevision: expectedRevision(ctx, body),
  });
  sendJson(ctx.res, 200, { card: result.card });
}

export function blockCard(ctx: RequestContext): void {
  const id = parseId(ctx);
  const blockedBy = readBodyObject(ctx.body).blockedBy;
  if (typeof blockedBy !== "number") {
    throw new HttpError(
      400,
      "invalid_input",
      "body.blockedBy must be a card id (number)",
    );
  }
  const result = ctx.kanban.block(id, blockedBy, ctx.actor, ctx.source);
  sendJson(ctx.res, 200, { card: result.card });
}

export function unblockCard(ctx: RequestContext): void {
  const id = parseId(ctx);
  const blockedBy = readBodyObject(ctx.body).blockedBy;
  if (typeof blockedBy !== "number") {
    throw new HttpError(
      400,
      "invalid_input",
      "body.blockedBy must be a card id (number)",
    );
  }
  const result = ctx.kanban.unblock(id, blockedBy, ctx.actor, ctx.source);
  sendJson(ctx.res, 200, { card: result.card });
}

/* ------------------------------- helpers ------------------------------- */

function parseId(ctx: RequestContext): number {
  const raw = ctx.params.id;
  const id = Number(raw);
  if (raw === undefined || !Number.isInteger(id) || id <= 0) {
    throw new HttpError(
      400,
      "invalid_input",
      "card id must be a positive integer",
    );
  }
  return id;
}

function notFound(id: number): HttpError {
  return new HttpError(404, "card_not_found", `card ${id} not found`);
}

function isCardState(value: unknown): value is CardState {
  return (
    typeof value === "string" &&
    (CARD_STATES as readonly string[]).includes(value)
  );
}

/** `If-Match` header wins over `expectedRevision` in the body. */
function expectedRevision(
  ctx: RequestContext,
  body: Record<string, unknown>,
): number | undefined {
  const fromHeader = parseIfMatch(ctx.req.headers["if-match"]);
  if (fromHeader !== undefined) return fromHeader;
  const fromBody = body.expectedRevision;
  return typeof fromBody === "number" ? fromBody : undefined;
}
