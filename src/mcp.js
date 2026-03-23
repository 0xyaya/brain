#!/usr/bin/env node
/**
 * brain MCP server
 * Exposes brain_recall, brain_push, brain_explore, brain_get as MCP tools.
 *
 * Usage:
 *   node src/mcp.js
 *
 * Configure in .mcp.json or ~/.claude/settings.json:
 *   {
 *     "mcpServers": {
 *       "brain": {
 *         "command": "node",
 *         "args": ["/path/to/brain/src/mcp.js"],
 *         "env": { "BRAIN_AGENT_ID": "myagent" }
 *       }
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(__dirname, "../bin");

const AGENT_ID = process.env.BRAIN_AGENT_ID || "neo";
const CORPUS_ROOT = (process.env.BRAIN_CORPUS_ROOT || path.join(os.homedir(), "corpus")).replace("~", os.homedir());
const BRAIN_DIR = process.env.BRAIN_DIR || path.join(os.homedir(), "corpus", "brain");

function runBrain(args, input) {
  const env = {
    ...process.env,
    BRAIN_AGENT_ID: AGENT_ID,
    BRAIN_CORPUS_ROOT: CORPUS_ROOT,
    BRAIN_DIR,
  };
  const cmd = `node ${BIN_DIR}/brain.js ${args}`;
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      env,
      timeout: 30_000,
      input,
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch (e) {
    return e.stdout?.trim() || e.message;
  }
}

const server = new Server(
  { name: "brain", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "brain_recall",
      description: "Semantic search over agent memory. Returns relevant knowledge, experiences, and facts.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          days: { type: "number", description: "Limit results to last N days (optional)" },
        },
        required: ["query"],
      },
    },
    {
      name: "brain_push",
      description: "Push a new experience, knowledge fact, or decision into the agent's memory graph.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["experience", "knowledge"],
            description: "Node type",
          },
          kind: {
            type: "string",
            description: "For knowledge: fact | decision | topic | thread. For experience: task_run | conversation etc.",
          },
          content: { type: "string", description: "For knowledge nodes: the fact or decision text" },
          summary: { type: "string", description: "For experience nodes: summary of what happened" },
          outcome: { type: "string", enum: ["success", "fail", "partial"], description: "For experience nodes" },
        },
        required: ["type"],
      },
    },
    {
      name: "brain_explore",
      description: "Graph neighborhood traversal from a known entity. Returns connected nodes and relationships.",
      inputSchema: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Entity name to explore (e.g. 'karpathy', 'nanoGPT', 'brainbook')" },
        },
        required: ["entity"],
      },
    },
    {
      name: "brain_get",
      description: "Retrieve a specific node by ID from the memory graph.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Node ID (e.g. 'memory:karpathy:recent', 'know:abc123')" },
        },
        required: ["id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case "brain_recall": {
        const daysFlag = args.days ? `--days ${args.days}` : "";
        result = runBrain(`recall --agent ${AGENT_ID} ${daysFlag} "${args.query.replace(/"/g, '\\"')}"`);
        break;
      }

      case "brain_push": {
        const payload = { type: args.type, agent: AGENT_ID };
        if (args.type === "knowledge") {
          payload.kind = args.kind || "fact";
          payload.content = args.content || "";
        } else {
          payload.type = "experience";
          payload.summary = args.summary || "";
          payload.outcome = args.outcome || "success";
        }
        result = runBrain(`push --agent ${AGENT_ID} '${JSON.stringify(payload)}'`);
        break;
      }

      case "brain_explore": {
        result = runBrain(`explore "${args.entity.replace(/"/g, '\\"')}"`);
        break;
      }

      case "brain_get": {
        result = runBrain(`get "${args.id.replace(/"/g, '\\"')}"`);
        break;
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    return { content: [{ type: "text", text: result || "(no results)" }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
