import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrations } from "./schema.js";

export type SqliteDatabase = Database.Database;

export function openDatabase(filename = "data/outbound.sqlite"): SqliteDatabase {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });

  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: SqliteDatabase): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (currentVersion > migrations.length) {
    throw new Error(`Database schema version ${currentVersion} is newer than supported version ${migrations.length}`);
  }

  for (let index = currentVersion; index < migrations.length; index += 1) {
    db.transaction(() => {
      db.exec(migrations[index]);
      db.pragma(`user_version = ${index + 1}`);
    })();
  }
}
