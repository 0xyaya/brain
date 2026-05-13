// Lane D tests — file-watcher closes the freshness gap for external edits
// (vim, git pull, rm) under the brain home + mounted source targets.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use brainmd::index_dirty;
use brainmd::source_config::{SourceConfig, SourceEntry};
use brainmd::watcher::{is_relevant, spawn_watcher};

use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

#[test]
fn is_relevant_filters_correctly() {
    assert!(is_relevant(&PathBuf::from("/tmp/x/foo.md")));
    assert!(is_relevant(&PathBuf::from("/tmp/x/Foo.MD")));
    assert!(!is_relevant(&PathBuf::from("/tmp/x/foo.txt")));
    assert!(!is_relevant(&PathBuf::from("/tmp/x/.git/foo.md")));
    assert!(!is_relevant(&PathBuf::from("/tmp/x/node_modules/foo.md")));
    assert!(!is_relevant(&PathBuf::from("/tmp/x/foo.md.swp")));
    assert!(!is_relevant(&PathBuf::from("/tmp/x/foo.md~")));
    assert!(!is_relevant(&PathBuf::from("/tmp/x/.hidden.md")));
}

fn fresh_brain_with_source() -> (TempDir, PathBuf, PathBuf) {
    let tmp = TempDir::new().expect("tempdir");
    let home = tmp.path().to_path_buf();

    // PARA buckets so collect_watch_targets has a base.
    for d in &["projects", "areas", "resources"] {
        fs::create_dir_all(home.join(d)).unwrap();
    }
    fs::create_dir_all(home.join(".brain")).unwrap();
    fs::create_dir_all(home.join("sources")).unwrap();

    // Register a source via the config so the watcher discovers its origin.
    let origin = tmp.path().join("src-origin");
    fs::create_dir_all(&origin).unwrap();
    let mut cfg = SourceConfig::default();
    cfg.sources.insert(
        "scratch".to_string(),
        SourceEntry { from: origin.clone() },
    );
    cfg.save(&home).unwrap();
    fs::create_dir_all(home.join("sources/scratch")).unwrap();

    (tmp, home, origin)
}

async fn wait_for_marker(home: &Path, timeout: Duration) -> Option<SystemTime> {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if let Ok(Some(mtime)) = index_dirty::marker_mtime(home) {
            return Some(mtime);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    None
}

#[tokio::test]
async fn watcher_touches_marker_on_md_write() {
    let (_tmp, home, target) = fresh_brain_with_source();
    let cancel = CancellationToken::new();

    let handle = spawn_watcher(home.clone(), cancel.clone())
        .await
        .expect("spawn_watcher");

    // Give the watcher a moment to install its watches before we write.
    tokio::time::sleep(Duration::from_millis(300)).await;

    fs::write(target.join("note.md"), b"hello").unwrap();

    // 200ms debounce + macOS fsevent delay; allow up to 3s.
    let mtime = wait_for_marker(&home, Duration::from_secs(3)).await;
    assert!(mtime.is_some(), "dirty marker should exist after .md write");

    // Mirror should have propagated the origin write into sources/scratch/.
    let mirrored = home.join("sources/scratch/note.md");
    assert!(
        mirrored.exists(),
        "watcher should mirror origin writes into sources/<name>/"
    );
    assert_eq!(fs::read(&mirrored).unwrap(), b"hello");

    cancel.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
}

#[tokio::test]
async fn watcher_ignores_irrelevant_changes() {
    let (_tmp, home, target) = fresh_brain_with_source();
    let cancel = CancellationToken::new();

    let handle = spawn_watcher(home.clone(), cancel.clone())
        .await
        .expect("spawn_watcher");
    tokio::time::sleep(Duration::from_millis(300)).await;

    fs::write(target.join(".hidden.md.swp"), b"x").unwrap();
    fs::write(target.join("note.txt"), b"y").unwrap();

    // Wait past the debounce window.
    tokio::time::sleep(Duration::from_millis(800)).await;

    let marker = home.join(".brain/index-dirty");
    assert!(
        !marker.exists(),
        "dirty marker should NOT be created by irrelevant changes"
    );

    cancel.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
}

#[tokio::test]
async fn watcher_debounces_burst_writes() {
    let (_tmp, home, target) = fresh_brain_with_source();
    let cancel = CancellationToken::new();

    let handle = spawn_watcher(home.clone(), cancel.clone())
        .await
        .expect("spawn_watcher");
    tokio::time::sleep(Duration::from_millis(300)).await;

    for i in 0..10 {
        fs::write(target.join(format!("burst-{i}.md")), b"x").unwrap();
    }

    let mtime = wait_for_marker(&home, Duration::from_secs(3)).await;
    assert!(mtime.is_some(), "dirty marker should exist after burst");

    cancel.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
}

// What this would test: spawn the watcher with a known-stale dirty marker
// (marker_mtime > last-indexed) and assert that the initial drain ran exactly
// one `qmd update` cycle, advancing the watermark. Requires a real qmd binary,
// so skip in CI unless the env provides it.
#[tokio::test]
#[ignore]
async fn watcher_initial_drain_runs() {
    let (_tmp, home, _target) = fresh_brain_with_source();
    index_dirty::touch(&home).unwrap();

    let cancel = CancellationToken::new();
    let handle = spawn_watcher(home.clone(), cancel.clone())
        .await
        .expect("spawn_watcher");

    // The initial drain runs synchronously inside spawn_watcher; by the time
    // it returns, last-indexed should be set if qmd is available.
    let last_indexed = index_dirty::read_last_indexed(&home).unwrap();
    assert!(last_indexed.is_some(), "initial drain should have run");

    cancel.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
}
