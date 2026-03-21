#!/usr/bin/env node
import os from "os";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { initSchema, getDb, closeDb } from "../src/db.js";
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
    if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs < 5 * 60 * 1000) {
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

const uid = () => crypto.randomUUID().slice(0, 12);
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const shellEscape = (s) => "'" + s.replace(/'/g, "'\\''") + "'";

// --- Parse CLI flags ---
const flags = { drain: false, focus: false, recent: false, permanent: false, daily: false, maintain: false, input: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--input" && process.argv[i + 1]) flags.input = process.argv[++i];
  else if (a.startsWith("--") && a.slice(2) in flags) flags[a.slice(2)] = true;
}
if (!Object.values(flags).some(Boolean)) {
  flags.drain = flags.focus = flags.recent = true;
}

// --- MEMORY.md section management ---
function updateMemorySection(section, content) {
  fs.mkdirSync(path.dirname(MEMORY_MD_PATH), { recursive: true });
  let md = fs.existsSync(MEMORY_MD_PATH) ? fs.readFileSync(MEMORY_MD_PATH, "utf-8") : "";
  const start = `<!-- BRAIN:${section}:START -->`, end = `<!-- BRAIN:${section}:END -->`;
  const block = `${start}\n${content}\n${end}`;
  const si = md.indexOf(start), ei = md.indexOf(end);
  md = (si !== -1 && ei !== -1) ? md.slice(0, si) + block + md.slice(ei + end.length) : md.trimEnd() + "\n\n" + block + "\n";
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

// --- Focus ---
async function runFocus() {
  try {
    const threads = await withDb(true, (conn) =>
      safeQuery(conn, `MATCH (k:Knowledge {kind: 'thread'}) RETURN k.content AS content, k.timestamp AS ts ORDER BY k.timestamp DESC LIMIT 5`)
    );
    let content = "# Focus\n";
    content += threads.length > 0
      ? threads.map(t => `- ${(t.content || "").slice(0, 120)}`).join("\n") + "\n"
      : "_No open threads_\n";
    updateMemorySection("FOCUS", content);
    log(`Focus: ${threads.length} threads`);
  } catch (e) { log(`Focus error: ${e.message}`); }
}

// --- Recent ---
async function runRecent() {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const [experiences, knowledges] = await withDb(true, async (conn) => [
      await safeQuery(conn, `MATCH (e:Experience) WHERE e.timestamp > '${esc(cutoff)}' RETURN e.summary AS summary, e.type AS type, e.outcome AS outcome ORDER BY e.timestamp DESC LIMIT 5`),
      await safeQuery(conn, `MATCH (k:Knowledge) WHERE k.timestamp > '${esc(cutoff)}' AND k.kind IN ['fact','decision'] RETURN k.content AS content, k.kind AS kind ORDER BY k.timestamp DESC LIMIT 8`),
    ]);
    let content = "# Recent\n";
    for (const e of experiences) {
      content += `- ${(e.summary || e.type || "experience").slice(0, 100)}${e.outcome ? ` [${e.outcome}]` : ""}\n`;
    }
    for (const k of knowledges) {
      content += `- ${k.kind ? `(${k.kind}) ` : ""}${(k.content || "").slice(0, 100)}\n`;
    }
    if (!experiences.length && !knowledges.length) content += "_No recent activity_\n";
    updateMemorySection("RECENT", content);
    log(`Recent: ${experiences.length} experiences, ${knowledges.length} knowledges`);
  } catch (e) { log(`Recent error: ${e.message}`); }
}

// --- Permanent ---
async function runPermanent() {
  try {
    const knowledges = await withDb(true, (conn) =>
      safeQuery(conn, `MATCH (k:Knowledge) RETURN k.content AS content, k.kind AS kind ORDER BY k.timestamp DESC LIMIT 20`)
    );
    if (!knowledges.length) {
      updateMemorySection("PERMANENT", "# Permanent\n_No knowledge yet_\n");
      log("Permanent: no knowledges to summarize");
      return;
    }
    const knowledgeList = knowledges.map((k, i) => `${i + 1}. (${k.kind || "fact"}) ${(k.content || "").slice(0, 200)}`).join("\n");
    const prompt = `You are summarizing an agent's most important knowledge into permanent memory facts. Given these ${knowledges.length} knowledge items, distill them into 5-10 concise permanent facts. Return ONLY a markdown bulleted list, no preamble.\n\nKNOWLEDGE ITEMS:\n${knowledgeList}\n\nOutput format:\n- fact one\n- fact two\n...`;
    let summary;
    try {
      summary = execSync(`echo ${shellEscape(prompt)} | claude --print --permission-mode bypassPermissions`, {
        encoding: "utf-8", timeout: 120_000, maxBuffer: 1024 * 1024,
      }).trim();
    } catch {
      summary = knowledges.slice(0, 10).map(k => `- (${k.kind || "fact"}) ${(k.content || "").slice(0, 120)}`).join("\n");
    }
    updateMemorySection("PERMANENT", `# Permanent\n${summary}\n`);
    log(`Permanent: summarized ${knowledges.length} knowledges`);
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
      await safeQuery(conn, `MATCH (e:Experience) WHERE e.timestamp > '${esc(cutoff)}' RETURN e.summary AS summary, e.type AS type, e.outcome AS outcome, e.timestamp AS ts ORDER BY e.timestamp ASC`),
      await safeQuery(conn, `MATCH (k:Knowledge) WHERE k.timestamp > '${esc(cutoff)}' RETURN k.content AS content, k.kind AS kind ORDER BY k.timestamp ASC`),
    ]);
    let md = `# ${dateStr}\n\n`;
    if (experiences.length) {
      md += "## Experiences\n";
      for (const e of experiences) md += `- ${(e.ts || "").slice(11, 16)} ${(e.summary || e.type || "experience").slice(0, 150)}${e.outcome ? ` [${e.outcome}]` : ""}\n`;
      md += "\n";
    }
    if (knowledges.length) {
      md += "## Knowledges\n";
      for (const k of knowledges) md += `- ${k.kind ? `(${k.kind}) ` : ""}${(k.content || "").slice(0, 150)}\n`;
      md += "\n";
    }
    if (!experiences.length && !knowledges.length) md += "_No activity today_\n";
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const dailyPath = path.join(DAILY_DIR, `${dateStr}.md`);
    fs.writeFileSync(dailyPath, md);
    log(`Daily: wrote ${dailyPath} (${experiences.length} exp, ${knowledges.length} know)`);
  } catch (e) { log(`Daily error: ${e.message}`); }
}

// --- Drain ---
async function runDrain() {
  const filePath = flags.input || QUEUE_PATH;
  if (!fs.existsSync(filePath)) { log(`No input file: ${filePath}`); return; }
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) { log("Empty input file."); return; }
  const items = raw.split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!items.length) { log("No valid items."); return; }
  log(`Processing ${items.length} items (${flags.input ? "input" : "drain"})`);

  await initSchema();
  const conn = await getDb();

  // Handle graph_import items before LLM extraction
  const regularItems = [];
  for (const item of items) {
    if (item.type === 'graph_import') {
      const { entities = [], relationships = [] } = item.data || {};

      // Insert Entity nodes
      for (const entity of entities) {
        const id = 'entity:' + entity.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const name = entity.name;
        const type = entity.label || 'Concept';
        const metadata = JSON.stringify({ description: entity.description || '', source: item.source || 'brain-provider' });
        try {
          const stmt = await conn.prepare('MERGE (e:Entity {id: $id}) SET e.name = $name, e.type = $type, e.metadata = $metadata');
          await conn.execute(stmt, { id, name, type, metadata });
        } catch (e) { /* skip */ }
      }

      // Build entity id map for relationship creation
      const entityIdMap = {};
      for (const entity of entities) {
        entityIdMap[entity.name] = 'entity:' + entity.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
      }

      // Insert CONNECTS edges
      for (const rel of relationships) {
        const fromId = entityIdMap[rel.from];
        const toId = entityIdMap[rel.to];
        if (!fromId || !toId) continue;
        try {
          await conn.query(
            `MATCH (a:Entity {id: '${esc(fromId)}'}), (b:Entity {id: '${esc(toId)}'})` +
            ` CREATE (a)-[:CONNECTS {type: '${esc(rel.type || 'RELATES_TO')}', weight: 1.0}]->(b)`
          );
        } catch (e) { /* skip duplicate */ }
      }

      log(`Graph import: ${entities.length} entities, ${relationships.length} relationships`);
      continue;
    }
    regularItems.push(item);
  }

  // If only graph imports, skip LLM extraction
  if (!regularItems.length) {
    if (!flags.input) fs.writeFileSync(QUEUE_PATH, "");
    else fs.unlinkSync(flags.input);
    await closeDb();
    log("Drain done (graph imports only).");
    await exportIndex();
    return;
  }

  const prompt = `You are a knowledge extraction engine. Given raw experience/knowledge items from an agent's session, extract structured data for a knowledge graph.

INPUT ITEMS:
${JSON.stringify(regularItems, null, 2)}

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

  let llmResponse;
  try {
    llmResponse = execSync(`echo ${shellEscape(prompt)} | claude --print --permission-mode bypassPermissions`, {
      encoding: "utf-8", timeout: 120_000, maxBuffer: 1024 * 1024,
    });
  } catch (e) {
    log(`LLM call failed: ${e.message}`);
  }

  let extracted = llmResponse ? parseLLMResponse(llmResponse) : null;
  if (!extracted) extracted = fallbackExtract(regularItems);

  for (const entity of extracted.entities || []) {
    const id = `entity:${entity.name.toLowerCase().replace(/\s+/g, "-")}`;
    try {
      const stmt = await conn.prepare(`MERGE (e:Entity {id: $id}) SET e.name = $name, e.type = $type, e.metadata = $metadata`);
      await conn.execute(stmt, { id, name: entity.name, type: entity.type || "concept", metadata: JSON.stringify(entity.metadata || {}) });
    } catch (e) { log(`Entity upsert error: ${e.message}`); }
  }

  for (const node of extracted.nodes || []) {
    const id = node.id || `${node.nodeType || "exp"}:${uid()}`;
    const ts = node.timestamp || new Date().toISOString();
    try {
      if (node.nodeType === "Knowledge") {
        await conn.query(
          `MERGE (k:Knowledge {id: '${esc(id)}'})
           SET k.kind = '${esc(node.kind || "fact")}', k.content = '${esc(node.content || "")}',
               k.agent = '${esc(node.agent || "")}', k.timestamp = '${esc(ts)}'`
        );
      } else {
        await conn.query(
          `MERGE (x:Experience {id: '${esc(id)}'})
           SET x.type = '${esc(node.type || "task_run")}', x.agent = '${esc(node.agent || "")}',
               x.timestamp = '${esc(ts)}', x.outcome = '${esc(node.outcome || "")}',
               x.summary = '${esc(node.summary || "")}', x.metadata = '${esc(JSON.stringify(node.metadata || {}))}'`
        );
      }
    } catch (e) { log(`Node create error: ${e.message}`); }
  }

  for (const edge of extracted.edges || []) {
    try {
      const fromT = inferTable(edge.from), toT = inferTable(edge.to);
      if (fromT && toT) {
        await conn.query(`MATCH (a:${fromT} {id: '${esc(edge.from)}'}), (b:${toT} {id: '${esc(edge.to)}'}) CREATE (a)-[:${edge.type}]->(b)`);
      }
    } catch { /* edge may exist or nodes missing */ }
  }

  if (!flags.input) fs.writeFileSync(QUEUE_PATH, "");
  else fs.unlinkSync(flags.input);

  await closeDb();
  log(`Drain done. ${(extracted.nodes || []).length} nodes, ${(extracted.edges || []).length} edges, ${(extracted.entities || []).length} entities.`);

  await exportIndex();
}

// --- Maintain ---
async function runMaintain() {
  await initSchema();
  const conn = await getDb();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  let pruned = 0, strengthened = 0;
  try {
    const rows = await (await conn.query(
      `MATCH (e:Experience) WHERE e.timestamp < '${esc(cutoff)}' AND NOT EXISTS { MATCH (e)-[:DERIVED]->(:Knowledge) } RETURN e.id AS id`
    )).getAll();
    for (const row of rows) {
      try { await conn.query(`MATCH (e:Experience {id: '${esc(row.id)}'}) DETACH DELETE e`); pruned++; } catch { /* skip */ }
    }
  } catch (e) { log(`Prune error: ${e.message}`); }
  for (const rel of ["DERIVED", "ABOUT", "INVOLVES", "RELATES_TO", "FOLLOWS"]) {
    try {
      await conn.query(`MATCH ()-[r:${rel}]->() SET r.weight = r.weight + 1`);
      const rows = await (await conn.query(`MATCH ()-[r:${rel}]->() RETURN count(r) AS c`)).getAll();
      strengthened += rows[0]?.c || 0;
    } catch (e) { log(`Strengthen ${rel} error: ${e.message}`); }
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

function parseLLMResponse(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const p = JSON.parse(m[0]); return (p.entities || p.nodes || p.edges) ? p : null; }
  catch { return null; }
}

function fallbackExtract(items) {
  const entities = [], nodes = [], edges = [], seen = new Set();
  for (const item of items) {
    const id = `${item.type === "knowledge" ? "know" : "exp"}:${uid()}`;
    const ts = item.timestamp || new Date().toISOString();
    if (item.type === "knowledge") {
      nodes.push({ nodeType: "Knowledge", id, kind: item.kind || "fact", content: item.content || item.summary || "", agent: item.agent || "", timestamp: ts });
    } else {
      nodes.push({ nodeType: "Experience", id, type: item.type || "task_run", agent: item.agent || "", outcome: item.outcome || "", summary: item.summary || "", timestamp: ts, metadata: item.metadata || {} });
    }
    if (item.agent && !seen.has(item.agent)) {
      seen.add(item.agent);
      entities.push({ name: item.agent, type: "agent" });
      edges.push({ from: id, to: `entity:${item.agent.toLowerCase()}`, type: "INVOLVES" });
    }
  }
  return { entities, nodes, edges };
}

// --- Export index.md ---
async function exportIndex() {
  try {
    const [knowledges, experiences] = await withDb(true, async (conn) => [
      await safeQuery(conn, `MATCH (k:Knowledge) RETURN k.id AS id, k.kind AS kind, k.content AS content, k.agent AS agent, k.timestamp AS timestamp ORDER BY k.timestamp DESC`),
      await safeQuery(conn, `MATCH (e:Experience) RETURN e.id AS id, e.type AS type, e.summary AS summary, e.outcome AS outcome, e.agent AS agent, e.timestamp AS timestamp ORDER BY e.timestamp DESC`),
    ]);
    let md = "";
    for (const k of knowledges) {
      md += `## ${k.id}\nkind: ${k.kind || "fact"}\nagent: ${k.agent || ""}\ncontent: ${k.content || ""}\ntimestamp: ${k.timestamp || ""}\n\n`;
    }
    for (const e of experiences) {
      md += `## ${e.id}\ntype: experience\nagent: ${e.agent || ""}\nsummary: ${e.summary || ""}`;
      if (e.outcome) md += `\noutcome: ${e.outcome}`;
      md += `\ntimestamp: ${e.timestamp || ""}\n\n`;
    }
    const indexPath = path.join(BRAIN_DIR, "index.md");
    fs.writeFileSync(indexPath, md);
    log(`exportIndex: wrote ${indexPath} (${knowledges.length} knowledge, ${experiences.length} experience)`);
  } catch (e) { log(`exportIndex error: ${e.message}`); }
}

// --- Main ---
async function run() {
  acquireLock();
  try {
    if (flags.maintain) await runMaintain();
    if (flags.drain || flags.input) await runDrain();
    if (flags.focus) await runFocus();
    if (flags.recent) await runRecent();
    if (flags.permanent) await runPermanent();
    if (flags.daily) await runDaily();
    log("consolidate complete.");
  } finally { releaseLock(); }
}

run().catch(e => { log(`Fatal: ${e.message}`); releaseLock(); process.exit(1); });
