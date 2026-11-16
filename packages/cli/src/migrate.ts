/**
 * `ukb migrate --to postgres` — copy the local SQLite event log into Postgres.
 *
 * Event ids and card ids are board identity (people type card handles), so the
 * import preserves both and then advances both sequences past the imported
 * maximum. The target must be empty unless `--force` is explicit.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PgEventLog, SqliteEventLog } from "@wayblink/using-kanban-core";
import { flagBoolean, flagString, UsageError } from "./argv.js";
import type { Io } from "./commands.js";

export async function runMigrate(
  flags: Record<string, string | true>,
  io: Io,
  dir: string,
  postgresUrl: string | undefined,
): Promise<number> {
  const to = flagString(flags, "to");
  if (to !== "postgres") {
    throw new UsageError(
      "ukb migrate needs --to postgres (the only supported target right now)",
    );
  }

  const sourcePath = flagString(flags, "from") ?? join(dir, ".ukb", "board.db");
  if (!existsSync(sourcePath)) {
    throw new UsageError(
      `no SQLite board at ${sourcePath} — pass --from <path> or run this on the machine that owns the store`,
    );
  }

  const source = new SqliteEventLog(sourcePath);
  try {
    const events = await source.since(0);
    const maxId = await source.maxId();
    io.stdout(
      `source: ${events.length} events (max id ${maxId}) from ${sourcePath}`,
    );

    if (flagBoolean(flags, "dry-run")) {
      io.stdout("dry run — nothing written");
      return 0;
    }
    if (postgresUrl === undefined) {
      throw new UsageError(
        "postgres needs a connection URL: --pg-url, UKB_PG_URL or DATABASE_URL",
      );
    }

    const target = new PgEventLog({ connectionString: postgresUrl });
    try {
      const summary = await target.importEvents(events, {
        force: flagBoolean(flags, "force"),
      });
      io.stdout(
        `imported: ${summary.events} events, max event ${summary.maxEventId}, max card ${summary.maxCardId}`,
      );
    } finally {
      target.close();
    }
  } finally {
    source.close();
  }
  return 0;
}
