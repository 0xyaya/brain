import path from "path";
import os from "os";
import fs from "fs";
import { spawn, execSync } from "child_process";

const BRAIN_DIR = path.join(os.homedir(), "corpus", "brain");
const QUEUE_PATH = path.join(BRAIN_DIR, "queue.jsonl");
const LOCK_PATH = path.join(BRAIN_DIR, "consolidate.lock");
const BIN_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "bin");

function resolveConfig(api) {
  const pluginConfig = api.config?.plugins?.entries?.["brain"]?.config || {};
  const corpusRoot = (pluginConfig.corpusRoot || "~/corpus").replace(/^~/, os.homedir());
  const agentId = pluginConfig.agentId || "neo";
  return { corpusRoot, agentId };
}

export default function register(api) {
  const config = resolveConfig(api);

  // Slash command: /brain <subcommand>
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

  // after_compaction: push richer experience from compaction summary
  api.on("after_compaction", (ctx) => {
    (async () => {
      try {
        // Extract active topics from compaction context if available
        const context = ctx?.summary || ctx?.context || "";
        let topicHint = "";
        if (context) {
          // Take first 200 chars as topic hint
          topicHint = ` — active topics: ${context.slice(0, 200)}`;
        }
        const item = {
          type: "experience",
          subtype: "conversation",
          agent: config.agentId,
          summary: `Session compaction${topicHint}`,
          outcome: "success",
          timestamp: new Date().toISOString(),
        };
        fs.mkdirSync(BRAIN_DIR, { recursive: true });
        fs.appendFileSync(QUEUE_PATH, JSON.stringify(item) + "\n");
        spawnConsolidate("--drain", "--focus", "--recent");
      } catch { /* silent */ }
    })();
  });

  // Periodic: 5min cron — drain + focus + recent
  api.registerService({
    id: "brain-drain",
    start: () => {
      setTimeout(() => {
        const drain = () => {
          try {
            if (fs.existsSync(QUEUE_PATH)) {
              const content = fs.readFileSync(QUEUE_PATH, "utf-8").trim();
              if (content) spawnConsolidate("--drain", "--focus", "--recent");
            }
          } catch { /* silent */ }
        };
        drain();
        setInterval(drain, 5 * 60 * 1000);
      }, 5 * 60 * 1000);
    },
  });

  // Every 6h: permanent + daily + maintain
  api.registerService({
    id: "brain-nightly",
    start: () => {
      const scheduleNext = () => {
        setTimeout(() => {
          spawnConsolidate("--permanent", "--daily", "--maintain");
          setInterval(() => spawnConsolidate("--permanent", "--daily", "--maintain"), 6 * 60 * 60 * 1000);
        }, 6 * 60 * 60 * 1000);
      };
      scheduleNext();
    },
  });
}

function spawnConsolidate(...args) {
  if (fs.existsSync(LOCK_PATH)) return;
  const child = spawn("node", [path.join(BIN_DIR, "consolidate.js"), ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
