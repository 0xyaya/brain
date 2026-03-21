/**
 * embed.js — local text embeddings via transformers.js
 *
 * Model: Xenova/all-MiniLM-L6-v2
 *   - 25MB, downloads once to ~/.cache/huggingface/
 *   - 384 dimensions, fast on CPU
 *   - No API key, no server, no subscription
 *
 * Embeddings are stored in ~/corpus/brain/embeddings.json
 * (outside LadybugDB to avoid column type conflicts)
 */

import fs from "fs";
import path from "path";
import os from "os";

const EMBEDDINGS_PATH = path.join(
  process.env.BRAIN_DIR
    ? path.resolve(process.env.BRAIN_DIR)
    : path.join(os.homedir(), "corpus", "brain"),
  "embeddings.json"
);

let _pipeline = null;

async function getPipeline() {
  if (_pipeline) return _pipeline;
  const { pipeline, env } = await import("@xenova/transformers");
  env.allowLocalModels = true;
  env.useBrowserCache = false;

  // Check if model is already cached
  const cacheDir = path.join(os.homedir(), ".cache", "huggingface", "hub");
  const modelCached = fs.existsSync(path.join(cacheDir, "models--Xenova--all-MiniLM-L6-v2"));

  const tty = process.stderr.isTTY;
  if (!modelCached && tty) {
    process.stderr.write("brain: downloading embedding model (~25MB, one-time)...\n");
  } else if (modelCached && tty) {
    process.stderr.write("brain: loading model...\r");
  }

  _pipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    progress_callback: (p) => {
      if (tty && p.status === "downloading" && p.name && !modelCached) {
        const pct = p.progress ? `${Math.round(p.progress)}%` : "";
        process.stderr.write(`\r  ↓ ${path.basename(p.name)} ${pct}   `);
      }
    },
  });
  if (tty) process.stderr.write("\r                          \r"); // clear line
  return _pipeline;
}

/**
 * Embed a single text string → float[] of 384 dims.
 */
export async function embed(text) {
  if (!text || !text.trim()) return null;
  const extractor = await getPipeline();
  const output = await extractor(text.slice(0, 512), { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

/**
 * Cosine similarity between two vectors.
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Load all embeddings from disk → { [nodeId]: float[] }
 */
export function loadEmbeddings() {
  try {
    return JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, "utf-8"));
  } catch { return {}; }
}

/**
 * Save a single embedding to the embeddings file.
 */
export function saveEmbedding(nodeId, vec) {
  const store = loadEmbeddings();
  store[nodeId] = vec;
  fs.writeFileSync(EMBEDDINGS_PATH, JSON.stringify(store));
}

/**
 * Save multiple embeddings at once (batch).
 */
export function saveEmbeddings(entries) {
  const store = loadEmbeddings();
  for (const [nodeId, vec] of Object.entries(entries)) {
    store[nodeId] = vec;
  }
  fs.writeFileSync(EMBEDDINGS_PATH, JSON.stringify(store));
}

export { EMBEDDINGS_PATH };

