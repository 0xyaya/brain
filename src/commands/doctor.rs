use anyhow::Result;
use brainmd::index_dirty::{self, LagStatus};
use brainmd::qmd_collection::{self, BRAIN_COLLECTION};
use brainmd::source_config::SourceConfig;

use crate::brain::{Brain, TOP_LEVEL_DIRS};

pub fn run(brain: &Brain) -> Result<()> {
    let mut issues = 0u32;

    println!("Checking brain at {}", brain.home.display());

    if !brain.home.exists() {
        println!("  ✗ brain home does not exist. Run: brain init");
        return Ok(());
    }

    for dir in TOP_LEVEL_DIRS {
        let p = brain.home.join(dir);
        if p.is_dir() {
            println!("  ✓ {} exists", dir);
        } else {
            println!("  ✗ {} missing. Recreate with: mkdir -p {}", dir, p.display());
            issues += 1;
        }
    }

    let cfg = SourceConfig::load(&brain.home).unwrap_or_default();
    let sources_dir = brain.sources_dir();
    for (name, entry) in &cfg.sources {
        let dest = sources_dir.join(name);
        let origin_ok = entry.from.exists();
        let mirror_ok = dest.is_dir();
        match (origin_ok, mirror_ok) {
            (true, true) => println!("  ✓ source {name} <- {}", entry.from.display()),
            (false, true) => {
                println!(
                    "  ! source {name}: origin {} missing on this host (mirror dir still readable)",
                    entry.from.display()
                );
            }
            (true, false) => {
                println!(
                    "  ! source {name}: mirror dir absent (run: brain source sync {name})"
                );
                issues += 1;
            }
            (false, false) => {
                println!(
                    "  ✗ source {name}: origin {} missing AND no mirror dir. Remove: brain source remove {name}",
                    entry.from.display()
                );
                issues += 1;
            }
        }
    }

    // Flag pre-mirror legacy entries under sources/ (e.g. symlinks from
    // the old design) that aren't in the config. They're orphaned.
    if sources_dir.is_dir()
        && let Ok(entries) = std::fs::read_dir(&sources_dir)
    {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if cfg.sources.contains_key(&name) {
                continue;
            }
            let path = entry.path();
            let meta = match path.symlink_metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                println!(
                    "  ! sources/{name} is a legacy symlink. Remove with: rm {} (then re-add via `brain source add {name} --from <path>`)",
                    path.display()
                );
                issues += 1;
            } else {
                println!("  ! sources/{name} is unregistered (not in sources.json)");
                issues += 1;
            }
        }
    }

    // TODO(v0.3.1): pin a minimum qmd version once the binary stabilizes.
    if has_command("qmd") {
        match std::process::Command::new("qmd").arg("--version").output() {
            Ok(out) if out.status.success() => {
                let line = String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if line.is_empty() {
                    println!("  ✓ qmd on PATH (version unknown)");
                } else {
                    println!("  ✓ qmd {line} on PATH");
                }
            }
            _ => println!("  ✓ qmd on PATH (version probe failed)"),
        }

        issues += check_qmd_collections(brain);
    } else {
        println!("  i qmd not found. For semantic search in v0.3: see https://github.com/tobi/qmd");
    }

    let marker = index_dirty::marker_mtime(&brain.home).ok().flatten();
    let watermark = index_dirty::read_last_indexed(&brain.home).ok().flatten();
    match index_dirty::classify_lag(marker, watermark) {
        LagStatus::UpToDate => println!("  ✓ index up-to-date"),
        LagStatus::Ok(s) => println!("  ✓ index lag: {s}s"),
        LagStatus::Warn(s) => {
            println!("  ! index lag: {s}s (run brain index --sync to flush)");
            issues += 1;
        }
        LagStatus::Bad(s) => {
            println!("  ✗ index lag: {s}s — brain serve appears stuck");
            issues += 1;
        }
    }

    if issues == 0 {
        println!("\nAll checks passed.");
    } else {
        println!("\n{} issue(s) found.", issues);
    }
    Ok(())
}

fn check_qmd_collections(brain: &Brain) -> u32 {
    let mut issues = 0u32;
    let brain_canonical = brain.home.canonicalize().unwrap_or_else(|_| brain.home.clone());
    match qmd_collection::collection_path(BRAIN_COLLECTION) {
        Some(p) if p.canonicalize().unwrap_or(p.clone()) == brain_canonical => {
            println!("  ✓ qmd collection 'brain' → {}", brain.home.display());
        }
        Some(p) => {
            println!(
                "  ! qmd collection 'brain' is registered to {} (this brain is at {})",
                p.display(),
                brain.home.display()
            );
            issues += 1;
        }
        None => {
            println!("  ! qmd collection 'brain' not registered. Fix: brain init --force");
            issues += 1;
        }
    }
    for name in qmd_collection::mounted_source_names(&brain.home) {
        let dest = brain.sources_dir().join(&name);
        let dest_canonical = dest.canonicalize().unwrap_or_else(|_| dest.clone());
        match qmd_collection::collection_path(&name) {
            Some(p) if p.canonicalize().unwrap_or(p.clone()) == dest_canonical => {
                println!("  ✓ qmd collection '{name}' → {}", dest.display());
            }
            Some(p) => {
                println!(
                    "  ! qmd collection '{name}' is registered to {} (brain mirror is at {})",
                    p.display(),
                    dest.display()
                );
                issues += 1;
            }
            None => {
                println!(
                    "  ! qmd collection '{name}' not registered. Fix: brain source sync {name}"
                );
                issues += 1;
            }
        }
    }
    issues
}

fn has_command(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return true;
        }
    }
    false
}
