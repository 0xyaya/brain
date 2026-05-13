//! Fire-and-forget `brain sync` after MCP writes.
//!
//! When `brain_remember` writes a deposit, this spawns a detached
//! `brain sync` child process to push it to the hub within seconds —
//! rather than waiting for the launchd/systemd timer's next tick.
//!
//! No-ops in three cases (no spawn happens):
//! - `BRAIN_DISABLE_AUTOSYNC` env var is set (tests, dogfood escape hatch)
//! - the brain is not a git repo (`.git/` missing)
//! - the brain has no `origin` remote (single-machine setup; nothing to push)

use std::path::Path;
use std::process::{Command, Stdio};

pub const DISABLE_ENV: &str = "BRAIN_DISABLE_AUTOSYNC";

pub fn try_autosync(brain_home: &Path) {
    if std::env::var_os(DISABLE_ENV).is_some() {
        return;
    }
    if !has_git_origin(brain_home) {
        return;
    }
    let Ok(brain_bin) = std::env::current_exe() else {
        tracing::warn!("autosync: could not resolve current_exe()");
        return;
    };

    let result = Command::new(&brain_bin)
        .arg("sync")
        .env("BRAIN_HOME", brain_home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match result {
        Ok(_child) => tracing::debug!("autosync: spawned `brain sync`"),
        Err(e) => tracing::warn!("autosync: failed to spawn `brain sync`: {e}"),
    }
}

fn has_git_origin(brain_home: &Path) -> bool {
    let config_path = brain_home.join(".git").join("config");
    let Ok(contents) = std::fs::read_to_string(&config_path) else {
        return false;
    };
    // Cheap heuristic — no full git ini parse. Matches what `git remote add origin` writes.
    contents.contains("[remote \"origin\"]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn no_op_without_git_dir() {
        let tmp = TempDir::new().unwrap();
        // try_autosync should be a no-op (and silent) on a non-git brain.
        try_autosync(tmp.path());
    }

    #[test]
    fn no_op_with_git_but_no_origin() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".git")).unwrap();
        fs::write(tmp.path().join(".git/config"), "[core]\n").unwrap();
        try_autosync(tmp.path());
    }

    #[test]
    fn no_op_when_disabled_via_env() {
        let tmp = TempDir::new().unwrap();
        // Fake an "origin" so the env-var check is the only thing standing
        // between us and a spawn.
        fs::create_dir_all(tmp.path().join(".git")).unwrap();
        fs::write(
            tmp.path().join(".git/config"),
            "[remote \"origin\"]\n\turl = /nowhere\n",
        )
        .unwrap();
        // SAFETY: tests run single-threaded by default for env mutations in
        // this binary. Worst case across-crate, other tests don't check this var.
        // (Tests in this module are independent; race risk only matters here.)
        unsafe { std::env::set_var(DISABLE_ENV, "1"); }
        try_autosync(tmp.path());
        unsafe { std::env::remove_var(DISABLE_ENV); }
    }

    #[test]
    fn has_git_origin_detects_origin_block() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".git")).unwrap();
        fs::write(
            tmp.path().join(".git/config"),
            "[core]\n[remote \"origin\"]\n\turl = /x\n",
        )
        .unwrap();
        assert!(has_git_origin(tmp.path()));
    }

    #[test]
    fn has_git_origin_false_when_config_missing() {
        let tmp = TempDir::new().unwrap();
        assert!(!has_git_origin(tmp.path()));
    }
}
