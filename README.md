# brain

MCP-served aggregator of AI artifacts. A PARA-structured second brain that mounts Claude Code, gstack, and other AI-tool memory via symlink sources.

## Why

If you run Claude Code + gstack (or similar AI dev tooling), you're already generating valuable markdown across `~/.claude/`, `~/.gstack/`, `~/.openclaw/`, and project-local files. brain aggregates them into one PARA-organized folder you can query, snapshot, and (in v0.3) serve over MCP.

brain is **your** second brain — agents are guests acting on your behalf. Agents read everything via MCP and write to PARA buckets via `brain_remember` (v0.3). They never write to `sources/` or to each other's stores.

## Install

```sh
cargo install brainmd
```

The crate is `brainmd`; the installed binary is `brain`.

## Usage

```sh
brain init                          # scaffold ~/brain (PARA + sources, with auto-mounts)
brain doctor                        # validate folder + report broken sources
brain source list                   # enumerate mounted sources
brain source add <NAME> <PATH>      # symlink an external markdown dir
brain source remove <NAME>          # unmount (never deletes the target)
brain snapshot --out brain.tar.zst  # portable archive
brain serve                         # run as MCP server over stdio (v0.2)
```

## MCP server (v0.2)

`brain serve` exposes brain as an MCP server. Register it once with Claude Code and every session has structured access.

```sh
claude mcp add brain -s user -- /full/path/to/brain serve
```

Use the full absolute path (`which brain`) so the spawned subprocess always finds the binary.

**Tools exposed:**
- `brain_context(project?)` — discovery surface. Returns layout, mounted sources, `areas/user.md` content, and an optional project file. Call this first at session start.
- `brain_read(path)` — read any file under the brain (relative or absolute path; symlinks into mounted sources are followed transparently). Refuses path traversal.
- `brain_remember(category, content, project?)` — append-only deposit to a PARA bucket on Yann's behalf. `category` ∈ `{projects, areas, resources}`. Auto-prepends a metadata header (timestamp, provenance). Returns JSON `{path, bytes_written, created}`.
- `brain_list_sources()` — JSON enumeration of mounted sources: `[{name, target, broken}, ...]`.

**Ownership model:** brain is *Yann's* brain — agents are guests acting on his behalf. `brain_remember` always deposits **for Yann** (PARA-typed, never to `archive/` or `sources/`). Agent self-memory (identity, beliefs, daily journal) belongs in each agent's own tool, not brain.

## Folder layout

```
~/brain/
├── projects/    # PARA: active work with deadlines
├── areas/       # PARA: ongoing responsibilities
├── resources/   # PARA: reference material, topics of interest
├── archive/     # PARA: inactive items
└── sources/     # symlinked external dirs (read-only mounts)
```

`brain init` auto-mounts these when present:

| Mount | Source path |
| --- | --- |
| `gstack-projects` | `~/.gstack/projects/` |
| `claude-memory` | `~/.claude/projects/<encoded-cwd>/memory/` |
| `builder-journey.md` | `~/.gstack/builder-journey.md` |

Mounts are skipped silently with a stderr note when the target is absent. Add others with `brain source add`.

## Configuration

- `BRAIN_HOME` — where the brain folder lives. Defaults to `~/brain`.

## What's coming

- **v0.3**: Homebrew tap, manifest-augmented sources (descriptions, hostname-namespacing, indexed-at).
- **v0.4+**: optional [qmd](https://github.com/tobi/qmd) companion for semantic search; brain detects qmd at runtime, falls back to ripgrep when absent.

## Status

v0.2 — MCP server over stdio, plus the v0.1 surface. Unix-only (macOS + Linux). Windows is fast-fail.

## License

MIT
