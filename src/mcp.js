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

const shellEscape = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

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
      description: "Push a knowledge or experience node into the agent's memory graph.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["knowledge", "experience"], description: "Node type" },
          text: { type: "string", description: "What happened or was learned — write clearly and specifically" },
          entities: {
            type: "array",
            items: { type: "string" },
            description: "Everything this node is about — real names AND classification words (e.g. ['postgres','migrations','decision','risk'])"
          },
          derives: {
            type: "array",
            items: { type: "string" },
            description: "For knowledge: IDs of experience nodes this was derived from"
          },
        },
        required: ["type", "text"],
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
          id: { type: "string", description: "Node ID from brain_recall or brain_explore" },
        },
        required: ["id"],
      },
    },
    {
      name: "brain_remove",
      description: "Delete a node by ID. Use to remove bad or stale memory. MEMORY.md self-heals on next consolidation.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Node ID to delete" },
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
        const payload = {
          type: args.type,
          text: args.text || "",
          entities: args.entities || [],
          ...(args.derives?.length ? { derives: args.derives } : {}),
          agent: AGENT_ID,
        };
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

      case "brain_remove": {
        result = runBrain(`remove ${shellEscape(args.id)}`);
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
