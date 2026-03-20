#!/usr/bin/env node
import os from "os";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { initSchema, getDb, closeDb, hashEmbedding } from "../src/db.js";
import crypto from "crypto";

const BRAIN_DIR = path.join(os.homedir(), "corpus", "brain");
const QUEUE_PATH = path.join(BRAIN_DIR, "queue.jsonl");
const LOCK_PATH = path.join(BRAIN_DIR, "consolidate.lock");
const LOG_PATH = path.join(BRAIN_DIR, "consolidate.log");

const AGENT_ID = process.env.BRAIN_AGENT_ID || "neo";
const USER_DIR = path.join(os.homedir(), "corpus", "users", AGENT_ID);
const MEMORY_MD_PATH = path.join(USER_DIR, "MEMORY.md");
const DAILY_DIR = path.join(USER_DIR, "memory");

function log(msg) {
  const line = `[${new Date().toISOString().slice(0, 19)}] ${msg}`;
  fs.appendFileSync(LOG_PATH, line + "\n");
  console.error(line);
}

function acquireLock() {
  if (fs.existsSync(LOCK_PATH)) {
    const stat = fs.statSync(LOCK_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 5 * 60 * 1000) {
      log("consolidate already running (lock exists). Exiting.");
      process.exit(0);
    }
    log("Stale lock detected, removing.");
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch { /* ignore */ }
}

function uid() {
  return crypto.randomUUID().slice(0, 12);
}

// --- Parse CLI flags ---
const flags = {
  drain: false,
  focus: false,
  recent: false,
  permanent: false,
  daily: false,
  maintain: false,
  input: null,
};

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--drain") flags.drain = true;
  else if (process.argv[i] === "--focus") flags.focus = true;
  else if (process.argv[i] === "--recent") flags.recent = true;
  else if (process.argv[i] === "--permanent") flags.permanent = true;
  else if (process.argv[i] === "--daily") flags.daily = true;
  else if (process.argv[i] === "--maintain") flags.maintain = true;
  else if (process.argv[i] === "--input" && process.argv[i + 1]) {
    flags.input = process.argv[++i];
  }
}

// Default: no flags = --drain --focus --recent
const anyFlag = flags.drain || flags.focus || flags.recent || flags.permanent || flags.daily || flags.maintain || flags.input;
if (!anyFlag) {
  flags.drain = true;
  flags.focus = true;
  flags.recent = true;
}

// --- MEMORY.md section management ---
function updateMemorySection(section, content) {
  fs.mkdirSync(path.dirname(MEMORY_MD_PATH), { recursive: true });

  let md = "";
  if (fs.existsSync(MEMORY_MD_PATH)) {
    md = fs.readFileSync(MEMORY_MD_PATH, "utf-8");
  }

  const startMarker = `<!-- BRAIN:${section}:START -->`;
  const endMarker = `<!-- BRAIN:${section}:END -->`;
  const block = `${startMarker}\n${content}\n${endMarker}`;

  const startIdx = md.indexOf(startMarker);
  const endIdx = md.indexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1) {
    md = md.slice(0, startIdx) + block + md.slice(endIdx + endMarker.length);
  } else {
    // Append at bottom
    md = md.trimEnd() + "\n\n" + block + "\n";
  }

  fs.writeFileSync(MEMORY_MD_PATH, md);
}

// --- Focus: open threads ---
async function runFocus() {
  try {
    await initSchema();
    const conn = await getDb(true);

    let threads = [];
    try {
      const r = await conn.query(
        `MATCH (k:Knowledge {kind: 'thread'}) RETURN k.content AS content, k.timestamp AS ts ORDER BY k.timestamp DESC LIMIT 5`
      );
      threads = await r.getAll();
    } catch { /* empty */ }

    await closeDb();

    let content = "# Focus\n";
    if (threads.length > 0) {
      for (const t of threads) {
        content += `- ${(t.content || "").slice(0, 120)}\n`;
      }
    } else {
      content += "_No open threads_\n";
    }

    updateMemorySection("FOCUS", content);
    log(`Focus: ${threads.length} threads`);
  } catch (e) {
    log(`Focus error: ${e.message}`);
  }
}

// --- Recent: last 48h experiences + knowledges ---
async function runRecent() {
  try {
    await initSchema();
    const conn = await getDb(true);
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    let experiences = [];
    try {
      const r = await conn.query(
        `MATCH (e:Experience) WHERE e.timestamp > '${escape(cutoff)}'
         RETURN e.summary AS summary, e.type AS type, e.outcome AS outcome, e.timestamp AS ts
         ORDER BY e.timestamp DESC LIMIT 5`
      );
      experiences = await r.getAll();
    } catch { /* empty */ }

    let knowledges = [];
    try {
      const r = await conn.query(
        `MATCH (k:Knowledge) WHERE k.timestamp > '${escape(cutoff)}' AND k.kind IN ['fact','decision']
         RETURN k.content AS content, k.kind AS kind, k.timestamp AS ts
         ORDER BY k.timestamp DESC LIMIT 8`
      );
      knowledges = await r.getAll();
    } catch { /* empty */ }

    await closeDb();

    let content = "# Recent\n";
    for (const e of experiences) {
      const outcome = e.outcome ? ` [${e.outcome}]` : "";
      content += `- ${(e.summary || e.type || "experience").slice(0, 100)}${outcome}\n`;
    }
    for (const k of knowledges) {
      const kind = k.kind ? `(${k.kind}) ` : "";
      content += `- ${kind}${(k.content || "").slice(0, 100)}\n`;
    }
    if (experiences.length === 0 && knowledges.length === 0) {
      content += "_No recent activity_\n";
    }

    updateMemorySection("RECENT", content);
    log(`Recent: ${experiences.length} experiences, ${knowledges.length} knowledges`);
  } catch (e) {
    log(`Recent error: ${e.message}`);
  }
}

// --- Permanent: LLM-summarized top knowledges ---
async function runPermanent() {
  try {
    await initSchema();
    const conn = await getDb(true);

    let knowledges = [];
    try {
      const r = await conn.query(
        `MATCH (k:Knowledge)
         RETURN k.content AS content, k.kind AS kind, k.timestamp AS ts
         ORDER BY k.timestamp DESC LIMIT 20`
      );
      knowledges = await r.getAll();
    } catch { /* empty */ }

    await closeDb();

    if (knowledges.length === 0) {
      updateMemorySection("PERMANENT", "# Permanent\n_No knowledge yet_\n");
      log("Permanent: no knowledges to summarize");
      return;
    }

    const knowledgeList = knowledges.map((k, i) =>
      `${i + 1}. (${k.kind || "fact"}) ${(k.content || "").slice(0, 200)}`
    ).join("\n");

    const prompt = `You are summarizing an agent's most important knowledge into permanent memory facts. Given these ${knowledges.length} knowledge items, distill them into 5-10 concise permanent facts. Return ONLY a markdown bulleted list, no preamble.

KNOWLEDGE ITEMS:
${knowledgeList}

Output format:
- fact one
- fact two
...`;

    let summary;
    try {
      summary = execSync(`echo ${shellEscape(prompt)} | claude --print --permission-mode bypassPermissions`, {
        encoding: "utf-8",
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      }).trim();
    } catch (e) {
      log(`Permanent LLM error: ${e.message}`);
      // Fallback: just list top 10 knowledges
      summary = knowledges.slice(0, 10).map(k =>
        `- (${k.kind || "fact"}) ${(k.content || "").slice(0, 120)}`
      ).join("\n");
    }

    updateMemorySection("PERMANENT", `# Permanent\n${summary}\n`);
    log(`Permanent: summarized ${knowledges.length} knowledges`);
  } catch (e) {
    log(`Permanent error: ${e.message}`);
  }
}

// --- Daily: write today's log ---
async function runDaily() {
  try {
    await initSchema();
    const conn = await getDb(true);

    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const dayStart = new Date(today);
    dayStart.setHours(0, 0, 0, 0);
    const cutoff = dayStart.toISOString();

    let experiences = [];
    try {
      const r = await conn.query(
        `MATCH (e:Experience) WHERE e.timestamp > '${escape(cutoff)}'
         RETURN e.summary AS summary, e.type AS type, e.outcome AS outcome, e.timestamp AS ts, e.agent AS agent
         ORDER BY e.timestamp ASC`
      );
      experiences = await r.getAll();
    } catch { /* empty */ }

    let knowledges = [];
    try {
      const r = await conn.query(
        `MATCH (k:Knowledge) WHERE k.timestamp > '${escape(cutoff)}'
         RETURN k.content AS content, k.kind AS kind, k.timestamp AS ts
         ORDER BY k.timestamp ASC`
      );
      knowledges = await r.getAll();
    } catch { /* empty */ }

    await closeDb();

    let md = `# ${dateStr}\n\n`;

    if (experiences.length > 0) {
      md += "## Experiences\n";
      for (const e of experiences) {
        const time = (e.ts || "").slice(11, 16);
        const outcome = e.outcome ? ` [${e.outcome}]` : "";
        md += `- ${time} ${(e.summary || e.type || "experience").slice(0, 150)}${outcome}\n`;
      }
      md += "\n";
    }

    if (knowledges.length > 0) {
      md += "## Knowledges\n";
      for (const k of knowledges) {
        const kind = k.kind ? `(${k.kind}) ` : "";
        md += `- ${kind}${(k.content || "").slice(0, 150)}\n`;
      }
      md += "\n";
    }

    if (experiences.length === 0 && knowledges.length === 0) {
      md += "_No activity today_\n";
    }

    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const dailyPath = path.join(DAILY_DIR, `${dateStr}.md`);
    fs.writeFileSync(dailyPath, md);
    log(`Daily: wrote ${dailyPath} (${experiences.length} exp, ${knowledges.length} know)`);
  } catch (e) {
    log(`Daily error: ${e.message}`);
  }
}

// --- Drain: process queue.jsonl (existing memify logic) ---
async function runDrain() {
  const filePath = flags.input || QUEUE_PATH;
  if (!fs.existsSync(filePath)) {
    log(`No input file: ${filePath}`);
    return;
  }

  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) {
    log("Empty input file.");
    return;
  }

  const items = raw.split("\n").map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  if (items.length === 0) {
    log("No valid items.");
    return;
  }

  log(`Processing ${items.length} items (${flags.input ? "input" : "drain"})`);

  // Build LLM prompt
  const prompt = buildPrompt(items);

  // Run LLM
  let llmResponse;
  try {
    llmResponse = execSync(`echo ${shellEscape(prompt)} | claude --print --permission-mode bypassPermissions`, {
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (e) {
    log(`LLM call failed: ${e.message}`);
    llmResponse = null;
  }

  // Parse LLM response or build fallback
  let extracted;
  if (llmResponse) {
    extracted = parseLLMResponse(llmResponse);
  }
  if (!extracted) {
    extracted = fallbackExtract(items);
  }

  // Write to DB
  await initSchema();
  const conn = await getDb();

  // Upsert entities
  for (const entity of extracted.entities || []) {
    const id = `entity:${entity.name.toLowerCase().replace(/\s+/g, "-")}`;
    try {
      const stmt = await conn.prepare(
        `MERGE (e:Entity {id: $id}) SET e.name = $name, e.type = $type, e.metadata = $metadata`
      );
      await conn.execute(stmt, {
        id,
        name: entity.name,
        type: entity.type || "concept",
        metadata: JSON.stringify(entity.metadata || {}),
      });
    } catch (e) {
      log(`Entity upsert error: ${e.message}`);
    }
  }

  // Create nodes
  for (const node of extracted.nodes || []) {
    const id = node.id || `${node.nodeType || "exp"}:${uid()}`;
    const ts = node.timestamp || new Date().toISOString();
    try {
      if (node.nodeType === "Knowledge") {
        const emb = hashEmbedding(node.content || "");
        const embStr = `[${emb.join(",")}]`;
        await conn.query(
          `MERGE (k:Knowledge {id: '${escape(id)}'})
           SET k.kind = '${escape(node.kind || "fact")}',
               k.content = '${escape(node.content || "")}',
               k.agent = '${escape(node.agent || "")}',
               k.timestamp = '${escape(ts)}',
               k.embedding = ${embStr}`
        );
      } else {
        await conn.query(
          `MERGE (x:Experience {id: '${escape(id)}'})
           SET x.type = '${escape(node.type || "task_run")}',
               x.agent = '${escape(node.agent || "")}',
               x.timestamp = '${escape(ts)}',
               x.outcome = '${escape(node.outcome || "")}',
               x.summary = '${escape(node.summary || "")}',
               x.metadata = '${escape(JSON.stringify(node.metadata || {}))}'`
        );
      }
    } catch (e) {
      log(`Node create error: ${e.message}`);
    }
  }

  // Create edges
  for (const edge of extracted.edges || []) {
    try {
      const { from, to, type } = edge;
      const fromTable = inferTable(from);
      const toTable = inferTable(to);
      if (fromTable && toTable) {
        await conn.query(
          `MATCH (a:${fromTable} {id: '${escape(from)}'}), (b:${toTable} {id: '${escape(to)}'})
           CREATE (a)-[:${type}]->(b)`
        );
      }
    } catch (e) {
      // Edge may already exist or nodes missing — skip
    }
  }

  // Clear input
  if (!flags.input) {
    fs.writeFileSync(QUEUE_PATH, "");
  } else {
    fs.unlinkSync(flags.input);
  }

  await closeDb();
  log(`Drain done. ${(extracted.nodes || []).length} nodes, ${(extracted.edges || []).length} edges, ${(extracted.entities || []).length} entities.`);
}

// --- Maintain (existing nightly logic) ---
async function runMaintain() {
  await initSchema();
  const conn = await getDb();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  let pruned = 0;
  let strengthened = 0;

  try {
    const result = await conn.query(
      `MATCH (e:Experience)
       WHERE e.timestamp < '${escape(cutoff)}'
       AND NOT EXISTS { MATCH (e)-[:DERIVED]->(:Knowledge) }
       RETURN e.id AS id`
    );
    const rows = await result.getAll();
    for (const row of rows) {
      try {
        await conn.query(`MATCH (e:Experience {id: '${escape(row.id)}'}) DETACH DELETE e`);
        pruned++;
      } catch { /* skip */ }
    }
  } catch (e) {
    log(`Prune error: ${e.message}`);
  }

  for (const relType of ["DERIVED", "ABOUT", "INVOLVES", "RELATES_TO", "FOLLOWS"]) {
    try {
      await conn.query(`MATCH ()-[r:${relType}]->() SET r.weight = r.weight + 1`);
      const countResult = await conn.query(`MATCH ()-[r:${relType}]->() RETURN count(r) AS c`);
      const countRows = await countResult.getAll();
      strengthened += countRows[0]?.c || 0;
    } catch (e) {
      log(`Strengthen ${relType} error: ${e.message}`);
    }
  }

  await closeDb();
  log(`Maintenance done. Pruned ${pruned} stale experiences, strengthened ${strengthened} edges.`);
}

// --- Helpers ---
function inferTable(id) {
  if (id.startsWith("entity:")) return "Entity";
  if (id.startsWith("know:") || id.startsWith("knowledge:")) return "Knowledge";
  if (id.startsWith("exp:") || id.startsWith("experience:")) return "Experience";
  return null;
}

// Escape single quotes for Cypher string literals
function escape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Escape for safe shell argument passing (wraps in single quotes)
function shellEscape(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function buildPrompt(items) {
  return `You are a knowledge extraction engine. Given raw experience/knowledge items from an agent's session, extract structured data for a knowledge graph.

INPUT ITEMS:
${JSON.stringify(items, null, 2)}

Extract and return ONLY valid JSON (no markdown, no explanation) with this structure:
{
  "entities": [{"name": "string", "type": "agent|project|person|concept|tool"}],
  "nodes": [
    {
      "nodeType": "Experience|Knowledge",
      "id": "exp:<short-id> or know:<short-id>",
      "type": "conversation|task_run|dag_step|heartbeat",
      "kind": "fact|decision|thread",
      "content": "string (for Knowledge)",
      "summary": "string (for Experience)",
      "agent": "string",
      "outcome": "success|fail|partial",
      "timestamp": "ISO string"
    }
  ],
  "edges": [
    {"from": "<node-id>", "to": "<node-id>", "type": "DERIVED|ABOUT|INVOLVES|RELATES_TO|FOLLOWS"}
  ]
}

Rules:
- Every item should produce at least one node
- Extract entities mentioned (agents, projects, tools, concepts)
- Create INVOLVES edges from Experience nodes to relevant Entity nodes
- Create ABOUT edges from Knowledge nodes to relevant Entity nodes
- Create DERIVED edges from Experience to any Knowledge extracted from it
- Use the agent field from the input items
- Generate short unique IDs with prefix (exp: or know: or entity:)`;
}

function parseLLMResponse(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.entities || parsed.nodes || parsed.edges) return parsed;
    return null;
  } catch {
    return null;
  }
}

function fallbackExtract(items) {
  const entities = [];
  const nodes = [];
  const edges = [];
  const seenEntities = new Set();

  for (const item of items) {
    const id = `${item.type === "knowledge" ? "know" : "exp"}:${uid()}`;
    const ts = item.timestamp || new Date().toISOString();

    if (item.type === "knowledge") {
      nodes.push({
        nodeType: "Knowledge",
        id,
        kind: item.kind || "fact",
        content: item.content || item.summary || "",
        agent: item.agent || "",
        timestamp: ts,
      });
    } else {
      nodes.push({
        nodeType: "Experience",
        id,
        type: item.type || "task_run",
        agent: item.agent || "",
        outcome: item.outcome || "",
        summary: item.summary || "",
        timestamp: ts,
        metadata: item.metadata || {},
      });
    }

    if (item.agent && !seenEntities.has(item.agent)) {
      seenEntities.add(item.agent);
      const entityId = `entity:${item.agent.toLowerCase()}`;
      entities.push({ name: item.agent, type: "agent" });
      edges.push({ from: id, to: entityId, type: "INVOLVES" });
    }
  }

  return { entities, nodes, edges };
}

// --- Main ---
async function run() {
  acquireLock();

  try {
    if (flags.maintain) {
      await runMaintain();
    }

    if (flags.drain || flags.input) {
      await runDrain();
    }

    if (flags.focus) {
      await runFocus();
    }

    if (flags.recent) {
      await runRecent();
    }

    if (flags.permanent) {
      await runPermanent();
    }

    if (flags.daily) {
      await runDaily();
    }

    log("consolidate complete.");
  } finally {
    releaseLock();
  }
}

run().catch(e => {
  log(`Fatal: ${e.message}`);
  releaseLock();
  process.exit(1);
});
