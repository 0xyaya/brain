# Brain — Agent Memory Plugin

Persistent memory for AI agents. Push experiences and knowledge into a LadybugDB graph, consolidate with an LLM, recall by semantic similarity — no external infrastructure required.

## Requirements

- Node.js 20+
- `claude` CLI ([install](https://docs.anthropic.com/en/docs/claude-code)) — used by the consolidation pipeline to extract entities and relationships from raw session data
- Claude API access (Anthropic account with API key configured in `claude` CLI)

## Quick Start

```bash
# 1. Clone and install
git clone <repo> brain
cd brain && npm install

# 2. Link the CLI
npm link   # or: ln -s $(pwd)/bin/brain.js ~/.local/bin/brain

# 3. Initialize for your agent
brain init --agent myagent

# 4. Build the vector index (downloads ~25MB model once)
brain consolidate --embed

# 5. Test recall
brain recall --agent myagent "what have I been working on"
```

## Installation (OpenClaw plugin)

```bash
git clone <repo> ~/.openclaw/extensions/brain
cd ~/.openclaw/extensions/brain && npm install
```

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "brain": {
      "config": {
        "agentId": "your-agent-id",
        "corpusRoot": "~/corpus"
      }
    }
  }
}
```

Restart the OpenClaw gateway.

## Configuration

Brain reads `~/corpus/brain/config.json` (or `$BRAIN_DIR/config.json`):

```json
{
  "agentId": "myagent",
  "corpusRoot": "~/my-data",
  "brainDir": "~/my-data/brain"
}
```

All paths can also be set via environment variables:

| Variable           | Default                  | Description                    |
|--------------------|--------------------------|--------------------------------|
| `BRAIN_DIR`        | `~/corpus/brain`         | Brain DB + queue + config dir  |
| `BRAIN_AGENT_ID`   | value from config.json   | Agent identifier               |
| `BRAIN_CORPUS_ROOT`| `~/corpus`               | Root for agent memory dirs     |

`brain init --agent <id>` creates the config and directory structure automatically.

## CLI Reference

```bash
brain init [--agent <id>] [--corpus <path>]   # Initialize brain for this machine
brain push [--agent <id>] <json>              # Push experience/knowledge to queue
brain push --graph <file>                     # Import entity graph from JSON
brain recall [--agent <id>] [--days N] <query> # Semantic search over memory
brain explore <entity>                        # Graph neighborhood of an entity
brain get <id>                                # Get full node by ID
brain consolidate [--agent <id>] [--flags]    # Run consolidation pipeline
brain --help                                  # Print usage
```

### Push formats

```bash
# Experience (what happened)
brain push --agent myagent '{"type":"experience","summary":"deployed v2 to prod","outcome":"success"}'

# Knowledge (what was learned)
brain push --agent myagent '{"type":"knowledge","kind":"fact","content":"always use --flag X"}'
brain push --agent myagent '{"type":"knowledge","kind":"decision","content":"use postgres not sqlite"}'

# Entity graph (bulk import)
brain push --graph personas/karpathy.brain.json
```

### Recall

```bash
brain recall --agent myagent "neural networks and training"
# Returns semantically similar nodes — works even with zero keyword overlap
# Also searches last 3 days of daily memory logs (keyword fallback)
brain recall --agent myagent --days 7 "deployment issues"  # extend daily log window
```

### Consolidate flags

| Flag          | Description                                              | Needs Claude |
|---------------|----------------------------------------------------------|-------------|
| `--drain`     | Process queue — LLM extracts entities & edges to graph   | ✓           |
| `--focus`     | Update MEMORY.md focus section (open threads)            | ✓           |
| `--recent`    | Update MEMORY.md recent section (last 48h)               | ✓           |
| `--permanent` | LLM-summarize top knowledge into permanent facts         | ✓           |
| `--daily`     | Write daily log to `memory/YYYY-MM-DD.md`                | ✓           |
| `--maintain`  | Prune stale experiences, strengthen edge weights         | ✗           |
| `--embed`     | Backfill vector embeddings for all existing nodes        | ✗           |

No flags → defaults to `--drain --focus --recent`.

### Recommended cron schedule

```
every 30m → brain consolidate --drain --focus --recent
every 6h  → brain consolidate --drain --focus --recent --permanent --daily
```

## Architecture

### Graph schema

- **Experience** — what happened (sessions, tasks, outcomes)
- **Knowledge** — what was learned (facts, decisions, open threads)
- **Entity** — who/what (agents, projects, tools, concepts)

Edges: `DERIVED`, `ABOUT`, `INVOLVES`, `RELATES_TO`, `FOLLOWS`

### Recall pipeline

1. Embed query via `all-MiniLM-L6-v2` (local, ~25MB, no API key)
2. Cosine similarity over `embeddings.json` (all 950+ nodes)
3. Fetch top-N node details from LadybugDB
4. Keyword fallback over recent daily logs (`memory/YYYY-MM-DD.md`)

### Vector embeddings

Embeddings are stored in `$BRAIN_DIR/embeddings.json` (outside LadybugDB to avoid type conflicts). New nodes are embedded automatically at consolidate time. Backfill existing nodes with `brain consolidate --embed`.

### MEMORY.md

Auto-maintained by consolidate pipeline via `<!-- BRAIN:*:START/END -->` markers:
- **Focus** — current open threads
- **Recent** — last 48h digest
- **Permanent** — LLM-distilled long-term facts

## Known Issues

**Stale lock file** — LadybugDB can crash during `--maintain` (ABOUT edge assertion failure), leaving `consolidate.lock` behind. Fix:
```bash
rm ~/corpus/brain/consolidate.lock
```

**`--maintain` ABOUT crash** — LadybugDB bug in edge strengthening for ABOUT relationships. `--maintain` skips ABOUT edges as a workaround. All other edge types work fine.

## Example personas

See `personas/` directory for ready-to-import `.brain.json` files:

```bash
brain push --graph personas/karpathy.brain.json   # Andrej Karpathy knowledge graph
brain push --graph personas/hormozi.brain.json    # Alex Hormozi frameworks
```

## License

MIT
