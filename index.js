import path from "path";
import os from "os";
import fs from "fs";
import { spawn, execSync } from "child_process";
import { ClaudeConsolidation } from "./src/consolidation/claude.js";

const BRAIN_DIR = path.join(os.homedir(), "corpus", "brain");
const QUEUE_PATH = path.join(BRAIN_DIR, "queue.jsonl");
const LOCK_PATH = path.join(BRAIN_DIR, "consolidate.lock");
const BIN_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "bin");

const shellEscape = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

function resolveConfig(api) {
  const pluginConfig = api.config?.plugins?.entries?.["brain"]?.config || {};
  const corpusRoot = (pluginConfig.corpusRoot || "~/corpus").replace(/^~/, os.homedir());
  const agentId = pluginConfig.agentId || "neo";
  return { corpusRoot, agentId };
}

// Discover all agent IDs from corpus/users/
function getAllAgentIds(corpusRoot) {
  try {
    const usersDir = path.join(corpusRoot, "users");
    return fs.readdirSync(usersDir).filter(d => {
      try { return fs.statSync(path.join(usersDir, d)).isDirectory(); } catch { return false; }
    });
  } catch { return []; }
}

export default function register(api) {
  const config = resolveConfig(api);

  // ─── Slash command: /brain <subcommand> ────────────────────────────────────
  api.registerCommand({
    name: "brain",
    description: "Brain memory (push|recall|explore|get|flush)",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = (ctx.args || "").trim();
      try {
        const out = execSync(`node ${BIN_DIR}/brain.js ${args}`, {
          encoding: "utf-8",
          cwd: path.dirname(BIN_DIR),
          timeout: 30_000,
        });
        return { text: `\`\`\`\n${out.trim()}\n\`\`\`` };
      } catch (e) {
        return { text: `Error: ${e.stderr || e.message}` };
      }
    },
  });

  // ─── Native LLM tool: brain_recall ─────────────────────────────────────────
  api.registerTool({
    name: "brain_recall",
    description: "Semantic search over agent memory graph + recent daily logs. Use at session start and whenever a new topic comes up to retrieve relevant context before responding.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        days: { type: "number", description: "Days of daily logs to include (default 3)" },
      },
      required: ["query"],
    },
    async execute(callId, params, ctx) {
      const agentId = ctx?.agentId || config.agentId;
      const daysFlag = params.days ? `--days ${params.days}` : "";
      try {
        const out = execSync(
          `node ${BIN_DIR}/brain.js recall --agent ${shellEscape(agentId)} ${daysFlag} ${shellEscape(params.query)}`,
          { encoding: "utf-8", timeout: 45_000, env: { ...process.env, BRAIN_AGENT_ID: agentId }, stdio: ["pipe", "pipe", "pipe"] }
        );
        return { content: [{ type: "text", text: out.trim() || "[]" }] };
      } catch (e) {
        const err = e?.stderr?.toString?.() || e?.message || "unknown";
        console.error(`[brain_recall] error: ${err.slice(0, 300)}`);
        return { content: [{ type: "text", text: "[]" }] };
      }
    },
  });

  // ─── Native LLM tool: brain_push ───────────────────────────────────────────
  api.registerTool({
    name: "brain_push",
    description: "Push a knowledge node or experience to the memory graph. Call this after completing tasks, making key decisions, or learning durable facts. Do not wait — push immediately.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["knowledge", "experience"], description: "knowledge = fact, decision, or ongoing concern. experience = task or event that happened." },
        text: { type: "string", description: "Free-form text — what happened, was learned, or is being tracked. Write clearly and specifically." },
        entities: { type: "array", items: { type: "string" }, description: "Everything this node is about — real entities AND classification words. Mix freely: ['brain','kuzu','decision','risk'] or ['yann','autoresearch','open']. Each becomes an Entity node with a graph edge, so classification words like 'decision', 'risk', 'open', 'resolved', 'success' become traversable axes of the graph." },
        derives: { type: "array", items: { type: "string" }, description: "For knowledge: IDs of experience nodes this was derived from (creates DERIVED edges)." },
      },
      required: ["type", "text"],
    },
    async execute(callId, params, ctx) {
      const agentId = ctx?.agentId || config.agentId;
      const node = {
        ...params,
        agent: agentId,
        timestamp: new Date().toISOString(),
      };
      fs.mkdirSync(BRAIN_DIR, { recursive: true });
      fs.appendFileSync(QUEUE_PATH, JSON.stringify(node) + "\n");
      // flush cron (brain-flush-30m) drains the queue every 30min
      return { content: [{ type: "text", text: "OK" }] };
    },
  });

  // ─── Native LLM tool: brain_explore ────────────────────────────────────────
  api.registerTool({
    name: "brain_explore",
    description: "Explore the graph neighborhood of a named entity (person, project, concept). Use when you know the exact entity name and want to surface related nodes.",
    parameters: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Entity name to explore (e.g. 'Andrej', 'brainbook', 'obsidian')" },
      },
      required: ["entity"],
    },
    async execute(callId, params) {
      try {
        const out = execSync(
          `node ${BIN_DIR}/brain.js explore ${shellEscape(params.entity)}`,
          { encoding: "utf-8", timeout: 10_000 }
        );
        return { content: [{ type: "text", text: out.trim() || "[]" }] };
      } catch (e) {
        return { content: [{ type: "text", text: "[]" }] };
      }
    },
  });

  // ─── Native LLM tool: brain_get ────────────────────────────────────────────
  api.registerTool({
    name: "brain_get",
    description: "Fetch a full memory node by ID. Use after brain_recall or brain_explore returns a promising result and you need the full content.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Node ID from brain_recall or brain_explore results" },
      },
      required: ["id"],
    },
    async execute(callId, params) {
      try {
        const out = execSync(
          `node ${BIN_DIR}/brain.js get ${shellEscape(params.id)}`,
          { encoding: "utf-8", timeout: 10_000 }
        );
        return { content: [{ type: "text", text: out.trim() || "null" }] };
      } catch (e) {
        return { content: [{ type: "text", text: "null" }] };
      }
    },
  });

  // ─── Native LLM tool: brain_remove ─────────────────────────────────────────
  api.registerTool({
    name: "brain_remove",
    description: "Delete a memory node by ID. Use to remove bad, stale, or incorrect nodes. MEMORY.md self-heals on next consolidate. Get the ID from brain_recall or brain_explore first.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Node ID to delete — get it from brain_recall or brain_explore (e.g. know:abc123, exp:xyz, entity:kuzu)" },
      },
      required: ["id"],
    },
    async execute(callId, params) {
      try {
        const out = execSync(
          `node ${BIN_DIR}/brain.js remove ${shellEscape(params.id)}`,
          { encoding: "utf-8", timeout: 15_000 }
        );
        return { content: [{ type: "text", text: out.trim() }] };
      } catch (e) {
        const err = e?.stderr?.toString?.() || e?.message || "unknown";
        return { content: [{ type: "text", text: `Error: ${err.slice(0, 200)}` }] };
      }
    },
  });

  // ─── after_compaction hook ──────────────────────────────────────────────────
  // memoryFlush prompt (pre-compaction) handles structured brain_push calls.
  // This hook just records that a compaction occurred as a lightweight experience node.
  api.on("after_compaction", (ctx) => {
    try {
      const agentId = ctx?.agentId || config.agentId;
      const ts = new Date().toISOString();
      fs.mkdirSync(BRAIN_DIR, { recursive: true });
      fs.appendFileSync(QUEUE_PATH, JSON.stringify({
        type: "experience",
        text: "Session compaction — context trimmed",
        agent: agentId,
        timestamp: ts,
        entities: [agentId],
      }) + "\n");
    } catch { /* silent — hook must never crash the host */ }
  });

    // Flush handled by external 30m cron (brain-flush-30m) — no in-process drain service needed

  // ─── Every 30min: extract session logs → graph for ALL agents ─────────────
  api.registerService({
    id: "brain-sessions",
    start: () => {
      // Wait 2min after gateway start for sessions to settle
      setTimeout(() => {
        const run = () => {
          const agents = getAllAgentIds(config.corpusRoot);
          agents.forEach((agentId, i) => {
            // Stagger 90s per agent to avoid consolidate lock conflicts
            setTimeout(() => spawnExtract(agentId), i * 90_000);
          });
        };
        run();
        setInterval(run, 30 * 60 * 1000);
      }, 2 * 60 * 1000);
    },
  });

  // ─── Every 6h: permanent + daily + maintain for ALL agents ─────────────────
  api.registerService({
    id: "brain-nightly",
    start: () => {
      setTimeout(() => {
        const nightly = () => {
          const agentIds = getAllAgentIds(config.corpusRoot);
          agentIds.forEach((agentId, i) => {
            setTimeout(
              () => spawnConsolidate(agentId, "--permanent", "--daily", "--maintain"),
              i * 60_000 // 1min stagger per agent
            );
          });
        };
        nightly();
        setInterval(nightly, 6 * 60 * 60 * 1000);
      }, 6 * 60 * 60 * 1000);
    },
  });
}

function spawnExtract(agentId) {
  const child = spawn("node", [path.join(BIN_DIR, "extract-sessions.js"), "--agent", agentId], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BRAIN_AGENT_ID: agentId },
  });
  child.unref();
}

function spawnConsolidate(agentId, ...args) {
  // Auto-clear stale lock (dead PID) before checking
  if (fs.existsSync(LOCK_PATH)) {
    try {
      const pid = parseInt(fs.readFileSync(LOCK_PATH, "utf-8").trim(), 10);
      if (pid && !isNaN(pid)) {
        try { process.kill(pid, 0); return; } // still alive — bail
        catch { fs.unlinkSync(LOCK_PATH); }   // dead — remove stale lock
      } else {
        return;
      }
    } catch { return; }
  }
  const child = spawn("node", [path.join(BIN_DIR, "consolidate.js"), ...args], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BRAIN_AGENT_ID: agentId },
  });
  child.unref();
}
