# parabrain

> Your second brain — open to your AI agents, on every machine.

PARA-structured markdown at `~/brain/`, with mirrored copies of whatever external memory you want surfaced (Claude Code, gstack, Obsidian, anything). Exposed over MCP so every agent on every machine reads and writes to the same place. Built-in git sync keeps a laptop and a VPS in lock-step within seconds.

## Install

```sh
npm install -g @tobilu/qmd       # search backend (semantic + BM25 + reranking)
cargo install brainmd            # crate is `brainmd`, binary is `brain`
brain init                       # scaffolds ~/brain/ (PARA dirs + git repo +
                                 # agent primer + auto-mounted AI-tool sources)
qmd embed                        # one-time, ~30s + 333MB model download
```

`brain init` is interactive-friendly: it scaffolds the PARA folders, initializes a git repo (with a sensible `.gitignore`), writes a 30-line `brain.md` primer agents can `@`-import, and auto-mounts known AI-tool memory paths (Claude Code, gstack, etc.) as host-namespaced sources. Each mounted source is registered as its own qmd collection so search hits the mirrored copies.

`$BRAIN_HOME` overrides the default `~/brain/` location. Useful if you keep separate work and personal brains.

Without qmd installed, `brain_search` falls back to `rg` keyword search — semantic queries return nothing useful, but everything else still works.

## Wire it into Claude Code

```sh
claude mcp add brain -s user -- $(which brain) serve
```

Then add ONE line to `~/.claude/CLAUDE.md` so every session loads the brain primer:

```markdown
@~/brain/brain.md
```

`brain init` writes `~/brain/brain.md` with the meta-rules every agent needs (call `brain_context` first, ownership, never write directly, etc.). Editing the primer in one place updates every framework that imports it. For frameworks without `@`-imports, copy the file's content inline.

Open a new Claude Code session and ask *"what's in my brain?"* or *"what did I decide about X?"*

## Folder

```
~/brain/
├── brain.md     # agent primer (auto-generated; sync-able)
├── projects/    # active work
├── areas/       # responsibilities (areas/user.md is your identity)
├── resources/   # reference
├── archive/     # inactive
├── sources/     # mirrored copies of external markdown
└── .brain/      # host-local state (sources.json, locks); NEVER synced
```

The four buckets follow Tiago Forte's [PARA](https://fortelabs.com/blog/para/) note-organization scheme. `sources/` is the extension point — `brain source add NAME --from PATH` registers any markdown directory; brain mirrors the content into `sources/NAME/` as real files (so it syncs across machines via git, unlike symlinks which can't).

## Tools (MCP)

- **`brain_context(project?)`** — discovery: layout, mounted sources, your identity, optional project file. Call first when context matters.
- **`brain_read(path)`** — read any file under the brain.
- **`brain_remember(category, content, project?)`** — append-only deposit to a PARA bucket. Never overwrites; never writes to `archive/` or `sources/`. Each write gets a metadata header (timestamp + provenance). Touches the index-dirty marker so search stays fresh.
- **`brain_list_sources()`** — JSON enumeration of mounted external memory.
- **`brain_search(query, scope?, mode?)`** — full-corpus search. `mode` ∈ `hybrid` (default) | `fast` | `semantic`; `scope` is an optional path prefix (e.g. `projects`). Backed by [qmd](https://github.com/tobi/qmd) when available; degrades to ripgrep keyword search when not.
- **`brain_sync()`** — force-drain the index queue once and return the outcome. Use after a write when you need a search to immediately reflect it.

## Search

`brain_search` ranks across your whole brain — PARA buckets and every mounted source. `brain init` and `brain source add` register a separate qmd collection per mount (over the mirror dir under `sources/NAME/`), so search hits the synced content. Brain-relative paths come back in results:

```
$ brain_search "dirty bit worker"        # via MCP
{
  "backend": "qmd",
  "mode": "hybrid",
  "hits": [
    { "score": 0.93, "path": "sources/gstack-projects-mac/brain/yann-main-design-…md", "snippet": "…" },
    { "score": 0.50, "path": "sources/claude-memory-mac/sessionmoney-api-deployment.md", "snippet": "…" }
  ]
}
```

`brain serve` runs a background worker that drains within `BRAIN_INDEX_INTERVAL` seconds (default 5). The worker fires on agent writes (dirty bit set by `brain_remember`) and on filesystem events under the brain home + every registered source origin. When an origin changes, the watcher re-mirrors into the brain subdir, which then dirties the index. `qmd update` refreshes the BM25 index, `qmd embed` adds vectors for new chunks. Both are content-hash idempotent, so unchanged content costs nothing. Freshness lag is reported by `brain doctor`.

Direct file edits (vim, `git pull`, `brain sync`) are picked up automatically.

`brain index sync` force-drains from the CLI when `brain serve` isn't running. `brain_sync()` is the in-session equivalent over MCP — useful when an agent writes and immediately needs the result searchable.

## Sync across machines

Brain runs on a laptop and a VPS at the same time, with one machine designated as the **hub** (it holds the bare git repo all working copies push to and pull from). Setup is three commands:

```sh
# on the machine you want as the hub (typically a VPS — always-on)
brain init && brain sync && brain hub init
# → creates ~/brain.git (bare) + post-receive hook that auto-checks out
#   into ~/brain on push. Prints the SSH URL clients use to attach.

# on every other machine
brain join brain@hub:~/brain.git
# → clones into ~/brain, sets per-host git identity, installs a
#   launchd/systemd timer that runs `brain sync` every 5 min.
```

After that, `brain sync` (commit + pull --rebase + push) glues everything together. It runs on three triggers:

1. **The timer** — every 5 min as the safety net.
2. **The watcher** — when files change inside the brain.
3. **The MCP write hook** — fire-and-forget after every `brain_remember` deposit, so agent memories propagate to other machines within ~2 seconds.

Migrating an existing single-machine brain to a hub: `brain join URL --seed-from-here` pushes the local brain to the (empty) hub as the seed instead of cloning.

Sources stay per-host (the origin path is host-local; only the mirrored content syncs) and are conventionally host-namespaced (`cc-mac`, `cc-vps`, …) so subdirs don't collide. `brain init` does this automatically for auto-mounted sources.

## CLI

```sh
brain doctor            # validate folder, check qmd, report index lag
brain source add NAME --from PATH    # register an external dir as a mirrored source
brain source list                    # show registered sources
brain source remove NAME             # drop a source (deletes mirror dir; origin untouched)
brain source sync [NAME]             # manually re-mirror one or all sources
brain snapshot          # portable .tar.zst archive
brain serve             # MCP server over stdio (acquires single-instance lock)
brain index sync        # force-drain the index queue once (refuses if `brain serve` is running)
brain sync              # commit local edits, pull --rebase --autostash, push to hub
brain hub init          # promote this machine to be the sync hub
brain join URL          # attach this machine to a hub
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

v0.4 (in-progress) — built-in Mac↔VPS sync (`brain sync`, `brain hub init`, `brain join`), source primitive switched from symlinks to mirrored copies (so content syncs through git), MCP write hook for sub-2-second propagation. v0.3.1 was the last symlink-source release. Unix only (macOS, Linux). MIT.
