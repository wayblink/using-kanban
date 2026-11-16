#!/usr/bin/env node
/**
 * Online backup: better-sqlite3's backup API reads a consistent snapshot of a
 * live database, which is the supported way to copy SQLite without stopping the
 * writer. The accounts file rides along because an unauthenticated board is not
 * a usable restore.
 *
 * Runs inside the image: `docker compose exec -T ukb node /app/backup.mjs`.
 */
import { createRequire } from "node:module";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const base = process.env.UKB_DIR ?? "/data";
const dir = join(base, "backups");
mkdirSync(dir, { recursive: true });

const require = createRequire(import.meta.url);
const corePackage = require.resolve("@wayblink/using-kanban-core/package.json");
const Database = createRequire(corePackage)("better-sqlite3");

const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const target = join(dir, `board-${stamp}.db`);
const db = new Database(join(base, ".ukb", "board.db"), { readonly: true });
await db.backup(target);
db.close();

try {
  const accountsCopy = join(dir, `accounts-${stamp}.json`);
  copyFileSync(join(base, ".ukb", "accounts.json"), accountsCopy);
  chmodSync(accountsCopy, 0o600);
} catch (error) {
  // No accounts file yet: the board is local-only, still worth backing up.
  if (error.code !== "ENOENT") throw error;
}

const keepDays = Number(process.env.UKB_BACKUP_KEEP_DAYS ?? "14");
const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
for (const name of readdirSync(dir)) {
  if (!/^(board|accounts)-.*\.(db|json)$/u.test(name)) continue;
  const path = join(dir, name);
  if (statSync(path).mtimeMs < cutoff) rmSync(path);
}

process.stdout.write(`backup written: ${target}\n`);
