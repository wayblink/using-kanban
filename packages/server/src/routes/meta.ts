import { CARD_STATES } from "@wayblink/using-kanban-core";
import { sendJson } from "../http.js";
import { openApiSpec } from "../openapi.js";
import type { RequestContext } from "../router.js";

export async function health(ctx: RequestContext): Promise<void> {
  sendJson(ctx.res, 200, { ok: true });
}

export async function me(ctx: RequestContext): Promise<void> {
  const board = await ctx.kanban.board();
  sendJson(ctx.res, 200, {
    actor: ctx.actor,
    user: ctx.identity?.name ?? null,
    role: ctx.identity?.role ?? null,
    owner: ctx.options.owner,
    storage: { kind: ctx.options.storage, dir: ctx.options.dir },
    counts: {
      someday: board.someday.length,
      todo: board.todo.length,
      doing: board.doing.length,
      review: board.review.length,
      done: board.done.length,
    },
    states: CARD_STATES,
  });
}

export async function openapi(ctx: RequestContext): Promise<void> {
  sendJson(ctx.res, 200, openApiSpec());
}
