use anyhow::{Context, Result, anyhow, bail};
use std::path::Path;
use std::process::{Command, Output};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::brain::Brain;

pub fn run(brain: &Brain) -> Result<()> {
    let home = &brain.home;
    if !home.join(".git").exists() {
        bail!(
            "{} is not a git repo. Run `brain init` (without --no-git) first, \
             or `brain join` to attach to a hub.",
            home.display()
        );
    }

    let host = hostname_short();

    // Stage everything. Even an empty stage is fine.
    git_quiet(home, &["add", "-A"])?;

    let dirty = !git(home, &["diff", "--cached", "--quiet"])?.status.success();
    if dirty {
        let ts = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_else(|_| "unknown".to_string());
        let msg = format!("autosync({host}): {ts}");
        git_quiet(home, &["commit", "-m", &msg])?;
        println!("Committed local changes ({msg})");
    } else {
        println!("No local changes to commit");
    }

    if !has_origin(home)? {
        println!("No 'origin' remote configured; skipping pull/push.");
        println!("  Set one with `brain join <ssh-url>` or `git remote add origin <url>`.");
        return Ok(());
    }

    if remote_has_main(home)? {
        println!("Pulling from origin (rebase --autostash)…");
        let pull = git(home, &["pull", "--rebase", "--autostash", "origin", "main"])?;
        if !pull.status.success() {
            let stderr = String::from_utf8_lossy(&pull.stderr);
            bail!(
                "git pull --rebase failed. Resolve the conflict in {} (run \
                 `git status` there to see what needs attention), then re-run \
                 `brain sync`.\n\n{}",
                home.display(),
                stderr.trim()
            );
        }
    } else {
        println!("Remote has no 'main' branch yet; skipping pull (first push will create it).");
    }

    println!("Pushing to origin…");
    let push = git(home, &["push", "origin", "main"])?;
    if !push.status.success() {
        let stderr = String::from_utf8_lossy(&push.stderr);
        bail!(
            "git push failed. Re-run `brain sync` once the hub is reachable.\n\n{}",
            stderr.trim()
        );
    }

    println!("Synced.");
    Ok(())
}

fn git(home: &Path, args: &[&str]) -> Result<Output> {
    Command::new("git")
        .arg("-C")
        .arg(home)
        .args(args)
        .output()
        .with_context(|| format!("running git {}", args.join(" ")))
}

fn git_quiet(home: &Path, args: &[&str]) -> Result<()> {
    let out = git(home, args)?;
    if !out.status.success() {
        return Err(anyhow!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

fn has_origin(home: &Path) -> Result<bool> {
    let out = git(home, &["remote"])?;
    if !out.status.success() {
        return Ok(false);
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|l| l.trim() == "origin"))
}

fn remote_has_main(home: &Path) -> Result<bool> {
    let out = git(home, &["ls-remote", "--heads", "origin", "main"])?;
    if !out.status.success() {
        return Ok(false);
    }
    Ok(!String::from_utf8_lossy(&out.stdout).trim().is_empty())
}

fn hostname_short() -> String {
    Command::new("hostname")
        .arg("-s")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}
