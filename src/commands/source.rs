use anyhow::{Context, Result, anyhow};
use std::path::Path;

use crate::brain::Brain;
use brainmd::qmd_collection::{self, RegisterOutcome, qmd_available};
use brainmd::source_config::{SourceConfig, SourceEntry};
use brainmd::source_mirror;

pub fn add(brain: &Brain, name: &str, from: &Path, force: bool) -> Result<()> {
    validate_name(name)?;

    let sources_dir = brain.sources_dir();
    if !sources_dir.is_dir() {
        return Err(anyhow!("{} does not exist. Run: brain init", sources_dir.display()));
    }

    let from_canonical = from
        .canonicalize()
        .with_context(|| format!("resolving {}", from.display()))?;
    if !from_canonical.is_dir() {
        return Err(anyhow!("origin {} must be a directory", from_canonical.display()));
    }

    let mut cfg = SourceConfig::load(&brain.home)?;
    if cfg.sources.contains_key(name) && !force {
        return Err(anyhow!(
            "source '{name}' is already registered (from {}). Use --force to re-register.",
            cfg.sources[name].from.display()
        ));
    }
    cfg.sources.insert(
        name.to_string(),
        SourceEntry { from: from_canonical.clone() },
    );
    cfg.save(&brain.home)?;

    let dest = sources_dir.join(name);
    let report = source_mirror::mirror(&from_canonical, &dest)
        .with_context(|| format!("initial mirror for source '{name}'"))?;
    println!(
        "Mounted {name} <- {}\n  Initial mirror: {} copied, {} unchanged",
        from_canonical.display(),
        report.copied,
        report.unchanged
    );

    if qmd_available() {
        // qmd indexes the mirror dir under the brain, not the origin: that's
        // what `brain_read("sources/<name>/...")` and search must agree on.
        match qmd_collection::register(&dest, name) {
            Ok(RegisterOutcome::Created) => {
                println!("  ✓ Registered qmd collection '{name}' over {}", dest.display());
                println!("  i Run `qmd embed` to generate vector embeddings for the new source.");
            }
            Ok(RegisterOutcome::AlreadyMatches) => {
                println!("  ✓ qmd collection '{name}' already registered");
            }
            Ok(RegisterOutcome::Conflict { existing }) => {
                eprintln!(
                    "  ! qmd collection '{name}' is registered to {} — pointing it at {} would conflict.",
                    existing.display(),
                    dest.display()
                );
                eprintln!("    Run `qmd collection remove {name}` first to let this brain own that name.");
            }
            Err(e) => eprintln!("  ! qmd collection add for '{name}' failed: {e}"),
        }
    }
    Ok(())
}

pub fn list(brain: &Brain) -> Result<()> {
    let cfg = SourceConfig::load(&brain.home)?;
    if cfg.sources.is_empty() {
        println!("No sources mounted.");
        return Ok(());
    }
    for (name, entry) in &cfg.sources {
        let origin_status = if entry.from.exists() { "ok" } else { "MISSING" };
        let dest = brain.sources_dir().join(name);
        let dest_marker = if dest.is_dir() { "" } else { " (mirror not initialized)" };
        println!(
            "{name:30} <- {} [{origin_status}]{dest_marker}",
            entry.from.display()
        );
    }
    Ok(())
}

pub fn remove(brain: &Brain, name: &str) -> Result<()> {
    validate_name(name)?;
    let mut cfg = SourceConfig::load(&brain.home)?;
    if cfg.sources.remove(name).is_none() {
        return Err(anyhow!(
            "source '{name}' is not registered. Run `brain source list` to see what's mounted."
        ));
    }
    cfg.save(&brain.home)?;

    let dest = brain.sources_dir().join(name);
    if dest.is_dir() {
        std::fs::remove_dir_all(&dest)
            .with_context(|| format!("removing mirror dir {}", dest.display()))?;
    }
    println!("Unmounted {name}");

    if qmd_available() {
        match qmd_collection::unregister(name) {
            Ok(true) => println!("  ✓ Removed qmd collection '{name}'"),
            Ok(false) => {}
            Err(e) => eprintln!("  ! qmd collection remove for '{name}' failed: {e}"),
        }
    }
    Ok(())
}

pub fn sync(brain: &Brain, only: Option<&str>) -> Result<()> {
    let cfg = SourceConfig::load(&brain.home)?;
    if cfg.sources.is_empty() {
        println!("No sources mounted.");
        return Ok(());
    }
    let names: Vec<String> = match only {
        Some(n) => {
            if !cfg.sources.contains_key(n) {
                return Err(anyhow!("source '{n}' is not registered."));
            }
            vec![n.to_string()]
        }
        None => cfg.sources.keys().cloned().collect(),
    };
    for name in names {
        let entry = &cfg.sources[&name];
        let dest = brain.sources_dir().join(&name);
        if !entry.from.exists() {
            eprintln!(
                "  ! {name}: origin {} missing on this host; skipping.",
                entry.from.display()
            );
            continue;
        }
        let report = source_mirror::mirror(&entry.from, &dest)
            .with_context(|| format!("mirroring source '{name}'"))?;
        println!(
            "  {name}: {} copied, {} deleted, {} unchanged",
            report.copied, report.deleted, report.unchanged
        );
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(anyhow!("source name must not be empty"));
    }
    if name.contains('/') || name.contains("..") {
        return Err(anyhow!("source name must not contain '/' or '..': {name}"));
    }
    Ok(())
}
