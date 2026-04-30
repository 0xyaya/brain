# parabrain

> A second brain for your AI agents — yours, not theirs.

PARA-structured markdown at `~/brain/`, plus symlinks to whatever external memory you want surfaced (Claude Code, gstack, Obsidian, anything). Exposed over MCP so every agent on your machine reads and writes to the same place.

## Install

```sh
cargo install brainmd
brain init
```

The crate is `brainmd`. The binary is `brain`. `brain init` scaffolds `~/brain/` and auto-mounts the AI-tool memory it finds on your system.

## Wire it into Claude Code

```sh
claude mcp add brain -s user -- $(which brain) serve
```

Append to `~/.claude/CLAUDE.md` so every session knows brain exists:

```markdown
## brain
Personal second brain over MCP. Call `brain_context` first when the
user asks anything that depends on cross-session context. Use
`brain_remember` to save notes for them.
```

Open a new Claude Code session and ask *"what's in my brain?"*

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
- **`brain_remember(category, content, project?)`** — append-only deposit to a PARA bucket. Never overwrites; never writes to `archive/` or `sources/`. Each write gets a metadata header (timestamp + provenance).
- **`brain_list_sources()`** — JSON enumeration of mounted external memory.

## CLI

```sh
brain doctor            # validate folder + check for broken symlinks
brain source list       # show mounted memory
brain source add        # mount a markdown directory
brain source remove     # unmount (never deletes the target)
brain snapshot          # portable .tar.zst archive
brain serve             # MCP server over stdio
```

## Ownership

Brain is yours. Agents are guests. They read what you mount and save notes for you via `brain_remember` — but their own identity, beliefs, and daily journal live in their own tool's store, never in brain.

## Status

v0.2. Unix only (macOS, Linux). MIT.
