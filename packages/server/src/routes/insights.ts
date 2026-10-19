import {
  DEFAULT_INSIGHT_DAYS,
  MAX_INSIGHT_DAYS,
  buildInsights,
} from "@wayblink/using-kanban-core";
import { HttpError, sendJson } from "../http.js";
import type { RequestContext } from "../router.js";

/**
 * `GET /api/insights?days=30&tz=Asia/Shanghai` — the board over time.
 *
 * The aggregate is computed here, not in the browser, because the raw material
 * is the whole event log: `/api/log` is a newest-first window capped at 500
 * rows, and a 90-day question on a busy board would need several pages of it
 * before the first number could be drawn.
 *
 * `tz` is an IANA zone rather than an offset: the same offset means different
 * days in summer and winter, and the client already knows its zone.
 */
export function getInsights(ctx: RequestContext): void {
  const days = parseDays(ctx);
  const timeZone = parseTimeZone(ctx);
  const insights = buildInsights({
    events: ctx.kanban.events(),
    cards: ctx.kanban.cards(),
    days,
    timeZone,
  });
  sendJson(ctx.res, 200, insights);
}

function parseDays(ctx: RequestContext): number {
  const raw = ctx.query.get("days");
  if (raw === null || raw.trim() === "") return DEFAULT_INSIGHT_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_INSIGHT_DAYS) {
    throw new HttpError(
      400,
      "invalid_input",
      `days must be an integer between 1 and ${MAX_INSIGHT_DAYS}`,
    );
  }
  return days;
}

function parseTimeZone(ctx: RequestContext): string {
  const raw = ctx.query.get("tz");
  if (raw === null || raw.trim() === "") return "UTC";
  const timeZone = raw.trim();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    throw new HttpError(400, "invalid_input", `unknown time zone: ${timeZone}`);
  }
  return timeZone;
}
