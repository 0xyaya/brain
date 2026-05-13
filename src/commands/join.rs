use anyhow::{Context, Result, bail};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::brain::Brain;
use crate::commands::sync;

pub fn run(
    brain: &Brain,
    hub_url: &str,
    no_schedule: bool,
    seed_from_here: bool,
) -> Result<()> {
    let home = &brain.home;

    if seed_from_here {
        seed_hub_from_existing_brain(home, hub_url)?;
    } else {
        clone_from_hub(home, hub_url)?;
    }

    configure_identity(home)?;

    if no_schedule {
        println!("(skipping sync schedule install — --no-schedule)");
    } else {
        match install_schedule(default_schedule_config()?) {
            Ok(InstallReport { path, activate_cmd }) => {
                println!("Wrote sync schedule to {}", path.display());
                println!("Activate it with:");
                println!("    {activate_cmd}");
            }
            Err(e) => {
                eprintln!("! sync schedule install failed: {e}");
                eprintln!("  brain is joined; run `brain sync` manually or wire your own timer.");
            }
        }
    }

    println!();
    println!("Running initial brain sync to verify round-trip…");
    sync::run(brain)?;
    println!();
    println!("Joined. This machine is now attached to {hub_url}.");
    Ok(())
}

fn clone_from_hub(home: &Path, hub_url: &str) -> Result<()> {
    if home.exists() {
        let mut entries = fs::read_dir(home)
            .with_context(|| format!("reading {}", home.display()))?;
        if entries.next().is_some() {
            bail!(
                "{} already has content. Refusing to clobber. \
                 Move it aside, or run with `--seed-from-here` to push it as the hub's seed.",
                home.display()
            );
        }
    }
    if let Some(parent) = home.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }

    let out = Command::new("git")
        .args(["clone", hub_url])
        .arg(home)
        .output()
        .context("running git clone")?;
    if !out.status.success() {
        bail!(
            "git clone failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    println!("Cloned {hub_url} -> {}", home.display());
    Ok(())
}

fn seed_hub_from_existing_brain(home: &Path, hub_url: &str) -> Result<()> {
    if !home.exists() {
        bail!(
            "--seed-from-here needs an existing brain at {}. Run `brain init` first.",
            home.display()
        );
    }
    if !home.join(".git").exists() {
        bail!(
            "{} is not a git repo. Re-run `brain init` (without --no-git) before seeding.",
            home.display()
        );
    }

    // Wire origin if missing or update if it already matches; refuse if it
    // points somewhere else (avoid surprises).
    let existing = git_in(home, &["remote", "get-url", "origin"])?;
    if existing.status.success() {
        let current = String::from_utf8_lossy(&existing.stdout).trim().to_string();
        if current != hub_url {
            bail!(
                "Working copy 'origin' is set to {current}, not the seed target {hub_url}. \
                 Remove or rename it first, then re-run."
            );
        }
        println!("Origin already wired to {hub_url}.");
    } else {
        let out = git_in(home, &["remote", "add", "origin", hub_url])?;
        if !out.status.success() {
            bail!(
                "git remote add origin failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        println!("Wired origin -> {hub_url}");
    }

    // Make sure the local has at least one commit, then push it as seed.
    let head = git_in(home, &["rev-parse", "--verify", "HEAD"])?;
    if !head.status.success() {
        bail!(
            "Working copy has no commits yet. Run `brain sync` once to make an initial commit, then re-run with --seed-from-here."
        );
    }
    let push = git_in(home, &["push", "-u", "origin", "main"])?;
    if !push.status.success() {
        bail!(
            "git push to seed the hub failed: {}",
            String::from_utf8_lossy(&push.stderr).trim()
        );
    }
    println!("Seeded hub at {hub_url} with current HEAD.");
    Ok(())
}

fn configure_identity(home: &Path) -> Result<()> {
    let host = hostname_short();
    let email = format!("brain@{host}");
    let name = format!("brain ({host})");
    git_in(home, &["config", "user.email", &email])?;
    git_in(home, &["config", "user.name", &name])?;
    println!("Set git identity for this working copy: {name} <{email}>");
    Ok(())
}

#[derive(Debug)]
pub struct ScheduleConfig {
    pub brain_binary: PathBuf,
    pub install_dir: PathBuf,
    pub os: &'static str,
}

#[derive(Debug)]
pub struct InstallReport {
    pub path: PathBuf,
    pub activate_cmd: String,
}

pub fn default_schedule_config() -> Result<ScheduleConfig> {
    let brain_binary = std::env::current_exe().context("locating the brain binary")?;
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        bail!(
            "automatic sync scheduling is only implemented on macOS and Linux. \
             Re-run with --no-schedule and wire your own cron/scheduler."
        );
    };
    let home_dir = std::env::var_os("HOME").context("$HOME not set")?;
    let install_dir = match os {
        "macos" => PathBuf::from(home_dir).join("Library/LaunchAgents"),
        "linux" => PathBuf::from(home_dir).join(".config/systemd/user"),
        _ => unreachable!(),
    };
    Ok(ScheduleConfig { brain_binary, install_dir, os })
}

pub fn install_schedule(config: ScheduleConfig) -> Result<InstallReport> {
    fs::create_dir_all(&config.install_dir)
        .with_context(|| format!("creating {}", config.install_dir.display()))?;

    match config.os {
        "macos" => install_launchd(&config),
        "linux" => install_systemd(&config),
        other => bail!("unsupported OS: {other}"),
    }
}

fn install_launchd(config: &ScheduleConfig) -> Result<InstallReport> {
    let plist_path = config.install_dir.join("dev.brain.sync.plist");
    let activate_cmd = format!("launchctl load {}", plist_path.display());
    if plist_path.exists() {
        return Ok(InstallReport { path: plist_path, activate_cmd });
    }
    let bin = config.brain_binary.display();
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.brain.sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>{bin}</string>
        <string>sync</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
"#
    );
    fs::write(&plist_path, plist)
        .with_context(|| format!("writing {}", plist_path.display()))?;
    Ok(InstallReport { path: plist_path, activate_cmd })
}

fn install_systemd(config: &ScheduleConfig) -> Result<InstallReport> {
    let service_path = config.install_dir.join("brain-sync.service");
    let timer_path = config.install_dir.join("brain-sync.timer");
    let activate_cmd = "systemctl --user enable --now brain-sync.timer".to_string();
    if service_path.exists() && timer_path.exists() {
        return Ok(InstallReport { path: timer_path, activate_cmd });
    }
    let bin = config.brain_binary.display();
    let service = format!(
        "[Unit]\n\
         Description=brain sync\n\
         \n\
         [Service]\n\
         Type=oneshot\n\
         ExecStart={bin} sync\n"
    );
    let timer = "[Unit]\n\
                 Description=Run brain sync every 5 minutes\n\
                 \n\
                 [Timer]\n\
                 OnBootSec=1min\n\
                 OnUnitActiveSec=5min\n\
                 Persistent=true\n\
                 \n\
                 [Install]\n\
                 WantedBy=timers.target\n";
    fs::write(&service_path, service)
        .with_context(|| format!("writing {}", service_path.display()))?;
    fs::write(&timer_path, timer)
        .with_context(|| format!("writing {}", timer_path.display()))?;
    Ok(InstallReport { path: timer_path, activate_cmd })
}

fn git_in(home: &Path, args: &[&str]) -> Result<Output> {
    Command::new("git")
        .arg("-C")
        .arg(home)
        .args(args)
        .output()
        .with_context(|| format!("running git {}", args.join(" ")))
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn install_launchd_writes_plist_with_brain_binary() {
        let tmp = TempDir::new().unwrap();
        let config = ScheduleConfig {
            brain_binary: PathBuf::from("/usr/local/bin/brain"),
            install_dir: tmp.path().to_path_buf(),
            os: "macos",
        };
        let report = install_schedule(config).unwrap();
        assert_eq!(report.path, tmp.path().join("dev.brain.sync.plist"));
        assert!(report.activate_cmd.contains("launchctl load"));
        let contents = fs::read_to_string(&report.path).unwrap();
        assert!(contents.contains("dev.brain.sync"));
        assert!(contents.contains("/usr/local/bin/brain"));
        assert!(contents.contains("<integer>300</integer>"));
    }

    #[test]
    fn install_systemd_writes_service_and_timer() {
        let tmp = TempDir::new().unwrap();
        let config = ScheduleConfig {
            brain_binary: PathBuf::from("/usr/bin/brain"),
            install_dir: tmp.path().to_path_buf(),
            os: "linux",
        };
        let report = install_schedule(config).unwrap();
        assert!(report.path.ends_with("brain-sync.timer"));
        assert!(report.activate_cmd.contains("systemctl --user"));
        let service = fs::read_to_string(tmp.path().join("brain-sync.service")).unwrap();
        let timer = fs::read_to_string(tmp.path().join("brain-sync.timer")).unwrap();
        assert!(service.contains("/usr/bin/brain sync"));
        assert!(timer.contains("OnUnitActiveSec=5min"));
    }

    #[test]
    fn install_schedule_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let make_config = || ScheduleConfig {
            brain_binary: PathBuf::from("/usr/bin/brain"),
            install_dir: tmp.path().to_path_buf(),
            os: if cfg!(target_os = "linux") { "linux" } else { "macos" },
        };
        let _ = install_schedule(make_config()).unwrap();
        // Second call must not error or clobber.
        let _ = install_schedule(make_config()).unwrap();
    }
}
