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
  brain push --graph <file>                 Import entity graph from JSON file
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
    } else if (args[i] === "--graph" && args[i + 1]) {
      flags.graph = args[++i];
    } else if (args[i] === "--source" && args[i + 1]) {
      flags.source = args[++i];
    } else if (args[i] === "--days" && args[i + 1]) {
      flags.days = args[++i];
    } else {
      rest.push(args[i]);
    }
  }
  return { flags, rest };
}

function isConsolidateRunning() {
  return fs.existsSync(LOCK_PATH);
}

function spawnConsolidate(...args) {
  if (isConsolidateRunning()) return;
  const child = spawn("node", [path.join(BIN_DIR, "consolidate.js"), ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

switch (cmd) {
  case "push": {
    const { flags, rest } = parseFlags(args);

    // Handle --graph flag: import entity/relationship JSON
    if (flags.graph) {
      if (!fs.existsSync(flags.graph)) {
        console.error("Graph file not found:", flags.graph);
        process.exit(1);
      }
      const data = JSON.parse(fs.readFileSync(flags.graph, "utf-8"));
      const item = { type: 'graph_import', data, timestamp: new Date().toISOString(), ...(flags.source && { source: flags.source }) };
      const target = flags.buffer || QUEUE_PATH;
      if (flags.buffer) {
        fs.mkdirSync(path.dirname(flags.buffer), { recursive: true });
      }
      fs.appendFileSync(target, JSON.stringify(item) + "\n");
      if (!flags.buffer) {
        spawnConsolidate("--drain");
      }
      console.log("OK");
      break;
    }

    let json = rest.join(" ");

    // Read from stdin if no JSON arg
    if (!json) {
      json = fs.readFileSync(0, "utf-8").trim();
    }

    if (!json) {
      console.error("Usage: brain push [--buffer <file>] [--graph <file>] <json>");
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
      spawnConsolidate("--drain");
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
      const results = [];

      // 1. BM25 search over index.md (graph: Knowledge + Experience + Entity) via qmd
      try {
        const out = execSync(`qmd search ${JSON.stringify(query)} -c brain --json -n 5`, { encoding: 'utf-8' });
        const qmdResults = JSON.parse(out);
        for (const r of qmdResults) {
          const meta = { source: "graph" };
          const text = r.snippet || "";
          if (r.title) meta.id = r.title;
          const kindMatch = text.match(/^kind: (.+)/m);
          const typeMatch = text.match(/^type: (.+)/m);
          if (kindMatch) meta.kind = kindMatch[1];
          else if (typeMatch) meta.type = typeMatch[1];
          const contentMatch = text.match(/^content: (.+)/m);
          const summaryMatch = text.match(/^summary: (.+)/m);
          const descMatch = text.match(/^description: (.+)/m);
          if (contentMatch) meta.content = contentMatch[1].slice(0, 200);
          else if (summaryMatch) meta.content = summaryMatch[1].slice(0, 200);
          else if (descMatch) meta.content = descMatch[1].slice(0, 200);
          const agentMatch = text.match(/^agent: (.+)/m);
          if (agentMatch) meta.agent = agentMatch[1];
          if (meta.id) results.push(meta);
        }
      } catch { /* qmd not available or no results */ }

      // 2. Search recent daily memory logs (last N days)
      const days = flags.days ? parseInt(flags.days) : 3;
      const agentId = process.env.BRAIN_AGENT_ID || (() => {
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(BRAIN_DIR, "config.json"), "utf-8"));
          return cfg.agentId || "neo";
        } catch { return "neo"; }
      })();
      const dailyDir = path.join(os.homedir(), "corpus", "users", agentId, "memory");
      const queryLower = query.toLowerCase();
      try {
        const now = new Date();
        for (let i = 0; i < days; i++) {
          const d = new Date(now);
          d.setDate(d.getDate() - i);
          const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
          const logPath = path.join(dailyDir, `${dateStr}.md`);
          if (!fs.existsSync(logPath)) continue;
          const content = fs.readFileSync(logPath, "utf-8");
          if (!content.toLowerCase().includes(queryLower)) continue;
          // Extract matching paragraphs (split on double newline)
          const paras = content.split(/\n{2,}/);
          for (const para of paras) {
            if (para.toLowerCase().includes(queryLower)) {
              results.push({
                source: "daily",
                date: dateStr,
                content: para.trim().slice(0, 300),
              });
              if (results.filter(r => r.source === "daily").length >= 3) break;
            }
          }
        }
      } catch { /* no daily dir or unreadable */ }

      console.log(JSON.stringify(results.slice(0, 10)));
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
    spawnConsolidate("--input", flags.buffer);
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
    spawnConsolidate(...consolidateFlags);
    console.log("OK — consolidate spawned with: " + consolidateFlags.join(" "));
    break;
  }

  default:
    console.error(`Unknown command: ${cmd}. Run 'brain --help' for usage.`);
    process.exit(1);
}
