// Lane C tests — integration glue: brain_remember dirty-touch, brain_sync,
// serve.lock, brain index --sync, doctor freshness lag.

use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, SystemTime};

use brainmd::index_dirty::{self, LagStatus, classify_lag};
use brainmd::remember::{RememberInput, remember_inner};
use brainmd::serve_lock::ServeLock;
use brainmd::worker::{DrainOutcome, drain_one_pass};

use tempfile::TempDir;

const BRAIN_BIN: &str = env!("CARGO_BIN_EXE_brain");

fn fresh_brain() -> TempDir {
    TempDir::new().expect("tempdir")
}

#[test]
fn brain_remember_touches_dirty_marker() {
    let tmp = fresh_brain();
    let home = tmp.path();
    let input = RememberInput {
        category: "projects",
        content: "hello world",
        project: Some("scratch"),
    };
    let resp = remember_inner(home, &input).expect("remember ok");
    assert_eq!(resp.get("created").and_then(|v| v.as_bool()), Some(true));

    let marker = home.join(".brain/index-dirty");
    assert!(marker.exists(), "index-dirty marker should exist");

    let mtime = index_dirty::marker_mtime(home).unwrap().unwrap();
    let age = SystemTime::now()
        .duration_since(mtime)
        .unwrap_or(Duration::ZERO);
    assert!(
        age < Duration::from_secs(5),
        "marker mtime should be fresh, was {age:?} old"
    );
}

#[test]
fn serve_lock_blocks_second_acquisition() {
    let tmp = fresh_brain();
    let home = tmp.path();

    let first = ServeLock::try_acquire(home).unwrap();
    assert!(first.is_some(), "first acquire should succeed");

    let second = ServeLock::try_acquire(home).unwrap();
    assert!(second.is_none(), "second acquire should be blocked");
}

#[test]
fn serve_lock_releases_on_drop() {
    let tmp = fresh_brain();
    let home = tmp.path();

    let first = ServeLock::try_acquire(home).unwrap();
    assert!(first.is_some());
    drop(first);

    // On some platforms (notably macOS) flock release after drop can race
    // with re-acquisition in tight loops. Retry briefly to absorb this.
    let mut acquired = false;
    for _ in 0..50 {
        if let Ok(Some(_)) = ServeLock::try_acquire(home) {
            acquired = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(acquired, "after drop, lock should be acquirable");
}

#[test]
fn serve_lock_recovers_from_stale_file() {
    let tmp = fresh_brain();
    let home = tmp.path();
    let dir = home.join(".brain");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("serve.lock"), b"").unwrap();

    let lock = ServeLock::try_acquire(home).unwrap();
    assert!(
        lock.is_some(),
        "stale lock file (no flock) should be acquirable"
    );
}

#[tokio::test]
async fn brain_sync_returns_nothing_to_do_when_clean() {
    let tmp = fresh_brain();
    let outcome = drain_one_pass(tmp.path()).await.unwrap();
    assert!(matches!(outcome, DrainOutcome::NothingToDo));
}

#[test]
fn doctor_classify_lag_buckets() {
    let now = SystemTime::now();

    // No marker -> UpToDate.
    assert_eq!(classify_lag(None, None), LagStatus::UpToDate);

    // Watermark ahead of marker -> UpToDate.
    let past = now - Duration::from_secs(10);
    assert_eq!(classify_lag(Some(past), Some(now)), LagStatus::UpToDate);

    // Marker 30s ahead of watermark -> Ok.
    let m = now;
    let w = now - Duration::from_secs(30);
    match classify_lag(Some(m), Some(w)) {
        LagStatus::Ok(s) => assert!((28..=32).contains(&s), "lag {s}s out of bounds"),
        other => panic!("expected Ok(~30), got {other:?}"),
    }

    // Marker 120s ahead -> Warn.
    let w2 = now - Duration::from_secs(120);
    match classify_lag(Some(m), Some(w2)) {
        LagStatus::Warn(s) => assert!((118..=122).contains(&s)),
        other => panic!("expected Warn(~120), got {other:?}"),
    }

    // Marker 1000s ahead -> Bad.
    let w3 = now - Duration::from_secs(1000);
    match classify_lag(Some(m), Some(w3)) {
        LagStatus::Bad(s) => assert!((998..=1002).contains(&s)),
        other => panic!("expected Bad(~1000), got {other:?}"),
    }

    // Marker present, no watermark -> Bad (very large lag).
    match classify_lag(Some(now), None) {
        LagStatus::Bad(_) => {}
        other => panic!("expected Bad with no watermark, got {other:?}"),
    }
}

#[test]
fn brain_doctor_reports_freshness_lag() {
    // Construct a marker mtime in the past + an even-older watermark; verify
    // the classification helper agrees.
    let now = SystemTime::now();
    let marker = now - Duration::from_secs(90);
    let watermark = now - Duration::from_secs(200);

    let status = classify_lag(Some(marker), Some(watermark));
    match status {
        LagStatus::Warn(s) => assert!((108..=112).contains(&s), "expected ~110, got {s}"),
        other => panic!("expected Warn for 110s lag, got {other:?}"),
    }
}

fn run_brain(brain_home: &Path, args: &[&str]) -> std::process::Output {
    Command::new(BRAIN_BIN)
        .env("BRAIN_HOME", brain_home)
        .args(args)
        .output()
        .expect("failed to invoke brain binary")
}

#[test]
fn brain_index_sync_runs_on_clean_brain() {
    let tmp = fresh_brain();
    let home = tmp.path().join("brain");
    fs::create_dir_all(home.join(".brain")).unwrap();

    let out = run_brain(&home, &["index", "sync"]);
    assert!(
        out.status.success(),
        "brain index sync failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("nothing to do"),
        "expected 'nothing to do' on clean brain, got: {stdout}"
    );
}

// Integration test — exercises the lock contention path via two simultaneous
// `brain index sync` invocations. Skipped by default because it requires a
// real qmd binary or carefully timed binary spawns to demonstrate contention.
#[test]
#[ignore]
fn brain_index_sync_cli_refuses_when_lock_held() {
    // Acquire the lock in-process, then spawn `brain index sync` and assert
    // exit code 1 + the "already draining" message on stderr.
    let tmp = fresh_brain();
    let home = tmp.path().join("brain");
    fs::create_dir_all(home.join(".brain")).unwrap();

    let _lock = ServeLock::try_acquire(&home).unwrap().unwrap();
    let out = run_brain(&home, &["index", "sync"]);
    assert!(!out.status.success(), "should refuse when lock held");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("already draining"),
        "expected refusal message, got: {stderr}"
    );
}
