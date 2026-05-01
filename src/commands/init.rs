use anyhow::{Context, Result, anyhow};
use std::fs;
use std::path::Path;

use crate::auto_mount;
use crate::brain::Brain;
use brainmd::qmd_collection::{
    self, BRAIN_COLLECTION, RegisterOutcome, mounted_source_names, qmd_available,
};

pub fn run(brain: &Brain, force: bool) -> Result<()> {
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

    let candidates = auto_mount::discover();
    let sources_dir = brain.sources_dir();
    let mut mounted = 0;
    for mount in &candidates {
        if !mount.target_exists() {
            eprintln!(
                "  auto-mount {} skipped: target {} not found",
                mount.name,
                mount.target.display()
            );
            continue;
        }
        let dest = sources_dir.join(mount.name);
        if dest.symlink_metadata().is_ok() {
            eprintln!("  auto-mount {} skipped: {} already exists", mount.name, dest.display());
            continue;
        }
        std::os::unix::fs::symlink(&mount.target, &dest)
            .with_context(|| format!("symlink {} -> {}", dest.display(), mount.target.display()))?;
        println!("  Mounted {} -> {}", mount.name, mount.target.display());
        mounted += 1;
    }

    if mounted == 0 {
        println!("  No default sources auto-mounted (none of the known paths were present).");
    } else {
        println!("  Auto-mounted {} source(s).", mounted);
    }

    bootstrap_qmd_collection(brain);

    println!("\nNext: brain doctor");
    Ok(())
}

fn bootstrap_qmd_collection(brain: &Brain) {
    if !qmd_available() {
        println!(
            "  i qmd not found. For semantic search, install with: npm install -g @tobilu/qmd"
        );
        return;
    }
    register_collection(&brain.home, BRAIN_COLLECTION);
    let mut registered_sources = 0;
    for name in mounted_source_names(&brain.sources_dir()) {
        let dest = brain.sources_dir().join(&name);
        let target = match std::fs::read_link(&dest) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !target.exists() {
            eprintln!("  ! source '{name}' is broken; skipping qmd registration");
            continue;
        }
        if register_collection(&target, &name) {
            registered_sources += 1;
        }
    }
    if registered_sources > 0 {
        eprintln!(
            "  i Run `qmd embed` once to generate vector embeddings for {registered_sources} new source(s)."
        );
    }
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
