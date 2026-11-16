/**
 * The board over HTTP: the client side of a shared `ukb web`.
 *
 * The wire is the server's own REST API, so nothing here invents a second
 * protocol. Reads are derived from `/api/cards` (the same projection rules the
 * local store uses); mutations post to the endpoint the Web UI already calls.
 *
 * The methods return Promises like every other {@link BoardService}. Errors keep
 * the server's domain codes (`card_not_found`, `claim_conflict`, …) so the CLI
 * and MCP server print the words a local board would print.
 */
import { KanbanError, type KanbanErrorCode } from "./errors.js";
import type { MutationResult } from "./kanban.js";
import type {
  AddCardInput,
  AddNoteInput,
  EditCardInput,
  MutationOptions,
  UpdateNoteInput,
} from "./schemas.js";
import type { BoardService } from "./service.js";
import {
  onRadar,
  type Actor,
  type Board,
  type Card,
  type CardState,
  type Event,
  type EventSource,
  type ProjectSummary,
  type RelationDirection,
} from "./types.js";

export interface RemoteBoardOptions {
  /** Server origin, e.g. `https://board.example.com`. */
  readonly baseUrl: string;
  /** Machine token (`ukb_…`) or the server's generated token. */
  readonly token?: string | null | undefined;
}

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

interface RequestOptions {
  query?: Record<string, string | null | undefined>;
  body?: unknown;
  actor?: Actor;
  source?: EventSource;
  expectedRevision?: number | undefined;
}

const KANBAN_CODES: ReadonlySet<string> = new Set<KanbanErrorCode>([
  "invalid_input",
  "card_not_found",
  "board_not_found",
  "invalid_state",
  "claim_conflict",
  "forbidden",
  "revision_conflict",
  "internal_error",
]);

export class RemoteBoard implements BoardService {
  private readonly baseUrl: string;
  private readonly token: string | null;

  constructor(options: RemoteBoardOptions) {
    // Keep one trailing-slash-free base so `/api/...` joins are predictable.
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.token = options.token?.trim() || null;
  }

  /* -------------------------------- queries -------------------------------- */

  async board(
    project?: string | null,
    subproject?: string | null,
  ): Promise<Board> {
    const body = await this.request<Board & { projects?: string[] }>(
      "GET",
      "/api/board",
      { query: { project, subproject } },
    );
    return {
      someday: body.someday,
      todo: body.todo,
      doing: body.doing,
      review: body.review,
      done: body.done,
    };
  }

  async cards(): Promise<Card[]> {
    const body = await this.request<{ cards: Card[] }>("GET", "/api/cards");
    return body.cards;
  }

  async card(id: number): Promise<Card | null> {
    try {
      const body = await this.request<{ card: Card }>(
        "GET",
        `/api/cards/${id}`,
      );
      return body.card;
    } catch (error) {
      if (error instanceof KanbanError && error.code === "card_not_found") {
        return null;
      }
      throw error;
    }
  }

  async history(id: number): Promise<Event[]> {
    const body = await this.request<{ events: Event[] }>(
      "GET",
      `/api/cards/${id}/history`,
    );
    return body.events;
  }

  async mine(
    assignee: string,
    project?: string | null,
    subproject?: string | null,
  ): Promise<Card[]> {
    const cards = await this.cards();
    return cards.filter(
      (card) =>
        card.assignee === assignee &&
        onRadar(card.state) &&
        inScope(card, project, subproject),
    );
  }

  async reviewQueue(
    reviewer: string,
    project?: string | null,
    subproject?: string | null,
  ): Promise<Card[]> {
    const cards = await this.cards();
    return cards.filter(
      (card) =>
        card.reviewer === reviewer &&
        card.state === "review" &&
        inScope(card, project, subproject),
    );
  }

  async childrenOf(id: number): Promise<Card[]> {
    const cards = await this.cards();
    const parent = cards.find((card) => card.id === id);
    if (parent === undefined) {
      throw new KanbanError("card_not_found", `card ${id} not found`);
    }
    const byId = new Map(cards.map((card) => [card.id, card]));
    const children: Card[] = [];
    for (const childId of parent.children) {
      const child = byId.get(childId);
      if (child !== undefined) children.push(child);
    }
    return children;
  }

  async projects(): Promise<string[]> {
    const cards = await this.cards();
    const names = new Set<string>();
    for (const card of cards) {
      if (card.project) names.add(card.project);
    }
    return [...names].sort();
  }

  async projectSummary(): Promise<ProjectSummary[]> {
    const cards = await this.cards();
    const summaries = new Map<string | null, ProjectSummary>();
    for (const card of cards) {
      const key = card.project ?? null;
      const entry = summaries.get(key) ?? {
        project: key,
        someday: 0,
        todo: 0,
        doing: 0,
        review: 0,
        done: 0,
      };
      summaries.set(key, { ...entry, [card.state]: entry[card.state] + 1 });
    }
    return [...summaries.values()].sort((left, right) => {
      if (left.project === null) return right.project === null ? 0 : 1;
      if (right.project === null) return -1;
      return left.project.localeCompare(right.project);
    });
  }

  /* ------------------------------- mutations ------------------------------- */

  async add(
    input: AddCardInput,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    const body = await this.request<{ card: Card }>("POST", "/api/cards", {
      body: input,
      actor,
      source,
    });
    return { card: body.card, events: [] };
  }

  async edit(
    id: number,
    input: EditCardInput,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    const body = await this.request<{ card: Card }>(
      "PATCH",
      `/api/cards/${id}`,
      {
        body: input,
        actor,
        source,
        expectedRevision: expectedRevisionOf(options),
      },
    );
    return { card: body.card, events: [] };
  }

  async claim(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.transition(id, "claim", actor, source, options);
  }

  async review(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.transition(id, "review", actor, source, options);
  }

  async done(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.transition(id, "done", actor, source, options);
  }

  async reopen(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.transition(id, "reopen", actor, source, options);
  }

  async move(
    id: number,
    to: CardState,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    const body = await this.request<{ card: Card }>(
      "POST",
      `/api/cards/${id}/move`,
      {
        body: { to, expectedRevision: expectedRevisionOf(options) },
        actor,
        source,
      },
    );
    return { card: body.card, events: [] };
  }

  async remove(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    const card = await this.mustCard(id);
    await this.request<void>("DELETE", `/api/cards/${id}`, { actor, source });
    return { card, events: [] };
  }

  async block(
    id: number,
    blockedById: number,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    return this.mutate(id, "block", { blockedBy: blockedById }, actor, source);
  }

  async unblock(
    id: number,
    blockedById: number,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    return this.mutate(
      id,
      "unblock",
      { blockedBy: blockedById },
      actor,
      source,
    );
  }

  async parent(
    id: number,
    parentId: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.mutate(
      id,
      "parent",
      { parent: parentId, expectedRevision: expectedRevisionOf(options) },
      actor,
      source,
    );
  }

  async unparent(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.mutate(
      id,
      "unparent",
      { expectedRevision: expectedRevisionOf(options) },
      actor,
      source,
    );
  }

  async relate(
    id: number,
    otherId: number,
    direction: RelationDirection,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    return this.mutate(
      id,
      "relate",
      { other: otherId, direction },
      actor,
      source,
    );
  }

  async unrelate(
    id: number,
    otherId: number,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    return this.mutate(id, "unrelate", { other: otherId }, actor, source);
  }

  async addNote(
    id: number,
    input: AddNoteInput,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    const body = await this.request<{ card: Card }>(
      "POST",
      `/api/cards/${id}/notes`,
      { body: input, actor, source },
    );
    return { card: body.card, events: [] };
  }

  async updateNote(
    id: number,
    noteId: number,
    input: UpdateNoteInput,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    const body = await this.request<{ card: Card }>(
      "PATCH",
      `/api/cards/${id}/notes/${noteId}`,
      {
        body: { ...input, expectedRevision: expectedRevisionOf(options) },
        actor,
        source,
      },
    );
    return { card: body.card, events: [] };
  }

  async removeNote(
    id: number,
    noteId: number,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    const card = await this.mustCard(id);
    await this.request<void>("DELETE", `/api/cards/${id}/notes/${noteId}`, {
      actor,
      source,
    });
    return { card, events: [] };
  }

  close(): void {
    // Connectionless: every call owns its request.
  }

  /* -------------------------------- internals ------------------------------ */

  /** A state transition whose endpoint is named after the verb. */
  private async transition(
    id: number,
    verb: "claim" | "review" | "done" | "reopen",
    actor: Actor,
    source: EventSource,
    options?: MutationOptions,
  ): Promise<MutationResult> {
    const body = await this.request<{ card: Card }>(
      "POST",
      `/api/cards/${id}/${verb}`,
      {
        body: { expectedRevision: expectedRevisionOf(options) },
        actor,
        source,
      },
    );
    return { card: body.card, events: [] };
  }

  /** The `POST /api/cards/:id/<verb>` family that shares one JSON shape. */
  private async mutate(
    id: number,
    verb: string,
    body: Record<string, unknown>,
    actor: Actor,
    source: EventSource,
  ): Promise<MutationResult> {
    const result = await this.request<{ card: Card }>(
      "POST",
      `/api/cards/${id}/${verb}`,
      { body, actor, source },
    );
    return { card: result.card, events: [] };
  }

  private async mustCard(id: number): Promise<Card> {
    const card = await this.card(id);
    if (card === null) {
      throw new KanbanError("card_not_found", `card ${id} not found`);
    }
    return card;
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token !== null) headers.authorization = `Bearer ${this.token}`;
    if (options.actor !== undefined) {
      headers["x-actor-name"] = options.actor.name;
      headers["x-actor-type"] = options.actor.type;
    }
    if (options.source !== undefined) headers["x-source"] = options.source;
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== null
    ) {
      headers["if-match"] = String(options.expectedRevision);
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new Error(
        `cannot reach the board server at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    if (!response.ok) throw failureFor(response.status, text);
    if (text === "") return undefined as T;
    return JSON.parse(text) as T;
  }
}

function expectedRevisionOf(options?: MutationOptions): number | undefined {
  return options?.expectedRevision;
}

function inScope(
  card: Card,
  project?: string | null,
  subproject?: string | null,
): boolean {
  if (project !== null && project !== undefined && card.project !== project) {
    return false;
  }
  if (
    subproject !== null &&
    subproject !== undefined &&
    card.subproject !== subproject
  ) {
    return false;
  }
  return true;
}

/** Keep the server's domain codes; turn auth/transport failures into advice. */
function failureFor(status: number, text: string): Error {
  let code: string | undefined;
  let message = text.trim();
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: string; message?: string };
    };
    if (parsed.error !== undefined) {
      code = parsed.error.code;
      message = parsed.error.message ?? message;
    }
  } catch {
    // Non-JSON error (a proxy page, say) stands as the message.
  }

  if (status === 401) {
    return new Error(
      `the board server wants credentials — run \`ukb login --server ${"<url>"}\`, set UKB_TOKEN, or pass --token`,
    );
  }
  if (code !== undefined && KANBAN_CODES.has(code)) {
    return new KanbanError(code as KanbanErrorCode, message);
  }
  return new Error(
    `board server answered HTTP ${status}: ${message || "(empty body)"}`,
  );
}
