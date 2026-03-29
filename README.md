# brain

Memory for AI agents. Push what happened, recall what matters.

```bash
$ brain push '{"type":"experience","text":"prod deploy failed — missing env var DATABASE_URL","entities":["deploy","prod","fail"]}'
$ brain recall "why did production break"
→ [0.91] prod deploy failed — missing env var DATABASE_URL
→ [0.74] deploy pipeline skips env validation when NODE_ENV is not set
```

No external infrastructure. One graph file. Works with any agent.

---

## How it works

You push knowledge and experiences as JSON.  
Brain stores them in a graph. Edges carry weight.  
Recall is hybrid — vector similarity finds related nodes, graph traversal surfaces connected siblings.  
Recalled edges grow stronger. Unused ones decay. What matters rises naturally.

```
Knowledge  -[ABOUT]->    Entity
Experience -[INVOLVES]-> Entity
Experience -[DERIVED]->  Knowledge
```

---

## Install

```bash
npm install -g brain-plugin
cd myproject && brain init
```

Or from source:

```bash
git clone https://github.com/0xyaya/brain
cd brain && npm install && npm link
cd myproject && brain init
```

`brain init` runs interactive prompts on first use and creates a `brain.json` in your project root. On subsequent runs it reads `brain.json` silently — no prompts.

Generates an `AGENTS.md` with shell command instructions — works for every agent out of the box. If your agent supports MCP, add brain to your agent's MCP config manually (see MCP section below).

```json
{
  "projectName": "myapp",
  "brainDir": ".brain"
}
```

---

## Push

```bash
# Something you learned
brain push '{"type":"knowledge","text":"always run migrations in a transaction","entities":["postgres","migrations","decision"]}'

# Something that happened
brain push '{"type":"experience","text":"migrated 2M rows — took 4min, zero downtime","entities":["postgres","migrations","prod","success"]}'
```

`entities[]` takes real names and classification words alike — `decision`, `risk`, `open`, `success` become graph nodes and traversable axes of memory.

---

## Recall

```bash
brain recall "database migration lessons"
```

Returns nodes ranked by vector score × edge weight. The more a node is recalled, the stronger its edges become.

---

## CLI

```bash
brain init                     # Initialize for this directory
brain push     <json>          # Queue a memory item
brain flush                    # Write queue to graph
brain recall   <query>         # Hybrid semantic + graph search
brain explore  <entity>        # Graph neighborhood of an entity
brain get      <id>            # Fetch full node by ID
brain remove   <id>            # Delete a node
brain consolidate [--flags]    # Rebuild MEMORY.md
```

Override the agent ID via `BRAIN_AGENT_ID` env var, or use `BRAIN_DIR` for full isolation.

---

## MEMORY.md

`brain consolidate` maintains a `MEMORY.md` file for each agent — rebuilt from the graph on every run. Three sections: **Focus** (highest-centrality × recency), **Recent** (last 72h), **Permanent** (LLM synthesis of top nodes).

```
# Focus
- prod deploy is unstable — three failures this week linked to env config
- migration strategy unresolved: rolling vs blue-green still open

# Recent
- deploy pipeline fixed: added env validation step [success]
- decided to use feature flags for all schema changes [decision]

# Permanent
- always run migrations in a transaction — learned the hard way in prod
- data quality beats model complexity every time
```

Inject into agent context at session start. Never edit manually.

---

## Consolidation schedule

```
Every 30m   brain flush && brain consolidate --focus --recent
Every 6h    brain consolidate --summarize --permanent
Weekly      brain consolidate --ingest --maintain --embed
```

Light sleep → deep sleep → REM. The graph consolidates like memory does.

---

## MCP

Works with Claude Desktop, Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/path/to/brain/src/mcp.js"],
      "env": { "BRAIN_DIR": "/path/to/project/.brain" }
    }
  }
}
```

---

## OpenClaw

Using [OpenClaw](https://github.com/openclaw/openclaw)? See [brain-openclaw](https://github.com/0xyaya/brain-openclaw) for the native plugin.

---

MIT
