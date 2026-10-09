import type { IncomingMessage, ServerResponse } from "node:http";
import { KanbanError, type KanbanErrorCode } from "@wayblink/using-kanban-core";

/** An HTTP-level failure (bad JSON, bad actor header, …). */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

const STATUS_BY_CODE: Record<KanbanErrorCode, number> = {
  invalid_input: 400,
  card_not_found: 404,
  invalid_state: 409,
  claim_conflict: 409,
  forbidden: 403,
  revision_conflict: 409,
  internal_error: 500,
};

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendNoContent(res: ServerResponse): void {
  if (res.writableEnded) return;
  res.writeHead(204);
  res.end();
}

export function sendHttpError(res: ServerResponse, error: HttpError): void {
  sendJson(res, error.status, {
    error: { code: error.code, message: error.message },
  });
}

/** Maps domain + HTTP errors onto a stable JSON error envelope. */
export function sendFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendHttpError(res, error);
    return;
  }
  if (error instanceof KanbanError) {
    sendJson(res, STATUS_BY_CODE[error.code], {
      error: { code: error.code, message: error.message },
    });
    return;
  }
  const message = error instanceof Error ? error.message : "unexpected error";
  sendJson(res, 500, { error: { code: "internal_error", message } });
}

const MAX_BODY_BYTES = 1_000_000;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(
        413,
        "payload_too_large",
        `body exceeds ${MAX_BODY_BYTES} bytes`,
      );
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;

  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
}

/** Reads the request body as an object, for handlers that need named fields. */
export function readBodyObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(
      400,
      "invalid_json",
      "request body must be a JSON object",
    );
  }
  return body as Record<string, unknown>;
}

export function setCorsHeaders(res: ServerResponse, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Actor-Name, X-Actor-Type, X-Source, If-Match",
  );
  res.setHeader("Access-Control-Expose-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

/** `If-Match: 3` / `If-Match: "3"` / `If-Match: W/"3"` → 3 */
export function parseIfMatch(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /(\d+)/.exec(value);
  if (!match?.[1]) return undefined;
  return Number(match[1]);
}
