#!/usr/bin/env node
import os from "os";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import readline from "readline";

// --- Config resolution ---
const DEFAULT_BRAIN_DIR = path.join(os.homedir(), ".brain");

function loadConfig(brainDir = DEFAULT_BRAIN_DIR) {
  try {
    return JSON.parse(fs.readFileSync(path.join(brainDir, "config.json"), "utf-8"));
  } catch { return {}; }
}

const BRAIN_DIR = process.env.BRAIN_DIR
  ? path.resolve(process.env.BRAIN_DIR)
  : (() => {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(DEFAULT_BRAIN_DIR, "config.json"), "utf-8"));
        if (cfg.brainDir) return path.resolve(cfg.brainDir.replace("~", os.homedir()));
      } catch { /* use default */ }
      return DEFAULT_BRAIN_DIR;
    })();

const QUEUE_PATH = path.join(BRAIN_DIR, "queue.jsonl");
const BIN_DIR = path.dirname(new URL(import.meta.url).pathname);

fs.mkdirSync(BRAIN_DIR, { recursive: true });

const cmd = process.argv[2];
const args = process.argv.slice(3);

// Agent ID: env → config → cwd basename (default for new projects)
function resolveAgentId() {
  if (process.env.BRAIN_AGENT_ID) return process.env.BRAIN_AGENT_ID;
  const cfg = loadConfig(BRAIN_DIR);
  if (cfg.agentId) return cfg.agentId;
  return path.basename(process.cwd());
}

// Daily logs dir: env → config → BRAIN_DIR/memory
function resolveDailyDir() {
  if (process.env.BRAIN_DAILY_DIR) return process.env.BRAIN_DAILY_DIR;
  const cfg = loadConfig(BRAIN_DIR);
  if (cfg.dailyDir) return cfg.dailyDir.replace("~", os.homedir());
  return path.join(BRAIN_DIR, "memory");
}

if (cmd === "--help" || cmd === "-h" || !cmd) {
  console.log(`brain — agent memory CLI

Usage:
  brain init                                             Interactive setup (or reads brain.json if present)
  brain push [--buffer <file>] <json>                   Queue a knowledge/experience item
  brain push --graph <file>                             Queue a persona graph file
  brain flush [--buffer <file>]                         Flush queue to graph
  brain recall [--buffer <file>] [--days N] <query>    Hybrid semantic + graph search
  brain explore <entity>                                Graph neighborhood of an entity
  brain get <id>                                        Fetch full node by ID
  brain remove <id>                                     Delete a node
  brain consolidate [--flags]                           Update MEMORY.md
  brain ingest [--dir <path>]                          Extract knowledge from daily logs

Consolidate flags:
  --focus       Update focus section (centrality × recency)
  --recent      Update recent section (last 72h)
  --permanent   LLM synthesize top nodes into permanent section
  --summarize   LLM summarize top entity clusters
  --maintain    Decay edge weights, purge isolated nodes
  --embed       Backfill vector embeddings

Environment:
  BRAIN_DIR         DB, queue, embeddings (default: ~/.brain)
  BRAIN_AGENT_ID    Override agent ID (default: current directory name)
  BRAIN_DAILY_DIR   Override daily logs directory (default: BRAIN_DIR/memory)`);
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
    } else if (args[i] === "--dir" && args[i + 1]) {
      flags.dir = args[++i];
    } else if (args[i] === "--threshold" && args[i + 1]) {
      flags.threshold = args[++i];
    } else {
      rest.push(args[i]);
    }
  }
  return { flags, rest };
}

function spawnConsolidate(...spawnArgs) {
  const child = spawn("node", [path.join(BIN_DIR, "consolidate.js"), ...spawnArgs], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
}

switch (cmd) {
  case "push": {
    const { flags, rest } = parseFlags(args);

    if (flags.graph) {
      if (!fs.existsSync(flags.graph)) {
        console.error("Graph file not found:", flags.graph);
        process.exit(1);
      }
      const data = JSON.parse(fs.readFileSync(flags.graph, "utf-8"));
      const agentId = resolveAgentId();
      // Support new-style {nodes:[]} and legacy flat array
      const nodes = data.nodes || (Array.isArray(data) ? data : null);
      if (!nodes) {
        console.error("Invalid graph file: expected {nodes:[...]}");
        process.exit(1);
      }
      const target = flags.buffer || QUEUE_PATH;
      if (flags.buffer) fs.mkdirSync(path.dirname(flags.buffer), { recursive: true });
      let count = 0;
      for (const node of nodes) {
        const item = { ...node, agent: agentId, timestamp: new Date().toISOString() };
        fs.appendFileSync(target, JSON.stringify(item) + "\n");
        count++;
      }
      console.log(`OK — queued ${count} nodes`);
      break;
    }

    let json = rest.join(" ");
    if (!json) json = fs.readFileSync(0, "utf-8").trim();
    if (!json) {
      console.error("Usage: brain push [--buffer <file>] <json>");
      process.exit(1);
    }

    let item;
    try { item = JSON.parse(json); } catch {
      console.error("Invalid JSON:", json.slice(0, 100));
      process.exit(1);
    }

    // Inject agent if not present
    if (!item.agent) item.agent = resolveAgentId();
    if (!item.timestamp) item.timestamp = new Date().toISOString();

    const target = flags.buffer || QUEUE_PATH;
    if (flags.buffer) fs.mkdirSync(path.dirname(flags.buffer), { recursive: true });
    fs.appendFileSync(target, JSON.stringify(item) + "\n");
    console.log("OK");
    break;
  }

  case "flush": {
    const { flags } = parseFlags(args);
    const inputFile = flags.buffer || QUEUE_PATH;
    if (flags.buffer && !fs.existsSync(flags.buffer)) {
      console.error("Buffer file not found:", flags.buffer);
      process.exit(1);
    }
    spawnConsolidate("--input", inputFile);
    console.log("OK");
    break;
  }

  case "recall": {
    const { flags, rest } = parseFlags(args);
    const query = rest.join(" ");

    if (!query) {
      console.error("Usage: brain recall [--buffer <file>] [--days N] <query>");
      process.exit(1);
    }

    if (flags.buffer) {
      if (!fs.existsSync(flags.buffer)) { console.log("[]"); break; }
      const lines = fs.readFileSync(flags.buffer, "utf-8").trim().split("\n").filter(Boolean);
      const queryLower = query.toLowerCase();
      const matches = [];
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (JSON.stringify(item).toLowerCase().includes(queryLower)) matches.push(item);
        } catch { /* skip */ }
      }
      console.log(JSON.stringify(matches.slice(0, 5)));
      break;
    }

    const { getDb, closeDb } = await import("../src/db.js");
    const { embed, cosine, loadEmbeddings } = await import("../src/embed.js");
    const results = [];
    const agentId = resolveAgentId();

    // 1. Vector search + graph expansion
    try {
      const queryVec = await embed(query);
      if (queryVec) {
        const store = loadEmbeddings();
        const nodeIds = Object.keys(store);
        if (nodeIds.length > 0) {
          const scored = nodeIds
            .map(id => ({ id, score: cosine(queryVec, store[id]) }))
            .sort((a, b) => b.score - a.score);

          const conn = await getDb(false);
          const seenIds = new Set();
          const vectorHits = [];

          for (const { id, score } of scored.slice(0, 10)) {
            if (score < 0.3) break;
            try {
              const table = id.startsWith("entity:") ? "Entity"
                : id.startsWith("know:") ? "Knowledge" : "Experience";
              const agentFilter = (table !== "Entity" && agentId)
                ? ` WHERE n.agent = '${agentId}'` : "";
              const rows = await (await conn.query(
                `MATCH (n:${table} {id: '${id}'})${agentFilter} RETURN n.text AS text, n.agent AS agent`
              )).getAll();
              if (rows[0]) {
                seenIds.add(id);
                vectorHits.push({
                  source: "graph",
                  id,
                  type: table.toLowerCase(),
                  text: (rows[0].text || "").slice(0, 200),
                  agent: rows[0].agent || null,
                  score: Math.round(score * 100) / 100,
                });
                try {
                  await conn.query(
                    `MATCH (n:${table} {id: '${id}'})-[r]-(:Entity)
                     SET r.weight = CASE WHEN r.weight < 4.9 THEN r.weight + 0.1 ELSE 5.0 END`
                  );
                } catch { /* no edges */ }
              }
            } catch { /* skip */ }
          }

          // Graph expansion: siblings sharing entities
          const graphHits = [];
          for (const hit of vectorHits.slice(0, 5)) {
            const table = hit.id.startsWith("know:") ? "Knowledge" : "Experience";
            const edgeRel = table === "Knowledge" ? "ABOUT" : "INVOLVES";
            try {
              const entities = await (await conn.query(`
                MATCH (n:${table} {id: '${hit.id}'})-[r:${edgeRel}]->(e:Entity)
                RETURN e.id AS eid, r.weight AS w
              `)).getAll();
              if (!entities.length) continue;
              const eids = entities.map(e => `'${e.eid}'`).join(",");

              for (const sibTable of ["Knowledge", "Experience"]) {
                const sRel = sibTable === "Knowledge" ? "ABOUT" : "INVOLVES";
                const agentF = agentId ? ` AND sib.agent = '${agentId}'` : "";
                const sibs = await (await conn.query(`
                  MATCH (sib:${sibTable})-[r:${sRel}]->(e:Entity)
                  WHERE e.id IN [${eids}] AND sib.id <> '${hit.id}'${agentF}
                  WITH sib, SUM(r.weight) AS sharedWeight
                  RETURN sib.id AS id, sib.text AS text, sib.agent AS agent, sharedWeight
                  ORDER BY sharedWeight DESC LIMIT 3
                `)).getAll();
                for (const sib of sibs) {
                  if (seenIds.has(sib.id) || !sib.text) continue;
                  seenIds.add(sib.id);
                  graphHits.push({
                    source: "graph-neighbor",
                    id: sib.id,
                    type: sibTable.toLowerCase(),
                    text: (sib.text || "").slice(0, 200),
                    agent: sib.agent || null,
                    score: Math.round((hit.score * 0.6 + Math.min(sib.sharedWeight / 5.0, 1) * 0.4) * 100) / 100,
                  });
                }
              }
            } catch { /* skip */ }
          }

          results.push(...vectorHits, ...graphHits);
          await closeDb();
        }
      }
    } catch { /* embedding unavailable */ }

    // 2. Queue scan — unflushed items ranked by tmp_weight (1-5, default 1.0)
    const cfg = loadConfig(BRAIN_DIR);
    const brainJson = (() => { try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), "brain.json"), "utf-8")); } catch { return {}; } })();
    const queueLimit = brainJson.queueLimit ?? cfg.queueLimit ?? 5;
    try {
      if (fs.existsSync(QUEUE_PATH)) {
        const lines = fs.readFileSync(QUEUE_PATH, "utf-8").trim().split("\n").filter(Boolean);
        const queueItems = lines
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(item => item && item.text && (!agentId || !item.agent || item.agent === agentId))
          .sort((a, b) => (b.tmp_weight ?? 1.0) - (a.tmp_weight ?? 1.0))
          .slice(0, queueLimit)
          .map(item => ({
            source: "queue",
            text: (item.text || "").slice(0, 200),
            entities: item.entities || [],
            tmp_weight: item.tmp_weight ?? 1.0,
            timestamp: item.timestamp || null,
          }));
        results.push(...queueItems);
      }
    } catch { /* queue unreadable */ }

    // 3. Keyword search over daily logs
    const days = flags.days ? parseInt(flags.days) : 3;
    const dailyDir = resolveDailyDir();
    const queryLower = query.toLowerCase();
    try {
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
            results.push({ source: "daily", date: dateStr, text: para.trim().slice(0, 300) });
            if (results.filter(r => r.source === "daily").length >= 3) break;
          }
        }
      }
    } catch { /* no daily dir */ }

    console.log(JSON.stringify(results.slice(0, 10)));
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
      const results = [];

      const eStmt = await conn.prepare(
        `MATCH (e:Entity {name: $name})-[r*1..2]-(n:Entity) RETURN DISTINCT n.id AS id, n.name AS name, 'entity' AS type LIMIT 10`
      );
      results.push(...await (await conn.execute(eStmt, { name: entity })).getAll());

      const kStmt = await conn.prepare(
        `MATCH (k:Knowledge)-[:ABOUT]->(e:Entity {name: $name}) RETURN k.id AS id, k.text AS name, 'knowledge' AS type LIMIT 10`
      );
      results.push(...await (await conn.execute(kStmt, { name: entity })).getAll());

      const xStmt = await conn.prepare(
        `MATCH (x:Experience)-[:INVOLVES]->(e:Entity {name: $name}) RETURN x.id AS id, x.text AS name, 'experience' AS type LIMIT 10`
      );
      results.push(...await (await conn.execute(xStmt, { name: entity })).getAll());

      console.log(JSON.stringify(results));
      await closeDb();
    } catch {
      console.log("[]");
    }
    break;
  }

  case "get": {
    const id = args[0];
    if (!id) { console.error("Usage: brain get <id>"); process.exit(1); }
    const { getDb, closeDb } = await import("../src/db.js");
    try {
      const conn = await getDb(true);
      for (const table of ["Experience", "Knowledge", "Entity"]) {
        try {
          const stmt = await conn.prepare(`MATCH (n:${table} {id: $id}) RETURN n.*`);
          const rows = await (await conn.execute(stmt, { id })).getAll();
          if (rows.length > 0) {
            console.log(JSON.stringify({ type: table, ...rows[0] }));
            await closeDb();
            process.exit(0);
          }
        } catch { /* try next */ }
      }
      console.log("null");
      await closeDb();
    } catch (e) {
      console.error("Error:", e.message);
    }
    break;
  }

  case "remove": {
    const id = args[0];
    if (!id) { console.error("Usage: brain remove <id>"); process.exit(1); }
    const { getDb, closeDb } = await import("../src/db.js");
    const { loadEmbeddings, saveEmbeddings } = await import("../src/embed.js");
    let deleted = false;
    try {
      const conn = await getDb(false);
      for (const table of ["Knowledge", "Experience", "Entity"]) {
        try {
          const check = await (await conn.query(`MATCH (n:${table} {id: '${id.replace(/'/g, "\\'")}' }) RETURN n.id AS id`)).getAll();
          if (check.length > 0) {
            await conn.query(`MATCH (n:${table} {id: '${id.replace(/'/g, "\\'")}' }) DETACH DELETE n`);
            deleted = true;
            console.log(`Deleted ${table} node: ${id}`);
            break;
          }
        } catch { /* try next */ }
      }
      await closeDb();
      if (!deleted) { console.log(`Not found: ${id}`); process.exit(1); }
      const store = loadEmbeddings();
      if (store[id]) {
        delete store[id];
        saveEmbeddings(store);
        console.log(`Removed embedding for: ${id}`);
      }
      console.log("OK — MEMORY.md will self-heal on next consolidate");
    } catch (e) {
      console.error("Error:", e.message);
      process.exit(1);
    }
    break;
  }

  case "consolidate": {
    const consolidateFlags = args.filter(a => a.startsWith("--"));
    if (consolidateFlags.length === 0) consolidateFlags.push("--focus", "--recent");
    spawnConsolidate(...consolidateFlags);
    console.log("OK — consolidate spawned with: " + consolidateFlags.join(" "));
    break;
  }

  case "ingest": {
    const { flags: iFlags } = parseFlags(args);
    const ingestArgs = ["--ingest"];
    if (iFlags.dir) ingestArgs.push("--ingest-dir", path.resolve(iFlags.dir.replace("~", os.homedir())));
    if (iFlags.threshold) ingestArgs.push("--threshold", iFlags.threshold);
    spawnConsolidate(...ingestArgs);
    console.log("OK — ingest spawned");
    break;
  }

  case "init": {
    const CWD = process.cwd();
    const brainJsonPath = path.join(CWD, "brain.json");

    // Load brain.json if present, else run interactive prompts
    let cfg;
    if (fs.existsSync(brainJsonPath)) {
      cfg = JSON.parse(fs.readFileSync(brainJsonPath, "utf-8"));
      console.log(`✦ brain.json found — using config`);
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q, def) => new Promise(res => rl.question(`  ${q}${def ? ` (${def})` : ""}: `, a => res(a.trim() || def || "")));

      console.log(`\n  ✦ brain init\n`);
      const projectName = await ask("Project name", path.basename(CWD));
      const brainDir = await ask("Brain directory", ".brain");
      const ingestAnswer = await ask("Scan project files for initial knowledge? (y/n)", "y");
      const ingestProject = ingestAnswer.toLowerCase().startsWith("y");

      cfg = { projectName, brainDir, ingestProject };
      rl.close();

      fs.writeFileSync(brainJsonPath, JSON.stringify(cfg, null, 2));
      console.log(`\n  ✓ Created brain.json`);
    }

    const { projectName = path.basename(CWD), brainDir: rawBrainDir = ".brain" } = cfg;
    const resolvedBrainDir = path.isAbsolute(rawBrainDir)
      ? rawBrainDir
      : path.join(CWD, rawBrainDir);
    const agentId = projectName.toLowerCase().replace(/[^a-z0-9]/g, "-");

    // --- Initialize brain DB ---
    fs.mkdirSync(resolvedBrainDir, { recursive: true });
    fs.mkdirSync(path.join(resolvedBrainDir, "memory"), { recursive: true });

    const brainConfig = { agentId, brainDir: resolvedBrainDir };
    fs.writeFileSync(path.join(resolvedBrainDir, "config.json"), JSON.stringify(brainConfig, null, 2));

    const memoryMdPath = path.join(resolvedBrainDir, "MEMORY.md");
    if (!fs.existsSync(memoryMdPath)) {
      fs.writeFileSync(memoryMdPath, `# MEMORY.md — ${projectName}\n\n<!-- BRAIN:FOCUS:START -->\n# Focus\n<!-- BRAIN:FOCUS:END -->\n\n<!-- BRAIN:RECENT:START -->\n# Recent\n<!-- BRAIN:RECENT:END -->\n\n<!-- BRAIN:PERMANENT:START -->\n# Permanent\n<!-- BRAIN:PERMANENT:END -->\n`);
    }

    const created = [];

    // --- AGENTS.md: shell instructions, works for every agent ---
    const agentsMdPath = path.join(CWD, "AGENTS.md");
    const agentsSnippet = `\n## Memory (brain)\n\nUse brain CLI to maintain persistent memory across sessions.\n\n- **Session start**: \`brain recall "current task"\` — prime context before working\n- **After tasks/decisions**: \`brain push '{"type":"knowledge","text":"...","entities":["topic"]}'\`\n- **Flush queue**: \`brain flush\` — write queue to graph\n- **BRAIN_DIR**: \`${resolvedBrainDir}\`\n`;
    if (!fs.existsSync(agentsMdPath)) {
      fs.writeFileSync(agentsMdPath, `# ${projectName}${agentsSnippet}`);
      created.push("AGENTS.md");
    } else if (!fs.readFileSync(agentsMdPath, "utf-8").includes("brain recall")) {
      fs.appendFileSync(agentsMdPath, agentsSnippet);
      created.push("AGENTS.md (brain snippet appended)");
    }

    // --- Claude instructions: .claude/brain.md if .claude/ exists, else CLAUDE.md at root ---
    const claudeDir = path.join(CWD, ".claude");
    const claudeMdPath = fs.existsSync(claudeDir)
      ? path.join(claudeDir, "brain.md")
      : path.join(CWD, "CLAUDE.md");
    const claudeSnippet = `## Memory (brain)\n\nYou have persistent memory. Use it proactively — don't rely on conversation history.\n\n**Session start** (do both):\n1. Read \`${resolvedBrainDir}/MEMORY.md\` — pre-built summary of accumulated knowledge (Focus, Recent, Permanent sections)\n2. Call \`brain_recall\` with the current task for live semantic search\n\n**After completing tasks or making decisions**: call \`brain_push\` immediately — don't wait.\n\nPush format:\n\`\`\`json\n{"type":"knowledge","text":"what was learned or decided","entities":["topic","decision"],"tmp_weight":3.0}\n\`\`\`\n\`tmp_weight\` 1–5: importance for future recall (5 = critical, 1 = routine log).\n\n**Check recent unflushed work**: \`brain_recall\` includes pending queue items (\`source: "queue"\`).\n\n**Remove bad/stale nodes**: \`brain_remove <id>\` — MEMORY.md self-heals on next consolidation.\n`;
    if (!fs.existsSync(claudeMdPath)) {
      fs.writeFileSync(claudeMdPath, claudeSnippet);
      created.push(path.relative(CWD, claudeMdPath));
    } else if (!fs.readFileSync(claudeMdPath, "utf-8").includes("brain_recall")) {
      fs.appendFileSync(claudeMdPath, "\n" + claudeSnippet);
      created.push(path.relative(CWD, claudeMdPath) + " (brain snippet appended)");
    }

    // --- .mcp.json: register brain MCP server for Claude Code ---
    const mcpJsonPath = path.join(CWD, ".mcp.json");
    const BRAIN_MCP = path.join(BIN_DIR, "../src/mcp.js");
    const mcpExisting = fs.existsSync(mcpJsonPath) ? JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8")) : {};
    mcpExisting.mcpServers = mcpExisting.mcpServers || {};
    mcpExisting.mcpServers.brain = {
      command: "node",
      args: [BRAIN_MCP],
      env: { BRAIN_DIR: resolvedBrainDir }
    };
    fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpExisting, null, 2));
    created.push(".mcp.json");

    // --- Claude Code hooks: wire Stop + PostToolUse into .claude/settings.local.json (project-level, personal) ---
    const claudeSettingsPath = path.join(CWD, ".claude", "settings.local.json");
    try {
      const BRAIN_BIN = process.argv[1]; // path to this brain.js
      const flushCmd = `BRAIN_DIR=${resolvedBrainDir} node ${BRAIN_BIN} flush`;
      const consolidateCmd = `BRAIN_DIR=${resolvedBrainDir} node ${BRAIN_BIN} consolidate --focus --recent`;

      const settings = fs.existsSync(claudeSettingsPath)
        ? JSON.parse(fs.readFileSync(claudeSettingsPath, "utf-8"))
        : {};

      settings.hooks = settings.hooks || {};

      // PostToolUse: flush queue after every tool call
      // Claude Code hook format: { matcher: "", hooks: [{ type: "command", command: "..." }] }
      // Always remove stale brain entries for this BRAIN_DIR, then re-add with correct format
      const isBrainHook = (h) => h?.command?.includes(resolvedBrainDir) || h?.hooks?.[0]?.command?.includes(resolvedBrainDir);

      settings.hooks.PostToolUse = (settings.hooks.PostToolUse || []).filter(h => !isBrainHook(h));
      settings.hooks.PostToolUse.push({
        matcher: "",
        hooks: [{ type: "command", command: flushCmd }]
      });

      settings.hooks.Stop = (settings.hooks.Stop || []).filter(h => !isBrainHook(h));
      settings.hooks.Stop.push({
        matcher: "",
        hooks: [{ type: "command", command: `${flushCmd} && ${consolidateCmd} --embed` }]
      });

      fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
      fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2));
      created.push(".claude/settings.local.json (PostToolUse + Stop hooks)");
    } catch (e) {
      console.warn(`  ⚠ Could not wire Claude Code hooks: ${e.message}`);
    }

    // Print summary after all created[] items are populated (Level 1 + 2 push below)
    // --- Level 1: System knowledge (always) ---
    const systemKnowledgePath = [
      path.join(BIN_DIR, "../system-knowledge/brain.json"),
      path.join(fs.realpathSync(BIN_DIR), "../system-knowledge/brain.json"),
    ].find(p => fs.existsSync(p));
    if (systemKnowledgePath) {
      const sysData = JSON.parse(fs.readFileSync(systemKnowledgePath, "utf-8"));
      const nodes = sysData.nodes || [];
      let sysCount = 0;
      for (const node of nodes) {
        const item = { ...node, agent: agentId, source: "system", timestamp: new Date().toISOString() };
        fs.appendFileSync(path.join(resolvedBrainDir, "queue.jsonl"), JSON.stringify(item) + "\n");
        sysCount++;
      }
      created.push(`system-knowledge: queued ${sysCount} nodes`);
    } else {
      console.warn(`  ⚠ system-knowledge not found (looked in ${path.join(BIN_DIR, "../system-knowledge/")})`);
    }

    // --- Level 2: Project scan (optional) ---
    // If brain.json exists but has no ingestProject key, prompt interactively
    let ingestProject = cfg.ingestProject;
    if (ingestProject === undefined) {
      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = await new Promise(res => rl2.question(`\n  Scan project files for initial knowledge? (y/n) [y]: `, a => res(a.trim() || "y")));
      rl2.close();
      ingestProject = ans.toLowerCase().startsWith("y");
      cfg.ingestProject = ingestProject;
      fs.writeFileSync(brainJsonPath, JSON.stringify(cfg, null, 2));
    }
    if (ingestProject) {
      // Find candidate files: README, package.json, docs, config files
      const candidates = [];
      const scanPatterns = [
        "README.md", "README.txt", "package.json", "pyproject.toml",
        "Cargo.toml", "go.mod", "ARCHITECTURE.md", "CONTRIBUTING.md",
      ];
      for (const f of scanPatterns) {
        const fp = path.join(CWD, f);
        if (fs.existsSync(fp)) candidates.push(fp);
      }
      // Scan docs/ and src/ for .md files (max 10)
      for (const dir of ["docs", "doc", "src", ".claude"]) {
        const dirPath = path.join(CWD, dir);
        if (!fs.existsSync(dirPath)) continue;
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith(".md")).slice(0, 5);
        candidates.push(...files.map(f => path.join(dirPath, f)));
      }

      if (candidates.length > 0) {
        console.log(`\n  Scanning ${candidates.length} project files...`);
        spawnConsolidate("--ingest", "--ingest-dir", CWD, "--ingest-files", candidates.join(","));
        created.push(`project scan: ${candidates.length} files queued for ingestion`);
      }
    }

    console.log(`\n  ✓ ${projectName} — brain initialized`);
    console.log(`  brain dir:  ${resolvedBrainDir}`);
    console.log(`  agent ID:   ${agentId}`);
    for (const f of created) console.log(`  created:    ${f}`);
    console.log(`\n  Ready. Start your Claude Code session — brain will handle the rest.`);
    break;
  }

  default:
    console.error(`Unknown command: ${cmd}. Run 'brain --help' for usage.`);
    process.exit(1);
}
