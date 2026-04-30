use anyhow::{Context, Result, anyhow};
use std::path::Path;

use crate::brain::Brain;

pub fn add(brain: &Brain, name: &str, target: &Path, force: bool) -> Result<()> {
    validate_name(name)?;

    let sources = brain.sources_dir();
    if !sources.is_dir() {
        return Err(anyhow!(
            "{} does not exist. Run: brain init",
            sources.display()
        ));
    }

    let canonical_target = target
        .canonicalize()
        .with_context(|| format!("resolving target path {}", target.display()))?;

    let dest = sources.join(name);
    if dest.symlink_metadata().is_ok() {
        if force {
            std::fs::remove_file(&dest)
                .with_context(|| format!("removing existing source at {}", dest.display()))?;
        } else {
            return Err(anyhow!(
                "source {} already exists at {}. Use --force to overwrite.",
                name,
                dest.display()
            ));
        }
    }

    std::os::unix::fs::symlink(&canonical_target, &dest).with_context(|| {
        format!("symlink {} -> {}", dest.display(), canonical_target.display())
    })?;
    println!("Mounted {} -> {}", name, canonical_target.display());
    Ok(())
}

pub fn list(brain: &Brain) -> Result<()> {
    let sources = brain.sources_dir();
    if !sources.is_dir() {
        return Err(anyhow!(
            "{} does not exist. Run: brain init",
            sources.display()
        ));
    }

    let mut entries: Vec<_> = std::fs::read_dir(&sources)?
        .collect::<std::io::Result<_>>()
        .with_context(|| format!("reading {}", sources.display()))?;
    entries.sort_by_key(|e| e.file_name());

    if entries.is_empty() {
        println!("No sources mounted.");
        return Ok(());
    }

    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = match path.symlink_metadata() {
            Ok(m) => m,
            Err(e) => {
                println!("{:30} ! {}", name, e);
                continue;
            }
        };
        if meta.file_type().is_symlink() {
            match std::fs::read_link(&path) {
                Ok(target) => {
                    let marker = if path.exists() { "" } else { " [broken]" };
                    println!("{:30} -> {}{}", name, target.display(), marker);
                }
                Err(e) => println!("{:30} ! {}", name, e),
            }
        } else {
            println!("{:30} (not a symlink)", name);
        }
    }
    Ok(())
}

pub fn remove(brain: &Brain, name: &str) -> Result<()> {
    validate_name(name)?;
    let dest = brain.sources_dir().join(name);
    let meta = dest
        .symlink_metadata()
        .with_context(|| format!("source {} not found at {}", name, dest.display()))?;
    if !meta.file_type().is_symlink() {
        return Err(anyhow!(
            "{} is not a symlink; refusing to remove (sources/ should hold symlinks only)",
            dest.display()
        ));
    }
    std::fs::remove_file(&dest).with_context(|| format!("removing {}", dest.display()))?;
    println!("Unmounted {}", name);
    Ok(())
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(anyhow!("source name must not be empty"));
    }
    if name.contains('/') || name.contains("..") {
        return Err(anyhow!("source name must not contain '/' or '..': {}", name));
    }
    Ok(())
}
