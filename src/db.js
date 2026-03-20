import { Database, Connection } from "@ladybugdb/core";
import os from "os";
import path from "path";
import fs from "fs";

const DB_DIR = path.join(os.homedir(), "corpus", "brain");
const DB_PATH = path.join(DB_DIR, "brain.db");

let _db = null;
let _conn = null;

export async function getDb(readOnly = false) {
  if (_conn && !_conn._isClosed) return _conn;
  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH, 0, true, readOnly);
  await _db.init();
  _conn = new Connection(_db);
  await _conn.init();
  return _conn;
}

// Explicit close — needed in CLI tools that exit after a query.
// Long-running processes (plugin services) can skip this; the DB
// closes automatically on process exit.
export async function closeDb() {
  // Skip explicit close — LadybugDB native cleanup on process exit causes segfault.
  // OS reclaims file handles safely on exit.
  _conn = null;
  _db = null;
}

export async function initSchema() {
  const conn = await getDb();

  // Node tables
  const nodeTables = [
    `CREATE NODE TABLE IF NOT EXISTS Experience (
      id STRING,
      type STRING,
      agent STRING,
      timestamp STRING,
      outcome STRING,
      summary STRING,
      metadata STRING,
      PRIMARY KEY(id)
    )`,
    `CREATE NODE TABLE IF NOT EXISTS Knowledge (
      id STRING,
      kind STRING,
      content STRING,
      agent STRING,
      timestamp STRING,
      PRIMARY KEY(id)
    )`,
    `CREATE NODE TABLE IF NOT EXISTS Entity (
      id STRING,
      type STRING,
      name STRING,
      metadata STRING,
      PRIMARY KEY(id)
    )`,
  ];

  // Edge tables (weight defaults to 1, incremented by nightly maintenance)
  const edgeTables = [
    `CREATE REL TABLE IF NOT EXISTS DERIVED (FROM Experience TO Knowledge, weight INT64 DEFAULT 1)`,
    `CREATE REL TABLE IF NOT EXISTS ABOUT (FROM Knowledge TO Entity, weight INT64 DEFAULT 1)`,
    `CREATE REL TABLE IF NOT EXISTS INVOLVES (FROM Experience TO Entity, weight INT64 DEFAULT 1)`,
    `CREATE REL TABLE IF NOT EXISTS RELATES_TO (FROM Knowledge TO Knowledge, weight INT64 DEFAULT 1)`,
    `CREATE REL TABLE IF NOT EXISTS FOLLOWS (FROM Experience TO Experience, weight INT64 DEFAULT 1)`,
  ];

  // Migrate existing edge tables: add weight column if missing
  for (const rel of ["DERIVED", "ABOUT", "INVOLVES", "RELATES_TO", "FOLLOWS"]) {
    try {
      await conn.query(`ALTER TABLE ${rel} ADD weight INT64 DEFAULT 1`);
    } catch { /* column already exists — ignore */ }
  }

  for (const q of [...nodeTables, ...edgeTables]) {
    await conn.query(q);
  }

  return conn;
}

// TODO: add real vector embeddings when embedding API is available (OpenAI, Voyage, etc.)

export { DB_PATH, DB_DIR };
