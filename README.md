# Brain — Agent Memory Plugin

An OpenClaw plugin that gives agents persistent memory. Experiences and knowledge are captured into a LadybugDB graph database, consolidated by an LLM pipeline, and surfaced back to agents via a minimal CLI. No external infrastructure required — just an embedded DB, flat files, and `claude` CLI.

## Requirements

- Node.js 20+
- [@ladybugdb/core](https://github.com/ladybugdb/ladybugdb) (embedded graph database)
- `claude` CLI with Claude Max (used by consolidate pipeline)
- `qmd` CLI (for brain recall)

## Setup

```bash
qmd collection add ~/corpus/brain --name brain --mask 'index.md'
```

## Installation

```bash
cp -r brain ~/.openclaw/extensions/brain
cd ~/.openclaw/extensions/brain && npm install
```

Add to your OpenClaw config:

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

## CLI Reference

```bash
brain push [--buffer <file>] <json>       # Push experience/knowledge to queue
brain recall [--buffer <file>] <query>    # Search knowledge (vector or text)
brain explore <entity>                    # Graph neighborhood of an entity
brain get <id>                            # Get full node by ID
brain flush --buffer <file>               # Flush buffer file via consolidate
brain consolidate [--flags]               # Run consolidate pipeline
brain --help                              # Print usage
```

### Push modes

**Interactive** (default): appends to `queue.jsonl`, spawns consolidate.

```bash
brain push '{"type": "experience", "agent": "neo", "summary": "deployed v2", "outcome": "success"}'
brain push '{"type": "knowledge", "kind": "fact", "content": "Always use --flag X"}'
```

**Buffered** (for workflows): writes to an isolated file, flushed at end.

```bash
brain push --buffer /tmp/run.jsonl '{"type": "experience", ...}'
brain recall --buffer /tmp/run.jsonl "deploy error"
brain flush --buffer /tmp/run.jsonl
```

### Consolidate flags

| Flag          | Description                                          |
|---------------|------------------------------------------------------|
| `--drain`     | Process queue.jsonl — LLM extracts entities & edges  |
| `--focus`     | Update MEMORY.md focus section (open threads)        |
| `--recent`    | Update MEMORY.md recent section (last 48h)           |
| `--permanent` | LLM-summarize top knowledge into permanent facts     |
| `--daily`     | Write daily log to `memory/YYYY-MM-DD.md`            |
| `--maintain`  | Prune stale experiences, strengthen edge weights      |

No flags defaults to `--drain --focus --recent`.

## Architecture

### Graph schema

Three node types in LadybugDB:

- **Experience** — what happened (conversations, task runs, DAG steps)
- **Knowledge** — what was learned (facts, decisions, open threads)
- **Entity** — who or what (agents, projects, tools, concepts)

Five edge types: `DERIVED`, `ABOUT`, `INVOLVES`, `RELATES_TO`, `FOLLOWS` — all with a `weight` column incremented by nightly maintenance.

### Consolidate pipeline

`bin/consolidate.js` is the single DB writer. It runs as a detached subprocess (never blocks the caller) with a lockfile to prevent concurrent runs.

1. **Drain** — reads queue items, sends to LLM for entity/relationship extraction, writes nodes + edges to LadybugDB
2. **Focus/Recent** — queries the graph, writes summary sections into `MEMORY.md`
3. **Permanent** — LLM-summarizes top knowledge into permanent facts in `MEMORY.md`
4. **Daily** — writes a date-stamped log of the day's experiences and knowledge
5. **Maintain** — prunes experiences older than 30 days with no derived knowledge, strengthens surviving edges

### MEMORY.md sections

The consolidate pipeline maintains three auto-updating sections in `MEMORY.md` (delimited by `<!-- BRAIN:*:START/END -->` markers):

- **Focus** — current open threads
- **Recent** — last 48h of experiences and knowledge
- **Permanent** — LLM-distilled permanent facts

### Plugin hooks

- `after_compaction` — pushes a compaction experience to the queue, runs drain + focus + recent
- `brain-drain` service — every 5 minutes, drains queue if non-empty
- `brain-nightly` service — every 6 hours, runs permanent + daily + maintain

## Config

| Key           | Type   | Default    | Description                |
|---------------|--------|------------|----------------------------|
| `agentId`     | string | `"neo"`    | Agent identifier           |
| `corpusRoot`  | string | `~/corpus` | Path to corpus root        |

## License

MIT
