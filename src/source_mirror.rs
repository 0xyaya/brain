//! One-way mirror from a host-local origin path into a `sources/<name>/`
//! subtree of the brain. Skips host-noise dirs (`.git`, `node_modules`, …).
//! Preserves mtime so re-runs are mostly no-ops.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use filetime::{FileTime, set_file_mtime};
use walkdir::WalkDir;

use crate::watcher::is_relevant;

const EXCLUDED_SEGMENTS: &[&str] = &[
    ".git",
    ".brain",
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    ".cache",
    ".next",
    ".svelte-kit",
    ".DS_Store",
];

#[derive(Debug, Default)]
pub struct MirrorReport {
    pub copied: usize,
    pub deleted: usize,
    pub unchanged: usize,
}

/// Reflect `origin` into `dest`. Creates `dest` if missing. Returns counts.
pub fn mirror(origin: &Path, dest: &Path) -> Result<MirrorReport> {
    if !origin.exists() {
        bail!("origin {} does not exist", origin.display());
    }
    if !origin.is_dir() {
        bail!("origin {} is not a directory", origin.display());
    }
    fs::create_dir_all(dest)
        .with_context(|| format!("creating {}", dest.display()))?;

    let mut report = MirrorReport::default();
    let mut origin_files: HashSet<PathBuf> = HashSet::new();

    for entry in WalkDir::new(origin).follow_links(false) {
        let entry = entry.with_context(|| format!("walking {}", origin.display()))?;
        let rel = match entry.path().strip_prefix(origin) {
            Ok(r) if r.as_os_str().is_empty() => continue,
            Ok(r) => r,
            Err(_) => continue,
        };
        if has_excluded_segment(rel) {
            continue;
        }
        let dest_path = dest.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&dest_path)
                .with_context(|| format!("creating {}", dest_path.display()))?;
            continue;
        }
        if entry.file_type().is_file() {
            // Mirror is markdown-only, matching the brain's content model.
            // Hidden/temp/binary files in the origin are silently ignored.
            if !is_relevant(rel) {
                continue;
            }
            origin_files.insert(rel.to_path_buf());
            if needs_copy(entry.path(), &dest_path)? {
                if let Some(parent) = dest_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(entry.path(), &dest_path).with_context(|| {
                    format!("copying {} -> {}", entry.path().display(), dest_path.display())
                })?;
                if let Ok(meta) = entry.path().metadata()
                    && let Ok(mt) = meta.modified()
                {
                    let _ = set_file_mtime(&dest_path, FileTime::from_system_time(mt));
                }
                report.copied += 1;
            } else {
                report.unchanged += 1;
            }
        }
        // Symlinks inside the origin are skipped — we don't try to follow
        // arbitrary symlink graphs into someone else's filesystem.
    }

    // Second pass: delete files in dest that aren't in origin anymore.
    for entry in WalkDir::new(dest).follow_links(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = match entry.path().strip_prefix(dest) {
            Ok(r) => r,
            Err(_) => continue,
        };
        // Only manage relevant (markdown) files. Non-md files in the mirror
        // dir aren't tracked, so leave them alone — could be user-added.
        if !is_relevant(rel) {
            continue;
        }
        if !origin_files.contains(rel) {
            if let Err(e) = fs::remove_file(entry.path()) {
                tracing::warn!("mirror: failed to delete stale {}: {e}", entry.path().display());
            } else {
                report.deleted += 1;
            }
        }
    }

    // Clean up empty directories in dest. (Best-effort; ignore errors.)
    prune_empty_dirs(dest);

    Ok(report)
}

fn has_excluded_segment(rel: &Path) -> bool {
    for component in rel.components() {
        if let std::path::Component::Normal(seg) = component
            && let Some(seg) = seg.to_str()
            && EXCLUDED_SEGMENTS.contains(&seg)
        {
            return true;
        }
    }
    false
}

fn needs_copy(src: &Path, dst: &Path) -> Result<bool> {
    let dst_meta = match dst.metadata() {
        Ok(m) => m,
        Err(_) => return Ok(true),
    };
    let src_meta = src.metadata().with_context(|| format!("stat {}", src.display()))?;
    if src_meta.len() != dst_meta.len() {
        return Ok(true);
    }
    match (src_meta.modified().ok(), dst_meta.modified().ok()) {
        (Some(s), Some(d)) => Ok(s > d),
        _ => Ok(true),
    }
}

fn prune_empty_dirs(root: &Path) {
    // Walk depth-first, removing dirs whose only contents we've already removed.
    let entries: Vec<_> = WalkDir::new(root)
        .follow_links(false)
        .contents_first(true)
        .into_iter()
        .filter_map(|e| e.ok())
        .collect();
    for entry in entries {
        if entry.path() == root {
            continue;
        }
        if entry.file_type().is_dir() {
            let _ = fs::remove_dir(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn mirror_copies_files_to_dest() {
        let tmp = TempDir::new().unwrap();
        let origin = tmp.path().join("origin");
        let dest = tmp.path().join("dest");
        fs::create_dir_all(origin.join("sub")).unwrap();
        fs::write(origin.join("a.md"), "hello").unwrap();
        fs::write(origin.join("sub/b.md"), "world").unwrap();

        let report = mirror(&origin, &dest).unwrap();
        assert_eq!(report.copied, 2);
        assert!(dest.join("a.md").exists());
        assert!(dest.join("sub/b.md").exists());
        assert_eq!(fs::read_to_string(dest.join("a.md")).unwrap(), "hello");
    }

    #[test]
    fn mirror_is_idempotent_when_origin_unchanged() {
        let tmp = TempDir::new().unwrap();
        let origin = tmp.path().join("origin");
        let dest = tmp.path().join("dest");
        fs::create_dir_all(&origin).unwrap();
        fs::write(origin.join("a.md"), "hello").unwrap();

        let _ = mirror(&origin, &dest).unwrap();
        let r2 = mirror(&origin, &dest).unwrap();
        assert_eq!(r2.copied, 0);
        assert_eq!(r2.unchanged, 1);
    }

    #[test]
    fn mirror_deletes_files_no_longer_in_origin() {
        let tmp = TempDir::new().unwrap();
        let origin = tmp.path().join("origin");
        let dest = tmp.path().join("dest");
        fs::create_dir_all(&origin).unwrap();
        fs::write(origin.join("keep.md"), "keep").unwrap();
        fs::write(origin.join("remove-me.md"), "gone").unwrap();
        mirror(&origin, &dest).unwrap();
        assert!(dest.join("remove-me.md").exists());

        fs::remove_file(origin.join("remove-me.md")).unwrap();
        let r = mirror(&origin, &dest).unwrap();
        assert_eq!(r.deleted, 1);
        assert!(!dest.join("remove-me.md").exists());
        assert!(dest.join("keep.md").exists());
    }

    #[test]
    fn mirror_skips_excluded_directories() {
        let tmp = TempDir::new().unwrap();
        let origin = tmp.path().join("origin");
        let dest = tmp.path().join("dest");
        fs::create_dir_all(origin.join(".git")).unwrap();
        fs::create_dir_all(origin.join("node_modules")).unwrap();
        fs::write(origin.join(".git/HEAD"), "ref: ...").unwrap();
        fs::write(origin.join("node_modules/foo.js"), "noise").unwrap();
        fs::write(origin.join("note.md"), "keep").unwrap();

        let r = mirror(&origin, &dest).unwrap();
        assert_eq!(r.copied, 1);
        assert!(dest.join("note.md").exists());
        assert!(!dest.join(".git").exists());
        assert!(!dest.join("node_modules").exists());
    }

    #[test]
    fn mirror_errors_when_origin_missing() {
        let tmp = TempDir::new().unwrap();
        let r = mirror(&tmp.path().join("nope"), &tmp.path().join("dest"));
        assert!(r.is_err());
    }
}
