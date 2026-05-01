use anyhow::{Context, Result};
use brainmd::index_dirty::{self, LagStatus};

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

    let sources = brain.sources_dir();
    if sources.is_dir() {
        let entries = std::fs::read_dir(&sources)
            .with_context(|| format!("reading {}", sources.display()))?;
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let meta = path.symlink_metadata()?;
            if meta.file_type().is_symlink() {
                let target = std::fs::read_link(&path)?;
                if path.exists() {
                    println!("  ✓ source {} -> {}", name, target.display());
                } else {
                    println!(
                        "  ✗ source {} broken (target {} missing). Fix: brain source remove {}",
                        name,
                        target.display(),
                        name
                    );
                    issues += 1;
                }
            } else {
                println!("  ! {} is not a symlink (sources/ should hold symlinks only)", name);
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
