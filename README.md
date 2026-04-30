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
brain init                    # scaffold ~/brain (PARA + sources, with auto-mounts)
brain doctor                  # validate folder + report broken sources
brain source list             # enumerate mounted sources
brain source add <NAME> <PATH>  # symlink an external markdown dir
brain source remove <NAME>    # unmount (never deletes the target)
brain snapshot --out brain.tar.zst  # portable archive
```

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

- **v0.2**: Homebrew tap, manifest-augmented sources (descriptions, hostname-namespacing).
- **v0.3**: `brain serve` — MCP server with `brain_context`, `brain_read`, `brain_remember`, `brain_list_sources`. Search composed via [qmd](https://github.com/tobi/qmd) when installed.

## Status

v0.1 — Unix-only. macOS and Linux supported. Windows is fast-fail.

## License

MIT
