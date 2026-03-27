import { Database, Connection } from "@ladybugdb/core";
import os from "os";
import path from "path";
import fs from "fs";

const DB_DIR = process.env.BRAIN_DIR
  ? path.resolve(process.env.BRAIN_DIR)
  : path.join(os.homedir(), "corpus", "brain");
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
    `CREATE NODE TABLE IF NOT EXISTS Entity (
      id          STRING,
      name        STRING,
      text        STRING,
      kind        STRING,
      description STRING,
      source      STRING,
      embedding   STRING,
      created_at  STRING,
      PRIMARY KEY (id)
    )`,
    `CREATE NODE TABLE IF NOT EXISTS Knowledge (
      id          STRING,
      text        STRING,
      kind        STRING,
      source      STRING,
      confidence  DOUBLE,
      agent       STRING,
      timestamp   STRING,
      PRIMARY KEY (id)
    )`,
    `CREATE NODE TABLE IF NOT EXISTS Experience (
      id               STRING,
      text             STRING,
      type             STRING,
      agent            STRING,
      outcome          STRING,
      period           STRING,
      last_accessed_at STRING,
      metadata         STRING,
      source           STRING,
      timestamp        STRING,
      PRIMARY KEY (id)
    )`,
    `CREATE NODE TABLE IF NOT EXISTS Summary (
      id         STRING,
      title      STRING,
      content    STRING,
      source     STRING,
      source_ids STRING,
      created_at STRING,
      PRIMARY KEY (id)
    )`,
  ];

  // Edge tables
  const edgeTables = [
    `CREATE REL TABLE IF NOT EXISTS CONNECTS   (FROM Entity TO Entity,        why STRING, source STRING, weight DOUBLE DEFAULT 1.0)`,
    `CREATE REL TABLE IF NOT EXISTS ABOUT      (FROM Knowledge TO Entity,     why STRING, source STRING, weight DOUBLE DEFAULT 1.0)`,
    `CREATE REL TABLE IF NOT EXISTS INVOLVES   (FROM Experience TO Entity,    source STRING, weight DOUBLE DEFAULT 1.0)`,
    `CREATE REL TABLE IF NOT EXISTS DERIVED    (FROM Experience TO Knowledge, source STRING, weight DOUBLE DEFAULT 1.0)`,
    `CREATE REL TABLE IF NOT EXISTS RELATES_TO (FROM Knowledge TO Knowledge,  why STRING, source STRING, weight DOUBLE DEFAULT 1.0)`,
    `CREATE REL TABLE IF NOT EXISTS FOLLOWS    (FROM Experience TO Experience, source STRING, weight DOUBLE DEFAULT 1.0)`,
    `CREATE REL TABLE IF NOT EXISTS SUMMARIZES (FROM Summary TO Entity,       source STRING)`,
  ];

  // Migrate existing tables: add new columns if missing
  const migrations = [
    // Entity columns
    ["Entity", "text", "STRING"],
    ["Entity", "kind", "STRING"],
    ["Entity", "description", "STRING"],
    ["Entity", "source", "STRING"],
    ["Entity", "embedding", "STRING"],
    ["Entity", "created_at", "STRING"],
    // Knowledge columns
    ["Knowledge", "text", "STRING"],
    ["Knowledge", "source", "STRING"],
    ["Knowledge", "confidence", "DOUBLE"],
    ["Knowledge", "embedding", "STRING"],
    // Experience columns
    ["Experience", "text", "STRING"],
    ["Experience", "period", "STRING"],
    ["Experience", "last_accessed_at", "STRING"],
    ["Experience", "source", "STRING"],
    ["Experience", "embedding", "STRING"],
    // Edge new columns
    ["CONNECTS", "why", "STRING"],
    ["CONNECTS", "source", "STRING"],
    ["ABOUT", "why", "STRING"],
    ["ABOUT", "source", "STRING"],
    ["INVOLVES", "source", "STRING"],
    ["DERIVED", "source", "STRING"],
    ["RELATES_TO", "why", "STRING"],
    ["RELATES_TO", "source", "STRING"],
    ["FOLLOWS", "source", "STRING"],
  ];
  for (const [table, col, type] of migrations) {
    try {
      await conn.query(`ALTER TABLE ${table} ADD ${col} ${type}`);
    } catch { /* column already exists — ignore */ }
  }

  for (const q of [...nodeTables, ...edgeTables]) {
    await conn.query(q);
  }

  return conn;
}

// TODO: add real vector embeddings when embedding API is available (OpenAI, Voyage, etc.)

export { DB_PATH, DB_DIR };
