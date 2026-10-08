import Database from "better-sqlite3";
import { EventRowSchema, StoredEventSchema } from "./schemas.js";
import type { Event, EventType, NewEvent } from "./types.js";
import type { EventLog } from "./event-log.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT    NOT NULL,
  actor_type TEXT    NOT NULL,
  actor_name TEXT    NOT NULL,
  source     TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  card_id    INTEGER NOT NULL,
  payload    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS events_card_id_idx ON events (card_id);
`;

/**
 * SQLite-backed event log. WAL mode lets several processes (an MCP server per
 * agent session, a CLI call, the HTTP server) read and append concurrently.
 */
export class SqliteEventLog implements EventLog {
  private readonly db: Database.Database;
  private readonly insertStatement: Database.Statement;
  private readonly linkCardStatement: Database.Statement;
  private readonly sinceStatement: Database.Statement;
  private readonly byCardStatement: Database.Statement;
  private readonly appendTransaction: (rows: readonly NewEvent[]) => Event[];

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);

    this.insertStatement = this.db.prepare(
      `INSERT INTO events (ts, actor_type, actor_name, source, type, card_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.linkCardStatement = this.db.prepare(
      `UPDATE events SET card_id = ? WHERE id = ?`,
    );
    this.sinceStatement = this.db.prepare(
      `SELECT * FROM events WHERE id > ? ORDER BY id ASC`,
    );
    this.byCardStatement = this.db.prepare(
      `SELECT * FROM events WHERE card_id = ? ORDER BY id ASC`,
    );

    this.appendTransaction = this.db.transaction(
      (rows: readonly NewEvent[]): Event[] => {
        const stored: Event[] = [];
        for (const row of rows) {
          const ts = new Date().toISOString();
          const info = this.insertStatement.run(
            ts,
            row.actor.type,
            row.actor.name,
            row.source,
            row.type,
            row.cardId ?? 0,
            JSON.stringify(row.payload),
          );
          const id = Number(info.lastInsertRowid);
          const cardId = row.cardId ?? id;
          if (row.cardId === null) {
            this.linkCardStatement.run(cardId, id);
          }
          stored.push({
            id,
            ts,
            actor: row.actor,
            source: row.source,
            type: row.type,
            cardId,
            payload: row.payload,
          });
        }
        return stored;
      },
    );
  }

  append(rows: readonly NewEvent[]): Event[] {
    return this.appendTransaction(rows);
  }

  since(id: number): Event[] {
    return this.sinceStatement.all(id).map((row) => this.toEvent(row));
  }

  byCard(cardId: number): Event[] {
    return this.byCardStatement.all(cardId).map((row) => this.toEvent(row));
  }

  maxId(): number {
    const row = this.db
      .prepare(`SELECT MAX(id) AS max_id FROM events`)
      .get() as { max_id: number | null } | undefined;
    return row?.max_id ?? 0;
  }

  close(): void {
    this.db.close();
  }

  private toEvent(row: unknown): Event {
    const parsed = EventRowSchema.parse(row);
    const payload = JSON.parse(parsed.payload) as unknown;
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      throw new Error(`event ${parsed.id} has a non-object payload`);
    }
    const stored = StoredEventSchema.parse({
      id: parsed.id,
      ts: parsed.ts,
      actor: { type: parsed.actor_type, name: parsed.actor_name },
      source: parsed.source,
      type: parsed.type,
      cardId: parsed.card_id,
      payload,
    });
    return {
      id: stored.id,
      ts: stored.ts,
      actor: stored.actor,
      source: stored.source,
      type: stored.type as EventType,
      cardId: stored.cardId,
      payload: stored.payload,
    };
  }
}
