use anyhow::{Context, Result, anyhow};
use std::fs;
use std::process::Command;

use crate::auto_mount;
use crate::brain::Brain;

const QMD_COLLECTION_NAME: &str = "brain";

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
    if which::which("qmd").is_err() {
        println!(
            "  i qmd not found. For semantic search, install with: npm install -g @tobilu/qmd"
        );
        return;
    }
    let target = brain.home.canonicalize().unwrap_or_else(|_| brain.home.clone());
    match qmd_collection_path(QMD_COLLECTION_NAME) {
        Some(p) if p.canonicalize().unwrap_or(p.clone()) == target => {
            println!(
                "  ✓ qmd collection '{QMD_COLLECTION_NAME}' already registered to {}",
                brain.home.display()
            );
            return;
        }
        Some(p) => {
            eprintln!(
                "  ! qmd collection '{QMD_COLLECTION_NAME}' is registered to {} — pointing it at {} would conflict.",
                p.display(),
                brain.home.display()
            );
            eprintln!(
                "    Run `qmd collection remove {QMD_COLLECTION_NAME}` first if you want this brain to own that name."
            );
            return;
        }
        None => {}
    }
    let status = Command::new("qmd")
        .args(["collection", "add"])
        .arg(&brain.home)
        .args(["--name", QMD_COLLECTION_NAME])
        .status();
    match status {
        Ok(s) if s.success() => {
            println!(
                "  ✓ Registered qmd collection '{QMD_COLLECTION_NAME}' over {}",
                brain.home.display()
            );
            eprintln!(
                "  i Run `qmd embed` once to generate vector embeddings (~30s + model download)."
            );
        }
        Ok(s) => eprintln!("  ! qmd collection add exited with {s} — register manually if needed"),
        Err(e) => eprintln!("  ! qmd collection add failed: {e}"),
    }
}

fn qmd_collection_path(name: &str) -> Option<std::path::PathBuf> {
    let output = Command::new("qmd")
        .args(["collection", "show", name])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(rest) = line.trim().strip_prefix("Path:") {
            return Some(std::path::PathBuf::from(rest.trim()));
        }
    }
    None
}
