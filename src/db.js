import { Database, Connection } from "@ladybugdb/core";
import os from "os";
import path from "path";
import fs from "fs";

const EMBEDDING_DIM = 64;
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
  if (_conn && !_conn._isClosed) await _conn.close();
  if (_db && !_db._isClosed) await _db.close();
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
      embedding FLOAT[${EMBEDDING_DIM}],
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

  // Vector search uses array_cosine_similarity() — no HNSW index needed for now
  // When HNSW extension becomes available:
  // CALL CREATE_HNSW_INDEX('knowledge_embedding_idx', 'Knowledge', 'embedding', metric := 'cosine')

  return conn;
}

// TODO: Replace with real embeddings (e.g. OpenAI text-embedding-3-small).
// This hash-based placeholder is deterministic but NOT semantic — it only
// supports exact/near-exact text matching via cosine similarity.
export function hashEmbedding(text) {
  const vec = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < text.length; i++) {
    const idx = i % EMBEDDING_DIM;
    vec[idx] += text.charCodeAt(i) * (i + 1) * 0.001;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] /= norm;
  return Array.from(vec);
}

export { EMBEDDING_DIM, DB_PATH, DB_DIR };
