import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AccountStore,
  Kanban,
  MemoryEventLog,
  SqliteEventLog,
  type Event,
} from "@wayblink/using-kanban-core";
import { startServer, type RunningServer } from "../src/server.js";

const TOKEN = "server-token";
const dirs: string[] = [];
const servers: RunningServer[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-import-test-"));
  dirs.push(dir);
  return dir;
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function serving(dir: string, allowImport: boolean): Promise<string> {
  const server = await startServer({ dir, token: TOKEN, allowImport });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function seed(): Promise<Event[]> {
  const log = new MemoryEventLog();
  const board = new Kanban({ log });
  const actor = { type: "human" as const, name: "jyxc" };
  await board.add({ title: "one", project: "web" }, actor);
  await board.add({ title: "two", blockedBy: [1] }, actor);
  await board.claim(1, actor);
  return log.since(0);
}

async function withAccounts(): Promise<{
  baseUrl: string;
  dir: string;
}> {
  const dir = tempDir();
  const accounts = AccountStore.inStoreDir(dir);
  await accounts.addUser("alice", "alice password", "admin");
  await accounts.addUser("bob", "bob password", "member");
  return { baseUrl: await serving(dir, true), dir };
}

async function post(
  baseUrl: string,
  auth: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}/api/import/events`, {
    method: "POST",
    headers: {
      authorization: auth,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

afterAll(async () => {
  await Promise.all(
    servers.map((server) => server.close().catch(() => undefined)),
  );
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/import/events", () => {
  it("imports events for an admin and keeps card ids", async () => {
    const { baseUrl } = await withAccounts();
    const events = await seed();
    const response = await post(baseUrl, basic("alice", "alice password"), {
      events,
    });
    expect(response.status).toBe(200);
    const summary = (await response.json()) as {
      events: number;
      maxEventId: number;
      maxCardId: number;
    };
    expect(summary).toMatchObject({
      events: events.length,
      maxEventId: events.length,
      maxCardId: 2,
    });

    const board = (await (
      await fetch(`${baseUrl}/api/board`, {
        headers: { authorization: basic("alice", "alice password") },
      })
    ).json()) as { doing: { id: number }[]; todo: { id: number }[] };
    expect(board.doing.map((card) => card.id)).toEqual([1]);
    expect(board.todo.map((card) => card.id)).toEqual([2]);
  });

  it("rejects a member, a disabled endpoint, and a non-empty target", async () => {
    const { baseUrl, dir } = await withAccounts();
    const events = await seed();

    const member = await post(baseUrl, basic("bob", "bob password"), {
      events,
    });
    expect(member.status).toBe(403);

    const admin = basic("alice", "alice password");
    expect((await post(baseUrl, admin, { events })).status).toBe(200);
    expect((await post(baseUrl, admin, { events })).status).toBe(409);
    expect((await post(baseUrl, admin, { events, force: true })).status).toBe(
      200,
    );

    // Same directory/accounts, endpoint switched off.
    const disabled = await serving(dir, false);
    expect(
      (
        await post(disabled, basic("alice", "alice password"), {
          events: await seed(),
        })
      ).status,
    ).toBe(404);
  });

  it("validates ascending event ids", async () => {
    const { baseUrl } = await withAccounts();
    const events = await seed();
    const response = await post(baseUrl, basic("alice", "alice password"), {
      events: [events[1], events[0]],
    });
    expect(response.status).toBe(400);
  });
});

// Keep the SQLite import path covered too (the online board may still be SQLite).
describe("SqliteEventLog.importEvents", () => {
  it("persists imported ids across reopen", async () => {
    const dir = tempDir();
    const path = join(dir, "board.db");
    const source = new MemoryEventLog();
    const board = new Kanban({ log: source });
    await board.add({ title: "persisted" }, { type: "human", name: "jyxc" });
    const events = await source.since(0);

    const log = new SqliteEventLog(path);
    await log.importEvents(events);
    log.close();
    const reopened = new SqliteEventLog(path);
    expect(await reopened.maxId()).toBe(events.length);
    reopened.close();
  });
});
