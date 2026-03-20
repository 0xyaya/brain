# Brain Plugin — Architecture

## Overview
An OpenClaw plugin for individual and multi-agent memory. Persistent, evolving knowledge built automatically from agent experiences — conversations, task executions, DAG workflow runs.

## Design Principles
- **Elegant and minimalist** — three node types, four CLI commands, one background process
- **No infra** — no Redis, no Docker, no daemon. Flat files + embedded DB
- **Single writer** — memify is the sole LadybugDB writer, eliminating concurrency issues
- **Global graph** — one shared graph for all agents; agent is an Entity node, not a graph boundary
- **CLI over MCP** — token efficient, zero schema overhead, models know it natively

---

## Stack

| Component | Tech | Why |
|-----------|------|-----|
| Knowledge graph | LadybugDB | Embedded, no infra, Cypher, HNSW vectors built-in |
| Short-term memory | `memory/recent.md` | Always injected at session start, no query needed |
| Corpus search | QMD (BM25) | Lexical search over all markdown files |
| LLM worker | `claude --print` via stdin | Claude Max OAuth, no API key |
| Agent interface | CLI (`brain`) | Token efficient, works from any process/container |
| Background process | memify | Single writer, LLM extraction, graph maintenance |

---

## Graph Schema

### Node Types

**Experience** — what happened
```
id, type (conversation|task_run|dag_step|heartbeat),
agent, timestamp,
outcome (success|fail|partial),
summary, metadata (error, duration, step_name, prompt_used...)
```

**Knowledge** — what was learned
```
id, kind (fact|decision|thread|lesson),
content, agent, timestamp,
embedding (HNSW vector index)
```

**Entity** — who or what
```
id, type (agent|project|person|concept|tool),
name, metadata
```

### Edge Types
```
(Experience)-[:DERIVED]->(Knowledge)     — experience produced this knowledge
(Knowledge)-[:ABOUT]->(Entity)           — knowledge is about this entity
(Experience)-[:INVOLVES]->(Entity)       — experience involved this entity
(Knowledge)-[:RELATES_TO]->(Knowledge)  — related knowledges
(Experience)-[:FOLLOWS]->(Experience)   — sequential experiences (DAG steps)
```

---

## CLI Interface

Four commands. Agents never touch LadybugDB directly.

```bash
brain push   '{"type": "knowledge", "kind": "fact", "content": "..."}'
brain recall "how to deploy odyssey"
brain explore "project:odyssey"
brain get    "<node-id>"
```

### recall / explore / get — read path
CLI opens LadybugDB **read-only** directly. Fast, no process dependency.
- `recall` → HNSW vector search over Knowledge nodes → returns top-K summaries
- `explore` → graph traversal from an Entity → returns neighborhood (compact: node names + edge types)
- `get` → fetch full node by id (agent controls what it loads into context)

### push — write path
Two modes depending on context:

**Interactive / ad-hoc** (default):
```bash
brain push '{"type": "experience", ...}'
# → appends one line to corpus/brain/queue.jsonl
# → if memify not running: spawns `memify --drain &` (async, returns immediately)
```

**DAG workflow run** (buffered):
```bash
brain push --buffer /tmp/run-123.jsonl '{"type": "experience", ...}'
# → appends to isolated run buffer (no global queue, no memify yet)
brain recall --buffer /tmp/run-123.jsonl "deploy error"
# → text search over raw buffer (cheap, no DB, within-run context)
brain flush --buffer /tmp/run-123.jsonl
# → spawns `memify --input /tmp/run-123.jsonl &` (async)
# → buffer deleted after processing
```

---

## Write Flows

### Interactive push
```
brain push item
  → append to corpus/brain/queue.jsonl
  → spawn memify --drain (async subprocess, lockfile prevents duplicates)
      → LLM: extract entities, relationships, deduplicate
      → write to LadybugDB (upsert nodes, edges, embeddings)
      → clear processed entries from queue.jsonl
```

### DAG workflow run
```
workflow.py starts
  → brain push --buffer /tmp/run-{id}.jsonl (each step, non-blocking)
  → brain recall --buffer ... (text search within run, no DB)

workflow.py ends
  → brain flush --buffer /tmp/run-{id}.jsonl
      → spawn memify --input /tmp/run-{id}.jsonl (async)
          → one LLM call over full batch (efficient)
          → batch write to LadybugDB
          → delete buffer file
```

### Cron drain (fallback)
```
Every 5min (OpenClaw registerService timer):
  → if queue.jsonl has unprocessed entries → run memify --drain
```

---

## memify

The single LadybugDB writer. Runs as an async subprocess (never blocks the caller).

**Per run:**
1. Read items from input (buffer file or queue.jsonl)
2. Single LLM call (`claude --print` via stdin, Claude Max OAuth):
   - Extract entities from all items
   - Detect duplicates within batch AND against existing graph
   - Infer relationships between items
3. Open LadybugDB → batch transaction:
   - Upsert Entity nodes
   - Create Experience + Knowledge nodes
   - Create edges
   - Generate embeddings → write to HNSW index
4. Close DB, clear input

**Nightly maintenance:**
- Prune nodes not accessed in 30+ days
- Strengthen edges traversed frequently
- Detect recurring patterns → derive meta-knowledge

Uses lockfile to prevent concurrent runs. New spawn exits immediately if one is running.

---

## Agent Patterns

### Pre-task context loading
```
brain explore "project:odyssey"     → graph neighborhood
brain recall "deploy error opensandbox"  → relevant past knowledges
→ inject compact results into prompt
```

### Post-task knowledge capture
```
# Interactive (ad-hoc)
brain push '{"type": "experience", "outcome": "fail", "error": "...", "summary": "..."}'
brain push '{"type": "knowledge", "kind": "fact", "content": "Always use --flag X"}'

# DAG (buffered during run, flushed at end)
brain push --buffer /tmp/run.jsonl '...'
brain flush --buffer /tmp/run.jsonl
```

### Context discipline
- `recall` / `explore` return **summaries** by default, not full content
- Agent calls `brain get <id>` only when it decides a node is relevant
- Keeps context window lean — agent controls what it loads

---

## Storage Layout
```
corpus/
  brain/
    brain.db           ← LadybugDB (graph + HNSW vector, single file)
    queue.jsonl        ← global write queue (ad-hoc pushes)
    memify.lock        ← prevents concurrent memify runs
    memify.log         ← memify run log
  users/<agentId>/
    memory/
      recent.md        ← short-term memory (injected via AGENTS.md)
      daily/
        YYYY-MM-DD.md  ← raw session logs (source of truth)
```

---

## OpenClaw Plugin Hooks
```
after_compaction   → update recent.md + brain push (experience) to global queue
registerService    → 5min cron: drain queue.jsonl if non-empty
```

---

## File I/O Reality Check
- Append one JSONL line: ~0.1ms
- Read full buffer (50-100 items, few KB): ~1ms
- memify LLM call: 5-30 seconds

File I/O is 0.01% of total time. LLM call dominates. Not a bottleneck.

---

## What Brain Is Not
- Not a RAG system over raw documents (that's QMD + future LanceDB)
- Not a per-agent isolated store (global graph, scoped by query)
- Not a real-time system (memify is async, eventual consistency is fine)
- Not infrastructure-heavy (no Redis, no Docker, no daemon process)

---

## Design Scorecard (Elegance / Minimalism)

| System | Score | Notes |
|--------|-------|-------|
| Google Always-On Memory | 8/10 | Single SQLite, 4 agents with clear jobs, HTTP API, zero unnecessary abstractions. Loses 2pts: no in-context memory (query step required), InMemorySession = no persistence between runs |
| Our new design (this doc) | 7/10 | See below |
| Cognee | 5/10 | Clean 4-operation API but 3 storage backends, 14 search modes, enterprise complexity, not designed for multi-agent concurrent writes, Kuzu dependency now archived |
| Our previous design (FalkorDB) | 4/10 | FalkorDB heavy dep nobody queried, SessionLogAdapter dead, daily logs never written, STM/LTM split that leaked, 5min startup delay |

### Our design (7/10) — why we lose 3 points
- ❌ Two write paths (interactive queue vs DAG buffer) adds cognitive overhead
- ❌ memify is non-trivial (LLM call, lockfile, two modes: --drain and --input)
- ❌ Two memory systems running in parallel (recent.md + graph) — long-term these should merge
- ❌ LadybugDB is a young fork (Kuzu acquired by Apple Oct 2025) — maturity risk

### What got us to 7/10
- ✅ One DB file (LadybugDB, graph + vector in one)
- ✅ Three node types, four CLI commands — nothing more
- ✅ No infra (no Redis, no Docker, no daemon)
- ✅ Single writer (memify) — elegant concurrency solution
- ✅ Buffer/flush pattern — clean DAG separation
- ✅ CLI over MCP — token efficient, zero schema overhead
- ✅ Reuses claude --print OAuth (Claude Max, no API key)

### Path to 9/10
Merge recent.md into the graph (query STM from LadybugDB instead of injecting a flat file). Single memory system. Removes the parallel-systems complexity.

---

## Future
- LanceDB for semantic search over raw corpus (docs, code, articles)
- External connectors: YouTube, Twitter, PDF, Obsidian → bootstrap knowledge
- `/brain graph <entity>` CLI — visualize graph neighborhood
- Agent performance dashboard — query prompt success rates by task type
