# SYNC — Mac ↔ VPS sync for brain

Plan doc for adding bidirectional sync to the brain project.
Status: **proposed, not implemented**. Decided 2026-05-13.

## Goal

Run brain on Mac (Obsidian, Claude Code, gstack) and on a VPS (openclaw,
Claude Code) with a single coherent view of all agent memories and
human notes across both hosts. Agents on either host can read what was
written on the other within seconds.

## Decision summary

- **Topology:** bare git repo on a designated **hub** machine. The hub
  holds the bare repo + its own working copy. Every other machine
  holds a working copy and points at the hub. (Term "hub" picked over
  server/host/primary — `serve` is taken by MCP; "host" is overloaded;
  "hub" matches the actual hub-and-spoke shape.)
- **Source primitive moves from symlink to mirror.** Only mirror.
  Symlink support is removed, not kept as a flag. `sources/<name>/`
  becomes a real directory of files copied from a host-local origin.
  Host-namespaced subdirs (`cc-mac/`, `cc-vps/`, …) so neither machine
  writes the other's tree.
- **`brain sync` subcommand** wraps commit + pull --rebase + push,
  called from three places: MCP `brain_remember` post-write hook, the
  file-watcher (debounced), and a launchd/systemd timer.
- **CLI surface for setup:**
  - `brain init` — single-machine setup. Always initializes git (no
    flag). `--no-git` if you really want a plain folder.
  - `brain hub init` — promotes a machine to be the hub. Creates the
    bare repo at `~/brain.git`, the working copy at `~/brain/`, and
    installs the post-receive checkout hook. Prints the SSH URL to
    use from other machines.
  - `brain join <ssh-url>` — clones from a hub into `~/brain/` on the
    current machine. Also installs the per-OS sync timer
    (launchd plist on macOS, systemd user timer on Linux). `--no-schedule`
    to skip the timer. `--seed-from-here` uploads the local `~/brain/`
    as the initial seed (for "I had brain on one machine, now I want
    to attach a fresh hub on my VPS").
- **Session transcripts (JSONL) out of scope, period.** Only mirror
  agent-authored markdown (memory dirs). Raw turn-by-turn transcripts
  aren't memory — they're audit trail — and don't belong in a synced
  knowledge layer. If needed, back them up separately with rsync.

## Reconciles with CONTEXT.md

`CONTEXT.md` pressure-test #2 currently holds the line on
"sync-agnostic, documented recipes only." This plan supersedes that.
Reasoning:

- Yann's own use case (laptop + VPS) is the primary one brain was
  built for (see CONTEXT.md "Who it's for").
- The source primitive *already* assumes a single host. Sync forces
  the question whether sources are mounts or content — and mounts
  can't sync.
- "Documented recipes" doesn't solve the mirror question; that's a
  code change either way.

Action: update `CONTEXT.md` pressure-test #2 once this lands.

## Architecture (recap)

```
┌──── Mac ────────────────────────────────────┐
│  ~/brain/             working copy          │
│    origin = brain@vps:/srv/brain/brain.git  │
└──────────┬──────────────────────────────────┘
           │ SSH push/pull
           ▼
┌──── VPS ────────────────────────────────────┐
│  /srv/brain/brain.git           bare hub    │
│  hooks/post-receive  → checkout into ↓      │
│  /home/brain/brain/   working copy          │
│    origin = /srv/brain/brain.git (local)    │
└─────────────────────────────────────────────┘
```

Sources, post-flip:

```
~/.claude/projects/<slug>/memory/         ← tool writes (untouched)
                  │
                  │ one-way mirror (rsync-style), watcher-driven
                  ▼
~/brain/sources/cc-<host>/<slug>/memory/  ← git-tracked, syncs
```

## Phases

Each phase is independently shippable.

### Phase 1 — `brain init` becomes git-by-default + writes the agent primer

Existing `brain init` already creates the PARA folder. Add:

- Always `git init` and write a `.gitignore` (`.DS_Store`, `.brain/`,
  `.obsidian/workspace*`, `.obsidian/cache/`). `--no-git` opts out.
- Always write `brain.md` (the agent primer — meta-rules for any AI
  agent using the brain). Independent of `--no-git`. Idempotent: an
  existing `brain.md` is preserved untouched.
- Print a one-line @-import snippet for the user to paste into their
  framework's instruction file (CLAUDE.md / AGENTS.md / …). Brain
  never writes to those framework files; the user owns them.

Touches: `src/commands/init.rs`.

Cheapest phase; lands independently of everything else.

### Phase 2 — `brain sync` subcommand

New file: `src/commands/sync.rs`. Wraps:

1. `git add -A` then `git commit -m "autosync(<host>): <ISO timestamp>"`
   if dirty.
2. `git pull --rebase --autostash origin main`.
3. `git push origin main`.

Host tag in commit messages = `hostname -s`. Exits non-zero with a
readable message on rebase failure. No retry logic — let the timer
retry on next interval.

Touches: `src/commands/sync.rs` (new), `src/cli.rs` (route),
`src/commands/mod.rs` (export).

### Phase 3 — `brain hub init`

New subcommand. On the machine being promoted to hub:

1. Create bare repo at `~/brain.git`.
2. Create working copy at `~/brain/` (or use existing one if present
   — same idempotency rules as `brain init`).
3. Configure local-path origin: working copy's `origin = ~/brain.git`.
4. Install `post-receive` hook in the bare:
   `git --git-dir=~/brain.git --work-tree=~/brain checkout -f main`.
5. Print the SSH URL clients should use:
   `<user>@<hostname>:~/brain.git`.

`--empty` flag: skip seeding the working copy with any existing
content (for the "fresh hub, will receive seed from a client"
scenario).

Touches: `src/commands/hub.rs` (new), `src/cli.rs`.

### Phase 4 — `brain join`

New subcommand. On any machine that wants to attach to a hub:

1. `git clone <ssh-url> ~/brain` (or fail if `~/brain` exists with
   conflicting content — refuse to clobber).
2. Configure `user.email` to a host-tagged value (`brain@<hostname>`).
3. Install OS-appropriate sync timer:
   - macOS: launchd plist at `~/Library/LaunchAgents/dev.brain.sync.plist`
     running `brain sync` every 5 min.
   - Linux: systemd user timer + service in
     `~/.config/systemd/user/`.
4. Run one initial `brain sync` to verify the round trip.

Flags:
- `--no-schedule`: skip the timer install.
- `--seed-from-here`: instead of cloning from the hub, push the
  current `~/brain/` to the (empty) hub as the seed, then set up
  tracking. For migrating an existing single-machine brain.

Touches: `src/commands/join.rs` (new), `src/cli.rs`, plus per-OS
scheduler templates under `src/commands/schedulers/`.

### Phase 5 — Source mirror replaces symlinks ✅

`brain source add <name> --from <path>` registers the source in
`<brain>/.brain/sources.json` (host-local, gitignored) and runs an
initial one-way mirror into `sources/<name>/` (real files, synced
across hosts).

`brain source sync [name]` re-runs the mirror manually. `brain serve`'s
watcher does it automatically: it watches each origin path, and on a
debounced relevant-event burst, re-mirrors the affected source(s),
which dirties the index marker.

Symlink support removed entirely. The legacy code paths in
`auto_mount.rs` / `source.rs` are gone. `brain doctor` flags any
leftover symlinks under `sources/` as legacy and tells the user to
remove + re-add.

Mirror semantics:
- Markdown-only (matches the brain's content model). Non-md files in
  the origin are ignored.
- Excluded directories: `.git`, `.brain`, `node_modules`, `target`,
  `dist`, `build`, `vendor`, `.cache`, `.next`, `.svelte-kit`.
- Hidden + temp/swap files filtered at the `is_relevant` boundary.
- Deletion semantics: a file removed from the origin is removed from
  the mirror on the next sync.
- Mtime preserved on copy so re-runs over unchanged content are
  no-ops.

Auto-mount on `brain init` now host-namespaces each discovered source
(`claude-memory-mac`, `gstack-projects-mac`, …) so siblings on other
machines don't collide.

Touches landed in this phase:
- `src/source_config.rs` (new) — JSON registry at `.brain/sources.json`
- `src/source_mirror.rs` (new) — one-way mirror algorithm
- `src/commands/source.rs` — rewritten for add/list/remove/sync
- `src/cli.rs` — new `source sync` subcommand; `--from` flag
- `src/qmd_collection.rs` — `mounted_source_names` reads config
- `src/commands/init.rs` — uses `source::add` for auto-mount
- `src/auto_mount.rs` — exposes `hostname_short()` for namespacing
- `src/commands/doctor.rs` — checks origin + mirror dir + qmd binding
- `src/watcher.rs` — watches source origins, mirrors on change
- `tests/integration.rs`, `tests/v03_lane_d.rs` — updated for new flow

### Phase 6 — MCP write hook ✅

`remember_inner` now spawns a detached `brain sync` child after each
successful deposit. No-ops in three cases (no spawn happens):

- `BRAIN_DISABLE_AUTOSYNC=1` (test escape hatch)
- The brain is not a git repo (`.git/` missing)
- The brain has no `origin` remote (single-machine setup; nothing to push)

The spawn is fire-and-forget: stdout/stderr go to `/dev/null`, no
wait. The MCP response returns immediately. Failures to spawn are
logged via `tracing::warn`; failures inside `brain sync` (rebase
conflicts, network errors) surface only in the next manual sync —
correct behavior, since blocking the MCP response on git is wrong.

End-to-end test verifies the loop:
1. `brain init` + first `brain sync` (initial commit)
2. `brain hub init` (creates bare alongside, seeds it)
3. `remember_inner` writes a new note
4. Within ~10s, the bare repo has an `autosync` commit containing the note

Touches landed:
- `src/autosync.rs` (new) — `try_autosync(brain_home)` helper
- `src/lib.rs` — export autosync module
- `src/remember.rs` — calls `autosync::try_autosync` after dirty-touch
- `tests/v03_lane_c.rs` — end-to-end autosync test


## Out of scope (explicitly)

- 3+ host topologies (works incidentally, not designed for).
- Conflict resolution beyond `--autostash` + `--rebase`. Hard
  conflicts surface as `brain sync` failures and human resolution.
- Real-time sync (Syncthing-style). 2-second floor is enough.
- LFS / large binary files. The brain is markdown.
- Encryption at rest on the VPS beyond SSH-key access. Threat model:
  Yann's own VPS, not multi-tenant.

## Open questions

1. **Hub setup ergonomics — see "Setup flows" below.** What does
   `brain init` look like for single-machine vs multi-machine? What do
   we name the role of the machine that holds the bare repo?
2. **Watcher backpressure.** A burst of edits (e.g. Obsidian sync
   plugin) shouldn't trigger N syncs. Debounce window: 2-5 sec?

## Implementation order

Phases 1 → 4 give a working Mac↔VPS sync of human-authored notes
(scheduler included in Phase 4). Phase 5 brings agent memories in via
the mirror. Phase 6 collapses propagation latency to seconds for
`brain_remember` writes.

Dogfood gate after Phase 4: run `brain hub init` on the Hetzner VPS,
`brain join` from the Mac, confirm a round-trip note edit syncs both
ways within 5 min. If that survives a week, proceed to 5 and 6.

Convert each phase to tracked tasks when starting it; no need to
materialize the task list before then.
