use anyhow::{Context, Result, anyhow};
use std::fs;

use crate::auto_mount;
use crate::brain::Brain;

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
    println!("\nNext: brain doctor");
    Ok(())
}
