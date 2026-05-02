# parabrain

> Your second brain — open to your AI agents.

PARA-structured markdown at `~/brain/`, plus symlinks to whatever external memory you want surfaced (Claude Code, gstack, Obsidian, anything). Exposed over MCP so every agent on your machine reads and writes to the same place.

## Install

```sh
npm install -g @tobilu/qmd       # search backend (semantic + BM25 + reranking)
cargo install brainmd            # crate is `brainmd`, binary is `brain`
brain init                       # scaffolds ~/brain/, auto-mounts AI-tool memory,
                                 # registers each mount as a qmd collection
qmd embed                        # one-time, ~30s + 333MB model download
```

`brain init` is interactive-friendly: it auto-mounts known AI-tool memory paths it finds on your system (Claude Code, gstack, etc.) and registers each as its own qmd collection so search hits the symlink targets.

`$BRAIN_HOME` overrides the default `~/brain/` location. Useful if you keep separate work and personal brains.

Without qmd installed, `brain_search` falls back to `rg` keyword search — semantic queries return nothing useful, but everything else still works.

## Wire it into Claude Code

```sh
claude mcp add brain -s user -- $(which brain) serve
```

Append to `~/.claude/CLAUDE.md` so every session knows brain exists:

```markdown
## brain
Personal second brain over MCP. Call `brain_context` first when the
user asks anything that depends on cross-session context. Use
`brain_search` to find prior decisions, notes, or anything across
mounted sources. Use `brain_remember` to save notes for the user.
```

Open a new Claude Code session and ask *"what's in my brain?"* or *"what did I decide about X?"*

## Folder

```
~/brain/
├── projects/    # active work
├── areas/       # responsibilities (areas/user.md is your identity)
├── resources/   # reference
├── archive/     # inactive
└── sources/     # symlinks to external markdown
```

The four buckets follow Tiago Forte's [PARA](https://fortelabs.com/blog/para/) note-organization scheme. `sources/` is the extension point — `brain source add NAME PATH` mounts any markdown directory.

## Tools (MCP)

- **`brain_context(project?)`** — discovery: layout, mounted sources, your identity, optional project file. Call first when context matters.
- **`brain_read(path)`** — read any file under the brain. Symlinks into mounted sources are followed transparently.
- **`brain_remember(category, content, project?)`** — append-only deposit to a PARA bucket. Never overwrites; never writes to `archive/` or `sources/`. Each write gets a metadata header (timestamp + provenance). Touches the index-dirty marker so search stays fresh.
- **`brain_list_sources()`** — JSON enumeration of mounted external memory.
- **`brain_search(query, scope?, mode?)`** — full-corpus search. `mode` ∈ `hybrid` (default) | `fast` | `semantic`; `scope` is an optional path prefix (e.g. `projects`). Backed by [qmd](https://github.com/tobi/qmd) when available; degrades to ripgrep keyword search when not.
- **`brain_sync()`** — force-drain the index queue once and return the outcome. Use after a write when you need a search to immediately reflect it.

## Search

`brain_search` ranks across your whole brain — PARA buckets and every mounted source. `brain init` and `brain source add` register a separate qmd collection per mount (over the symlink target), so search hits the real files. Brain-relative paths come back in results:

```
$ brain_search "dirty bit worker"        # via MCP
{
  "backend": "qmd",
  "mode": "hybrid",
  "hits": [
    { "score": 0.93, "path": "sources/gstack-projects/brain/yann-main-design-…md", "snippet": "…" },
    { "score": 0.50, "path": "sources/claude-memory/sessionmoney-api-deployment.md", "snippet": "…" }
  ]
}
```

`brain serve` runs a background worker that drains within `BRAIN_INDEX_INTERVAL` seconds (default 5). The worker fires on agent writes (dirty bit set by `brain_remember`) and on filesystem events under the brain home + every mounted source target — `qmd update` refreshes the BM25 index, `qmd embed` adds vectors for new chunks. Both are content-hash idempotent, so unchanged content costs nothing. Freshness lag is reported by `brain doctor`.

Direct file edits (vim, `git pull`) are picked up automatically via the file-watcher.

`brain index sync` force-drains from the CLI when `brain serve` isn't running. `brain_sync()` is the in-session equivalent over MCP — useful when an agent writes and immediately needs the result searchable.

## CLI

```sh
brain doctor            # validate folder, check qmd, report index lag
brain source list       # show mounted memory
brain source add        # mount a markdown directory
brain source remove     # unmount (never deletes the target)
brain snapshot          # portable .tar.zst archive
brain serve             # MCP server over stdio (acquires single-instance lock)
brain index sync        # force-drain the index queue once (refuses if `brain serve` is running)
```

## Ownership

Brain is yours. Agents are guests. They read what you mount and save notes for you via `brain_remember` — but their own identity, beliefs, and daily journal live in their own tool's store, never in brain.

## Troubleshooting

- **`qmd not found` from `brain doctor`** — run `npm install -g @tobilu/qmd` and `brain init --force` to re-register the collections.
- **`another brain serve already owns this brain — exiting`** — only one `brain serve` per brain home (advisory file lock at `.brain/serve.lock`). Stop the other instance or restart your MCP client.
- **`qmd collection 'X' is registered to <other-path>`** — qmd's collection registry is global per user. Either remove the conflicting registration (`qmd collection remove X`) or use a different name. Common when two brains share a name like `brain`.
- **Stale search results after manual edits** (Vim, `git pull`, `rm`) — picked up automatically by the file-watcher in v0.3.1+. If `brain serve` isn't running, force a refresh with `brain index sync`. The watcher snapshots the source list at startup, so newly mounted sources require restarting `brain serve` (planned for v0.4).
- **Linux: `inotify watch limit reached`** — the file-watcher uses inotify under the hood. Raise the limit by adding `fs.inotify.max_user_watches=524288` to `/etc/sysctl.d/99-inotify.conf` and reloading (`sudo sysctl --system`). The watcher logs a clear warning and continues even when watches fail to install, so search keeps working via `brain_remember` writes.

## Status

v0.3.1 — adds a file-watcher that closes the freshness gap for external edits (vim, `git pull`). Unix only (macOS, Linux). MIT.
