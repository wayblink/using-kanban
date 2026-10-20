import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server.js";

const TOKEN = "test-token";
const tempDirs: string[] = [];
const running: RunningServer[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-server-test-"));
  tempDirs.push(dir);
  return dir;
}

let baseUrl = "";

beforeEach(async () => {
  const server = await startServer({ dir: tempDir(), token: TOKEN });
  running.push(server);
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await Promise.all(
    running.map((server) => server.close().catch(() => undefined)),
  );
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function authHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "X-Actor-Name": "jyxc",
    "X-Actor-Type": "human",
    ...extra,
  };
}

async function request(
  path: string,
  init: RequestInit & {
    auth?: Record<string, string> | false | undefined;
  } = {},
): Promise<Response> {
  const { auth = authHeaders(), ...rest } = init;
  const headers = new Headers(auth === false ? {} : auth);
  // Caller-supplied headers (If-Match, X-Source, …) merge on top of the auth ones.
  const overrides = new Headers(rest.headers);
  overrides.forEach((value, key) => {
    headers.set(key, value);
  });
  if (rest.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${baseUrl}${path}`, { ...rest, headers });
}

function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function createCard(
  title: string,
  extra: Record<string, unknown> = {},
  auth?: Record<string, string>,
): Promise<{ id: number; revision: number; state: string }> {
  const response = await request("/api/cards", {
    method: "POST",
    body: JSON.stringify({ title, ...extra }),
    auth,
  });
  expect(response.status).toBe(201);
  const body = await json<{
    card: { id: number; revision: number; state: string };
  }>(response);
  return body.card;
}

describe("meta endpoints", () => {
  it("reports health", async () => {
    const response = await request("/healthz", { auth: false });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true });
  });

  it("reports the resolved actor, storage, and counts", async () => {
    await createCard("one");
    await createCard("two");

    const response = await request("/api/me");
    expect(response.status).toBe(200);
    const body = await json<{
      actor: { name: string };
      storage: { kind: string };
      counts: { todo: number };
    }>(response);
    expect(body.actor.name).toBe("jyxc");
    expect(body.storage.kind).toBe("sqlite");
    expect(body.counts.todo).toBe(2);
  });

  it("serves an OpenAPI document", async () => {
    const response = await request("/openapi.json", { auth: false });
    const spec = await json<{ paths: Record<string, unknown> }>(response);
    expect(Object.keys(spec.paths)).toContain("/api/cards/{id}/claim");
  });
});

describe("authentication", () => {
  it("rejects mutations without a token", async () => {
    const response = await request("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "nope" }),
      auth: false,
    });
    expect(response.status).toBe(401);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe(
      "unauthorized",
    );
  });

  it("accepts the token as a query parameter (browser EventSource cannot set headers)", async () => {
    const response = await request(`/api/cards?token=${TOKEN}`, {
      method: "POST",
      body: JSON.stringify({ title: "via query" }),
      auth: false,
    });
    expect(response.status).toBe(201);
  });

  it("allows reads on loopback without a token", async () => {
    const response = await request("/api/board", { auth: false });
    expect(response.status).toBe(200);
  });
});

describe("cards REST", () => {
  it("creates, reads, filters, and deletes cards", async () => {
    const card = await createCard("write docs", {
      assignee: "codex",
      body: "README + examples",
    });

    const list = await request("/api/cards?state=open&assignee=me", {
      headers: {},
      auth: { ...authHeaders(), "X-Actor-Name": "codex" },
    });
    expect(list.status).toBe(200);
    const listBody = await json<{ cards: { id: number }[] }>(list);
    expect(listBody.cards.map((entry) => entry.id)).toEqual([card.id]);

    const detail = await request(`/api/cards/${card.id}`, { auth: false });
    expect(detail.status).toBe(200);
    const detailBody = await json<{
      card: { title: string };
      history: { type: string }[];
    }>(detail);
    expect(detailBody.card.title).toBe("write docs");
    expect(detailBody.history).toHaveLength(1);

    const search = await request("/api/cards?q=docs", { auth: false });
    expect((await json<{ cards: unknown[] }>(search)).cards).toHaveLength(1);

    const forbiddenDelete = await request(`/api/cards/${card.id}`, {
      method: "DELETE",
      auth: authHeaders({ "X-Actor-Name": "claude-code" }),
    });
    expect(forbiddenDelete.status).toBe(403);

    const deleted = await request(`/api/cards/${card.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    const missing = await request(`/api/cards/${card.id}`, { auth: false });
    expect(missing.status).toBe(404);
  });

  it("validates input with stable error codes", async () => {
    const emptyTitle = await request("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "  " }),
    });
    expect(emptyTitle.status).toBe(400);
    expect(
      (await json<{ error: { code: string } }>(emptyTitle)).error.code,
    ).toBe("invalid_input");

    const badJson = await request("/api/cards", {
      method: "POST",
      body: "{not json",
      headers: { "Content-Type": "application/json" },
    });
    expect(badJson.status).toBe(400);
    expect((await json<{ error: { code: string } }>(badJson)).error.code).toBe(
      "invalid_json",
    );

    const badMove = await request("/api/cards/1/move", {
      method: "POST",
      body: JSON.stringify({ to: "nope" }),
    });
    expect(badMove.status).toBe(400);
    expect((await json<{ error: { code: string } }>(badMove)).error.code).toBe(
      "invalid_state",
    );

    const missing = await request("/api/cards/999/claim", { method: "POST" });
    expect(missing.status).toBe(404);
    expect((await json<{ error: { code: string } }>(missing)).error.code).toBe(
      "card_not_found",
    );
  });

  it("enforces edit permissions and clears fields with null", async () => {
    const card = await createCard("task", { assignee: "codex" });

    const asStranger = await request(`/api/cards/${card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "hijacked" }),
      auth: authHeaders({ "X-Actor-Name": "claude-code" }),
    });
    expect(asStranger.status).toBe(403);
    expect(
      (await json<{ error: { code: string } }>(asStranger)).error.code,
    ).toBe("forbidden");

    const asAssignee = await request(`/api/cards/${card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: "notes from codex", assignee: null }),
      auth: authHeaders({ "X-Actor-Name": "codex", "X-Actor-Type": "agent" }),
    });
    expect(asAssignee.status).toBe(200);
    const body = await json<{
      card: { body: string; assignee: string | null };
    }>(asAssignee);
    expect(body.card.body).toBe("notes from codex");
    expect(body.card.assignee).toBeNull();
  });

  it("supports optimistic concurrency via If-Match", async () => {
    const card = await createCard("task");

    // Someone edits first: the card moves from revision 1 to 2.
    const first = await request(`/api/cards/${card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: "first" }),
    });
    expect(first.status).toBe(200);

    // A client still holding revision 1 loses the race.
    const stale = await request(`/api/cards/${card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: "second" }),
      headers: { "If-Match": String(card.revision) },
    });
    expect(stale.status).toBe(409);
    expect((await json<{ error: { code: string } }>(stale)).error.code).toBe(
      "revision_conflict",
    );

    // With the current revision the same edit succeeds.
    const fresh = await request(`/api/cards/${card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: "third" }),
      headers: { "If-Match": String(card.revision + 1) },
    });
    expect(fresh.status).toBe(200);

    // expectedRevision in the body works the same way.
    const viaBody = await request(`/api/cards/${card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: "fourth", expectedRevision: card.revision }),
    });
    expect(viaBody.status).toBe(409);
  });

  it("runs the claim → review → done workflow with actor identity", async () => {
    const card = await createCard("implement", { reviewer: "jyxc" });
    const agentAuth = authHeaders({
      "X-Actor-Name": "claude-code",
      "X-Actor-Type": "agent",
    });

    const claimed = await request(`/api/cards/${card.id}/claim`, {
      method: "POST",
      auth: agentAuth,
    });
    expect(claimed.status).toBe(200);
    expect(
      (await json<{ card: { state: string; assignee: string } }>(claimed)).card,
    ).toMatchObject({
      state: "doing",
      assignee: "claude-code",
    });

    const conflict = await request(`/api/cards/${card.id}/claim`, {
      method: "POST",
      auth: authHeaders({ "X-Actor-Name": "codex", "X-Actor-Type": "agent" }),
    });
    expect(conflict.status).toBe(409);
    expect((await json<{ error: { code: string } }>(conflict)).error.code).toBe(
      "claim_conflict",
    );

    const reviewed = await request(`/api/cards/${card.id}/review`, {
      method: "POST",
      auth: agentAuth,
    });
    expect(reviewed.status).toBe(200);

    const done = await request(`/api/cards/${card.id}/done`, {
      method: "POST",
    });
    expect(done.status).toBe(200);

    const history = await request(`/api/cards/${card.id}/history`, {
      auth: false,
    });
    const events = await json<{
      events: { type: string; actor: { name: string }; source: string }[];
    }>(history);
    expect(events.events.map((event) => event.type)).toEqual([
      "card.created",
      "card.moved",
      "card.moved",
      "card.moved",
    ]);
    expect(events.events[1]?.actor.name).toBe("claude-code");
    expect(events.events[0]?.source).toBe("api");
  });

  it("records the X-Source override so UIs can mark their own events", async () => {
    const card = await createCard(
      "from the browser",
      {},
      authHeaders({ "X-Source": "web" }),
    );
    const history = await request(`/api/cards/${card.id}/history`, {
      auth: false,
    });
    const events = await json<{ events: { source: string }[] }>(history);
    expect(events.events[0]?.source).toBe("web");
  });

  it("manages dependencies and rejects cycles", async () => {
    const a = await createCard("a");
    const b = await createCard("b");

    const blocked = await request(`/api/cards/${b.id}/block`, {
      method: "POST",
      body: JSON.stringify({ blockedBy: a.id }),
    });
    expect(blocked.status).toBe(200);
    expect(
      (await json<{ card: { blockedBy: number[] } }>(blocked)).card.blockedBy,
    ).toEqual([a.id]);

    const selfBlock = await request(`/api/cards/${a.id}/block`, {
      method: "POST",
      body: JSON.stringify({ blockedBy: a.id }),
    });
    expect(selfBlock.status).toBe(400);

    const unblocked = await request(`/api/cards/${b.id}/unblock`, {
      method: "POST",
      body: JSON.stringify({ blockedBy: a.id }),
    });
    expect(
      (await json<{ card: { blockedBy: number[] } }>(unblocked)).card.blockedBy,
    ).toEqual([]);
  });
});

describe("routing", () => {
  it("returns 404 for unknown routes and 405 for wrong methods", async () => {
    const unknown = await request("/api/nope", { auth: false });
    expect(unknown.status).toBe(404);

    const wrongMethod = await request("/api/board", { method: "DELETE" });
    expect(wrongMethod.status).toBe(405);
  });

  it("falls back to a service index at / when no UI is configured", async () => {
    const response = await request("/", { auth: false });
    expect(response.status).toBe(200);
    expect((await json<{ docs: string }>(response)).docs).toBe("/openapi.json");
  });
});

describe("projects over REST", () => {
  it("stores, filters and reports the projects in use", async () => {
    const web = await createCard("web card", { project: "web" });
    const api = await createCard("api card", { project: "api" });
    await createCard("untagged");

    // the board carries the project list so a client can build its filter
    const board = await request("/api/board", { auth: false });
    const boardBody = await json<{
      todo: { id: number }[];
      projects: string[];
    }>(board);
    expect(boardBody.projects).toEqual(["api", "web"]);
    expect(boardBody.todo).toHaveLength(3);

    const webBoard = await request("/api/board?project=web", { auth: false });
    const webBody = await json<{ todo: { id: number }[] }>(webBoard);
    expect(webBody.todo.map((card) => card.id)).toEqual([web.id]);

    const webCards = await request("/api/cards?project=web", { auth: false });
    const webCardsBody = await json<{ cards: { id: number }[] }>(webCards);
    expect(webCardsBody.cards.map((card) => card.id)).toEqual([web.id]);

    // the project list survives the filter — it describes the board, not the view
    const filtered = await request("/api/board?project=api", { auth: false });
    expect((await json<{ projects: string[] }>(filtered)).projects).toEqual([
      "api",
      "web",
    ]);

    // an unknown project is an empty board, not an error
    const none = await request("/api/board?project=nope", { auth: false });
    expect((await json<{ todo: unknown[] }>(none)).todo).toEqual([]);

    // and it composes with the other filters
    const both = await request("/api/cards?project=web&state=done", {
      auth: false,
    });
    expect((await json<{ cards: unknown[] }>(both)).cards).toEqual([]);
    expect(api.id).toBeGreaterThan(web.id);
  });

  it("moves a card to another project through PATCH", async () => {
    const card = await createCard("movable", { project: "web" });
    const response = await request(`/api/cards/${card.id}`, {
      method: "PATCH",
      auth: authHeaders({ "X-Actor-Name": "jyxc" }),
      body: JSON.stringify({ project: "api" }),
    });
    expect(response.status).toBe(200);
    expect(
      (await json<{ card: { project: string } }>(response)).card.project,
    ).toBe("api");
  });

  it("rejects a slug that is not url/cli safe", async () => {
    const response = await request("/api/cards", {
      method: "POST",
      auth: authHeaders({ "X-Actor-Name": "jyxc" }),
      body: JSON.stringify({ title: "x", project: "web ui" }),
    });
    expect(response.status).toBe(400);
    const errorBody = await json<{ code?: string; error?: { code: string } }>(
      response,
    );
    expect(errorBody.code ?? errorBody.error?.code).toBe("invalid_input");
  });
});

describe("relations over REST", () => {
  it("relates cards from either side onto one edge", async () => {
    const a = await createCard("design");
    const b = await createCard("implement");

    const upstream = await request(`/api/cards/${b.id}/relate`, {
      method: "POST",
      body: JSON.stringify({ other: a.id, direction: "upstream" }),
    });
    expect(upstream.status).toBe(200);
    const upstreamCard = await json<{
      card: { blockedBy: number[]; blocks: number[] };
    }>(upstream);
    expect(upstreamCard.card.blockedBy).toEqual([a.id]);
    expect(upstreamCard.card.blocks).toEqual([]);

    // the same relation, named from the other card: the card that changes is
    // the one that ends up waiting, so this returns b
    const downstream = await request(`/api/cards/${a.id}/relate`, {
      method: "POST",
      body: JSON.stringify({ other: b.id, direction: "downstream" }),
    });
    const downstreamCard = await json<{
      card: { blockedBy: number[]; blocks: number[] };
    }>(downstream);
    expect(downstreamCard.card.blockedBy).toEqual([a.id]);

    const detail = await request(`/api/cards/${a.id}`, { auth: false });
    const shown = await json<{ card: { blocks: number[] } }>(detail);
    expect(shown.card.blocks).toEqual([b.id]);

    const unrelated = await request(`/api/cards/${a.id}/unrelate`, {
      method: "POST",
      body: JSON.stringify({ other: b.id }),
    });
    const after = await json<{
      card: { blockedBy: number[]; blocks: number[] };
    }>(unrelated);
    expect(after.card.blocks).toEqual([]);

    const cleared = await request(`/api/cards/${b.id}`, { auth: false });
    expect(
      (await json<{ card: { blockedBy: number[] } }>(cleared)).card.blockedBy,
    ).toEqual([]);
  });

  it("rejects a bad direction and a cycle", async () => {
    const a = await createCard("a");
    const b = await createCard("b");
    await request(`/api/cards/${b.id}/relate`, {
      method: "POST",
      body: JSON.stringify({ other: a.id, direction: "upstream" }),
    });

    const bad = await request(`/api/cards/${a.id}/relate`, {
      method: "POST",
      body: JSON.stringify({ other: b.id, direction: "sideways" }),
    });
    expect(bad.status).toBe(400);

    const cycle = await request(`/api/cards/${a.id}/relate`, {
      method: "POST",
      body: JSON.stringify({ other: b.id, direction: "upstream" }),
    });
    expect(cycle.status).toBe(400);
  });
});

describe("notes over REST", () => {
  it("adds, edits and removes a note with a document link", async () => {
    const card = await createCard("ship it");

    const created = await request(`/api/cards/${card.id}/notes`, {
      method: "POST",
      body: JSON.stringify({ text: "design doc", url: "docs/design.md" }),
    });
    expect(created.status).toBe(201);
    const added = await json<{
      note: { id: number; text: string; url: string; createdBy: string };
    }>(created);
    expect(added.note.text).toBe("design doc");
    expect(added.note.url).toBe("docs/design.md");
    expect(added.note.createdBy).toBe("jyxc");

    const shown = await request(`/api/cards/${card.id}`, { auth: false });
    const detail = await json<{
      card: { notes: { id: number; text: string }[] };
    }>(shown);
    expect(detail.card.notes.map((note) => note.text)).toEqual(["design doc"]);

    const patched = await request(
      `/api/cards/${card.id}/notes/${added.note.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ url: null }),
      },
    );
    expect(patched.status).toBe(200);
    expect((await json<{ note: { url: null } }>(patched)).note.url).toBeNull();

    const searched = await request("/api/cards?q=design", { auth: false });
    expect(
      (await json<{ cards: { id: number }[] }>(searched)).cards.map(
        (c) => c.id,
      ),
    ).toContain(card.id);

    const removed = await request(
      `/api/cards/${card.id}/notes/${added.note.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(204);
    const after = await request(`/api/cards/${card.id}`, { auth: false });
    expect(
      (await json<{ card: { notes: unknown[] } }>(after)).card.notes,
    ).toEqual([]);
  });

  it("rejects an unknown note and a stranger", async () => {
    const card = await createCard("ship it");

    const missing = await request(`/api/cards/${card.id}/notes/99`, {
      method: "DELETE",
    });
    expect(missing.status).toBe(404);

    const stranger = await request(`/api/cards/${card.id}/notes`, {
      method: "POST",
      auth: authHeaders({ "X-Actor-Name": "codex" }),
      body: JSON.stringify({ text: "hi" }),
    });
    expect(stranger.status).toBe(403);
  });
});

describe("documents", () => {
  it("serves a note's local document as markdown", async () => {
    const dir = tempDir();
    const root = join(dir, "docs");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "design.md"),
      "# Design\n\nHello **world**\n",
      "utf8",
    );

    const server = await startServer({ dir, token: TOKEN, docRoots: [root] });
    running.push(server);
    const url = `http://127.0.0.1:${server.port}`;

    const response = await fetch(
      `${url}/api/doc?path=design.md&token=${TOKEN}`,
    );
    expect(response.status).toBe(200);
    const doc = await json<{ name: string; kind: string; content: string }>(
      response,
    );
    expect(doc.name).toBe("design.md");
    expect(doc.kind).toBe("markdown");
    expect(doc.content).toContain("Hello **world**");

    const raw = await fetch(
      `${url}/api/doc?path=${encodeURIComponent(join(root, "design.md"))}&raw=1&token=${TOKEN}`,
    );
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toContain("text/markdown");
    expect(await raw.text()).toContain("# Design");
  });

  it("refuses paths outside the allowed roots", async () => {
    const dir = tempDir();
    const server = await startServer({ dir, token: TOKEN });
    running.push(server);
    const url = `http://127.0.0.1:${server.port}`;

    const escaped = await fetch(
      `${url}/api/doc?path=${encodeURIComponent("../../etc/passwd")}&token=${TOKEN}`,
    );
    expect(escaped.status).toBe(403);

    const absolute = await fetch(
      `${url}/api/doc?path=${encodeURIComponent("/etc/passwd")}&token=${TOKEN}`,
    );
    expect(absolute.status).toBe(403);
  });

  it("needs the token even on loopback — it reads files", async () => {
    const dir = tempDir();
    const server = await startServer({ dir, token: TOKEN });
    running.push(server);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/doc?path=x.md`,
    );
    expect(response.status).toBe(401);
  });
});

describe("GET /api/log", () => {
  const create = (title: string): Promise<Response> =>
    request("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title }),
    });

  it("returns the log newest first, and pages backwards with `before`", async () => {
    await create("one");
    await create("two");

    const first = await request("/api/log?limit=1");
    const page = (await first.json()) as {
      events: { id: number; type: string; payload: { title?: string } }[];
      hasMore: boolean;
      total: number;
    };
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.payload.title).toBe("two");
    expect(page.hasMore).toBe(true);
    // The pager counts against the whole filtered log, not the window.
    expect(page.total).toBe(2);

    const newest = page.events[0]?.id ?? 0;
    const older = (await (
      await request(`/api/log?limit=5&before=${newest}`)
    ).json()) as {
      events: { id: number; payload: { title?: string } }[];
      hasMore: boolean;
      total: number;
    };
    expect(older.events).toHaveLength(1);
    expect(older.events[0]?.payload.title).toBe("one");
    expect(older.events.every((event) => event.id < newest)).toBe(true);
    expect(older.hasMore).toBe(false);
    // ...and a cursor does not shrink it: the second page still says "of 2".
    expect(older.total).toBe(2);
  });

  it("rejects a bad limit or cursor", async () => {
    expect((await request("/api/log?limit=0")).status).toBe(400);
    expect((await request("/api/log?before=x")).status).toBe(400);
  });

  it("filters by project, including a card that has since been deleted", async () => {
    await request("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "web card", project: "web" }),
    });
    await request("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "api card", project: "api" }),
    });
    await request("/api/cards/1/move", {
      method: "POST",
      body: JSON.stringify({ to: "doing" }),
    });
    await request("/api/cards/1", { method: "DELETE" });

    const web = (await (await request("/api/log?project=web")).json()) as {
      events: { cardId: number; type: string; project: string | null }[];
      total: number;
    };
    // The project is not on the events: it is folded from the card, so the
    // deleted card's own history still filters correctly — and still names its
    // project in the response, which is what the audit column shows.
    expect(web.events.map((event) => event.type)).toEqual([
      "card.deleted",
      "card.moved",
      "card.created",
    ]);
    expect(web.events.every((event) => event.cardId === 1)).toBe(true);
    expect(web.events.every((event) => event.project === "web")).toBe(true);
    expect(web.total).toBe(3);

    const api = (await (await request("/api/log?project=api")).json()) as {
      events: { cardId: number; project: string | null }[];
      total: number;
    };
    expect(api.events.map((event) => event.cardId)).toEqual([2]);
    expect(api.events[0]?.project).toBe("api");
    expect(api.total).toBe(1);

    const all = (await (await request("/api/log")).json()) as {
      events: { project: string | null }[];
      total: number;
    };
    expect(all.events).toHaveLength(4);
    expect(all.total).toBe(4);
    expect(all.events.every((event) => typeof event.project === "string")).toBe(
      true,
    );
  });

  it("attributes each event to the project the card had at the time", async () => {
    await request("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "moves project", project: "web" }),
    });
    await request("/api/cards/1", {
      method: "PATCH",
      body: JSON.stringify({ project: "api" }),
    });

    const log = (await (await request("/api/log")).json()) as {
      events: { type: string; project: string | null }[];
    };
    // Oldest first here, so the create reads as `web` and the edit as `api`: a
    // column that showed the card's *current* project would misdate the past.
    expect(log.events.map((event) => [event.type, event.project])).toEqual([
      ["card.updated", "api"],
      ["card.created", "web"],
    ]);
  });
});

describe("insights", () => {
  interface InsightsBody {
    days: number;
    from: string;
    to: string;
    series: {
      date: string;
      created: number;
      done: number;
      states: Record<string, number>;
    }[];
    states: Record<string, number>;
    projects: { project: string | null; done: number }[];
    previous: { created: number; done: number };
    aging: {
      cards: unknown[];
      blocked: number;
      counts: { doing: number; review: number };
      stale: { doing: number; review: number };
      thresholds: { doing: number; review: number };
    };
    cycle: { completed: number; medianDays: number } | null;
  }

  function today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  it("returns a dense window that matches the board", async () => {
    const first = await createCard("one", { project: "web" });
    const second = await createCard("two", { project: "web" });
    await createCard("three", { project: "api" });

    await request(`/api/cards/${first.id}/claim`, { method: "POST" });
    await request(`/api/cards/${first.id}/done`, { method: "POST" });
    await request(`/api/cards/${second.id}/claim`, { method: "POST" });

    const response = await request("/api/insights?days=7");
    expect(response.status).toBe(200);
    const body = await json<InsightsBody>(response);

    expect(body.days).toBe(7);
    expect(body.series).toHaveLength(7);
    // Every day is present, even the ones with no events.
    expect(body.series.every((day) => day.date.length === 10)).toBe(true);
    expect(body.series.at(-1)?.date).toBe(today());

    // Creation happened today, so every card is in today's bucket.
    expect(body.series.at(-1)?.created).toBe(3);
    expect(body.series.at(-1)?.done).toBe(1);
    expect(body.series.at(-1)?.states).toEqual({
      someday: 0,
      todo: 1,
      doing: 1,
      review: 0,
      done: 1,
    });

    expect(body.states).toEqual({
      someday: 0,
      todo: 1,
      doing: 1,
      review: 0,
      done: 1,
    });
    expect(body.projects.map((project) => project.project).sort()).toEqual([
      "api",
      "web",
    ]);
    expect(body.cycle?.completed).toBe(1);
    expect(body.previous).toMatchObject({ created: 0, done: 0 });
  });

  it("rejects a window or a zone it cannot honour", async () => {
    for (const query of ["days=0", "days=366", "days=2.5", "days=abc"]) {
      const response = await request(`/api/insights?${query}`);
      expect(response.status, query).toBe(400);
      const body = await json<{ error: { code: string } }>(response);
      expect(body.error.code).toBe("invalid_input");
    }

    const zone = await request("/api/insights?tz=Mars/Olympus");
    expect(zone.status).toBe(400);
  });

  it("cuts days in the requested zone", async () => {
    await createCard("zone test");
    const response = await request("/api/insights?days=1&tz=Asia/Shanghai");
    const body = await json<InsightsBody>(response);
    expect(body.series).toHaveLength(1);
    // Shanghai is ahead of UTC, so its date can only be equal or one day later.
    const utc = new Date().toISOString().slice(0, 10);
    expect([
      utc,
      new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    ]).toContain(body.series[0]?.date);
  });
});

describe("project and subproject", () => {
  it("stores a direction under its repository and filters by both", async () => {
    await createCard("OAuth callback", { project: "web", subproject: "auth" });
    await createCard("Billing", { project: "web", subproject: "billing" });
    await createCard("Other repo", { project: "api", subproject: "auth" });

    const board = (await (
      await request("/api/board?project=web&subproject=auth")
    ).json()) as {
      todo: { title: string; subproject: string | null }[];
    };
    expect(board.todo.map((card) => card.title)).toEqual(["OAuth callback"]);
    expect(board.todo[0]?.subproject).toBe("auth");

    const cards = (await (
      await request("/api/cards?subproject=auth")
    ).json()) as { cards: { project: string; title: string }[] };
    expect(cards.cards.map((card) => card.title).sort()).toEqual([
      "OAuth callback",
      "Other repo",
    ]);
  });

  it("refuses a direction without a repository", async () => {
    const response = await request("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "orphan", subproject: "auth" }),
    });
    expect(response.status).toBe(400);
    const body = await json<{ error: { code: string; message: string } }>(
      response,
    );
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.message).toMatch(/subproject needs a project/);
  });

  it("clears the direction when the repository is cleared", async () => {
    const card = await createCard("OAuth callback", {
      project: "web",
      subproject: "auth",
    });
    const response = await request(`/api/cards/${card.id}`, {
      method: "PATCH",
      body: JSON.stringify({ project: null }),
    });
    expect(response.status).toBe(200);
    const body = await json<{ card: { project: null; subproject: null } }>(
      response,
    );
    expect(body.card.project).toBeNull();
    expect(body.card.subproject).toBeNull();
  });
});
