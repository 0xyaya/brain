use anyhow::{Context, Result, anyhow};
use std::fs;
use std::path::Path;
use std::process::Command;

use crate::auto_mount;
use crate::brain::Brain;
use crate::commands::source;
use brainmd::qmd_collection::{self, BRAIN_COLLECTION, RegisterOutcome, qmd_available};

const GITIGNORE: &str = "\
# Local-only state, never sync
.brain/

# macOS noise
.DS_Store

# Obsidian per-machine state (keep settings, ignore workspace + cache)
.obsidian/workspace*
.obsidian/cache/
";

const BRAIN_PRIMER: &str = "\
# brain

The primer for AI agents using this brain. Lives at the root of the
brain folder; syncs across machines.

This is the user's **cross-machine, cross-agent permanent memory**.
You are one of many agents (Claude Code, openclaw, Codex, …) on one
of multiple machines (laptop, VPS) that read and write here. Treat
it as shared, durable state.

## Tools (via the `brain` MCP)

- `brain_context(project?)` — **call first** when work might depend on
  cross-session context or project history. Returns brain layout,
  mounted sources, and `areas/user.md`. Use what's relevant; don't
  dump the result into the conversation.
- `brain_read(path)` — read any file under the brain.
- `brain_search(query, scope?, mode?)` — semantic + keyword search.
- `brain_remember(category, content, project?)` — append-only deposit
  to `projects/`, `areas/`, or `resources/` on the user's behalf.
- `brain_list_sources()` — enumerate mounted external memory.

## Rules

- **Brain is the user's brain, not yours.** `brain_remember` deposits
  FOR them. Your own self-memory (identity, journal) belongs in your
  tool's own store, never here.
- **Never write to this folder directly** — no `Write`, no `Edit`.
  Use `brain_remember`.
- **Memories sync, but not instantly** (every few minutes). What you
  wrote on one machine may not be on another yet.
- **Verify before relying on memory.** Entries are point-in-time;
  check current state if recency matters.
";

pub fn run(brain: &Brain, force: bool, no_git: bool) -> Result<()> {
    if brain.home.exists() {
        let mut entries = fs::read_dir(&brain.home)
            .with_context(|| format!("reading {}", brain.home.display()))?;
        if entries.next().is_some() && !force {
            return Err(anyhow!(
                "{} is not empty. Pass --force to init in place (no files will be deleted).",
                brain.home.display()
            ));
        }
    } else {
        fs::create_dir_all(&brain.home)
            .with_context(|| format!("creating {}", brain.home.display()))?;
    }

    for path in brain.top_level_paths() {
        fs::create_dir_all(&path)
            .with_context(|| format!("creating {}", path.display()))?;
    }

    println!("Initialized brain at {}", brain.home.display());
    println!("  PARA dirs: projects, areas, resources, archive");
    println!("  Mount dir: sources");

    write_primer(&brain.home);

    if !no_git {
        init_git(&brain.home);
    }

    bootstrap_brain_qmd_collection(brain);

    let candidates = auto_mount::discover();
    let host = auto_mount::hostname_short();
    let mut mounted = 0;
    for mount in &candidates {
        if !mount.target_exists() {
            eprintln!(
                "  auto-mount '{}' skipped: target {} not found",
                mount.name,
                mount.target.display()
            );
            continue;
        }
        // Host-namespace every auto-mounted source so siblings on other
        // machines don't collide on the same name.
        let namespaced = format!("{}-{}", mount.name, host);
        match source::add(brain, &namespaced, &mount.target, false) {
            Ok(()) => mounted += 1,
            Err(e) => eprintln!("  auto-mount '{namespaced}' skipped: {e}"),
        }
    }
    if mounted == 0 {
        println!("  No default sources auto-mounted (none of the known paths were present).");
    } else {
        println!("  Auto-mounted {} source(s).", mounted);
    }

    println!();
    println!("To wire an agent framework into this brain, add ONE line to");
    println!("its instruction file (CLAUDE.md, AGENTS.md, …):");
    println!();
    println!("    @{}/brain.md", brain.home.display());
    println!();
    println!("Where @-imports aren't supported, copy brain.md inline.");
    println!();
    println!("Next: brain doctor");
    Ok(())
}

fn write_primer(home: &Path) {
    let primer = home.join("brain.md");
    if primer.exists() {
        println!("  brain.md already present (kept as-is)");
        return;
    }
    if let Err(e) = fs::write(&primer, BRAIN_PRIMER) {
        eprintln!("  ! could not write brain.md: {e}");
        return;
    }
    println!("  Wrote brain.md (agent primer)");
}

fn init_git(home: &Path) {
    let gitignore = home.join(".gitignore");
    if !gitignore.exists() {
        if let Err(e) = fs::write(&gitignore, GITIGNORE) {
            eprintln!("  ! could not write .gitignore: {e}");
            return;
        }
        println!("  Wrote .gitignore");
    } else {
        println!("  .gitignore already present (kept as-is)");
    }

    if home.join(".git").exists() {
        println!("  Git repo already present (skipped git init)");
        return;
    }

    let status = Command::new("git")
        .args(["init", "--initial-branch=main", "--quiet"])
        .arg(home)
        .status();
    match status {
        Ok(s) if s.success() => println!("  Initialized git repo (branch: main)"),
        Ok(s) => eprintln!("  ! git init exited with status {s}"),
        Err(e) => eprintln!(
            "  ! git init skipped: {e}. Install git or rerun with --no-git to silence."
        ),
    }
}

fn bootstrap_brain_qmd_collection(brain: &Brain) {
    if !qmd_available() {
        println!(
            "  i qmd not found. For semantic search, install with: npm install -g @tobilu/qmd"
        );
        return;
    }
    register_collection(&brain.home, BRAIN_COLLECTION);
    // Per-source qmd registration happens inside `source::add`, so it's
    // covered by both manual `brain source add` and auto-mount.
}

/// Register one collection. Returns true on Created (new index work pending).
fn register_collection(target: &Path, name: &str) -> bool {
    match qmd_collection::register(target, name) {
        Ok(RegisterOutcome::Created) => {
            println!("  ✓ Registered qmd collection '{name}' over {}", target.display());
            true
        }
        Ok(RegisterOutcome::AlreadyMatches) => {
            println!("  ✓ qmd collection '{name}' already registered");
            false
        }
        Ok(RegisterOutcome::Conflict { existing }) => {
            eprintln!(
                "  ! qmd collection '{name}' is registered to {} — pointing it at {} would conflict.",
                existing.display(),
                target.display()
            );
            eprintln!(
                "    Run `qmd collection remove {name}` first to let this brain own that name."
            );
            false
        }
        Err(e) => {
            eprintln!("  ! qmd collection add for '{name}' failed: {e}");
            false
        }
    }
}
