use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use notify::RecursiveMode;
use notify_debouncer_mini::{DebounceEventResult, new_debouncer};
use tokio_util::sync::CancellationToken;

use crate::index_dirty;
use crate::source_config::SourceConfig;
use crate::source_mirror;
use crate::worker::{DrainOutcome, drain_one_pass};

const DEBOUNCE_MS: u64 = 200;
const PARA_BUCKETS: &[&str] = &["projects", "areas", "resources"];
const EXCLUDED_SEGMENTS: &[&str] = &[
    ".brain",
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    ".cache",
    ".next",
    ".svelte-kit",
];

pub fn is_relevant(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if name.starts_with('.') {
        return false;
    }
    if name.ends_with('~') {
        return false;
    }
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false);
    if !ext_ok {
        return false;
    }
    for component in path.components() {
        if let std::path::Component::Normal(seg) = component
            && let Some(seg) = seg.to_str()
            && EXCLUDED_SEGMENTS.contains(&seg)
        {
            return false;
        }
    }
    true
}

/// Returns (paths to watch, source origin → name map).
/// The origin→name map lets event handlers figure out which source a
/// changed file belongs to so it can mirror that source incrementally.
fn collect_watch_targets(brain_home: &Path) -> (Vec<PathBuf>, HashMap<PathBuf, String>) {
    let mut targets = Vec::new();
    let mut origin_to_name: HashMap<PathBuf, String> = HashMap::new();

    for bucket in PARA_BUCKETS {
        let p = brain_home.join(bucket);
        if p.is_dir() {
            targets.push(p);
        }
    }

    let cfg = SourceConfig::load(brain_home).unwrap_or_default();
    for (name, entry) in &cfg.sources {
        if !entry.from.exists() {
            tracing::warn!(
                "watcher: skipping source '{name}' — origin {} missing on this host",
                entry.from.display()
            );
            continue;
        }
        // Canonicalize so prefix matches still work even when the config
        // stores a path that resolves through a symlink (e.g. /var → /private/var
        // on macOS). Fall back to the configured path if canonicalize fails.
        let canonical = entry.from.canonicalize().unwrap_or_else(|_| entry.from.clone());
        targets.push(canonical.clone());
        origin_to_name.insert(canonical, name.clone());
    }

    (targets, origin_to_name)
}

/// Match an event path against registered origin paths. Returns the source
/// name if the event happened under exactly one origin.
fn source_name_for_event(
    event_path: &Path,
    origin_to_name: &HashMap<PathBuf, String>,
) -> Option<String> {
    for (origin, name) in origin_to_name {
        if event_path.starts_with(origin) {
            return Some(name.clone());
        }
    }
    None
}

pub async fn spawn_watcher(
    brain_home: PathBuf,
    cancel: CancellationToken,
) -> Result<tokio::task::JoinHandle<()>> {
    // Initial reconciliation: catch up on changes that landed while serve was down.
    match drain_one_pass(&brain_home).await {
        Ok(DrainOutcome::NothingToDo) => {
            tracing::info!("watcher: initial drain — nothing to do");
        }
        Ok(DrainOutcome::Drained { attempted_at }) => {
            tracing::info!(
                "watcher: initial drain completed (watermark={:?})",
                attempted_at
            );
        }
        Ok(DrainOutcome::Failed { stderr }) => {
            tracing::warn!("watcher: initial drain failed: {stderr}");
        }
        Err(e) => {
            tracing::warn!("watcher: initial drain error: {e:#}");
        }
    }

    let (targets, origin_to_name) = collect_watch_targets(&brain_home);
    tracing::info!(
        "watcher snapshot: {} sources; restart brain serve to pick up new sources",
        origin_to_name.len()
    );

    // Catch-up mirror for any source that drifted while serve was down.
    if let Ok(cfg) = SourceConfig::load(&brain_home) {
        for (name, entry) in &cfg.sources {
            if !entry.from.exists() {
                continue;
            }
            let dest = brain_home.join("sources").join(name);
            match source_mirror::mirror(&entry.from, &dest) {
                Ok(report) => tracing::info!(
                    "watcher: initial mirror of '{name}' — copied={} deleted={} unchanged={}",
                    report.copied,
                    report.deleted,
                    report.unchanged
                ),
                Err(e) => tracing::warn!("watcher: initial mirror of '{name}' failed: {e}"),
            }
        }
    }

    // Tokio bridge: a std mpsc from the debouncer thread, forwarded into a tokio mpsc
    // so we can `tokio::select!` against cancellation.
    let (std_tx, std_rx) = std::sync::mpsc::channel::<DebounceEventResult>();
    let (tokio_tx, mut tokio_rx) = tokio::sync::mpsc::unbounded_channel::<DebounceEventResult>();

    let mut debouncer = new_debouncer(Duration::from_millis(DEBOUNCE_MS), move |res| {
        let _ = std_tx.send(res);
    })
    .context("creating notify debouncer")?;

    for path in &targets {
        if let Err(e) = debouncer.watcher().watch(path, RecursiveMode::Recursive) {
            tracing::warn!(
                "watcher: failed to watch {} ({e}); on Linux this can mean inotify watch limit reached \
                 — raise fs.inotify.max_user_watches (e.g. add fs.inotify.max_user_watches=524288 to \
                 /etc/sysctl.d/99-inotify.conf)",
                path.display()
            );
        } else {
            tracing::info!("watcher: watching {}", path.display());
        }
    }

    // Bridge thread: shuttle events from the std channel to the tokio channel.
    let bridge_cancel = cancel.clone();
    std::thread::spawn(move || {
        while let Ok(evt) = std_rx.recv() {
            if bridge_cancel.is_cancelled() {
                break;
            }
            if tokio_tx.send(evt).is_err() {
                break;
            }
        }
    });

    let handle = tokio::spawn(async move {
        // Keep debouncer alive in this task so its watches are released on shutdown.
        let _debouncer_guard = debouncer;
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    tracing::info!("watcher shutting down");
                    break;
                }
                maybe_evt = tokio_rx.recv() => {
                    let Some(evt) = maybe_evt else {
                        tracing::info!("watcher: event channel closed");
                        break;
                    };
                    match evt {
                        Ok(events) => {
                            // Bucket events: which originate inside source
                            // origins (-> mirror), and which are in-brain
                            // (-> touch dirty marker)?
                            let mut sources_to_resync: std::collections::HashSet<String> = std::collections::HashSet::new();
                            let mut any_brain_relevant = false;
                            for e in &events {
                                // Only react to markdown changes. Editor temp
                                // files (.swp, ~), hidden files, and non-md
                                // content don't move the index forward.
                                if !is_relevant(&e.path) {
                                    continue;
                                }
                                if let Some(name) = source_name_for_event(&e.path, &origin_to_name) {
                                    sources_to_resync.insert(name);
                                } else {
                                    any_brain_relevant = true;
                                }
                            }
                            // Re-mirror each affected source. The mirror
                            // writes inside the brain, which itself dirties
                            // the index.
                            let cfg = SourceConfig::load(&brain_home).unwrap_or_default();
                            for name in &sources_to_resync {
                                let Some(entry) = cfg.sources.get(name) else { continue };
                                let dest = brain_home.join("sources").join(name);
                                match source_mirror::mirror(&entry.from, &dest) {
                                    Ok(report) if report.copied + report.deleted > 0 => {
                                        any_brain_relevant = true;
                                        tracing::info!(
                                            "watcher: re-mirrored '{name}' — copied={} deleted={}",
                                            report.copied,
                                            report.deleted
                                        );
                                    }
                                    Ok(_) => {}
                                    Err(e) => tracing::warn!(
                                        "watcher: mirror of '{name}' failed: {e}"
                                    ),
                                }
                            }
                            if any_brain_relevant
                                && let Err(err) = index_dirty::touch(&brain_home) {
                                    tracing::warn!("watcher: failed to touch dirty marker: {err:#}");
                                }
                        }
                        Err(err) => tracing::warn!("watcher: notify error: {err}"),
                    }
                }
            }
        }
    });

    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn is_relevant_filters_correctly() {
        assert!(is_relevant(&PathBuf::from("/tmp/x/foo.md")));
        assert!(is_relevant(&PathBuf::from("/tmp/x/Foo.MD")));
        assert!(!is_relevant(&PathBuf::from("/tmp/x/foo.txt")));
        assert!(!is_relevant(&PathBuf::from("/tmp/x/.git/foo.md")));
        assert!(!is_relevant(&PathBuf::from("/tmp/x/node_modules/foo.md")));
        assert!(!is_relevant(&PathBuf::from("/tmp/x/target/a/b.md")));
        assert!(!is_relevant(&PathBuf::from("/tmp/x/.brain/index-dirty")));
        assert!(!is_relevant(&PathBuf::from("/tmp/x/.foo.md.swp")));
        assert!(!is_relevant(&PathBuf::from("/tmp/x/foo.md~")));
        assert!(!is_relevant(&PathBuf::from("/tmp/x/.hidden.md")));
        assert!(!is_relevant(&PathBuf::from("/tmp/x/.DS_Store")));
    }
}
