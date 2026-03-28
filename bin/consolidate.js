#!/usr/bin/env node
import os from "os";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { initSchema, getDb, closeDb } from "../src/db.js";
import { embed, saveEmbedding, cosine, loadEmbeddings } from "../src/embed.js";
import crypto from "crypto";

const DEFAULT_BRAIN_DIR = path.join(os.homedir(), "corpus", "brain");
const BRAIN_DIR = process.env.BRAIN_DIR
  ? path.resolve(process.env.BRAIN_DIR)
  : DEFAULT_BRAIN_DIR;

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(BRAIN_DIR, "config.json"), "utf-8")); }
  catch { return {}; }
}
const _cfg = loadConfig();

const QUEUE_PATH = path.join(BRAIN_DIR, "queue.jsonl");
const LOCK_PATH = path.join(BRAIN_DIR, "consolidate.lock");
const LOG_PATH = path.join(BRAIN_DIR, "consolidate.log");

const AGENT_ID = process.env.BRAIN_AGENT_ID || _cfg.agentId || "neo";
const CORPUS_ROOT = (process.env.BRAIN_CORPUS_ROOT || _cfg.corpusRoot || path.join(os.homedir(), "corpus")).replace("~", os.homedir());
const USER_DIR = path.join(CORPUS_ROOT, "users", AGENT_ID);
const MEMORY_MD_PATH = path.join(USER_DIR, "MEMORY.md");
const DAILY_DIR = path.join(USER_DIR, "memory");

function log(msg) {
  const line = `[${new Date().toISOString().slice(0, 19)}] ${msg}`;
  fs.appendFileSync(LOG_PATH, line + "\n");
  console.error(line);
}

// Atomic lock — openSync('wx') fails with EEXIST if the file already exists,
// eliminating the TOCTOU race between check and write.
function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_PATH, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    // Lock exists — check if the owning process is still alive
    try {
      const pid = parseInt(fs.readFileSync(LOCK_PATH, "utf-8").trim(), 10);
      if (pid && !isNaN(pid)) {
        try {
          process.kill(pid, 0); // throws ESRCH if dead
          log("consolidate already running (lock exists). Exiting.");
          process.exit(0);
        } catch {
          log(`Stale lock (pid ${pid} dead), removing.`);
        }
      }
    } catch { /* malformed lock file — fall through to remove */ }
    fs.unlinkSync(LOCK_PATH);
    // Retry once after removing stale lock
    const fd = fs.openSync(LOCK_PATH, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch { /* ignore */ }
}

const uid = () => crypto.randomUUID().slice(0, 12);
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const shellEscape = (s) => "'" + s.replace(/'/g, "'\\''") + "'";

// --- Parse CLI flags ---
// --input <file>  flush a specific file into the graph (queue.jsonl or a buffer file)
// --focus         update MEMORY.md focus section
// --recent        update MEMORY.md recent section
// --permanent     LLM-summarize top knowledge into permanent section
// --daily         write daily log file
// --maintain      prune old experiences, strengthen edges
// --embed         backfill embeddings for existing nodes
const flags = { focus: false, recent: false, permanent: false, summarize: false, daily: false, maintain: false, embed: false, input: null, ingest: false, ingestDir: null, threshold: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--input" && process.argv[i + 1]) flags.input = process.argv[++i];
  else if (a === "--ingest-dir" && process.argv[i + 1]) flags.ingestDir = process.argv[++i];
  else if (a === "--threshold" && process.argv[i + 1]) flags.threshold = parseFloat(process.argv[++i]);
  else if (a.startsWith("--") && a.slice(2) in flags) flags[a.slice(2)] = true;
}
if (!Object.values(flags).some(v => v)) {
  // Default: update memory sections (flush is explicit via --input)
  flags.focus = flags.recent = true;
}

// --- MEMORY.md management ---
// Sections are stored in memory so each runX() can contribute its part,
// then writeMemory() builds and writes the full file at the end of the run.
const _memorySections = {};

function setMemorySection(section, content) {
  _memorySections[section] = content;
}

function writeMemory() {
  fs.mkdirSync(path.dirname(MEMORY_MD_PATH), { recursive: true });

  // Load existing sections not updated this run
  // Supports both old marker format and new plain format
  const existing = {};
  if (fs.existsSync(MEMORY_MD_PATH)) {
    const raw = fs.readFileSync(MEMORY_MD_PATH, "utf-8");
    for (const s of ["FOCUS", "RECENT", "PERMANENT"]) {
      // Try old HTML comment marker format first
      const markerMatch = raw.match(new RegExp(`<!-- BRAIN:${s}:START -->([\\s\\S]*?)<!-- BRAIN:${s}:END -->`));
      if (markerMatch) { existing[s] = markerMatch[1].trim(); continue; }
      // Try new plain format: section starts with "# Focus/Recent/Permanent"
      const label = s[0] + s.slice(1).toLowerCase();
      const plainMatch = raw.match(new RegExp(`(# ${label}[\\s\\S]*?)(?=\\n# [A-Z]|$)`));
      if (plainMatch) existing[s] = plainMatch[1].trim();
    }
  }

  const merged = { ...existing, ..._memorySections };
  const order = ["FOCUS", "RECENT", "PERMANENT"];
  const md = "# MEMORY.md — Long-term Memory\n\n" +
    order.filter(s => merged[s]).map(s => merged[s]).join("\n\n") + "\n";

  fs.writeFileSync(MEMORY_MD_PATH, md);
}

// --- DB query helper ---
async function withDb(readOnly, fn) {
  await initSchema();
  const conn = await getDb(readOnly);
  try { return await fn(conn); }
  finally { await closeDb(); }
}

async function safeQuery(conn, sql) {
  try { return await (await conn.query(sql)).getAll(); }
  catch { return []; }
}

// --- Item validation ---
// Rejects malformed or binary-corrupted items before they reach the DB.
function validateItem(item) {
  if (!item || typeof item !== "object") return false;
  if (!item.type) return false;
  if (item.type === "graph_import") return true; // handled separately

  // Validate text fields are readable strings (not binary garbage)
  const textField = item.text || item.content || item.summary;
  if (textField !== undefined) {
    if (typeof textField !== "string") return false;
    if (textField.length > 0) {
      const printable = [...textField].filter(c => {
        const code = c.charCodeAt(0);
        return code >= 32 || c === "\n" || c === "\t" || c === "\r";
      }).length;
      if (printable / textField.length < 0.9) return false; // binary garbage
    }
  }
  return true;
}

// --- Focus ---
// Score = weighted_centrality × exp(-days_old × λ)
// λ=0.05 → ~14 day half-life so important threads survive short detours
const FOCUS_LAMBDA = 0.05;

async function runFocus() {
  try {
    // Strategy: group all Knowledge nodes by entity.
    // Per entity: show the most recent knowledge node (tags tell us current state).
    // Score entities by centrality × decay, show top 5.
    // Hide nodes explicitly tagged 'resolved'.
    const rows = await withDb(true, (conn) =>
      safeQuery(conn, `
        MATCH (k:Knowledge)-[:ABOUT]->(e:Entity)
        WHERE k.agent = '${esc(AGENT_ID)}'
        OPTIONAL MATCH (k)-[r]-(:Entity)
        WITH k, e, COALESCE(SUM(r.weight), 0) + 1 AS centrality
        RETURN k.id AS id, k.text AS text, k.timestamp AS ts, k.tags AS tags,
               e.id AS entityId, centrality
      `)
    );

    // Build per-entity → most recent knowledge map
    const threadInfo = new Map();   // nodeId → {id, text, ts, tags, centrality}
    const threadEntities = new Map(); // nodeId → Set<entityId>
    const entityLatest = new Map();  // entityId → {ts, tags, nodeId}

    for (const r of rows) {
      if (!threadInfo.has(r.id)) {
        threadInfo.set(r.id, { id: r.id, text: r.text, ts: r.ts, tags: r.tags || [], centrality: r.centrality });
      }
      if (!threadEntities.has(r.id)) threadEntities.set(r.id, new Set());
      threadEntities.get(r.id).add(r.entityId);

      const prev = entityLatest.get(r.entityId);
      if (!prev || r.ts > prev.ts) entityLatest.set(r.entityId, { ts: r.ts, tags: r.tags || [], nodeId: r.id });
    }

    // For each entity: use its most recent knowledge node.
    // Score = centrality × exp(-days × λ). Skip if tagged 'resolved'.
    const agentEntityId = `entity:${AGENT_ID.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
    const now = Date.now();
    const seen = new Set(); // deduplicate nodes shown via multiple entities
    const scored = [];
    for (const [entityId, latest] of entityLatest) {
      if (entityId === agentEntityId) continue; // too broad
      if ((latest.tags || []).includes('resolved')) continue;
      if (seen.has(latest.nodeId)) continue;
      seen.add(latest.nodeId);
      const info = threadInfo.get(latest.nodeId);
      if (!info) continue;
      const days = (now - new Date(info.ts || now).getTime()) / 86400000;
      scored.push({ text: info.text, score: info.centrality * Math.exp(-days * FOCUS_LAMBDA) });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 5);

    let content = "# Focus\n";
    if (top.length > 0) {
      for (const t of top) {
        content += `- ${(t.text || "").slice(0, 120)}\n`;
      }
    } else {
      content += "_No open threads_\n";
    }
    setMemorySection("FOCUS", content);
    log(`Focus: ${top.length} nodes (entity-grouped, tag-filtered, centrality × decay)`);
  } catch (e) { log(`Focus error: ${e.message}`); }
}

// --- Summarize ---
// Per high-centrality entity: gather all thread/thread_update/thread_closed nodes
// ordered by timestamp, LLM synthesizes current state → writes/updates Summary node.
// Fires on 6h cron alongside runPermanent.
async function runSummarize() {
  try {
    // Find top entities by centrality (most connected = most important topics)
    const topEntities = await withDb(true, (conn) =>
      safeQuery(conn, `
        MATCH (e:Entity)
        OPTIONAL MATCH ()-[r]-(e)
        WITH e, COALESCE(SUM(r.weight), 0) + 1 AS centrality
        WHERE centrality >= 3
        RETURN e.id AS entityId, e.name AS entityName, centrality
        ORDER BY centrality DESC LIMIT 10
      `)
    );

    if (!topEntities.length) { log("Summarize: no high-centrality entities found"); return; }

    // For each top entity: gather all connected Knowledge + Experience nodes
    const toSummarize = await withDb(true, async (conn) => {
      const result = [];
      for (const { entityId, entityName, centrality } of topEntities) {
        const nodes = await safeQuery(conn, `
          MATCH (n)-[:ABOUT|INVOLVES]->(e:Entity {id: '${esc(entityId)}'})
          WHERE (n:Knowledge OR n:Experience) AND n.agent = '${esc(AGENT_ID)}'
            AND NOT ('summary' IN coalesce(n.tags, []))
          RETURN n.text AS text, n.timestamp AS ts
          ORDER BY n.timestamp DESC LIMIT 15
        `);
        if (nodes.length >= 3) result.push({ entityId, entityName, centrality, nodes });
      }
      return result;
    });

    if (!toSummarize.length) { log("Summarize: not enough nodes for synthesis"); return; }

    // LLM synthesizes each entity cluster → pushes as Knowledge node with all entity connections
    const queueItems = [];
    for (const { entityId, entityName, nodes } of toSummarize) {
      const nodeList = nodes.map(n => `- ${(n.text || "").slice(0, 160)}`).join("\n");
      const prompt = `Synthesize these notes about "${entityName}" into one dense paragraph (max 200 chars) capturing the essential current state — facts, decisions, risks, progress. No preamble:\n\n${nodeList}`;
      try {
        const synthesis = execSync(`echo ${shellEscape(prompt)} | claude --print --permission-mode bypassPermissions`, {
          encoding: "utf-8", timeout: 30_000, maxBuffer: 512 * 1024,
        }).trim().slice(0, 300);
        if (!synthesis) continue;
        // Push as a regular Knowledge node — highly connected = naturally high centrality
        queueItems.push({
          id: `know:summary:${entityId}:${Date.now()}`,
          type: "knowledge",
          text: synthesis,
          entities: [entityName, AGENT_ID],
          tags: ["summary"],
          agent: AGENT_ID,
          timestamp: new Date().toISOString(),
          source: "brain-summarize",
        });
      } catch { /* skip */ }
    }

    if (!queueItems.length) { log("Summarize: no synthesis generated"); return; }

    // Write via runFlush pipeline (handles entity wiring + embeddings)
    const tmpPath = path.join(BRAIN_DIR, `summarize-${Date.now()}.jsonl`);
    fs.writeFileSync(tmpPath, queueItems.map(i => JSON.stringify(i)).join("\n"));
    await runFlush(tmpPath);

    log(`Summarize: pushed ${queueItems.length} synthesis nodes`);
  } catch (e) { log(`Summarize error: ${e.message}`); }
}

// --- Recent ---
// Filter noise: exclude heartbeat acks, empty cron runs, zero-edge experiences
// All outcomes included (failures are meaningful)
const RECENT_NOISE = ['heartbeat_ok', 'heartbeat ok', 'cron', 'heartbeat'];

function isNoise(text) {
  if (!text) return true;
  const t = text.toLowerCase();
  return RECENT_NOISE.some(n => t.includes(n));
}

async function runRecent() {
  try {
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const [experiences, knowledges] = await withDb(true, async (conn) => [
      await safeQuery(conn, `
        MATCH (e:Experience)
        WHERE e.agent = '${esc(AGENT_ID)}' AND e.timestamp > '${esc(cutoff)}'
        OPTIONAL MATCH (e)-[r]-(:Entity)
        WITH e, COUNT(r) AS edge_count
        WHERE edge_count > 0
        RETURN e.text AS text, e.tags AS tags
        ORDER BY e.timestamp DESC LIMIT 10
      `),
      await safeQuery(conn, `
        MATCH (k:Knowledge)
        WHERE k.agent = '${esc(AGENT_ID)}' AND k.timestamp > '${esc(cutoff)}'
        RETURN k.text AS text, k.tags AS tags
        ORDER BY k.timestamp DESC LIMIT 12
      `),
    ]);

    const filteredExp = experiences.filter(e => !isNoise(e.text));
    const filteredKnow = knowledges.filter(k => !isNoise(k.text));

    let content = "# Recent\n";
    for (const e of filteredExp.slice(0, 5)) {
      const tagStr = (e.tags || []).length ? ` [${e.tags.join(",")}]` : "";
      content += `- ${(e.text || "experience").slice(0, 100)}${tagStr}\n`;
    }
    for (const k of filteredKnow.slice(0, 8)) {
      const tagStr = (k.tags || []).length ? ` [${k.tags.join(",")}]` : "";
      content += `- ${(k.text || "").slice(0, 100)}${tagStr}\n`;
    }
    if (!filteredExp.length && !filteredKnow.length) content += "_No recent meaningful activity_\n";
    setMemorySection("RECENT", content);
    log(`Recent: ${filteredExp.length} experiences, ${filteredKnow.length} knowledges (noise filtered)`);
  } catch (e) { log(`Recent error: ${e.message}`); }
}

// --- Permanent ---
// All node types ranked by weighted centrality (sum of edge weights).
// LLM synthesizes from structured data — not extracting from raw text,
// but formulating readable memory lines from already-validated graph nodes.
async function runPermanent() {
  try {
    const [knowledge, experience, entity] = await withDb(true, async (conn) => [
      await safeQuery(conn, `
        MATCH (k:Knowledge)
        WHERE k.agent = '${esc(AGENT_ID)}'
        OPTIONAL MATCH (k)-[r]-(:Entity)
        WITH k, COALESCE(SUM(r.weight), 0) + 1 AS centrality
        WHERE centrality >= 1
        RETURN k.text AS text, 'knowledge' AS type, centrality
        ORDER BY centrality DESC LIMIT 12
      `),
      await safeQuery(conn, `
        MATCH (e:Experience)
        WHERE e.agent = '${esc(AGENT_ID)}'
        OPTIONAL MATCH (e)-[r]-(:Entity)
        WITH e, COALESCE(SUM(r.weight), 0) + 1 AS centrality
        WHERE centrality >= 2
        RETURN e.text AS text, 'experience' AS type, centrality
        ORDER BY centrality DESC LIMIT 6
      `),
      await safeQuery(conn, `
        MATCH (e:Entity)
        OPTIONAL MATCH ()-[r]-(e)
        WITH e, COALESCE(SUM(r.weight), 0) + 1 AS centrality
        WHERE centrality >= 2
        RETURN e.name AS text, 'entity' AS type, centrality
        ORDER BY centrality DESC LIMIT 6
      `),
    ]);

    const allNodes = [...knowledge, ...experience, ...entity]
      .sort((a, b) => b.centrality - a.centrality)
      .slice(0, 20);

    if (!allNodes.length) {
      setMemorySection("PERMANENT", "# Permanent\n_No high-centrality nodes yet_\n");
      log("Permanent: no nodes with sufficient centrality");
      return;
    }

    const nodeList = allNodes.map((n, i) =>
      `${i + 1}. [${n.type}] (centrality:${n.centrality.toFixed(1)}) ${(n.text || "").slice(0, 200)}`
    ).join("\n");

    const prompt = `You are writing the PERMANENT memory section for an AI agent. These are the most central nodes in the agent's knowledge graph — the facts, experiences, and entities that are most connected and referenced.\n\nYour task: write 5-10 concise bullet points capturing what is permanently true and important. Synthesize across node types. One line per bullet, no fluff, no preamble.\n\nHIGH-CENTRALITY NODES:\n${nodeList}\n\nOutput ONLY a markdown bulleted list:`;

    let summary;
    try {
      summary = execSync(`echo ${shellEscape(prompt)} | claude --print --permission-mode bypassPermissions`, {
        encoding: "utf-8", timeout: 120_000, maxBuffer: 1024 * 1024,
      }).trim();
    } catch {
      // Fallback: just list top nodes directly
      summary = allNodes.slice(0, 10).map(n => `- [${n.type}] ${(n.text || "").slice(0, 120)}`).join("\n");
    }
    setMemorySection("PERMANENT", `# Permanent\n${summary}\n`);
    log(`Permanent: synthesized from ${allNodes.length} high-centrality nodes`);
  } catch (e) { log(`Permanent error: ${e.message}`); }
}

// --- Daily ---
async function runDaily() {
  try {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const dayStart = new Date(today); dayStart.setHours(0, 0, 0, 0);
    const cutoff = dayStart.toISOString();
    const [experiences, knowledges] = await withDb(true, async (conn) => [
      await safeQuery(conn, `MATCH (e:Experience) WHERE e.agent = '${esc(AGENT_ID)}' AND e.timestamp > '${esc(cutoff)}' RETURN e.text AS text, e.tags AS tags, e.timestamp AS ts ORDER BY e.timestamp ASC`),
      await safeQuery(conn, `MATCH (k:Knowledge) WHERE k.agent = '${esc(AGENT_ID)}' AND k.timestamp > '${esc(cutoff)}' RETURN k.text AS text, k.tags AS tags ORDER BY k.timestamp ASC`),
    ]);
    let md = `# ${dateStr}\n\n`;
    if (experiences.length) {
      md += "## Experiences\n";
      for (const e of experiences) {
        const tagStr = (e.tags || []).length ? ` [${e.tags.join(",")}]` : "";
        md += `- ${(e.ts || "").slice(11, 16)} ${(e.text || "experience").slice(0, 150)}${tagStr}\n`;
      }
      md += "\n";
    }
    if (knowledges.length) {
      md += "## Knowledges\n";
      for (const k of knowledges) md += `- ${(k.text || "").slice(0, 150)}\n`;
      md += "\n";
    }
    if (!experiences.length && !knowledges.length) md += "_No activity today_\n";
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const dailyPath = path.join(DAILY_DIR, `${dateStr}.md`);
    fs.writeFileSync(dailyPath, md);
    log(`Daily: wrote ${dailyPath} (${experiences.length} exp, ${knowledges.length} know)`);
  } catch (e) { log(`Daily error: ${e.message}`); }
}

// --- Flush ---
// Reads items from filePath, validates each one, writes directly to Kuzu.
// No LLM. Agents generate structured JSON at runtime — extraction already happened.
async function runFlush(filePath) {
  if (!fs.existsSync(filePath)) { log(`No input file: ${filePath}`); return; }
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) { log("Empty input file."); return; }

  const allItems = raw.split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!allItems.length) { log("No valid items."); return; }

  const items = allItems.filter(validateItem);
  const rejected = allItems.length - items.length;
  if (rejected > 0) log(`Validation: rejected ${rejected} malformed/corrupted items`);

  log(`Flushing ${items.length} items`);

  await initSchema();
  const conn = await getDb();

  let nodes = 0, entities = 0, edges = 0;

  for (const item of items) {
    // --- graph_import: direct entity/relationship write ---
    if (item.type === "graph_import") {
      const { entities: ents = [], relationships = [] } = item.data || {};
      const entityIdMap = {};
      const graphSource = item.source || "brain-provider";

      for (const entity of ents) {
        const id = "entity:" + entity.name.toLowerCase().replace(/[^a-z0-9]/g, "-");
        entityIdMap[entity.name] = id;
        const metadata = JSON.stringify({ description: entity.description || "", source: graphSource });
        try {
          const stmt = await conn.prepare("MERGE (e:Entity {id: $id}) SET e.name = $name, e.text = $name, e.type = $type, e.metadata = $metadata, e.source = $source");
          await conn.execute(stmt, { id, name: entity.name, type: entity.label || "Concept", metadata, source: graphSource });
          const embVec = await embed([entity.name, entity.description || ""].filter(Boolean).join(" "));
          if (embVec) saveEmbedding(id, embVec);
          entities++;
        } catch { /* skip duplicate */ }
      }

      for (const rel of relationships) {
        const fromId = entityIdMap[rel.from];
        const toId = entityIdMap[rel.to];
        if (!fromId || !toId) continue;
        try {
          await conn.query(
            `MATCH (a:Entity {id: '${esc(fromId)}'}), (b:Entity {id: '${esc(toId)}'})` +
            ` CREATE (a)-[:CONNECTS {type: '${esc(rel.type || "RELATES_TO")}', weight: 1.0, source: '${esc(graphSource)}'}]->(b)`
          );
          edges++;
        } catch { /* skip duplicate edge */ }
      }

      log(`Graph import: ${ents.length} entities, ${relationships.length} relationships`);
      continue;
    }

    // --- knowledge / experience: write node + edges ---
    const id = item.id || `${item.type === "knowledge" ? "know" : "exp"}:${uid()}`;
    const ts = item.timestamp || new Date().toISOString();
    const agent = item.agent || AGENT_ID;
    const source = item.source || `local:${agent}`;
    const isKnowledge = item.type === "knowledge";

    // Tags: array of optional labels (e.g. ["risk","open","resolved","decision"])
    const tags = Array.isArray(item.tags) ? item.tags : [];

    try {
      const text = item.text || item.content || item.summary || "";
      if (isKnowledge) {
        const stmt = await conn.prepare(
          "MERGE (k:Knowledge {id: $id}) SET k.text = $text, k.agent = $agent, k.timestamp = $ts, k.source = $source, k.tags = $tags"
        );
        await conn.execute(stmt, { id, text, agent, ts, source, tags });
        const embVec = await embed(text);
        if (embVec) saveEmbedding(id, embVec);
      } else {
        const stmt = await conn.prepare(
          "MERGE (x:Experience {id: $id}) SET x.text = $text, x.agent = $agent, x.timestamp = $ts, x.source = $source, x.tags = $tags"
        );
        await conn.execute(stmt, { id, text, agent, ts, source, tags });
        const embVec = await embed(text);
        if (embVec) saveEmbedding(id, embVec);
      }
      nodes++;
    } catch (e) { log(`Node write error (${id}): ${e.message}`); continue; }

    // --- Entity wiring ---
    // Collect declared entities + always include the agent as an entity
    const declaredEntities = Array.isArray(item.entities) ? item.entities : [];
    const allEntityNames = [...new Set([agent, ...declaredEntities])];
    const nodeTable = isKnowledge ? "Knowledge" : "Experience";
    const edgeType = isKnowledge ? "ABOUT" : "INVOLVES";

    for (const name of allEntityNames) {
      const entityId = `entity:${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
      try {
        // Upsert entity node
        const stmt = await conn.prepare("MERGE (e:Entity {id: $id}) SET e.name = $name, e.text = $name, e.source = $source");
        await conn.execute(stmt, { id: entityId, name, source });
        entities++;
      } catch { /* skip */ }
      try {
        // Create edge: node --ABOUT/INVOLVES--> entity
        await conn.query(
          `MATCH (n:${nodeTable} {id: '${esc(id)}'}), (e:Entity {id: '${esc(entityId)}'})
           MERGE (n)-[:${edgeType} {source: '${esc(source)}'}]->(e)`
        );
        edges++;
      } catch { /* skip duplicate */ }
    }

    // --- DERIVED edge: experience produced this knowledge ---
    // Schema direction: Experience -[DERIVED]-> Knowledge
    if (isKnowledge && item.derives) {
      const derivesList = Array.isArray(item.derives) ? item.derives : [item.derives];
      for (const expId of derivesList) {
        try {
          await conn.query(
            `MATCH (k:Knowledge {id: '${esc(id)}'}), (x:Experience {id: '${esc(expId)}'})
             MERGE (x)-[:DERIVED {source: '${esc(source)}'}]->(k)`
          );
          edges++;
        } catch { /* experience may not exist yet */ }
      }
    }

    // --- RELATES_TO edges: explicit Knowledge→Knowledge links ---
    // Used for thread_closed nodes to declare what they resolve.
    // Format: relates_to: ["know:abc123"]  →  RELATES_TO {why:"resolves"}
    if (item.relates_to) {
      const relatesList = Array.isArray(item.relates_to) ? item.relates_to : [item.relates_to];
      for (const targetId of relatesList) {
        const targetTable = targetId.startsWith("exp:") ? "Experience" : "Knowledge";
        try {
          await conn.query(
            `MATCH (n:${nodeTable} {id: '${esc(id)}'}), (t:${targetTable} {id: '${esc(targetId)}'})
             MERGE (n)-[:RELATES_TO {why: 'resolves', source: '${esc(source)}', weight: 1.0}]->(t)`
          );
          edges++;
        } catch { /* target may not exist yet */ }
      }
    }

    if (allEntityNames.length === 0) {
      log(`Warning: node ${id} has no entity references — isolated node`);
    }
  }

  // Clear input after successful write
  const isQueue = filePath === QUEUE_PATH;
  if (isQueue) fs.writeFileSync(filePath, "");
  else fs.unlinkSync(filePath);

  await closeDb();
  log(`Flush done. ${nodes} nodes, ${entities} entities, ${edges} edges.`);

  await exportIndex();
}

// --- Maintain ---
async function runMaintain() {
  await initSchema();
  const conn = await getDb();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  let pruned = 0, strengthened = 0;

  // Prune old experiences with no derived knowledge
  try {
    const rows = await (await conn.query(
      `MATCH (e:Experience) WHERE e.timestamp < '${esc(cutoff)}' AND NOT EXISTS { MATCH (e)-[:DERIVED]->(:Knowledge) } RETURN e.id AS id`
    )).getAll();
    for (const row of rows) {
      try { await conn.query(`MATCH (e:Experience {id: '${esc(row.id)}'}) DETACH DELETE e`); pruned++; } catch { /* skip */ }
    }
  } catch (e) { log(`Prune error: ${e.message}`); }

  // Strengthen recently traversed edges
  // Note: ABOUT crashes LadybugDB (csr_node_group.cpp assertion) — skipped until upstream fix
  const now = new Date().toISOString();
  for (const rel of ["DERIVED", "INVOLVES", "RELATES_TO", "FOLLOWS"]) {
    try {
      await conn.query(`MATCH ()-[r:${rel}]->() SET r.weight = r.weight + 1`);
      await conn.query(`MATCH (x:Experience)-[r:${rel}]->() SET x.last_accessed_at = '${esc(now)}'`);
      const rows = await (await conn.query(`MATCH ()-[r:${rel}]->() RETURN count(r) AS c`)).getAll();
      strengthened += rows[0]?.c || 0;
    } catch (e) { log(`Strengthen ${rel} error: ${e.message}`); }
  }

  await closeDb();
  log(`Maintenance done. Pruned ${pruned} stale experiences, strengthened ${strengthened} edges.`);
}

// --- Export index.md ---
async function exportIndex() {
  try {
    const [knowledges, experiences, entities] = await withDb(true, async (conn) => [
      await safeQuery(conn, `MATCH (k:Knowledge) RETURN k.id AS id, k.text AS text, k.tags AS tags, k.agent AS agent, k.timestamp AS timestamp ORDER BY k.timestamp DESC`),
      await safeQuery(conn, `MATCH (e:Experience) RETURN e.id AS id, e.text AS text, e.tags AS tags, e.agent AS agent, e.timestamp AS timestamp ORDER BY e.timestamp DESC`),
      await safeQuery(conn, `MATCH (e:Entity) RETURN e.id AS id, e.name AS name, e.tags AS tags, e.description AS description, e.source AS source ORDER BY e.id ASC`),
    ]);
    let md = "";
    for (const k of knowledges) {
      const tagStr = (k.tags || []).length ? `\ntags: ${k.tags.join(",")}` : "";
      md += `## ${k.id}\ntype: knowledge\nagent: ${k.agent || ""}\ncontent: ${k.text || ""}${tagStr}\ntimestamp: ${k.timestamp || ""}\n\n`;
    }
    for (const e of experiences) {
      const tagStr = (e.tags || []).length ? `\ntags: ${e.tags.join(",")}` : "";
      md += `## ${e.id}\ntype: experience\nagent: ${e.agent || ""}\nsummary: ${e.text || ""}${tagStr}\ntimestamp: ${e.timestamp || ""}\n\n`;
    }
    for (const e of entities) {
      md += `## ${e.id}\ntype: entity\nname: ${e.name || ""}`;
      if (e.description) md += `\ndescription: ${e.description}`;
      if (e.source) md += `\nsource: ${e.source}`;
      md += `\n\n`;
    }
    const indexPath = path.join(BRAIN_DIR, "index.md");
    fs.writeFileSync(indexPath, md);
    log(`exportIndex: wrote ${indexPath} (${knowledges.length} knowledge, ${experiences.length} experience, ${entities.length} entities)`);
  } catch (e) { log(`exportIndex error: ${e.message}`); }
}

// --- Backfill embeddings for existing nodes ---
async function runEmbed() {
  await initSchema();
  const conn = await getDb(true);
  const { saveEmbeddings, loadEmbeddings } = await import("../src/embed.js");
  const existing = loadEmbeddings();
  const batch = {};
  let count = 0;
  const tables = [
    { table: "Knowledge", textField: "text" },
    { table: "Experience", textField: "text" },
    { table: "Entity",     textField: "text" },
  ];
  for (const { table, textField } of tables) {
    try {
      const rows = await safeQuery(conn, `MATCH (n:${table}) RETURN n.id AS id, n.${textField} AS text`);
      let tableCount = 0;
      for (const row of rows) {
        if (!row.text || existing[row.id]) continue;
        try {
          const vec = await embed(row.text);
          if (!vec) continue;
          batch[row.id] = vec;
          count++;
          tableCount++;
        } catch (e) { log(`Embed error (${row.id}): ${e.message}`); }
      }
      log(`Embed: backfilled ${tableCount} ${table} nodes`);
    } catch (e) { log(`Embed ${table} error: ${e.message}`); }
  }
  await closeDb();
  if (count > 0) saveEmbeddings(batch);
  log(`Embed backfill done. ${count} nodes embedded.`);
}

// --- Ingest daily logs into graph ---
async function isDuplicate(text, threshold = 0.85) {
  try {
    const vec = await embed(text);
    if (!vec) return false;
    const embs = loadEmbeddings();
    let maxScore = 0;
    for (const stored of Object.values(embs)) {
      const s = cosine(vec, stored);
      if (s > maxScore) maxScore = s;
    }
    return maxScore >= threshold;
  } catch { return false; }
}

async function extractItemsFromFile(content, agentId) {
  const { runClaude } = await import("../src/worker.js");
  const prompt = `Extract knowledge and experiences from this daily log as a JSON array.

Each item must be one of:
- {"type":"knowledge","text":"...","entities":["topic1","topic2"],"tags":["decision","risk","open"]}
- {"type":"experience","text":"...","entities":["project","tool"],"tags":["success","fail","partial"]}

Rules:
- Only concrete facts, decisions, tasks — omit heartbeat/ok/trivial entries
- entities[] must have at least one item
- tags[] is optional — only include when classification clearly adds value
- content/summary should be a single clear sentence
- Return ONLY a JSON array, no explanation, no markdown

Daily log:
${content.slice(0, 6000)}`;

  try {
    const raw = await runClaude(prompt);
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const items = JSON.parse(match[0]);
    return items.map(item => ({ ...item, agent: agentId, timestamp: new Date().toISOString() }));
  } catch (e) {
    log(`extractItems error: ${e.message}`);
    return [];
  }
}

async function runIngest(memoryDir, threshold = 0.82) {
  const files = fs.readdirSync(memoryDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
    .sort();

  log(`Ingest: found ${files.length} daily log files in ${memoryDir}`);

  let pushed = 0, skipped = 0, errors = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(memoryDir, file), "utf-8").trim();
    if (!content) continue;

    log(`Ingest: processing ${file} (${content.length} chars)`);
    const items = await extractItemsFromFile(content, AGENT_ID);

    for (const item of items) {
      try {
        const text = item.text || item.content || item.summary || "";
        if (!text) { errors++; continue; }

        const dup = await isDuplicate(text, threshold);
        if (dup) {
          log(`  skip (exists): ${text.slice(0, 60)}`);
          skipped++;
        } else {
          fs.appendFileSync(QUEUE_PATH, JSON.stringify(item) + "\n");
          log(`  push: ${text.slice(0, 60)}`);
          pushed++;
        }
      } catch (e) { errors++; }
    }
  }

  log(`Ingest: done. pushed=${pushed} skipped=${skipped} errors=${errors}`);

  if (pushed > 0) {
    log("Ingest: flushing queue...");
    await runFlush(QUEUE_PATH);
  }
}

// --- Main ---
async function run() {
  acquireLock();
  try {
    if (flags.maintain) await runMaintain();
    if (flags.ingest) {
      const memDir = flags.ingestDir || path.join(
        path.dirname(path.dirname(MEMORY_MD_PATH)), "memory"
      );
      await runIngest(memDir, flags.threshold || 0.85);
      return;
    }
    if (flags.input) {
      await runFlush(flags.input);
    } else {
      // exportIndex is called inside runFlush; call explicitly when flush didn't run
      await exportIndex();
    }
    if (flags.embed) await runEmbed();
    if (flags.summarize) await runSummarize();
    if (flags.focus) await runFocus();
    if (flags.recent) await runRecent();
    if (flags.permanent) await runPermanent();
    if (flags.daily) await runDaily();
    // Write MEMORY.md once at the end — full file, no markers
    if (flags.focus || flags.recent || flags.permanent) { writeMemory(); log("writeMemory: done"); }
    log("consolidate complete.");
  } finally { releaseLock(); }
}

run().catch(e => { log(`Fatal: ${e.message}`); releaseLock(); process.exit(1); });
