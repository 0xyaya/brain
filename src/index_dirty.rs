use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{Context, Result};
use filetime::{FileTime, set_file_mtime};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

fn brain_dir(brain_home: &Path) -> PathBuf {
    brain_home.join(".brain")
}

fn marker_path(brain_home: &Path) -> PathBuf {
    brain_dir(brain_home).join("index-dirty")
}

fn last_indexed_path(brain_home: &Path) -> PathBuf {
    brain_dir(brain_home).join("last-indexed")
}

pub fn touch(brain_home: &Path) -> Result<()> {
    let dir = brain_dir(brain_home);
    fs::create_dir_all(&dir)
        .with_context(|| format!("creating {}", dir.display()))?;
    let path = marker_path(brain_home);
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    set_file_mtime(&path, FileTime::now())
        .with_context(|| format!("setting mtime on {}", path.display()))?;
    Ok(())
}

pub fn marker_mtime(brain_home: &Path) -> Result<Option<SystemTime>> {
    let path = marker_path(brain_home);
    match fs::metadata(&path) {
        Ok(meta) => Ok(Some(meta.modified()?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("stat {}", path.display())),
    }
}

pub fn read_last_indexed(brain_home: &Path) -> Result<Option<SystemTime>> {
    let path = last_indexed_path(brain_home);
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    match OffsetDateTime::parse(raw.trim(), &Rfc3339) {
        Ok(dt) => Ok(Some(dt.into())),
        Err(e) => {
            tracing::warn!(
                "could not parse {} ({e}); treating as missing",
                path.display()
            );
            Ok(None)
        }
    }
}

pub fn write_last_indexed(brain_home: &Path, ts: SystemTime) -> Result<()> {
    let dir = brain_dir(brain_home);
    fs::create_dir_all(&dir)
        .with_context(|| format!("creating {}", dir.display()))?;
    let dt: OffsetDateTime = ts.into();
    let formatted = dt
        .format(&Rfc3339)
        .context("formatting RFC3339 timestamp")?;
    let final_path = last_indexed_path(brain_home);
    let tmp_path = dir.join(".last-indexed.tmp");
    fs::write(&tmp_path, formatted)
        .with_context(|| format!("writing {}", tmp_path.display()))?;
    fs::rename(&tmp_path, &final_path).with_context(|| {
        format!(
            "renaming {} -> {}",
            tmp_path.display(),
            final_path.display()
        )
    })?;
    Ok(())
}

pub fn is_dirty(brain_home: &Path) -> Result<bool> {
    let Some(marker) = marker_mtime(brain_home)? else {
        return Ok(false);
    };
    let watermark = read_last_indexed(brain_home)?.unwrap_or(SystemTime::UNIX_EPOCH);
    Ok(marker > watermark)
}
