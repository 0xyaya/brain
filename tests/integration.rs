use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;

const BRAIN_BIN: &str = env!("CARGO_BIN_EXE_brain");

fn run(brain_home: &Path, args: &[&str]) -> std::process::Output {
    Command::new(BRAIN_BIN)
        .env("BRAIN_HOME", brain_home)
        .args(args)
        .output()
        .expect("failed to invoke brain binary")
}

fn run_ok(brain_home: &Path, args: &[&str]) -> String {
    let out = run(brain_home, args);
    if !out.status.success() {
        panic!(
            "brain {:?} failed:\n--stdout--\n{}\n--stderr--\n{}",
            args,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn fresh_home() -> (TempDir, std::path::PathBuf) {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("brain");
    (tmp, home)
}

#[test]
fn init_creates_para_dirs_and_sources() {
    let (_tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    for d in ["projects", "areas", "resources", "archive", "sources"] {
        assert!(home.join(d).is_dir(), "{} should be a dir after init", d);
    }
}

#[test]
fn init_refuses_non_empty_without_force() {
    let (_tmp, home) = fresh_home();
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("preexisting.md"), "hello").unwrap();

    let out = run(&home, &["init"]);
    assert!(!out.status.success(), "init should fail in non-empty dir without --force");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("not empty"), "stderr should mention not empty: {}", stderr);
}

#[test]
fn init_with_force_succeeds_in_non_empty() {
    let (_tmp, home) = fresh_home();
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("preexisting.md"), "keep me").unwrap();

    run_ok(&home, &["init", "--force"]);
    assert!(home.join("projects").is_dir());
    // Pre-existing file must not be deleted.
    assert!(home.join("preexisting.md").exists());
}

#[test]
fn source_add_creates_symlink() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    let target = tmp.path().join("external");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("note.md"), "external content").unwrap();

    run_ok(&home, &["source", "add", "ext", target.to_str().unwrap()]);

    let link = home.join("sources").join("ext");
    assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
    assert!(link.join("note.md").exists());
}

#[test]
fn source_add_collision_errors_without_force() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    let target1 = tmp.path().join("e1");
    let target2 = tmp.path().join("e2");
    fs::create_dir_all(&target1).unwrap();
    fs::create_dir_all(&target2).unwrap();

    run_ok(&home, &["source", "add", "ext", target1.to_str().unwrap()]);

    let out = run(&home, &["source", "add", "ext", target2.to_str().unwrap()]);
    assert!(!out.status.success(), "second add of same name should fail");
    assert!(String::from_utf8_lossy(&out.stderr).contains("already exists"));
}

#[test]
fn source_add_force_overwrites() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    let target1 = tmp.path().join("e1");
    let target2 = tmp.path().join("e2");
    fs::create_dir_all(&target1).unwrap();
    fs::create_dir_all(&target2).unwrap();

    run_ok(&home, &["source", "add", "ext", target1.to_str().unwrap()]);
    run_ok(&home, &["source", "add", "--force", "ext", target2.to_str().unwrap()]);

    let link = home.join("sources").join("ext");
    let resolved = fs::read_link(&link).unwrap();
    assert_eq!(resolved, target2.canonicalize().unwrap());
}

#[test]
fn source_list_enumerates_mounts() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    let t1 = tmp.path().join("a");
    let t2 = tmp.path().join("b");
    fs::create_dir_all(&t1).unwrap();
    fs::create_dir_all(&t2).unwrap();

    run_ok(&home, &["source", "add", "alpha", t1.to_str().unwrap()]);
    run_ok(&home, &["source", "add", "beta", t2.to_str().unwrap()]);

    let stdout = run_ok(&home, &["source", "list"]);
    assert!(stdout.contains("alpha"), "list should mention alpha:\n{}", stdout);
    assert!(stdout.contains("beta"), "list should mention beta:\n{}", stdout);
}

#[test]
fn source_remove_unlinks_only_the_symlink() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    let target = tmp.path().join("real");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("file.md"), "content").unwrap();

    run_ok(&home, &["source", "add", "ext", target.to_str().unwrap()]);
    run_ok(&home, &["source", "remove", "ext"]);

    assert!(home.join("sources").join("ext").symlink_metadata().is_err());
    // Target itself must NOT be deleted by `source remove`.
    assert!(target.is_dir(), "remove must not touch the target");
    assert!(target.join("file.md").exists(), "target contents must survive remove");
}

#[test]
fn source_name_with_slash_rejected() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);
    let target = tmp.path().join("t");
    fs::create_dir_all(&target).unwrap();

    let out = run(&home, &["source", "add", "bad/name", target.to_str().unwrap()]);
    assert!(!out.status.success());
}

#[test]
fn doctor_passes_on_clean_init() {
    let (_tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    let stdout = run_ok(&home, &["doctor"]);
    assert!(stdout.contains("All checks passed"), "doctor should pass:\n{}", stdout);
}

#[test]
fn doctor_flags_broken_symlinks() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    let target = tmp.path().join("ephemeral");
    fs::create_dir_all(&target).unwrap();
    run_ok(&home, &["source", "add", "ghost", target.to_str().unwrap()]);

    fs::remove_dir_all(&target).unwrap();

    let out = run(&home, &["doctor"]);
    assert!(out.status.success(), "doctor exits 0 even with broken symlinks (it reports, not fails)");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("broken"), "doctor should flag broken symlink:\n{}", stdout);
    assert!(stdout.contains("brain source remove ghost"), "doctor should suggest the fix");
}

#[test]
fn snapshot_produces_extractable_archive() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    fs::write(home.join("projects").join("brain.md"), "v0.1 ships").unwrap();

    let archive = tmp.path().join("snap.tar.zst");
    run_ok(&home, &["snapshot", "--out", archive.to_str().unwrap()]);
    assert!(archive.is_file());
    assert!(archive.metadata().unwrap().len() > 0);

    // Decode + extract and verify our file made it through.
    let extract_to = tmp.path().join("extracted");
    fs::create_dir_all(&extract_to).unwrap();
    let f = fs::File::open(&archive).unwrap();
    let dec = zstd::stream::read::Decoder::new(f).unwrap();
    let mut tar = tar::Archive::new(dec);
    tar.unpack(&extract_to).unwrap();

    let extracted = extract_to.join("brain").join("projects").join("brain.md");
    assert!(extracted.exists(), "snapshot should preserve project files");
    assert_eq!(fs::read_to_string(extracted).unwrap(), "v0.1 ships");
}
