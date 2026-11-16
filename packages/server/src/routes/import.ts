import { StoredEventSchema } from "@wayblink/using-kanban-core";
import { z } from "zod";
import { HttpError, readBodyObject, sendJson } from "../http.js";
import type { RequestContext } from "../router.js";

/**
 * `POST /api/import/events` — one-shot migration of an event log from another
 * board (same event ids and card ids).
 *
 * Off by default (`UKB_ALLOW_IMPORT=1`), admin-only, and the target must be
 * empty unless `force`. It writes events directly; it is not a general create
 * API and never assigns new ids.
 */
const ImportBodySchema = z.object({
  events: z.array(StoredEventSchema).min(1).max(20_000),
  force: z.boolean().optional(),
});

export async function importEvents(ctx: RequestContext): Promise<void> {
  if (ctx.options.allowImport !== true) {
    throw new HttpError(404, "not_found", "import endpoint is disabled");
  }
  if (ctx.identity?.role !== "admin") {
    throw new HttpError(403, "forbidden", "only an admin can import events");
  }
  const parsed = ImportBodySchema.safeParse(readBodyObject(ctx.body));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(
      400,
      "invalid_input",
      issue === undefined ? "invalid import body" : issue.message,
    );
  }
  const summary = await ctx.kanban.importEvents(parsed.data.events, {
    force: parsed.data.force,
  });
  sendJson(ctx.res, 200, summary);
}
