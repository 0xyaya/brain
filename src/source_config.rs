//! Host-local registry of mirrored sources.
//!
//! Lives at `<brain_home>/.brain/sources.json`. Not synced (the `.brain/` dir
//! is in `.gitignore`) because origin paths are per-host. The *content* of
//! each mirror dir (`sources/<name>/`) does sync; only the mapping from
//! mirror name → origin path stays local.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const CURRENT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceConfig {
    pub version: u32,
    #[serde(default)]
    pub sources: BTreeMap<String, SourceEntry>,
}

impl Default for SourceConfig {
    fn default() -> Self {
        Self { version: CURRENT_VERSION, sources: BTreeMap::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceEntry {
    /// Absolute path on this host where the source content lives.
    pub from: PathBuf,
}

impl SourceConfig {
    pub fn path(brain_home: &Path) -> PathBuf {
        brain_home.join(".brain").join("sources.json")
    }

    pub fn load(brain_home: &Path) -> Result<Self> {
        let p = Self::path(brain_home);
        if !p.exists() {
            return Ok(Self::default());
        }
        let data = fs::read_to_string(&p)
            .with_context(|| format!("reading {}", p.display()))?;
        let cfg: SourceConfig = serde_json::from_str(&data)
            .with_context(|| format!("parsing {}", p.display()))?;
        Ok(cfg)
    }

    pub fn save(&self, brain_home: &Path) -> Result<()> {
        let p = Self::path(brain_home);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let data = serde_json::to_string_pretty(self)?;
        // Atomic-ish write so a crash mid-save can't truncate the registry.
        let tmp = p.with_extension("json.tmp");
        fs::write(&tmp, data).with_context(|| format!("writing {}", tmp.display()))?;
        fs::rename(&tmp, &p).with_context(|| format!("renaming to {}", p.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn load_returns_default_when_missing() {
        let tmp = TempDir::new().unwrap();
        let cfg = SourceConfig::load(tmp.path()).unwrap();
        assert!(cfg.sources.is_empty());
        assert_eq!(cfg.version, CURRENT_VERSION);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let tmp = TempDir::new().unwrap();
        let mut cfg = SourceConfig::default();
        cfg.sources.insert(
            "cc-mac".to_string(),
            SourceEntry { from: PathBuf::from("/tmp/origin") },
        );
        cfg.save(tmp.path()).unwrap();

        let reloaded = SourceConfig::load(tmp.path()).unwrap();
        assert_eq!(reloaded.sources.len(), 1);
        assert_eq!(reloaded.sources["cc-mac"].from, PathBuf::from("/tmp/origin"));
    }
}
