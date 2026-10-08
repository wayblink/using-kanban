import { mkdtempSync, rmSync } from "node:fs";
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
