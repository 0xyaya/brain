use std::path::{Path, PathBuf};
use std::process::Command;

pub const BRAIN_COLLECTION: &str = "brain";

#[derive(Debug)]
pub enum RegisterOutcome {
    Created,
    AlreadyMatches,
    Conflict { existing: PathBuf },
}

pub fn qmd_available() -> bool {
    which::which("qmd").is_ok()
}

pub fn collection_path(name: &str) -> Option<PathBuf> {
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
            return Some(PathBuf::from(rest.trim()));
        }
    }
    None
}

pub fn register(target: &Path, name: &str) -> anyhow::Result<RegisterOutcome> {
    let target_canonical = target.canonicalize().unwrap_or_else(|_| target.to_path_buf());
    if let Some(existing) = collection_path(name) {
        let existing_canonical = existing.canonicalize().unwrap_or_else(|_| existing.clone());
        return Ok(if existing_canonical == target_canonical {
            RegisterOutcome::AlreadyMatches
        } else {
            RegisterOutcome::Conflict { existing }
        });
    }
    let status = Command::new("qmd")
        .args(["collection", "add"])
        .arg(target)
        .args(["--name", name])
        .status()?;
    if !status.success() {
        anyhow::bail!("qmd collection add exited with {status}");
    }
    Ok(RegisterOutcome::Created)
}

pub fn unregister(name: &str) -> anyhow::Result<bool> {
    if collection_path(name).is_none() {
        return Ok(false);
    }
    let status = Command::new("qmd")
        .args(["collection", "remove", name])
        .status()?;
    if !status.success() {
        anyhow::bail!("qmd collection remove exited with {status}");
    }
    Ok(true)
}

/// List the source names registered for this brain, for query scoping.
/// Sources are tracked in `<brain_home>/.brain/sources.json` — see
/// [`crate::source_config`].
pub fn mounted_source_names(brain_home: &Path) -> Vec<String> {
    let cfg = crate::source_config::SourceConfig::load(brain_home).unwrap_or_default();
    let mut names: Vec<String> = cfg.sources.keys().cloned().collect();
    names.sort();
    names
}
