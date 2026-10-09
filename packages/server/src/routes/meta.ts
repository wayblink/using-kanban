import { CARD_STATES } from "@wayblink/using-kanban-core";
import { sendJson } from "../http.js";
import { openApiSpec } from "../openapi.js";
import type { RequestContext } from "../router.js";

export function health(ctx: RequestContext): void {
  sendJson(ctx.res, 200, { ok: true });
}

export function me(ctx: RequestContext): void {
  const board = ctx.kanban.board();
  sendJson(ctx.res, 200, {
    actor: ctx.actor,
    storage: { kind: ctx.options.storage, dir: ctx.options.dir },
    counts: {
      todo: board.todo.length,
      doing: board.doing.length,
      review: board.review.length,
      done: board.done.length,
    },
    states: CARD_STATES,
  });
}

export function openapi(ctx: RequestContext): void {
  sendJson(ctx.res, 200, openApiSpec());
}
