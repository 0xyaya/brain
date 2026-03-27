#!/usr/bin/env node
import os from "os";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { initSchema, getDb, closeDb } from "../src/db.js";
import { embed, saveEmbedding } from "../src/embed.js";
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
const flags = { drain: false, focus: false, recent: false, permanent: false, daily: false, maintain: false, embed: false, input: null };
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

// --- Item validation ---
// Rejects malformed or binary-corrupted items before they reach the DB.
function validateItem(item) {
  if (!item || typeof item !== "object") return false;
  if (!item.type) return false;
  if (item.type === "graph_import") return true; // handled separately

  // Validate text fields are readable strings (not binary garbage)
  const textField = item.type === "knowledge" ? item.content : item.summary;
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
async function runFocus() {
  try {
    const threads = await withDb(true, (conn) =>
      safeQuery(conn, `MATCH (k:Knowledge {kind: 'thread', agent: '${esc(AGENT_ID)}'}) RETURN k.content AS content, k.timestamp AS ts ORDER BY k.timestamp DESC LIMIT 5`)
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
      await safeQuery(conn, `MATCH (e:Experience) WHERE e.agent = '${esc(AGENT_ID)}' AND e.timestamp > '${esc(cutoff)}' RETURN e.summary AS summary, e.type AS type, e.outcome AS outcome ORDER BY e.timestamp DESC LIMIT 5`),
      await safeQuery(conn, `MATCH (k:Knowledge) WHERE k.agent = '${esc(AGENT_ID)}' AND k.timestamp > '${esc(cutoff)}' AND k.kind IN ['fact','decision'] RETURN k.content AS content, k.kind AS kind ORDER BY k.timestamp DESC LIMIT 8`),
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
      safeQuery(conn, `MATCH (k:Knowledge) WHERE k.agent = '${esc(AGENT_ID)}' RETURN k.content AS content, k.kind AS kind ORDER BY k.timestamp DESC LIMIT 20`)
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
      await safeQuery(conn, `MATCH (e:Experience) WHERE e.agent = '${esc(AGENT_ID)}' AND e.timestamp > '${esc(cutoff)}' RETURN e.summary AS summary, e.type AS type, e.outcome AS outcome, e.timestamp AS ts ORDER BY e.timestamp ASC`),
      await safeQuery(conn, `MATCH (k:Knowledge) WHERE k.agent = '${esc(AGENT_ID)}' AND k.timestamp > '${esc(cutoff)}' RETURN k.content AS content, k.kind AS kind ORDER BY k.timestamp ASC`),
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
          const stmt = await conn.prepare("MERGE (e:Entity {id: $id}) SET e.name = $name, e.type = $type, e.metadata = $metadata, e.source = $source");
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

    // --- knowledge / experience: direct write ---
    const id = item.id || `${item.type === "knowledge" ? "know" : "exp"}:${uid()}`;
    const ts = item.timestamp || new Date().toISOString();
    const agent = item.agent || AGENT_ID;
    const source = item.source || `local:${agent}`;

    try {
      if (item.type === "knowledge") {
        await conn.query(
          `MERGE (k:Knowledge {id: '${esc(id)}'})
           SET k.kind = '${esc(item.kind || "fact")}', k.content = '${esc(item.content || "")}',
               k.agent = '${esc(agent)}', k.timestamp = '${esc(ts)}', k.source = '${esc(source)}'`
        );
        const embVec = await embed(item.content || "");
        if (embVec) saveEmbedding(id, embVec);
      } else {
        await conn.query(
          `MERGE (x:Experience {id: '${esc(id)}'})
           SET x.type = '${esc(item.type || "task_run")}', x.agent = '${esc(agent)}',
               x.timestamp = '${esc(ts)}', x.outcome = '${esc(item.outcome || "")}',
               x.summary = '${esc(item.summary || "")}', x.metadata = '${esc(JSON.stringify(item.metadata || {}))}',
               x.source = '${esc(source)}'`
        );
        const embVec = await embed(item.summary || "");
        if (embVec) saveEmbedding(id, embVec);
      }
      nodes++;
    } catch (e) { log(`Node write error (${id}): ${e.message}`); }
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
      await safeQuery(conn, `MATCH (k:Knowledge) RETURN k.id AS id, k.kind AS kind, k.content AS content, k.agent AS agent, k.timestamp AS timestamp ORDER BY k.timestamp DESC`),
      await safeQuery(conn, `MATCH (e:Experience) RETURN e.id AS id, e.type AS type, e.summary AS summary, e.outcome AS outcome, e.agent AS agent, e.timestamp AS timestamp ORDER BY e.timestamp DESC`),
      await safeQuery(conn, `MATCH (e:Entity) RETURN e.id AS id, e.name AS name, e.kind AS kind, e.description AS description, e.source AS source ORDER BY e.id ASC`),
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
    for (const e of entities) {
      md += `## ${e.id}\ntype: entity\nname: ${e.name || ""}\nkind: ${e.kind || ""}`;
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
    { table: "Knowledge", textField: "content" },
    { table: "Experience", textField: "summary" },
    { table: "Entity",     textField: "name" },
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

// --- Main ---
async function run() {
  acquireLock();
  try {
    if (flags.maintain) await runMaintain();
    if (flags.drain || flags.input) {
      await runFlush(flags.input || QUEUE_PATH);
    } else if (flags.focus || flags.recent || flags.permanent || flags.daily || flags.embed) {
      // exportIndex is called inside runFlush; call explicitly when flush didn't run
      await exportIndex();
    }
    if (flags.embed) await runEmbed();
    if (flags.focus) await runFocus();
    if (flags.recent) await runRecent();
    if (flags.permanent) await runPermanent();
    if (flags.daily) await runDaily();
    log("consolidate complete.");
  } finally { releaseLock(); }
}

run().catch(e => { log(`Fatal: ${e.message}`); releaseLock(); process.exit(1); });
