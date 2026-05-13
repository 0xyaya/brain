use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

const BRAIN_BIN: &str = env!("CARGO_BIN_EXE_brain");

fn run(brain_home: &Path, args: &[&str]) -> std::process::Output {
    // Scope qmd to per-test paths: INDEX_PATH controls the SQLite DB, QMD_CONFIG_DIR
    // controls the YAML collection registry. Both are needed for full isolation.
    let parent = brain_home.parent().unwrap_or(brain_home);
    let qmd_index = parent.join("qmd-index.sqlite");
    let qmd_config = parent.join("qmd-config");
    let _ = fs::create_dir_all(&qmd_config);
    Command::new(BRAIN_BIN)
        .env("BRAIN_HOME", brain_home)
        .env("INDEX_PATH", qmd_index)
        .env("QMD_CONFIG_DIR", qmd_config)
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
fn init_creates_git_repo_and_gitignore_by_default() {
    let (_tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    assert!(home.join(".git").is_dir(), ".git/ should exist after init");
    let gi = home.join(".gitignore");
    assert!(gi.exists(), ".gitignore should be written");
    let contents = fs::read_to_string(&gi).unwrap();
    for needle in [".brain/", ".DS_Store", ".obsidian/workspace", ".obsidian/cache/"] {
        assert!(contents.contains(needle), ".gitignore missing {needle}: {contents}");
    }
}

#[test]
fn init_no_git_skips_repo_and_gitignore() {
    let (_tmp, home) = fresh_home();
    run_ok(&home, &["init", "--no-git"]);

    assert!(!home.join(".git").exists(), ".git/ should not exist with --no-git");
    assert!(!home.join(".gitignore").exists(), ".gitignore should not exist with --no-git");
}

#[test]
fn init_preserves_existing_gitignore() {
    let (_tmp, home) = fresh_home();
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join(".gitignore"), "custom\n").unwrap();

    run_ok(&home, &["init", "--force"]);
    let contents = fs::read_to_string(home.join(".gitignore")).unwrap();
    assert_eq!(contents, "custom\n", "existing .gitignore must not be clobbered");
}

#[test]
fn init_writes_agent_primer() {
    let (_tmp, home) = fresh_home();
    let stdout = run_ok(&home, &["init"]);

    let primer = home.join("brain.md");
    assert!(primer.exists(), "brain.md should be written by init");
    let contents = fs::read_to_string(&primer).unwrap();
    for needle in [
        "cross-machine",
        "brain_context",
        "brain_remember",
        "Never write to this folder directly",
    ] {
        assert!(contents.contains(needle), "brain.md missing '{needle}'");
    }

    // init should also print the wiring hint pointing at this file.
    assert!(stdout.contains("@"), "init should print an @-import hint");
    assert!(stdout.contains("brain.md"), "init should reference brain.md");
}

#[test]
fn init_writes_primer_even_with_no_git() {
    let (_tmp, home) = fresh_home();
    run_ok(&home, &["init", "--no-git"]);
    assert!(home.join("brain.md").exists(), "brain.md should be written even with --no-git");
    assert!(!home.join(".git").exists(), ".git/ should not exist with --no-git");
}

#[test]
fn init_preserves_existing_primer() {
    let (_tmp, home) = fresh_home();
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("brain.md"), "custom primer\n").unwrap();

    run_ok(&home, &["init", "--force"]);
    let contents = fs::read_to_string(home.join("brain.md")).unwrap();
    assert_eq!(contents, "custom primer\n", "existing brain.md must not be clobbered");
}

#[test]
fn init_is_idempotent_on_existing_git_repo() {
    let (_tmp, home) = fresh_home();
    run_ok(&home, &["init"]);
    // Second init in the same dir must not fail or corrupt the repo.
    run_ok(&home, &["init", "--force"]);
    assert!(home.join(".git").is_dir());
}

fn git_in(home: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git").arg("-C").arg(home).args(args).output().unwrap()
}

fn configure_git_identity(home: &Path) {
    let _ = git_in(home, &["config", "user.email", "test@brain.local"]);
    let _ = git_in(home, &["config", "user.name", "brain test"]);
}

#[test]
fn sync_fails_clearly_when_not_a_git_repo() {
    let (_tmp, home) = fresh_home();
    run_ok(&home, &["init", "--no-git"]);

    let out = run(&home, &["sync"]);
    assert!(!out.status.success(), "sync should fail when no .git/ present");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("not a git repo"), "expected helpful error, got: {stderr}");
}

#[test]
fn sync_no_remote_commits_locally_and_succeeds() {
    let (_tmp, home) = fresh_home();
    run_ok(&home, &["init"]);
    configure_git_identity(&home);
    // Create a real change so there's something to commit.
    fs::write(home.join("areas").join("note.md"), "first note").unwrap();

    let stdout = run_ok(&home, &["sync"]);
    assert!(stdout.contains("Committed local changes"), "stdout: {stdout}");
    assert!(stdout.contains("No 'origin' remote"), "stdout: {stdout}");

    // Verify commit landed on HEAD.
    let log = git_in(&home, &["log", "--oneline"]);
    let log_str = String::from_utf8_lossy(&log.stdout);
    assert!(log_str.contains("autosync"), "expected autosync commit in log: {log_str}");
}

#[test]
fn sync_clean_repo_reports_nothing_to_commit() {
    let (_tmp, home) = fresh_home();
    run_ok(&home, &["init"]);
    configure_git_identity(&home);
    // First sync commits the freshly-written .gitignore.
    run_ok(&home, &["sync"]);

    // Second sync, with no further edits, must report nothing to commit.
    let stdout = run_ok(&home, &["sync"]);
    assert!(
        stdout.contains("No local changes to commit"),
        "expected nothing-to-commit message, got: {stdout}"
    );
}

#[test]
fn hub_init_creates_bare_hook_and_origin() {
    let (_tmp, home) = fresh_home();
    run_ok(&home, &["init"]);
    configure_git_identity(&home);
    // Commit the gitignore + brain.md so HEAD exists; otherwise hub init
    // can't seed the bare. (Exactly what `brain sync` would do on first run.)
    run_ok(&home, &["sync"]);

    let stdout = run_ok(&home, &["hub", "init"]);

    // Bare repo sits next to the working copy.
    let bare = {
        let mut s = home.as_os_str().to_owned();
        s.push(".git");
        std::path::PathBuf::from(s)
    };
    assert!(bare.is_dir(), "bare dir should exist at {}", bare.display());
    assert!(bare.join("HEAD").exists(), "bare should look like a git repo");

    // Hook installed and executable.
    let hook = bare.join("hooks").join("post-receive");
    assert!(hook.exists(), "post-receive hook should be installed");
    use std::os::unix::fs::PermissionsExt;
    let mode = hook.metadata().unwrap().permissions().mode() & 0o111;
    assert!(mode != 0, "post-receive hook should be executable");

    // Origin remote wired to the bare.
    let remote = git_in(&home, &["remote", "get-url", "origin"]);
    assert!(remote.status.success(), "origin should be set");
    let url = String::from_utf8_lossy(&remote.stdout).trim().to_string();
    assert_eq!(url, bare.to_str().unwrap());

    // Bare seeded with the working copy's HEAD.
    let bare_log = Command::new("git")
        .arg("--git-dir")
        .arg(&bare)
        .args(["log", "--oneline", "main"])
        .output()
        .unwrap();
    assert!(bare_log.status.success(), "bare should have main branch with commits");

    // Stdout printed join instructions.
    assert!(stdout.contains("brain join"), "stdout should print join hint: {stdout}");
}

#[test]
fn hub_init_refuses_when_brain_not_initialized() {
    let (_tmp, home) = fresh_home();
    // Don't run `brain init` — the brain folder isn't there.
    let out = run(&home, &["hub", "init"]);
    assert!(!out.status.success(), "hub init should fail without prior init");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("does not exist") || stderr.contains("brain init"),
        "expected helpful error, got: {stderr}"
    );
}

#[test]
fn hub_init_refuses_when_working_copy_is_not_a_git_repo() {
    let (_tmp, home) = fresh_home();
    run_ok(&home, &["init", "--no-git"]);
    let out = run(&home, &["hub", "init"]);
    assert!(!out.status.success(), "hub init should fail when no .git/");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("not a git repo"), "expected git-repo error, got: {stderr}");
}

#[test]
fn hub_init_is_idempotent() {
    let (_tmp, home) = fresh_home();
    run_ok(&home, &["init"]);
    configure_git_identity(&home);
    run_ok(&home, &["sync"]);
    run_ok(&home, &["hub", "init"]);
    // Second run must not fail.
    let stdout = run_ok(&home, &["hub", "init"]);
    assert!(
        stdout.contains("already") || stdout.contains("nothing to do"),
        "second hub init should detect existing state: {stdout}"
    );
}

#[test]
fn hub_init_with_no_commits_yet_warns_but_succeeds() {
    let (_tmp, home) = fresh_home();
    run_ok(&home, &["init"]);
    configure_git_identity(&home);
    // No `brain sync` first → no commits in working copy.

    let stdout = run_ok(&home, &["hub", "init"]);
    assert!(
        stdout.contains("No commits") || stdout.contains("empty"),
        "should explain bare stays empty: {stdout}"
    );
}

/// Provision a `brain hub` at a fresh path. Returns (working_copy, bare).
fn provision_hub(parent: &Path, slug: &str) -> (PathBuf, PathBuf) {
    let hub_home = parent.join(slug);
    run_ok(&hub_home, &["init"]);
    configure_git_identity(&hub_home);
    run_ok(&hub_home, &["sync"]);
    run_ok(&hub_home, &["hub", "init"]);
    let mut bare_os = hub_home.as_os_str().to_owned();
    bare_os.push(".git");
    let bare = PathBuf::from(bare_os);
    (hub_home, bare)
}

#[test]
fn join_clones_from_a_hub_and_runs_initial_sync() {
    let tmp = TempDir::new().unwrap();
    let (_hub_home, bare) = provision_hub(tmp.path(), "hub_brain");

    let joiner = tmp.path().join("joiner");
    let stdout = run_ok(
        &joiner,
        &["join", bare.to_str().unwrap(), "--no-schedule"],
    );

    // Working copy now has the seeded content.
    assert!(joiner.join("brain.md").exists(), "primer should arrive via clone");
    assert!(joiner.join(".gitignore").exists(), "gitignore should arrive via clone");
    assert!(joiner.join(".git").is_dir());

    // Origin remote points at the hub.
    let url = git_in(&joiner, &["remote", "get-url", "origin"]);
    assert!(url.status.success());
    assert_eq!(
        String::from_utf8_lossy(&url.stdout).trim(),
        bare.to_str().unwrap()
    );

    // Identity stamped per-host.
    let email = git_in(&joiner, &["config", "user.email"]);
    let email_str = String::from_utf8_lossy(&email.stdout);
    assert!(email_str.starts_with("brain@"), "got: {email_str}");

    // Initial sync ran (sync prints "Synced." on a successful round-trip).
    assert!(stdout.contains("Synced.") || stdout.contains("No local changes"),
        "expected sync output, got: {stdout}");
}

#[test]
fn join_refuses_to_clobber_existing_content() {
    let tmp = TempDir::new().unwrap();
    let target = tmp.path().join("joiner");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("existing.md"), "data").unwrap();

    let out = run(&target, &["join", "/nowhere/hub.git", "--no-schedule"]);
    assert!(!out.status.success(), "join should refuse to clobber");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("already has content") || stderr.contains("clobber"),
        "stderr: {stderr}"
    );
}

#[test]
fn join_seed_from_here_pushes_local_to_empty_hub() {
    let tmp = TempDir::new().unwrap();
    // An empty bare hub (no `brain hub init` — just a plain empty bare).
    let bare = tmp.path().join("empty_hub.git");
    let init_bare = Command::new("git")
        .args(["init", "--bare", "--initial-branch=main"])
        .arg(&bare)
        .output()
        .unwrap();
    assert!(init_bare.status.success(), "failed to create empty bare");

    // Local brain with content and an initial commit.
    let local = tmp.path().join("local");
    run_ok(&local, &["init"]);
    configure_git_identity(&local);
    run_ok(&local, &["sync"]);

    run_ok(
        &local,
        &[
            "join",
            bare.to_str().unwrap(),
            "--no-schedule",
            "--seed-from-here",
        ],
    );

    // The bare should have main with at least the autosync commit.
    let log = Command::new("git")
        .arg("--git-dir")
        .arg(&bare)
        .args(["log", "--oneline", "main"])
        .output()
        .unwrap();
    assert!(log.status.success(), "bare should have main after seed: {log:?}");
    let log_str = String::from_utf8_lossy(&log.stdout);
    assert!(log_str.contains("autosync"), "bare log: {log_str}");
}

#[test]
fn join_seed_from_here_refuses_if_no_commits_yet() {
    let tmp = TempDir::new().unwrap();
    let bare = tmp.path().join("empty_hub.git");
    Command::new("git")
        .args(["init", "--bare", "--initial-branch=main"])
        .arg(&bare)
        .output()
        .unwrap();

    let local = tmp.path().join("local");
    run_ok(&local, &["init"]);
    configure_git_identity(&local);
    // No `brain sync` — no commits yet in the working copy.

    let out = run(
        &local,
        &[
            "join",
            bare.to_str().unwrap(),
            "--no-schedule",
            "--seed-from-here",
        ],
    );
    assert!(!out.status.success(), "should refuse when no commits");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("no commits"), "stderr: {stderr}");
}

#[test]
fn sync_roundtrips_through_a_bare_remote() {
    // Set up: a bare repo acting as the hub, brain repo with origin pointing at it.
    let (tmp, home) = fresh_home();
    let bare = tmp.path().join("hub.git");
    let init = Command::new("git")
        .args(["init", "--bare", "--initial-branch=main"])
        .arg(&bare)
        .output()
        .unwrap();
    assert!(init.status.success(), "failed to create bare repo");

    run_ok(&home, &["init"]);
    configure_git_identity(&home);
    let _ = git_in(&home, &["remote", "add", "origin", bare.to_str().unwrap()]);

    fs::write(home.join("areas").join("note.md"), "synced content").unwrap();

    let stdout = run_ok(&home, &["sync"]);
    assert!(stdout.contains("Pushing to origin"), "stdout: {stdout}");
    assert!(stdout.contains("Synced."), "stdout: {stdout}");

    // Verify the bare actually received the commit.
    let log = Command::new("git")
        .arg("--git-dir")
        .arg(&bare)
        .args(["log", "--oneline", "main"])
        .output()
        .unwrap();
    assert!(log.status.success(), "bare log failed: {:?}", log);
    let log_str = String::from_utf8_lossy(&log.stdout);
    assert!(log_str.contains("autosync"), "bare repo missing commit: {log_str}");
}

#[test]
fn source_add_mirrors_content_into_brain() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    let origin = tmp.path().join("external");
    fs::create_dir_all(origin.join("sub")).unwrap();
    fs::write(origin.join("note.md"), "external content").unwrap();
    fs::write(origin.join("sub/inner.md"), "deeper").unwrap();

    run_ok(&home, &["source", "add", "ext", "--from", origin.to_str().unwrap()]);

    let dest = home.join("sources").join("ext");
    assert!(dest.is_dir(), "mirror should be a real dir, not a symlink");
    assert!(
        !dest.symlink_metadata().unwrap().file_type().is_symlink(),
        "mirror must not be a symlink anymore"
    );
    assert_eq!(fs::read_to_string(dest.join("note.md")).unwrap(), "external content");
    assert_eq!(fs::read_to_string(dest.join("sub/inner.md")).unwrap(), "deeper");
}

#[test]
fn source_add_collision_errors_without_force() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    let t1 = tmp.path().join("e1");
    let t2 = tmp.path().join("e2");
    fs::create_dir_all(&t1).unwrap();
    fs::create_dir_all(&t2).unwrap();

    run_ok(&home, &["source", "add", "ext", "--from", t1.to_str().unwrap()]);

    let out = run(&home, &["source", "add", "ext", "--from", t2.to_str().unwrap()]);
    assert!(!out.status.success(), "second add of same name should fail");
    assert!(String::from_utf8_lossy(&out.stderr).contains("already registered"));
}

#[test]
fn source_add_force_replaces_origin() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    let t1 = tmp.path().join("e1");
    let t2 = tmp.path().join("e2");
    fs::create_dir_all(&t1).unwrap();
    fs::create_dir_all(&t2).unwrap();
    fs::write(t2.join("hello.md"), "from t2").unwrap();

    run_ok(&home, &["source", "add", "ext", "--from", t1.to_str().unwrap()]);
    run_ok(
        &home,
        &["source", "add", "--force", "ext", "--from", t2.to_str().unwrap()],
    );

    // After force, the mirror should reflect t2's content.
    let dest = home.join("sources").join("ext");
    assert!(dest.join("hello.md").exists(), "mirror should now reflect t2");
}

#[test]
fn source_list_enumerates_registered_sources() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    let t1 = tmp.path().join("a");
    let t2 = tmp.path().join("b");
    fs::create_dir_all(&t1).unwrap();
    fs::create_dir_all(&t2).unwrap();

    run_ok(&home, &["source", "add", "alpha", "--from", t1.to_str().unwrap()]);
    run_ok(&home, &["source", "add", "beta", "--from", t2.to_str().unwrap()]);

    let stdout = run_ok(&home, &["source", "list"]);
    assert!(stdout.contains("alpha"), "list should mention alpha:\n{}", stdout);
    assert!(stdout.contains("beta"), "list should mention beta:\n{}", stdout);
}

#[test]
fn source_remove_deletes_mirror_dir_but_not_origin() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    let origin = tmp.path().join("real");
    fs::create_dir_all(&origin).unwrap();
    fs::write(origin.join("file.md"), "content").unwrap();

    run_ok(&home, &["source", "add", "ext", "--from", origin.to_str().unwrap()]);
    let mirror_dir = home.join("sources").join("ext");
    assert!(mirror_dir.is_dir(), "mirror dir should exist before remove");

    run_ok(&home, &["source", "remove", "ext"]);

    assert!(!mirror_dir.exists(), "mirror dir should be gone after remove");
    // Origin must survive remove.
    assert!(origin.is_dir(), "remove must not touch the origin");
    assert!(origin.join("file.md").exists(), "origin contents must survive remove");
}

#[test]
fn source_sync_repropagates_origin_changes() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    let origin = tmp.path().join("origin");
    fs::create_dir_all(&origin).unwrap();
    fs::write(origin.join("v1.md"), "v1").unwrap();

    run_ok(&home, &["source", "add", "ext", "--from", origin.to_str().unwrap()]);
    let mirror_dir = home.join("sources").join("ext");
    assert!(mirror_dir.join("v1.md").exists());

    // Mutate the origin: add a new file, remove the old one.
    fs::write(origin.join("v2.md"), "v2").unwrap();
    fs::remove_file(origin.join("v1.md")).unwrap();

    run_ok(&home, &["source", "sync"]);

    assert!(mirror_dir.join("v2.md").exists(), "new origin file should reach mirror");
    assert!(!mirror_dir.join("v1.md").exists(), "removed origin file should leave mirror");
}

#[test]
fn source_name_with_slash_rejected() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);
    let target = tmp.path().join("t");
    fs::create_dir_all(&target).unwrap();

    let out = run(&home, &["source", "add", "bad/name", "--from", target.to_str().unwrap()]);
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
fn doctor_flags_missing_origin() {
    let (tmp, home) = fresh_home();
    run_ok(&home, &["init"]);

    let origin = tmp.path().join("ephemeral");
    fs::create_dir_all(&origin).unwrap();
    fs::write(origin.join("note.md"), "data").unwrap();
    run_ok(&home, &["source", "add", "ghost", "--from", origin.to_str().unwrap()]);

    fs::remove_dir_all(&origin).unwrap();

    let out = run(&home, &["doctor"]);
    assert!(
        out.status.success(),
        "doctor reports, doesn't fail (exit code 0 even when issues are found)"
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("ghost"), "doctor should name the broken source:\n{}", stdout);
    assert!(
        stdout.contains("missing"),
        "doctor should flag the origin as missing:\n{}",
        stdout
    );
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
