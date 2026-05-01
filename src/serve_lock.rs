use std::fs::{File, OpenOptions};
use std::path::Path;

use anyhow::{Context, Result};
use fs2::FileExt;

pub struct ServeLock {
    _file: File,
}

impl ServeLock {
    pub fn try_acquire(brain_home: &Path) -> Result<Option<Self>> {
        let dir = brain_home.join(".brain");
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("creating {}", dir.display()))?;
        let lock_path = dir.join("serve.lock");
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .with_context(|| format!("opening {}", lock_path.display()))?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Some(Self { _file: file })),
            Err(e) => {
                if e.kind() != std::io::ErrorKind::WouldBlock {
                    tracing::debug!("serve.lock acquisition error: {e}");
                }
                Ok(None)
            }
        }
    }
}
