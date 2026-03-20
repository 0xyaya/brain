#!/usr/bin/env node
import os from "os";
import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";

const BRAIN_DIR = path.join(os.homedir(), "corpus", "brain");
const QUEUE_PATH = path.join(BRAIN_DIR, "queue.jsonl");
const LOCK_PATH = path.join(BRAIN_DIR, "consolidate.lock");
const BIN_DIR = path.dirname(new URL(import.meta.url).pathname);

fs.mkdirSync(BRAIN_DIR, { recursive: true });

const cmd = process.argv[2];
const args = process.argv.slice(3);

if (cmd === "--help" || cmd === "-h" || !cmd) {
  console.log(`brain — agent memory CLI

Usage:
  brain push [--buffer <file>] <json>       Push experience/knowledge to queue
  brain recall [--buffer <file>] <query>    Search knowledge (vector or text)
  brain explore <entity>                    Graph neighborhood of an entity
  brain get <id>                            Get full node by ID
  brain flush --buffer <file>               Flush buffer file via consolidate
  brain consolidate [--flags]               Run consolidate pipeline

Consolidate flags:
  --drain       Process queue.jsonl (LLM extraction)
  --focus       Update MEMORY.md focus section
  --recent      Update MEMORY.md recent section
  --permanent   LLM-summarize top knowledge into permanent section
  --daily       Write daily log file
  --maintain    Prune old experiences, strengthen edges`);
  process.exit(0);
}

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--buffer" && args[i + 1]) {
      flags.buffer = args[++i];
    } else {
      rest.push(args[i]);
    }
  }
  return { flags, rest };
}

function isBrainifyRunning() {
  return fs.existsSync(LOCK_PATH);
}

function spawnBrainify(...args) {
  if (isBrainifyRunning()) return;
  const child = spawn("node", [path.join(BIN_DIR, "consolidate.js"), ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

switch (cmd) {
  case "push": {
    const { flags, rest } = parseFlags(args);
    let json = rest.join(" ");

    // Read from stdin if no JSON arg
    if (!json) {
      json = fs.readFileSync(0, "utf-8").trim();
    }

    if (!json) {
      console.error("Usage: brain push [--buffer <file>] <json>");
      process.exit(1);
    }

    // Validate JSON
    try {
      JSON.parse(json);
    } catch {
      console.error("Invalid JSON:", json.slice(0, 100));
      process.exit(1);
    }

    const target = flags.buffer || QUEUE_PATH;
    if (flags.buffer) {
      fs.mkdirSync(path.dirname(flags.buffer), { recursive: true });
    }
    fs.appendFileSync(target, json + "\n");

    if (!flags.buffer) {
      spawnBrainify("--drain");
    }

    console.log("OK");
    break;
  }

  case "recall": {
    const { flags, rest } = parseFlags(args);
    const query = rest.join(" ");

    if (!query) {
      console.error("Usage: brain recall [--buffer <file>] <query>");
      process.exit(1);
    }

    if (flags.buffer) {
      // Text search over raw buffer file
      if (!fs.existsSync(flags.buffer)) {
        console.log("[]");
        break;
      }
      const lines = fs.readFileSync(flags.buffer, "utf-8").trim().split("\n").filter(Boolean);
      const queryLower = query.toLowerCase();
      const matches = [];
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          const text = JSON.stringify(item).toLowerCase();
          if (text.includes(queryLower)) {
            matches.push(item);
          }
        } catch { /* skip bad lines */ }
      }
      console.log(JSON.stringify(matches.slice(0, 5)));
    } else {
      // Vector similarity search on Knowledge.embedding via cosine similarity
      const { getDb, closeDb, hashEmbedding } = await import("../src/db.js");
      try {
        const conn = await getDb(true);
        const emb = hashEmbedding(query);
        const embStr = `[${emb.join(",")}]`;
        const result = await conn.query(
          `MATCH (k:Knowledge)
           WITH k, array_cosine_similarity(k.embedding, CAST(${embStr} AS FLOAT[64])) AS score
           WHERE score > 0
           RETURN k.id AS id, k.kind AS kind, k.content AS content, k.agent AS agent, score
           ORDER BY score DESC LIMIT 5`
        );
        const rows = await result.getAll();
        const compact = rows.map(r => ({
          id: r.id,
          kind: r.kind,
          content: (r.content || "").slice(0, 200),
          agent: r.agent,
        }));
        console.log(JSON.stringify(compact));
        await closeDb();
      } catch (e) {
        // If no data yet, return empty
        console.log("[]");
      }
    }
    break;
  }

  case "explore": {
    const entity = args.join(" ");
    if (!entity) {
      console.error("Usage: brain explore <entity-name>");
      process.exit(1);
    }

    const { getDb, closeDb } = await import("../src/db.js");
    try {
      const conn = await getDb(true);
      const stmt = await conn.prepare(
        `MATCH (e:Entity {name: $name})-[r*1..2]-(n) RETURN DISTINCT label(n) AS type, n.id AS id, n.name AS name LIMIT 20`
      );
      const result = await conn.execute(stmt, { name: entity });
      const rows = await result.getAll();
      console.log(JSON.stringify(rows));
      await closeDb();
    } catch (e) {
      console.log("[]");
    }
    break;
  }

  case "flush": {
    const { flags } = parseFlags(args);
    if (!flags.buffer) {
      console.error("Usage: brain flush --buffer <file>");
      process.exit(1);
    }
    if (!fs.existsSync(flags.buffer)) {
      console.error("Buffer file not found:", flags.buffer);
      process.exit(1);
    }
    spawnBrainify("--input", flags.buffer);
    console.log("OK");
    break;
  }

  case "get": {
    const id = args[0];
    if (!id) {
      console.error("Usage: brain get <id>");
      process.exit(1);
    }

    const { getDb, closeDb } = await import("../src/db.js");
    try {
      const conn = await getDb(true);
      // Try each node type
      for (const table of ["Experience", "Knowledge", "Entity"]) {
        try {
          const stmt = await conn.prepare(`MATCH (n:${table} {id: $id}) RETURN n.*`);
          const result = await conn.execute(stmt, { id });
          const rows = await result.getAll();
          if (rows.length > 0) {
            console.log(JSON.stringify({ type: table, ...rows[0] }));
            await closeDb();
            process.exit(0);
          }
        } catch { /* try next table */ }
      }
      console.log("null");
      await closeDb();
    } catch (e) {
      console.error("Error:", e.message);
    }
    break;
  }

  case "consolidate": {
    const consolidateFlags = args.filter(a => a.startsWith("--"));
    if (consolidateFlags.length === 0) {
      consolidateFlags.push("--drain", "--focus", "--recent");
    }
    spawnBrainify(...consolidateFlags);
    console.log("OK — consolidate spawned with: " + consolidateFlags.join(" "));
    break;
  }

  default:
    console.error(`Unknown command: ${cmd}. Run 'brain --help' for usage.`);
    process.exit(1);
}
