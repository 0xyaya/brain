# Brain — Agent Memory

Persistent memory for AI agents. Push experiences and knowledge into a graph, recall by semantic + graph similarity. No external infrastructure required.

```bash
brain push '{"type":"knowledge","text":"always commit before deploying","entities":["git","deploy"]}'
brain recall "deployment mistakes"
# → [0.84] always commit before deploying
# → [0.71] deploy pipeline failed due to uncommitted config change
```

## How it works

Three node types, one graph:

```
Knowledge  — what was learned (facts, decisions, concerns)
Experience — what happened (tasks, sessions, outcomes)
Entity     — who/what (people, projects, tools, concepts)
```

Edges wire them together:
```
Knowledge  -[ABOUT]->   Entity
Experience -[INVOLVES]-> Entity
Experience -[DERIVED]->  Knowledge
```

**Recall is hybrid** — vector search finds semantically similar nodes, then graph traversal expands to connected siblings ranked by shared edge weight. Used edges get stronger (+0.1 per recall). Unused edges decay weekly (×0.95). High-use nodes naturally rise to the surface.

**MEMORY.md** is auto-maintained — a living document rebuilt from the graph on every consolidation cycle.

## Requirements

- Node.js 20+
- `claude` CLI — used by `--permanent` and `--summarize` consolidation steps
- Claude API access (configured in `claude` CLI)

## Quick Start

```bash
git clone <repo> brain
cd brain && npm install

# Initialize
brain init --agent myagent

# Push some memory
brain push --agent myagent '{"type":"knowledge","text":"SQLite is safer than Kuzu for embedded graphs","entities":["sqlite","kuzu","architecture"]}'

# Build vector index (downloads ~25MB model once)
brain consolidate --agent myagent --embed

# Recall
brain recall --agent myagent "database choices"
```

## OpenClaw Plugin

```bash
git clone <repo> ~/.openclaw/extensions/brain
cd ~/.openclaw/extensions/brain && npm install
```

Add to `openclaw.json`:
```json
{
  "plugins": {
    "brain": {
      "config": {
        "agentId": "myagent",
        "corpusRoot": "~/corpus"
      }
    }
  }
}
```

## CLI

```bash
brain init     [--agent <id>] [--corpus <path>]     # Initialize for this machine
brain push     [--agent <id>] <json>                # Queue a memory item
brain flush    [--agent <id>]                       # Write queue to graph
brain recall   [--agent <id>] [--days N] <query>    # Hybrid semantic + graph search
brain explore  <entity>                             # Graph neighborhood of an entity
brain get      <id>                                 # Fetch full node by ID
brain remove   <id>                                 # Delete a node (MEMORY.md self-heals)
brain consolidate [--agent <id>] [flags]            # Update MEMORY.md
```

### Push format

```json
{
  "type": "knowledge",
  "text": "SQLite is the safer fallback — no concurrent write limitations",
  "entities": ["sqlite", "brain", "architecture", "decision"],
  "derives": ["exp:abc123"]
}
```

```json
{
  "type": "experience",
  "text": "Migrated brain DB from Kuzu to SQLite — no data loss",
  "entities": ["sqlite", "kuzu", "brain", "success"]
}
```

**`entities[]`** is everything — real names AND classification words mixed freely. Each becomes an Entity node with a graph edge. Classification words like `decision`, `risk`, `open`, `resolved`, `success` become traversable axes of the graph.

**`derives[]`** links a knowledge node back to the experience that produced it (creates `DERIVED` edge).

### Consolidate flags

| Flag          | What it does                                              | Needs Claude |
|---------------|-----------------------------------------------------------|:---:|
| `--focus`     | Update MEMORY.md focus (highest-centrality × recency)    | ✗   |
| `--recent`    | Update MEMORY.md recent (last 72h digest)                 | ✗   |
| `--permanent` | LLM synthesizes top nodes into permanent facts           | ✓   |
| `--summarize` | Creates synthesis Knowledge nodes for top entity clusters | ✓   |
| `--ingest`    | Extract knowledge from daily log files (LLM per file)    | ✓   |
| `--maintain`  | Decay edge weights (×0.95), purge isolated nodes         | ✗   |
| `--embed`     | Backfill vector embeddings for existing nodes            | ✗   |

Default (no flags): `--focus --recent`

### Recommended cron schedule

```
Every 30m  →  brain flush + brain consolidate --focus --recent
Every 6h   →  brain consolidate --summarize --permanent
Weekly     →  brain consolidate --ingest --maintain --embed
```

The sleep-cycle model:
- **Light sleep** (30m) — process new input, surface what matters
- **Deep sleep** (6h) — synthesize, strengthen important connections
- **REM** (weekly) — prune, re-ingest from source, rebuild embeddings

## Configuration

`$BRAIN_DIR/config.json` (default: `~/corpus/brain/config.json`):

```json
{
  "agentId": "myagent",
  "corpusRoot": "~/my-data"
}
```

Environment variables:

| Variable            | Default               | Description                   |
|---------------------|-----------------------|-------------------------------|
| `BRAIN_DIR`         | `~/corpus/brain`      | DB, queue, config             |
| `BRAIN_AGENT_ID`    | from config.json      | Agent identifier              |
| `BRAIN_CORPUS_ROOT` | `~/corpus`            | Root for agent memory dirs    |

## MEMORY.md

Auto-generated from the graph. Three sections:

```markdown
# Focus    — top 5 nodes by centrality × recency decay (λ=0.05)
# Recent   — last 72h experiences and knowledge, noise-filtered
# Permanent — LLM synthesis of highest-centrality nodes
```

Never edit MEMORY.md manually — it's overwritten on every consolidation. Fix bad content with `brain remove <id>`.

## MCP Server

Brain also ships as an MCP server for direct integration with Claude Desktop or other MCP clients:

```bash
node src/mcp.js
```

Configure in `.mcp.json`:
```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/path/to/brain/src/mcp.js"],
      "env": { "BRAIN_AGENT_ID": "myagent" }
    }
  }
}
```

## Example personas

Ready-to-import `.brain.json` files in `personas/`:

```bash
brain push --graph personas/karpathy.brain.json   # Andrej Karpathy knowledge graph
brain push --graph personas/hormozi.brain.json    # Alex Hormozi frameworks
```

## Known limitations

- LadybugDB has a bug causing assertion failures on `SET` operations for `DERIVED` and `RELATES_TO` edge types — `--maintain` skips those relationships as a workaround
- Stale lock: if consolidate crashes, remove `~/corpus/brain/consolidate.lock` manually
- Vector embeddings stored outside LadybugDB (`embeddings.json`) to avoid column type conflicts

## License

MIT
