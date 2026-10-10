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
  // `?project=` narrows the board; the full project list always comes back so
  // a client can build its filter without a second call.
  const project = ctx.query.get("project");
  sendJson(ctx.res, 200, {
    ...ctx.kanban.board(project),
    projects: ctx.kanban.projects(),
  });
}

export function listCards(ctx: RequestContext): void {
  const { query, kanban, actor } = ctx;

  const state = query.get("state");
  const assignee = query.get("assignee");
  const reviewer = query.get("reviewer");
  const project = query.get("project");
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
  if (project !== null) {
    cards = cards.filter((card) => card.project === project);
  }
  if (text) {
    cards = cards.filter(
      (card) =>
        card.title.toLowerCase().includes(text) ||
        (card.body ?? "").toLowerCase().includes(text) ||
        card.notes.some(
          (note) =>
            note.text.toLowerCase().includes(text) ||
            (note.url ?? "").toLowerCase().includes(text),
        ),
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

export function relateCard(ctx: RequestContext): void {
  const id = parseId(ctx);
  const body = readBodyObject(ctx.body);
  const other = body.other;
  if (typeof other !== "number") {
    throw new HttpError(
      400,
      "invalid_input",
      "body.other must be a card id (number)",
    );
  }
  const direction = body.direction;
  if (direction !== "upstream" && direction !== "downstream") {
    throw new HttpError(
      400,
      "invalid_input",
      'body.direction must be "upstream" or "downstream"',
    );
  }
  const result = ctx.kanban.relate(id, other, direction, ctx.actor, ctx.source);
  sendJson(ctx.res, 200, { card: result.card });
}

export function unrelateCard(ctx: RequestContext): void {
  const id = parseId(ctx);
  const other = readBodyObject(ctx.body).other;
  if (typeof other !== "number") {
    throw new HttpError(
      400,
      "invalid_input",
      "body.other must be a card id (number)",
    );
  }
  const result = ctx.kanban.unrelate(id, other, ctx.actor, ctx.source);
  sendJson(ctx.res, 200, { card: result.card });
}

export function addCardNote(ctx: RequestContext): void {
  const id = parseId(ctx);
  const body = readBodyObject(ctx.body);
  const text = body.text;
  if (typeof text !== "string") {
    throw new HttpError(400, "invalid_input", "body.text is required");
  }
  const url = body.url;
  if (url !== undefined && url !== null && typeof url !== "string") {
    throw new HttpError(
      400,
      "invalid_input",
      "body.url must be a string or null",
    );
  }
  const result = ctx.kanban.addNote(id, { text, url }, ctx.actor, ctx.source);
  const note = result.card.notes[result.card.notes.length - 1];
  sendJson(ctx.res, 201, { note, card: result.card });
}

export function updateCardNote(ctx: RequestContext): void {
  const id = parseId(ctx);
  const noteId = parseNoteId(ctx);
  const body = readBodyObject(ctx.body);
  const patch: { text?: string; url?: string | null } = {};
  if (body.text !== undefined) {
    if (typeof body.text !== "string") {
      throw new HttpError(400, "invalid_input", "body.text must be a string");
    }
    patch.text = body.text;
  }
  if (body.url !== undefined) {
    if (body.url !== null && typeof body.url !== "string") {
      throw new HttpError(
        400,
        "invalid_input",
        "body.url must be a string or null",
      );
    }
    patch.url = body.url;
  }
  if (patch.text === undefined && patch.url === undefined) {
    throw new HttpError(
      400,
      "invalid_input",
      "nothing to update — pass text and/or url",
    );
  }
  const result = ctx.kanban.updateNote(
    id,
    noteId,
    patch,
    ctx.actor,
    ctx.source,
    { expectedRevision: expectedRevision(ctx, body) },
  );
  const note = result.card.notes.find((entry) => entry.id === noteId);
  sendJson(ctx.res, 200, { note, card: result.card });
}

export function removeCardNote(ctx: RequestContext): void {
  const id = parseId(ctx);
  const noteId = parseNoteId(ctx);
  ctx.kanban.removeNote(id, noteId, ctx.actor, ctx.source);
  sendNoContent(ctx.res);
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

function parseNoteId(ctx: RequestContext): number {
  const raw = ctx.params.noteId;
  const id = Number(raw);
  if (raw === undefined || !Number.isInteger(id) || id <= 0) {
    throw new HttpError(
      400,
      "invalid_input",
      "note id must be a positive integer",
    );
  }
  return id;
}

/** `If-Match` header wins over `expectedRevision` in the body. */ function expectedRevision(
  ctx: RequestContext,
  body: Record<string, unknown>,
): number | undefined {
  const fromHeader = parseIfMatch(ctx.req.headers["if-match"]);
  if (fromHeader !== undefined) return fromHeader;
  const fromBody = body.expectedRevision;
  return typeof fromBody === "number" ? fromBody : undefined;
}
