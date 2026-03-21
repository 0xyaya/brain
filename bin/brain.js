#!/usr/bin/env node
import os from "os";
import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";

// --- Config resolution (supports custom brainDir + corpusRoot) ---
const DEFAULT_BRAIN_DIR = path.join(os.homedir(), "corpus", "brain");

function loadConfig(brainDir = DEFAULT_BRAIN_DIR) {
  try {
    return JSON.parse(fs.readFileSync(path.join(brainDir, "config.json"), "utf-8"));
  } catch { return {}; }
}

// Allow BRAIN_DIR override via env or default
const BRAIN_DIR = process.env.BRAIN_DIR
  ? path.resolve(process.env.BRAIN_DIR)
  : (() => {
      // Check if a config exists at default location pointing elsewhere
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(DEFAULT_BRAIN_DIR, "config.json"), "utf-8"));
        if (cfg.brainDir) return path.resolve(cfg.brainDir.replace("~", os.homedir()));
      } catch { /* use default */ }
      return DEFAULT_BRAIN_DIR;
    })();

const QUEUE_PATH = path.join(BRAIN_DIR, "queue.jsonl");
const LOCK_PATH = path.join(BRAIN_DIR, "consolidate.lock");
const BIN_DIR = path.dirname(new URL(import.meta.url).pathname);

fs.mkdirSync(BRAIN_DIR, { recursive: true });

const cmd = process.argv[2];
const args = process.argv.slice(3);

// Resolve agent ID: --agent flag > BRAIN_AGENT_ID env > config file > prompt user
function resolveAgentId(flags = {}) {
  if (flags.agent) return flags.agent;
  if (process.env.BRAIN_AGENT_ID) return process.env.BRAIN_AGENT_ID;
  const cfg = loadConfig(BRAIN_DIR);
  if (cfg.agentId) return cfg.agentId;
  return null; // will be caught where needed
}

// Resolve corpus root for daily memory logs
function resolveCorpusRoot(flags = {}) {
  const cfg = loadConfig(BRAIN_DIR);
  const root = process.env.BRAIN_CORPUS_ROOT || cfg.corpusRoot || path.join(os.homedir(), "corpus");
  return root.replace("~", os.homedir());
}

if (cmd === "--help" || cmd === "-h" || !cmd) {
  console.log(`brain — agent memory CLI

Usage:
  brain init [--agent <id>] [--corpus <path>]  Set up brain for this machine
  brain push [--buffer <file>] [--agent <id>] <json>       Push experience/knowledge to queue
  brain push --graph <file> [--agent <id>]                  Import entity graph from JSON file
  brain recall [--buffer <file>] [--agent <id>] [--days N] <query>  Search knowledge + daily logs
  brain explore <entity>                    Graph neighborhood of an entity
  brain get <id>                            Get full node by ID
  brain flush --buffer <file>               Flush buffer file via consolidate
  brain consolidate [--agent <id>] [--flags]  Run consolidate pipeline

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
    } else if (args[i] === "--agent" && args[i + 1]) {
      flags.agent = args[++i];
    } else if (args[i] === "--corpus" && args[i + 1]) {
      flags.corpus = args[++i];
    } else {
      rest.push(args[i]);
    }
  }
  return { flags, rest };
}

function isConsolidateRunning() {
  return fs.existsSync(LOCK_PATH);
}

function spawnConsolidate(agentId, ...args) {
  if (isConsolidateRunning()) return;
  const env = { ...process.env };
  if (agentId) env.BRAIN_AGENT_ID = agentId;
  const child = spawn("node", [path.join(BIN_DIR, "consolidate.js"), ...args], {
    detached: true,
    stdio: "ignore",
    env,
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
        spawnConsolidate(resolveAgentId(flags), "--drain");
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
      spawnConsolidate(resolveAgentId(flags), "--drain");
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
      const { getDb, closeDb } = await import("../src/db.js");
      const { embed, cosine, loadEmbeddings } = await import("../src/embed.js");
      const results = [];

      // 1. Vector search over graph using embeddings.json
      try {
        const queryVec = await embed(query);
        if (queryVec) {
          const store = loadEmbeddings();
          const nodeIds = Object.keys(store);
          if (nodeIds.length > 0) {
            // Score all stored embeddings
            const scored = nodeIds.map(id => ({
              id,
              score: cosine(queryVec, store[id])
            })).sort((a, b) => b.score - a.score);

            // Fetch node details from DB for top candidates
            const conn = await getDb(true);
            for (const { id, score } of scored.slice(0, 10)) {
              if (score < 0.3) break;
              try {
                const table = id.startsWith("entity:") ? "Entity"
                  : id.startsWith("know:") ? "Knowledge" : "Experience";
                // Only query columns that exist per node type
                let q;
                if (table === "Knowledge") {
                  q = `MATCH (n:Knowledge {id: '${id}'}) RETURN n.content AS text, n.kind AS kind, n.agent AS agent`;
                } else if (table === "Experience") {
                  q = `MATCH (n:Experience {id: '${id}'}) RETURN n.summary AS text, n.type AS kind, n.agent AS agent`;
                } else {
                  q = `MATCH (n:Entity {id: '${id}'}) RETURN n.name AS text, n.kind AS kind`;
                }
                const rows = await (await conn.query(q)).getAll();
                if (rows[0]) {
                  results.push({
                    source: "graph",
                    id,
                    type: table.toLowerCase(),
                    kind: rows[0].kind || null,
                    content: (rows[0].text || "").slice(0, 200),
                    agent: rows[0].agent || null,
                    score: Math.round(score * 100) / 100,
                  });
                }
              } catch { /* skip */ }
            }
            await closeDb();
          }
        }
      } catch (e) {
        // Embedding unavailable — silent fallback
      }

      // 2. Keyword search over recent daily memory logs (last N days)
      const days = flags.days ? parseInt(flags.days) : 3;
      const agentId = resolveAgentId(flags);
      const corpusRoot = resolveCorpusRoot(flags);
      const dailyDir = agentId ? path.join(corpusRoot, "users", agentId, "memory") : null;
      const queryLower = query.toLowerCase();
      try {
        if (!dailyDir) throw new Error("no dailyDir");
        const now = new Date();
        for (let i = 0; i < days; i++) {
          const d = new Date(now);
          d.setDate(d.getDate() - i);
          const dateStr = d.toISOString().slice(0, 10);
          const logPath = path.join(dailyDir, `${dateStr}.md`);
          if (!fs.existsSync(logPath)) continue;
          const content = fs.readFileSync(logPath, "utf-8");
          if (!content.toLowerCase().includes(queryLower)) continue;
          const paras = content.split(/\n{2,}/);
          for (const para of paras) {
            if (para.toLowerCase().includes(queryLower)) {
              results.push({ source: "daily", date: dateStr, content: para.trim().slice(0, 300) });
              if (results.filter(r => r.source === "daily").length >= 3) break;
            }
          }
        }
      } catch { /* no daily dir */ }

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
    spawnConsolidate(resolveAgentId(flags), "--input", flags.buffer);
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
    const { flags: cFlags } = parseFlags(args);
    const consolidateFlags = args.filter(a => a.startsWith("--"));
    if (consolidateFlags.length === 0) {
      consolidateFlags.push("--drain", "--focus", "--recent");
    }
    spawnConsolidate(resolveAgentId(cFlags), ...consolidateFlags);
    console.log("OK — consolidate spawned with: " + consolidateFlags.join(" "));
    break;
  }

  case "init": {
    const { flags: initFlags } = parseFlags(args);
    const agentId = initFlags.agent || process.env.BRAIN_AGENT_ID;
    const corpusRoot = initFlags.corpus
      ? path.resolve(initFlags.corpus.replace("~", os.homedir()))
      : path.join(os.homedir(), "corpus");

    if (!agentId) {
      console.error("Error: agent ID required. Use --agent <id> (e.g. brain init --agent myagent)");
      process.exit(1);
    }

    // Create directory structure
    const brainDir = BRAIN_DIR;
    const memoryDir = path.join(corpusRoot, "users", agentId, "memory");
    const userDir = path.join(corpusRoot, "users", agentId);
    fs.mkdirSync(brainDir, { recursive: true });
    fs.mkdirSync(memoryDir, { recursive: true });

    // Write config.json
    const configPath = path.join(brainDir, "config.json");
    const existingConfig = loadConfig(brainDir);
    const config = { ...existingConfig, agentId, corpusRoot };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Create MEMORY.md if missing
    const memoryMdPath = path.join(userDir, "MEMORY.md");
    if (!fs.existsSync(memoryMdPath)) {
      fs.writeFileSync(memoryMdPath, `# MEMORY.md — Long-term Memory

<!-- BRAIN:FOCUS:START -->
# Focus
<!-- BRAIN:FOCUS:END -->

<!-- BRAIN:RECENT:START -->
# Recent
<!-- BRAIN:RECENT:END -->

<!-- BRAIN:PERMANENT:START -->
# Permanent
<!-- BRAIN:PERMANENT:END -->
`);
      console.log(`  created ${memoryMdPath}`);
    }

    console.log(`✓ Brain initialized`);
    console.log(`  agent:      ${agentId}`);
    console.log(`  brain DB:   ${brainDir}`);
    console.log(`  memory:     ${memoryDir}`);
    console.log(`  config:     ${configPath}`);
    console.log(``);
    console.log(`Next steps:`);
    console.log(`  1. brain consolidate --drain --focus --recent   # first consolidation`);
    console.log(`  2. brain consolidate --embed                    # build vector index (~25MB model download)`);
    console.log(`  3. brain recall --agent ${agentId} "test query"  # verify search works`);
    break;
  }

  default:
    console.error(`Unknown command: ${cmd}. Run 'brain --help' for usage.`);
    process.exit(1);
}
