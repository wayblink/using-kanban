const CARD_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "integer" },
    title: { type: "string" },
    body: { type: ["string", "null"] },
    state: { type: "string", enum: ["todo", "doing", "review", "done"] },
    assignee: { type: ["string", "null"] },
    reviewer: { type: ["string", "null"] },
    blockedBy: {
      type: "array",
      items: { type: "integer" },
      description: "upstream — the cards this one waits on",
    },
    blocks: {
      type: "array",
      items: { type: "integer" },
      description: "downstream — the cards waiting on this one",
    },
    notes: { type: "array", items: { $ref: "#/components/schemas/CardNote" } },
    createdBy: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    revision: { type: "integer" },
  },
} as const;

const CARD_NOTE_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "integer", description: "the card.note_added event id" },
    text: { type: "string" },
    url: {
      type: ["string", "null"],
      description:
        "document link — https://… or a path to a local file the UI renders",
    },
    createdBy: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const ERROR_SCHEMA = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: {
          type: "string",
          enum: [
            "invalid_input",
            "card_not_found",
            "invalid_state",
            "claim_conflict",
            "forbidden",
            "revision_conflict",
            "unauthorized",
            "invalid_json",
            "invalid_actor",
            "payload_too_large",
            "not_found",
            "internal_error",
          ],
        },
        message: { type: "string" },
      },
    },
  },
} as const;

function jsonBody(schema: unknown): Record<string, unknown> {
  return {
    required: true,
    content: { "application/json": { schema } },
  };
}

export function openApiSpec(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "using-kanban API",
      version: "0.1.0",
      description:
        "Headless kanban for AI agents and humans. Board state is event-sourced; " +
        "subscribe to /api/events for live updates. Mutations require a bearer token.",
    },
    servers: [{ url: "/", description: "this server" }],
    components: {
      schemas: {
        Card: CARD_SCHEMA,
        CardNote: CARD_NOTE_SCHEMA,
        Error: ERROR_SCHEMA,
        AddCardInput: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", minLength: 1 },
            body: { type: ["string", "null"] },
            assignee: { type: ["string", "null"] },
            reviewer: { type: ["string", "null"] },
            blockedBy: { type: "array", items: { type: "integer" } },
          },
        },
        EditCardInput: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1 },
            body: { type: ["string", "null"] },
            assignee: { type: ["string", "null"] },
            reviewer: { type: ["string", "null"] },
            expectedRevision: { type: "integer" },
          },
        },
        RelateInput: {
          type: "object",
          required: ["other", "direction"],
          properties: {
            other: {
              type: "integer",
              description: "the card on the other end of the relation",
            },
            direction: {
              type: "string",
              enum: ["upstream", "downstream"],
              description:
                'the side `other` sits on relative to this card — "upstream" makes this card wait on it',
            },
          },
        },
        UnrelateInput: {
          type: "object",
          required: ["other"],
          properties: { other: { type: "integer" } },
        },
        AddNoteInput: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1 },
            url: {
              type: ["string", "null"],
              description: "document link — https://… or a local file path",
            },
          },
        },
        UpdateNoteInput: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1 },
            url: { type: ["string", "null"], description: "null clears it" },
          },
        },
        MoveInput: {
          type: "object",
          required: ["to"],
          properties: {
            to: { type: "string", enum: ["todo", "doing", "review", "done"] },
            expectedRevision: { type: "integer" },
          },
        },
        BlockInput: {
          type: "object",
          required: ["blockedBy"],
          properties: { blockedBy: { type: "integer" } },
        },
      },
    },
    paths: {
      "/healthz": {
        get: {
          summary: "Liveness probe",
          responses: { "200": { description: "ok" } },
        },
      },
      "/api/me": {
        get: {
          summary: "Current actor, storage info, and column counts",
          responses: { "200": { description: "identity and counts" } },
        },
      },
      "/api/board": {
        get: {
          summary: "Full board grouped into columns",
          responses: { "200": { description: "board" } },
        },
      },
      "/api/cards": {
        get: {
          summary: "List cards",
          parameters: [
            {
              name: "state",
              in: "query",
              schema: {
                type: "string",
                enum: ["open", "todo", "doing", "review", "done"],
              },
            },
            {
              name: "assignee",
              in: "query",
              schema: { type: "string" },
              description: 'actor name or "me"',
            },
            {
              name: "reviewer",
              in: "query",
              schema: { type: "string" },
              description: 'actor name or "me"',
            },
            {
              name: "q",
              in: "query",
              schema: { type: "string" },
              description: "case-insensitive title/body search",
            },
          ],
          responses: { "200": { description: "cards" } },
        },
        post: {
          summary: "Create a card in todo",
          requestBody: jsonBody({ $ref: "#/components/schemas/AddCardInput" }),
          responses: {
            "201": { description: "created" },
            "400": { description: "invalid input" },
          },
        },
      },
      "/api/cards/{id}": {
        get: {
          summary: "Card detail with event history",
          responses: {
            "200": { description: "card" },
            "404": { description: "not found" },
          },
        },
        patch: {
          summary: "Edit card fields (creator or assignee)",
          requestBody: jsonBody({ $ref: "#/components/schemas/EditCardInput" }),
          responses: {
            "200": { description: "updated" },
            "403": { description: "forbidden" },
          },
        },
        delete: {
          summary: "Delete a card (creator only)",
          responses: {
            "204": { description: "deleted" },
            "403": { description: "forbidden" },
          },
        },
      },
      "/api/cards/{id}/history": {
        get: {
          summary: "Event history for a card",
          responses: { "200": { description: "events" } },
        },
      },
      "/api/cards/{id}/claim": {
        post: {
          summary: "todo → doing, assigned to the actor",
          responses: {
            "200": { description: "claimed" },
            "409": { description: "conflict" },
          },
        },
      },
      "/api/cards/{id}/review": {
        post: {
          summary: "→ review",
          responses: { "200": { description: "in review" } },
        },
      },
      "/api/cards/{id}/done": {
        post: {
          summary: "→ done (idempotent)",
          responses: { "200": { description: "done" } },
        },
      },
      "/api/cards/{id}/reopen": {
        post: {
          summary: "→ todo",
          responses: { "200": { description: "reopened" } },
        },
      },
      "/api/cards/{id}/move": {
        post: {
          summary: "Move to an arbitrary column",
          requestBody: jsonBody({ $ref: "#/components/schemas/MoveInput" }),
          responses: { "200": { description: "moved" } },
        },
      },
      "/api/cards/{id}/block": {
        post: {
          summary: "Add a dependency",
          requestBody: jsonBody({ $ref: "#/components/schemas/BlockInput" }),
          responses: { "200": { description: "blocked" } },
        },
      },
      "/api/cards/{id}/unblock": {
        post: {
          summary: "Remove a dependency",
          requestBody: jsonBody({ $ref: "#/components/schemas/BlockInput" }),
          responses: { "200": { description: "unblocked" } },
        },
      },
      "/api/cards/{id}/relate": {
        post: {
          summary:
            "Relate two cards — upstream/downstream, many-to-many, either side",
          requestBody: jsonBody({ $ref: "#/components/schemas/RelateInput" }),
          responses: {
            "200": { description: "related" },
            "400": { description: "cycle, self-relation, or bad direction" },
          },
        },
      },
      "/api/cards/{id}/unrelate": {
        post: {
          summary: "Remove a relation, whichever way round it runs",
          requestBody: jsonBody({ $ref: "#/components/schemas/UnrelateInput" }),
          responses: { "200": { description: "unrelated" } },
        },
      },
      "/api/cards/{id}/notes": {
        post: {
          summary: "Add a note — a remark with an optional document link",
          requestBody: jsonBody({ $ref: "#/components/schemas/AddNoteInput" }),
          responses: {
            "201": { description: "note added" },
            "400": { description: "invalid input" },
          },
        },
      },
      "/api/cards/{id}/notes/{noteId}": {
        patch: {
          summary: "Edit a note's text and/or link",
          requestBody: jsonBody({
            $ref: "#/components/schemas/UpdateNoteInput",
          }),
          responses: {
            "200": { description: "note updated" },
            "404": { description: "note not on this card" },
          },
        },
        delete: {
          summary: "Remove a note",
          responses: { "204": { description: "removed" } },
        },
      },
      "/api/doc": {
        get: {
          summary:
            "The document behind a note's link — markdown/HTML/text, plus raw bytes with ?raw=1",
          description:
            "Always needs the token: it reads files off this machine. The path " +
            "must resolve inside a --doc-root directory, the store directory, " +
            "or the server's working directory.",
          parameters: [
            {
              name: "path",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "absolute path, or one relative to an allowed root",
            },
            {
              name: "raw",
              in: "query",
              schema: { type: "string", enum: ["1"] },
              description: "stream the file itself instead of JSON",
            },
          ],
          responses: {
            "200": { description: "document" },
            "403": { description: "path outside the allowed roots" },
            "404": { description: "no such document" },
          },
        },
      },
      "/api/events": {
        get: {
          summary: "SSE stream of board events",
          parameters: [
            {
              name: "since",
              in: "query",
              schema: { type: "integer" },
              description: "backfill after this event id",
            },
          ],
          responses: { "200": { description: "text/event-stream" } },
        },
      },
    },
  };
}
