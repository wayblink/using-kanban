import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PgEventLog } from "../src/event-log-postgres.js";
import { SqliteEventLog } from "../src/event-log-sqlite.js";
import { Kanban } from "../src/kanban.js";
import type { Actor, NewEvent } from "../src/types.js";

const { Pool } = pg;
const connectionString = process.env.UKB_TEST_PG_URL;

const actor: Actor = { type: "human", name: "jyxc" };

function created(title: string): NewEvent {
  return {
    actor,
    source: "cli",
    type: "card.created",
    cardId: null,
    payload: {
      title,
      body: null,
      assignee: null,
      reviewer: null,
      project: null,
      subproject: null,
      priority: "normal",
      blockedBy: [],
      notes: [],
      createdBy: actor.name,
    },
  };
}

function moved(cardId: number): NewEvent {
  return {
    actor,
    source: "cli",
    type: "card.moved",
    cardId,
    payload: { to: "doing", from: "todo", action: "claim", patch: {} },
  };
}

async function reset(): Promise<void> {
  // Force the schema first: TRUNCATE on a fresh database has no tables yet.
  const log = new PgEventLog({ connectionString: connectionString! });
  await log.maxId();
  await log.end();
  const pool = new Pool({ connectionString });
  try {
    await pool.query("TRUNCATE events RESTART IDENTITY");
    await pool.query("SELECT setval('ukb_card_seq', 1, false)");
  } finally {
    await pool.end();
  }
}

async function withLog<T>(fn: (log: PgEventLog) => Promise<T>): Promise<T> {
  const log = new PgEventLog({ connectionString: connectionString! });
  try {
    return await fn(log);
  } finally {
    await log.end();
  }
}

describe.skipIf(connectionString === undefined)("PgEventLog", () => {
  beforeEach(async () => {
    await reset();
  });

  afterAll(async () => {
    await reset();
  });

  it("appends with event ids and independent card ids", async () => {
    await withLog(async (log) => {
      const stored = await log.append([created("a"), moved(1), created("b")]);
      expect(stored.map((event) => event.id)).toEqual([1, 2, 3]);
      expect(stored.map((event) => event.cardId)).toEqual([1, 1, 2]);
      expect((await log.since(1)).map((event) => event.id)).toEqual([2, 3]);
      expect((await log.byCard(1)).map((event) => event.id)).toEqual([1, 2]);
      expect(await log.maxId()).toBe(3);
    });
  });

  it("persists across instances", async () => {
    await withLog(async (log) => {
      await log.append([created("persisted"), moved(1)]);
    });
    await withLog(async (log) => {
      expect(await log.maxId()).toBe(2);
      expect((await log.byCard(1)).map((event) => event.type)).toEqual([
        "card.created",
        "card.moved",
      ]);
    });
  });

  it("serialises concurrent card-id allocation", async () => {
    await withLog(async (log) => {
      await Promise.all(
        Array.from({ length: 5 }, () => log.append([created("parallel")])),
      );
      const cardIds = (await log.since(0)).map((event) => event.cardId);
      expect(new Set(cardIds).size).toBe(5);
    });
  });

  it("imports a SQLite log with ids and card handles intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ukb-pg-import-"));
    const sqlite = new SqliteEventLog(join(dir, "board.db"));
    const source = new Kanban({ log: sqlite });
    await source.add({ title: "migrated card", project: "web" }, actor);
    await source.claim(1, actor);
    const events = await sqlite.since(0);
    sqlite.close();

    await withLog(async (log) => {
      const result = await log.importEvents(events);
      expect(result.events).toBe(events.length);
      expect(result.maxCardId).toBe(1);
      expect(await log.maxId()).toBe(events.length);

      const replayed = new Kanban({ log });
      expect((await replayed.card(1))?.title).toBe("migrated card");
      expect(
        (await replayed.board("web")).doing.map((card) => card.id),
      ).toEqual([1]);

      // The next live append continues both sequences.
      const next = await log.append([created("after import")]);
      expect(next[0]?.id).toBe(events.length + 1);
      expect(next[0]?.cardId).toBe(2);

      // Refuses a second import without --force.
      await expect(log.importEvents(events)).rejects.toMatchObject({
        code: "invalid_input",
      });
    });
  });
});
