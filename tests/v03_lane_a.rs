// Lane A tests — dirty-bit + worker. The modules live in a binary crate, so
// integration tests pull them in via `#[path]` rather than `use brainmd::...`.

#[allow(dead_code)]
#[path = "../src/index_dirty.rs"]
mod index_dirty;

#[allow(dead_code)]
#[path = "../src/worker.rs"]
mod worker;

use std::fs;
use std::thread::sleep;
use std::time::{Duration, SystemTime};

use tempfile::TempDir;

fn fresh_brain() -> TempDir {
    TempDir::new().expect("tempdir")
}

#[test]
fn touch_creates_marker() {
    let tmp = fresh_brain();
    index_dirty::touch(tmp.path()).unwrap();

    let marker = tmp.path().join(".brain/index-dirty");
    assert!(marker.exists(), "marker file should exist after touch");
    let mtime = index_dirty::marker_mtime(tmp.path()).unwrap();
    assert!(mtime.is_some(), "marker_mtime should report Some");
}

#[test]
fn touch_updates_existing_mtime() {
    let tmp = fresh_brain();
    index_dirty::touch(tmp.path()).unwrap();
    let first = index_dirty::marker_mtime(tmp.path()).unwrap().unwrap();

    sleep(Duration::from_millis(1100));

    index_dirty::touch(tmp.path()).unwrap();
    let second = index_dirty::marker_mtime(tmp.path()).unwrap().unwrap();

    assert!(
        second > first,
        "second touch mtime ({:?}) should exceed first ({:?})",
        second,
        first
    );
}

#[test]
fn is_dirty_initially_false_after_first_drain() {
    let tmp = fresh_brain();
    index_dirty::touch(tmp.path()).unwrap();
    let future = SystemTime::now() + Duration::from_secs(1);
    index_dirty::write_last_indexed(tmp.path(), future).unwrap();

    assert!(
        !index_dirty::is_dirty(tmp.path()).unwrap(),
        "is_dirty should be false when watermark is ahead of marker"
    );
}

#[test]
fn is_dirty_true_when_marker_newer() {
    let tmp = fresh_brain();
    let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    index_dirty::write_last_indexed(tmp.path(), t0).unwrap();
    index_dirty::touch(tmp.path()).unwrap();

    assert!(
        index_dirty::is_dirty(tmp.path()).unwrap(),
        "is_dirty should be true when marker is newer than watermark"
    );
}

#[test]
fn read_last_indexed_missing_returns_none() {
    let tmp = fresh_brain();
    assert!(index_dirty::read_last_indexed(tmp.path()).unwrap().is_none());
}

#[test]
fn read_last_indexed_unparseable_returns_none() {
    let tmp = fresh_brain();
    let dir = tmp.path().join(".brain");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("last-indexed"), "not a timestamp").unwrap();

    assert!(index_dirty::read_last_indexed(tmp.path()).unwrap().is_none());
}

#[tokio::test]
async fn drain_nothing_to_do_when_clean() {
    let tmp = fresh_brain();
    let outcome = worker::drain_one_pass(tmp.path()).await.unwrap();
    assert!(matches!(outcome, worker::DrainOutcome::NothingToDo));
}

// Integration test — requires a real `qmd` binary on PATH and a configured
// collection. Lane C's integration suite covers the full happy path.
#[tokio::test]
#[ignore]
async fn drain_runs_qmd_when_dirty() {
    let tmp = fresh_brain();
    index_dirty::touch(tmp.path()).unwrap();
    let outcome = worker::drain_one_pass(tmp.path()).await.unwrap();
    assert!(matches!(outcome, worker::DrainOutcome::Drained { .. }));
}

// Integration test — needs to induce a qmd failure (e.g. shadowed binary on
// PATH). Lane C's integration suite owns this path.
#[tokio::test]
#[ignore]
async fn drain_failed_does_not_advance_watermark() {
    let tmp = fresh_brain();
    index_dirty::touch(tmp.path()).unwrap();
    let before = index_dirty::read_last_indexed(tmp.path()).unwrap();
    let outcome = worker::drain_one_pass(tmp.path()).await.unwrap();
    assert!(matches!(outcome, worker::DrainOutcome::Failed { .. }));
    let after = index_dirty::read_last_indexed(tmp.path()).unwrap();
    assert_eq!(before, after);
}
