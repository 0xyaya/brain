use anyhow::{Context, Result, bail};
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::brain::Brain;

/// Promote this machine to be the brain hub. Creates a bare repo as a
/// sibling of the working copy, installs a post-receive hook that checks
/// out main into the working copy, and wires the working copy's `origin`
/// to the bare.
pub fn init(brain: &Brain) -> Result<()> {
    let home = &brain.home;
    let bare = bare_path_for(home);

    if !home.exists() {
        bail!(
            "{} does not exist. Run `brain init` first.",
            home.display()
        );
    }
    if !home.join(".git").exists() {
        bail!(
            "{} is not a git repo. Re-run `brain init` (without --no-git) so the working copy has a git history before promoting it to a hub.",
            home.display()
        );
    }

    // Bare repo: create if missing, leave alone if already a bare repo
    // pointing at this home. Refuse if there's a non-bare directory there
    // that we'd clobber.
    if bare.exists() {
        if !is_bare_repo(&bare)? {
            bail!(
                "{} exists but is not a bare git repo. Move it aside before running `brain hub init`.",
                bare.display()
            );
        }
        println!("Bare repo already present at {} (kept as-is)", bare.display());
    } else {
        let out = Command::new("git")
            .args(["init", "--bare", "--initial-branch=main"])
            .arg(&bare)
            .output()
            .context("running git init --bare")?;
        if !out.status.success() {
            bail!(
                "git init --bare failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        println!("Created bare repo at {}", bare.display());
    }

    install_post_receive_hook(&bare, home)?;
    configure_origin(home, &bare)?;
    seed_bare_if_possible(home)?;

    print_join_instructions(&bare);
    Ok(())
}

fn bare_path_for(home: &Path) -> PathBuf {
    // /Users/yann/brain  ->  /Users/yann/brain.git
    let mut s: OsString = home.as_os_str().to_owned();
    s.push(".git");
    PathBuf::from(s)
}

fn is_bare_repo(path: &Path) -> Result<bool> {
    // `--git-dir` is a top-level `git` flag; it must come before the
    // subcommand, not as an arg to `rev-parse`.
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(path)
        .args(["rev-parse", "--is-bare-repository"])
        .output()
        .context("running git rev-parse")?;
    if !out.status.success() {
        return Ok(false);
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim() == "true")
}

fn install_post_receive_hook(bare: &Path, work_tree: &Path) -> Result<()> {
    let hooks_dir = bare.join("hooks");
    fs::create_dir_all(&hooks_dir)
        .with_context(|| format!("creating {}", hooks_dir.display()))?;
    let hook_path = hooks_dir.join("post-receive");
    let script = format!(
        "#!/bin/sh\n\
         # Installed by `brain hub init`. Keeps the hub's working copy in\n\
         # sync with whatever is pushed to the bare repo.\n\
         set -e\n\
         GIT_DIR={bare} GIT_WORK_TREE={work} git checkout -f main\n",
        bare = shell_quote(bare),
        work = shell_quote(work_tree),
    );
    fs::write(&hook_path, script)
        .with_context(|| format!("writing {}", hook_path.display()))?;
    let mut perms = fs::metadata(&hook_path)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&hook_path, perms)?;
    println!("Installed post-receive hook at {}", hook_path.display());
    Ok(())
}

fn configure_origin(home: &Path, bare: &Path) -> Result<()> {
    let bare_str = bare.to_str().context("bare path is not valid UTF-8")?;
    let existing = git_in(home, &["remote", "get-url", "origin"])?;
    if existing.status.success() {
        let current = String::from_utf8_lossy(&existing.stdout).trim().to_string();
        if current == bare_str {
            println!("Working copy 'origin' already points at the bare; nothing to do.");
            return Ok(());
        }
        bail!(
            "Working copy 'origin' is set to {current}, not the new bare at {bare_str}. \
             Remove or rename it first, then re-run `brain hub init`."
        );
    }
    let out = git_in(home, &["remote", "add", "origin", bare_str])?;
    if !out.status.success() {
        bail!(
            "git remote add origin failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    println!("Wired working copy 'origin' -> {}", bare.display());
    Ok(())
}

fn seed_bare_if_possible(home: &Path) -> Result<()> {
    // If the working copy has commits, push HEAD to the bare so the bare
    // isn't perpetually empty. The post-receive hook then idempotently
    // re-checks-out into the working copy (no-op for the host that just
    // pushed). If there are no commits yet, leave it — `brain sync` will
    // push the first commit later.
    let head = git_in(home, &["rev-parse", "--verify", "HEAD"])?;
    if !head.status.success() {
        println!(
            "No commits in working copy yet; the bare stays empty. Run `brain sync` once you have content to push."
        );
        return Ok(());
    }
    let push = git_in(home, &["push", "origin", "main"])?;
    if !push.status.success() {
        eprintln!(
            "Initial push to bare failed: {}",
            String::from_utf8_lossy(&push.stderr).trim()
        );
        eprintln!("Run `brain sync` later to retry.");
        return Ok(());
    }
    println!("Seeded bare with current HEAD.");
    Ok(())
}

fn print_join_instructions(bare: &Path) {
    let host = hostname_fqdn();
    let user = std::env::var("USER").unwrap_or_else(|_| "<user>".to_string());
    println!();
    println!("Hub is live. From any other machine, attach with:");
    println!();
    println!("    brain join {user}@{host}:{}", bare.display());
    println!();
    println!(
        "If the other machine is reaching this host over a non-default SSH port or alias, \
         use the matching SSH URL."
    );
}

fn git_in(home: &Path, args: &[&str]) -> Result<Output> {
    Command::new("git")
        .arg("-C")
        .arg(home)
        .args(args)
        .output()
        .with_context(|| format!("running git {}", args.join(" ")))
}

fn hostname_fqdn() -> String {
    Command::new("hostname")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "<hostname>".to_string())
}

fn shell_quote(path: &Path) -> String {
    // Wrap in single quotes for the shell hook script; escape any
    // embedded single quotes the POSIX way (close, escape, reopen).
    let s = path.display().to_string();
    format!("'{}'", s.replace('\'', "'\\''"))
}
