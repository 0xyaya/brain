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
          { encoding: "utf-8", timeout: 45_000, env: { ...process.env, BRAIN_AGENT_ID: agentId } }
        );
        return { content: [{ type: "text", text: out.trim() || "[]" }] };
      } catch (e) {
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
        type: { type: "string", enum: ["knowledge", "experience"], description: "Node type" },
        kind: { type: "string", description: "knowledge: fact|decision|thread|topic  |  experience: task_run|conversation|research" },
        content: { type: "string", description: "For knowledge nodes: the fact, decision, or thread text" },
        summary: { type: "string", description: "For experience nodes: summary of what happened" },
        outcome: { type: "string", enum: ["success", "fail", "partial"], description: "For experience nodes" },
        entities: { type: "array", items: { type: "string" }, description: "Entity names this node concerns (e.g. ['brain','kuzu']). Required for graph edge wiring." },
        derives: { type: "array", items: { type: "string" }, description: "IDs of experience nodes this knowledge was derived from (creates DERIVED edges)." },
      },
      required: ["type"],
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
      // brain-drain service is the single flush authority — just write to queue
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

  // ─── after_compaction hook ──────────────────────────────────────────────────
  // memoryFlush prompt (pre-compaction) handles structured brain_push calls.
  // This hook just records that a compaction occurred as a lightweight experience node.
  api.on("after_compaction", (ctx) => {
    try {
      const agentId = ctx?.agentId || config.agentId;
      const ts = new Date().toISOString();
      fs.mkdirSync(BRAIN_DIR, { recursive: true });
      fs.appendFileSync(QUEUE_PATH, JSON.stringify({
        type: "experience", kind: "conversation",
        agent: agentId,
        summary: "Session compaction — context trimmed",
        outcome: "success", timestamp: ts,
        entities: [agentId],
      }) + "\n");
    } catch { /* silent — hook must never crash the host */ }
  });

  // ─── Periodic: 5min drain ──────────────────────────────────────────────────
  // Single drain authority — one consolidate process at a time, never parallel.
  // Reads queue, picks the first agent with items, runs drain+focus+recent+embed.
  // Next tick handles remaining agents (lock ensures serialization).
  api.registerService({
    id: "brain-drain",
    start: () => {
      setTimeout(() => {
        const drain = () => {
          try {
            if (!fs.existsSync(QUEUE_PATH)) return;
            const raw = fs.readFileSync(QUEUE_PATH, "utf-8").trim();
            if (!raw) return;

            // Collect unique agent IDs from queued items (preserve order)
            const agentIds = [];
            for (const line of raw.split("\n")) {
              try {
                const item = JSON.parse(line);
                if (item.agent && !agentIds.includes(item.agent)) agentIds.push(item.agent);
              } catch { /* skip bad lines */ }
            }
            if (agentIds.length === 0) return;

            // Spawn ONE consolidate for the first agent — lock prevents concurrent runs.
            // Remaining agents will be picked up on next drain tick (5min).
            spawnConsolidate(agentIds[0], "--drain", "--focus", "--recent", "--embed");
          } catch { /* silent */ }
        };
        drain();
        setInterval(drain, 5 * 60 * 1000);
      }, 5 * 60 * 1000);
    },
  });

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
