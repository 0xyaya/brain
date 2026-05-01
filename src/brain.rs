use anyhow::{Context, Result};
use std::path::PathBuf;

pub const TOP_LEVEL_DIRS: &[&str] = &["projects", "areas", "resources", "archive", "sources"];

pub struct Brain {
    pub home: PathBuf,
}

impl Brain {
    pub fn resolve() -> Result<Self> {
        let home = if let Some(env_home) = std::env::var_os("BRAIN_HOME") {
            PathBuf::from(env_home)
        } else {
            let user_home = std::env::var_os("HOME")
                .context("could not determine $HOME; set $BRAIN_HOME explicitly")?;
            PathBuf::from(user_home).join("brain")
        };
        Ok(Self { home })
    }

    pub fn sources_dir(&self) -> PathBuf {
        self.home.join("sources")
    }

    pub fn top_level_paths(&self) -> Vec<PathBuf> {
        TOP_LEVEL_DIRS.iter().map(|d| self.home.join(d)).collect()
    }
}
