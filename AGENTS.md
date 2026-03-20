# AGENTS.md — Brain Plugin Agent Instructions

## Setup (run once)

```bash
# Add brain to PATH
ln -s ~/.openclaw/extensions/brain/bin/brain.js ~/bin/brain
chmod +x ~/bin/brain

# Register QMD collection for brain recall
qmd collection add ~/corpus/brain --name brain --mask 'index.md'
```

## Usage

```bash
brain push '{"type":"knowledge","kind":"fact|decision|thread","content":"..."}'
brain push '{"type":"experience","summary":"...","outcome":"success|fail"}'
brain recall "query"       # keyword search over knowledge graph
brain explore "entity"     # graph traversal from an entity
brain get <id>             # fetch full node by id
brain consolidate          # update MEMORY.md + daily log
```

## When to use

- **push** — after completing a task, making a decision, or learning something worth keeping
- **recall** — before starting a task to load relevant past knowledge
- **explore** — to understand what's connected to a project/entity
- **consolidate** — manually trigger MEMORY.md update (runs automatically every 5min)

## Buffered mode (for DAG workflows)

```bash
brain push --buffer /tmp/run.jsonl '{"type":"experience",...}'
brain recall --buffer /tmp/run.jsonl "query"   # text search within buffer
brain flush --buffer /tmp/run.jsonl            # commit buffer to graph at end
```
